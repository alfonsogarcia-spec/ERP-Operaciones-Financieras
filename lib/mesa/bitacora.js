/* lib/mesa/bitacora.js — Mesa de control: bitácora inalterable con cadena de hashes.
   Cada asiento guarda el hash del anterior; si alguien altera o borra uno (aun saltándose el sistema), verificar() lo detecta. Además la tabla
   tiene triggers que rechazan UPDATE, DELETE y TRUNCATE. `anotar` debe llamarse DENTRO de la transacción del cambio que registra: así el asiento
   y el cambio se confirman (o se deshacen) juntos. */
'use strict';
const crypto = require('crypto');

const T = 'credit_solvendom.mc_bitacora';
const stable = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort().reduce((a, x) => (a[x] = v[x], a), {}) : v);
const hashDe = (prev, a) => crypto.createHash('sha256').update(stable([prev || '', a.ts, a.usuario || '', a.rol || '', a.accion, a.entidad, String(a.entidad_id == null ? '' : a.entidad_id), a.resumen || '', a.detalle == null ? null : a.detalle])).digest('hex');

/* t = { query } de una transacción. a = { usuario, rol, accion, entidad, entidad_id, resumen, detalle } */
async function anotar(t, a) {
  await t.query('select pg_advisory_xact_lock(884201)');                       // un solo asiento a la vez: la cadena no se bifurca
  const ult = (await t.query(`select hash from ${T} order by id desc limit 1`)).rows[0];
  const e = { ...a, ts: new Date().toISOString(), detalle: a.detalle === undefined ? null : JSON.parse(JSON.stringify(a.detalle)) };
  const hash = hashDe(ult && ult.hash, e);
  await t.query(`insert into ${T}(ts,usuario,rol,accion,entidad,entidad_id,resumen,detalle,prev_hash,hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.ts, e.usuario || null, e.rol || null, e.accion, e.entidad, e.entidad_id == null ? null : String(e.entidad_id), e.resumen || null, e.detalle === null ? null : JSON.stringify(e.detalle), ult ? ult.hash : null, hash]);
  return hash;
}

/* Recorre toda la cadena. Devuelve { ok, total, primero_roto, motivo }. */
async function verificar(db) {
  let prev = null, total = 0, desde = 0;
  for (;;) {
    const filas = (await db.query(`select id, ts, usuario, rol, accion, entidad, entidad_id, resumen, detalle, prev_hash, hash from ${T} where id > $1 order by id limit 500`, [desde])).rows;
    if (!filas.length) break;
    for (const f of filas) {
      total++; desde = Number(f.id);
      if ((f.prev_hash || null) !== (prev || null)) return { ok: false, total, primero_roto: Number(f.id), motivo: 'El asiento no encadena con el anterior: falta o se alteró uno previo.' };
      const det = f.detalle == null ? null : (typeof f.detalle === 'string' ? JSON.parse(f.detalle) : f.detalle);
      const esperado = hashDe(prev, { ts: new Date(f.ts).toISOString(), usuario: f.usuario, rol: f.rol, accion: f.accion, entidad: f.entidad, entidad_id: f.entidad_id, resumen: f.resumen, detalle: det });
      if (esperado !== f.hash) return { ok: false, total, primero_roto: Number(f.id), motivo: 'El contenido del asiento no coincide con su huella: fue alterado.' };
      prev = f.hash;
    }
  }
  return { ok: true, total, primero_roto: null, motivo: null };
}

module.exports = { anotar, verificar, hashDe };
