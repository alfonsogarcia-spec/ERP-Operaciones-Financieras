// Candado a nivel de base de datos: el CEP es OPCIONAL (el candado de negocio es el comprobante, en las rutas); un fondeo asignado necesita monto y fecha,
// y su CEP no se toca una vez asignado.
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

test('el CEP es opcional: sin CEP se puede asignar si hay monto y fecha', async () => {
  const f = await fondeo(); await db.query(`update cards.fondeos set monto_recibido=1005.8, fecha=current_date, asignado_sin_cep=true where id=$1`, [f]);
  await asignar(f);
  const r = (await db.query('select estatus, asignado_sin_cep from cards.fondeos where id=$1', [f])).rows[0];
  assert.equal(r.estatus, 'ASIGNADO'); assert.equal(r.asignado_sin_cep, true);
});
test('con CEP (validado o no) también se asigna; el CEP no es requisito', async () => {
  const f = await fondeo(); await completar(f); await cep(f, false); await asignar(f);
  assert.equal((await db.query('select estatus from cards.fondeos where id=$1', [f])).rows[0].estatus, 'ASIGNADO');
});
test('lo único que exige la base: monto y fecha del fondeo asignado', async () => {
  const f = await fondeo();
  await rechaza(asignar(f), /no se puede asignar sin monto y fecha/);
  await db.query(`update cards.fondeos set monto_recibido=1005.8 where id=$1`, [f]);
  await rechaza(asignar(f), /no se puede asignar sin monto y fecha/);
  assert.equal((await db.query('select estatus from cards.fondeos where id=$1', [f])).rows[0].estatus, 'POR_ASIGNAR');
});
test('no se puede crear un fondeo directamente como asignado sin monto y fecha', async () => {
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
test('una vez asignado, no se cambia la marca «sin CEP»', async () => {
  const f = await fondeo(); await completar(f); await asignar(f);
  await rechaza(db.query(`update cards.fondeos set asignado_sin_cep=true where id=$1`, [f]), /ya está asignado/);
});
test('migración: las solicitudes que esperaban CEP pasan a por asignar, con su evento, y se puede reaplicar sin duplicar', async () => {
  const f = await fondeo({ estatus: 'SOLICITADO' });
  await db.exec(SQL);
  assert.equal((await db.query('select estatus from cards.fondeos where id=$1', [f])).rows[0].estatus, 'POR_ASIGNAR');
  const ev = (await db.query(`select detalle from cards.fondeo_eventos where fondeo_id=$1 and tipo='por_asignar'`, [f])).rows;
  assert.equal(ev.length, 1); assert.match(ev[0].detalle, /CEP ya es opcional/);
  await db.exec(SQL);
  assert.equal((await db.query(`select count(*)::int n from cards.fondeo_eventos where fondeo_id=$1 and tipo='por_asignar'`, [f])).rows[0].n, 1);
});

test('migración: el beneficiario de toda cuenta de fondeo pasa a BECM Servicios de Occidente (los fondeos ya asignados no cambian)', async () => {
  const BEN = 'BECM Servicios de Occidente';
  const e = (await db.query(`insert into cards.entidades(nivel,nombre,clabe,beneficiario) values('EMPRESA','Otra ' || $1::text,$2,'ACME SA DE CV') returning id`, [++n, clabeN(900 + n)])).rows[0].id;
  await db.query('update cards.entidades set empresa_id=id where id=$1', [e]);
  const sinCuenta = (await db.query(`insert into cards.entidades(nivel,parent_id,empresa_id,nombre) values('UN',$1,$1,'UN sin cuenta propia') returning id`, [e])).rows[0].id;
  const mk = async (estatus, extra) => (await db.query(
    `insert into cards.fondeos(folio,entidad_id,empresa_id,fondeo,comision,iva,comision_pct,iva_pct,clabe_destino,estatus,beneficiario_destino,monto_recibido,fecha) values($1,$2,$2,1000,5,0.8,0.5,16,$3,$4,'ACME SA DE CV',1005.8,current_date) returning id`,
    ['FND-B-' + (++n) + estatus, e, clabeN(900 + n), estatus])).rows[0].id;
  const pend = await mk('POR_ASIGNAR'), asig = await mk('POR_ASIGNAR'); await db.query(`update cards.fondeos set estatus='ASIGNADO' where id=$1`, [asig]);
  await db.exec(SQL);
  assert.equal((await db.query('select beneficiario from cards.entidades where id=$1', [e])).rows[0].beneficiario, BEN);
  assert.equal((await db.query('select beneficiario from cards.entidades where id=$1', [sinCuenta])).rows[0].beneficiario, null);   // la que hereda no lleva el suyo
  assert.equal((await db.query('select beneficiario_destino b from cards.fondeos where id=$1', [pend])).rows[0].b, BEN);          // pendiente: se corrige
  assert.equal((await db.query('select beneficiario_destino b from cards.fondeos where id=$1', [asig])).rows[0].b, 'ACME SA DE CV'); // asignado: se conserva
});
