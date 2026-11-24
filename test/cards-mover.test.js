/* Cards: corregir la estructura moviendo una empresa a unidad de negocio de otra, o una unidad de negocio / tarjeta a otra rama. Base pglite real (schema-cards.sql). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planear, aplicar } = require('../lib/cards-mover.js');

async function base() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-cards.sql'), 'utf8'));
  const db = { query: (t, p) => pg.query(t, p || []), tx: fn => pg.transaction(async t => fn({ query: (q, p) => t.query(q, p || []) })) };
  let n = 0;
  const ent = async (nivel, nombre, parent, extra = {}) => {
    const emp = parent == null ? null : (await db.query('select empresa_id from cards.entidades where id=$1', [parent])).rows[0].empresa_id;
    const id = (await db.query('insert into cards.entidades(nivel,parent_id,empresa_id,nombre,clabe,comision_pct,iva_pct,correo_usuario) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',
      [nivel, parent, emp, nombre, String(++n).padStart(18, '0'), extra.com ?? null, extra.iva ?? null, extra.correo || null])).rows[0].id;
    if (nivel === 'EMPRESA') await db.query('update cards.entidades set empresa_id=id where id=$1', [id]);
    return id;
  };
  const fondeo = async (entidad, estatus) => {
    const emp = (await db.query('select empresa_id from cards.entidades where id=$1', [entidad])).rows[0].empresa_id;
    return (await db.query(`insert into cards.fondeos(folio,entidad_id,empresa_id,fecha,monto_recibido,fondeo,comision,iva,comision_pct,iva_pct,clabe_destino,estatus) values($1,$2,$3,'2026-11-01',1160,1000,100,16,10,16,'x',$4) returning id`, ['F' + (++n), entidad, emp, estatus || 'ASIGNADO'])).rows[0].id;
  };
  const fila = async id => (await db.query('select id,nivel,parent_id,empresa_id from cards.entidades where id=$1', [id])).rows[0];
  return { pg, db, ent, fondeo, fila };
}

test('una empresa pasa a ser unidad de negocio de otra: sus UN suben a la empresa destino y sus tarjetas y fondeos se van con ella', async () => {
  const { pg, db, ent, fondeo, fila } = await base();
  try {
    const A = await ent('EMPRESA', 'Grupo A', null, { com: 2 }), B = await ent('EMPRESA', 'Grupo B (mal capturada)', null, { com: 3, iva: 16 });
    const unB = await ent('UN', 'Sucursal de B', B), tarjB = await ent('TARJETA', 'Tarjeta directa', B, { correo: 'ana@x.com' }), tarjUN = await ent('TARJETA', 'Tarjeta de sucursal', unB, { correo: 'beto@x.com' });
    const f1 = await fondeo(B), f2 = await fondeo(tarjUN, 'POR_ASIGNAR');
    const p = await planear(db, B, A);
    assert.ok(p.ok, JSON.stringify(p)); assert.equal(p.ok.nivel_nuevo, 'UN'); assert.equal(p.ok.fondeos.total, 2); assert.equal(p.ok.fondeos.en_proceso, 1);
    assert.deepEqual(p.ok.subir, ['Sucursal de B']); assert.equal(p.ok.arrastra.tarjetas, 2); assert.equal(p.ok.conserva_comision.comision_pct, 3);
    await aplicar(db, p.ok);
    const b = await fila(B); assert.equal(b.nivel, 'UN'); assert.equal(b.parent_id, A); assert.equal(b.empresa_id, A);
    const u = await fila(unB); assert.equal(u.nivel, 'UN'); assert.equal(u.parent_id, A, 'la UN de la empresa convertida cuelga ahora de la empresa destino'); assert.equal(u.empresa_id, A);
    assert.equal((await fila(tarjB)).parent_id, B); assert.equal((await fila(tarjB)).empresa_id, A);
    assert.equal((await fila(tarjUN)).parent_id, unB); assert.equal((await fila(tarjUN)).empresa_id, A);
    const fe = (await db.query('select id, empresa_id from cards.fondeos order by id')).rows; assert.ok(fe.every(x => x.empresa_id === A), 'los fondeos pasan a la empresa nueva');
    void f1; void f2;
  } finally { await pg.close(); }
});

test('una unidad de negocio y una tarjeta se mueven; reglas de nivel, rama y correo repetido', async () => {
  const { pg, db, ent, fondeo, fila } = await base();
  try {
    const A = await ent('EMPRESA', 'A', null), B = await ent('EMPRESA', 'B', null);
    const unA = await ent('UN', 'UN de A', A), tA = await ent('TARJETA', 'T1', unA, { correo: 'ana@x.com' }), tB = await ent('TARJETA', 'T2', B, { correo: 'ANA@x.com' });
    await fondeo(tA);
    // correo repetido en el destino: no se mueve
    const choque = await planear(db, unA, B); assert.equal(choque.error, 'correo_duplicado');
    await db.query('update cards.entidades set activo=false where id=$1', [tB]);
    const ok = await planear(db, unA, B); assert.ok(ok.ok); await aplicar(db, ok.ok);
    assert.equal((await fila(unA)).empresa_id, B); assert.equal((await fila(tA)).empresa_id, B); assert.equal((await fila(tA)).parent_id, unA);
    assert.equal((await db.query('select empresa_id from cards.fondeos')).rows[0].empresa_id, B);
    // reglas
    assert.equal((await planear(db, B, unA)).error, 'destino_invalido', 'una empresa solo pasa a UN de otra empresa; y el destino no puede estar en su propia rama');
    assert.equal((await planear(db, A, tA)).error, 'destino_invalido', 'no se mueve a una tarjeta');
    assert.equal((await planear(db, unA, tA)).error, 'destino_invalido', 'una UN solo se mueve a una empresa');
    assert.equal((await planear(db, unA, unA)).error, 'destino_invalido');
    assert.equal((await planear(db, unA, B)).error, 'sin_cambio', 'ya está ahí');
    const t = await planear(db, tA, A); assert.ok(t.ok); await aplicar(db, t.ok);
    assert.equal((await fila(tA)).parent_id, A); assert.equal((await fila(tA)).empresa_id, A);
    // destino desactivado
    await db.query('update cards.entidades set activo=false where id=$1', [A]);
    assert.equal((await planear(db, tA, A)).error, 'sin_cambio');
    assert.equal((await planear(db, unA, A)).error, 'destino_inactivo');
  } finally { await pg.close(); }
});
