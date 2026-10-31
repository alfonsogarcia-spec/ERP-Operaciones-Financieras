// Candado de asignación (a nivel de base de datos): sin CEP validado no hay "saldo asignado", y un CEP asignado no se toca.
// Usa Postgres en memoria (pglite) con el mismo esquema que producción.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-cards.sql'), 'utf8');

let db, n = 0;
const clabeN = k => '1' + String(k).padStart(17, '0');
test.before(async () => { const { PGlite } = await import('@electric-sql/pglite'); db = new PGlite(); await db.exec(SQL); });
test.after(async () => { try { await db.close(); } catch (_e) { /* nada */ } });

async function fondeo(extra = {}) {
  const e = (await db.query(`insert into cards.entidades(nivel,nombre,clabe) values('EMPRESA',$1,$2) returning id`, ['Acme ' + (++n), clabeN(n)])).rows[0].id;
  await db.query('update cards.entidades set empresa_id=id where id=$1', [e]);
  const f = (await db.query(
    `insert into cards.fondeos(folio,entidad_id,empresa_id,fondeo,comision,iva,comision_pct,iva_pct,clabe_destino,estatus) values($1,$2,$2,1000,5,0.8,0.5,16,$3,$4) returning id`,
    ['FND-T-' + n, e, clabeN(n), extra.estatus || 'POR_ASIGNAR'])).rows[0].id;
  return f;
}
const cep = (f, validado) => db.query(`insert into cards.fondeo_ceps(fondeo_id,filename,bytes_cifrado,sha256_hash,validado,datos,formato) values($1,'cep.pdf','x'::bytea,$2,$3,'{"monto":1005.8}','cep_banxico') returning id`, [f, 'h' + Math.random(), validado]);
const completar = f => db.query(`update cards.fondeos set monto_recibido=1005.8, fecha=current_date, clave_rastreo='RAST'||id where id=$1`, [f]);
const asignar = f => db.query(`update cards.fondeos set estatus='ASIGNADO' where id=$1`, [f]);
const rechaza = async (p, texto) => assert.rejects(p, e => { assert.match(e.message, texto); return true; });

test('sin ningún CEP no se puede asignar', async () => {
  const f = await fondeo(); await completar(f);
  await rechaza(asignar(f), /Candado de tesorería.*sin un CEP validado/);
  assert.equal((await db.query('select estatus from cards.fondeos where id=$1', [f])).rows[0].estatus, 'POR_ASIGNAR');
});
test('con un CEP que el sistema NO validó tampoco', async () => {
  const f = await fondeo(); await completar(f); await cep(f, false);
  await rechaza(asignar(f), /Candado de tesorería/);
});
test('con CEP validado pero sin monto, fecha o clave de rastreo tampoco', async () => {
  const f = await fondeo(); await cep(f, true);
  await rechaza(asignar(f), /Candado de tesorería/);
});
test('con un CEP validado y los datos completos sí se asigna', async () => {
  const f = await fondeo(); await completar(f); await cep(f, true);
  await asignar(f);
  assert.equal((await db.query('select estatus from cards.fondeos where id=$1', [f])).rows[0].estatus, 'ASIGNADO');
});
test('no se puede crear un fondeo directamente como asignado', async () => {
  await rechaza(fondeo({ estatus: 'ASIGNADO' }), /Candado de tesorería/);
});
test('otros cambios de estatus no se ven afectados (rechazar, cancelar)', async () => {
  const f = await fondeo(); await db.query(`update cards.fondeos set estatus='RECHAZADO' where id=$1`, [f]);
  await db.query(`update cards.fondeos set estatus='CANCELADO' where id=$1`, [f]);
});
test('una vez asignado, su CEP no se puede quitar ni alterar', async () => {
  const f = await fondeo(); await completar(f); const c = (await cep(f, true)).rows[0].id; await asignar(f);
  await rechaza(db.query('delete from cards.fondeo_ceps where id=$1', [c]), /CEP de un fondeo asignado/);
  await rechaza(db.query(`update cards.fondeo_ceps set datos='{"monto":1}' where id=$1`, [c]), /CEP de un fondeo asignado/);
  assert.equal((await db.query('select count(*)::int n from cards.fondeo_ceps where fondeo_id=$1', [f])).rows[0].n, 1);
});
test('antes de asignar, el CEP sí se puede quitar (el comercial corrige)', async () => {
  const f = await fondeo(); const c = (await cep(f, true)).rows[0].id;
  await db.query('delete from cards.fondeo_ceps where id=$1', [c]);
});
test('el esquema se puede volver a aplicar (migración idempotente) y el candado sigue activo', async () => {
  await db.exec(SQL);
  const f = await fondeo(); await completar(f);
  await rechaza(asignar(f), /Candado de tesorería/);
});

// Única excepción: tesorería asigna SIN CEP (la ruta solo la deja a ese rol); la base exige monto, fecha y un motivo.
const sinCep = (f, motivo = 'El cliente depositó y el CEP no se pudo descargar del banco') =>
  db.query(`update cards.fondeos set estatus='ASIGNADO', asignado_sin_cep=true, sin_cep_motivo=$2, monto_recibido=1005.8, fecha=current_date where id=$1`, [f, motivo]);
test('asignar sin CEP: con monto, fecha y motivo sí pasa (sin CEP y sin clave de rastreo)', async () => {
  const f = await fondeo(); await sinCep(f);
  const r = (await db.query('select estatus, asignado_sin_cep, sin_cep_motivo from cards.fondeos where id=$1', [f])).rows[0];
  assert.equal(r.estatus, 'ASIGNADO'); assert.equal(r.asignado_sin_cep, true); assert.match(r.sin_cep_motivo, /CEP no se pudo/);
});
test('asignar sin CEP exige un motivo de al menos 10 caracteres, monto y fecha', async () => {
  const f = await fondeo();
  await rechaza(sinCep(f, ''), /exige monto, fecha y el motivo/);
  await rechaza(sinCep(f, 'corto'), /exige monto, fecha y el motivo/);
  await rechaza(db.query(`update cards.fondeos set estatus='ASIGNADO', asignado_sin_cep=true, sin_cep_motivo='motivo suficientemente largo' where id=$1`, [f]), /exige monto, fecha y el motivo/);
  assert.equal((await db.query('select estatus from cards.fondeos where id=$1', [f])).rows[0].estatus, 'POR_ASIGNAR');
});
test('una vez asignado no se puede cambiar si fue sin CEP (ni disfrazar uno normal como sin CEP)', async () => {
  const f = await fondeo(); await sinCep(f);
  await rechaza(db.query('update cards.fondeos set asignado_sin_cep=false where id=$1', [f]), /no se cambia si se asignó sin CEP/);
  const g = await fondeo(); await completar(g); await cep(g, true); await asignar(g);
  await rechaza(db.query('update cards.fondeos set asignado_sin_cep=true where id=$1', [g]), /no se cambia si se asignó sin CEP/);
});
