/* Control optimista de estados: si entre la lectura y el UPDATE otro proceso cambió el estado,
   la ruta responde 409 y NO deja evento ni pisa el estado. Se simula la "carrera" con una BD falsa
   cuyo UPDATE de estado no encuentra la fila (porque ya cambió).
   Ejecuta: node test/disputa-conflicto.test.js  → sale con código ≠0 si algo falla. */
'use strict';
process.env.HMAC_PEPPER = 'p'; process.env.ENCRYPTION_KEY_V1 = '0'.repeat(64);
const express = require('express');
const C = require('../lib/crypto.js'); const D = require('../lib/disputas.js');
const mount = require('../lib/disputas-routes.js');

const log = [];                       // consultas ejecutadas
const estados = { chargebacks: 'NOTIFIED', refunds: 'NOTIFIED', duplicates: 'NOTIFIED' };
const db = {
  async query(sql, params) {
    log.push(sql);
    const m = /^select id, status from disputa\.(chargebacks|refunds|duplicates) where id=\$1/.exec(sql);
    if (m) return { rows: [{ id: 1, status: estados[m[1]] }] };           // lectura "vieja"
    if (/^select \* from disputa\.chargebacks where id=\$1/.test(sql)) return { rows: [{ id: 1, status: estados.chargebacks, fecha_recepcion: null }] };
    if (/^update disputa\.\w+ set .*status/i.test(sql) && /returning id/.test(sql)) return { rows: [] };   // el UPDATE protegido no encuentra fila
    return { rows: [] };
  },
};
const app = express(); app.use(express.json());
const auth = (req, _res, next) => { req.user = { rol: 'admin', nombre: 'T' }; next(); };
mount(app, { auth, requiereRol: () => (_q, _r, n) => n(), bit: async () => { }, db, C, D, upload: { single: () => (_q, _r, n) => n() }, sesEnabled: () => false, sendSES: null, armarNotifDisputaHTML: null, path: require('path'), fs: require('fs'), X: {}, enviarXLSX: () => { }, CCS: null, getFeriados: async () => [] });

const out = []; const chk = (desc, got, esp) => out.push({ desc, got: JSON.stringify(got), esperado: JSON.stringify(esp), pass: JSON.stringify(got) === JSON.stringify(esp) });
(async () => {
  const srv = app.listen(0); const base = 'http://localhost:' + srv.address().port;
  const post = async (url, body) => { const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
  const hayEvento = () => log.some(q => /insert into disputa\.\w+_events/i.test(q));
  let r;
  log.length = 0; r = await post('/api/disputa/chargebacks/1/status', { status: 'EVIDENCE_REQUESTED' }); chk('CB status: carrera perdida → 409 conflicto', [r.s, r.j.error], [409, 'conflicto']); chk('CB status: no deja evento', hayEvento(), false);
  log.length = 0; r = await post('/api/disputa/refunds/1/status', { status: 'ANSWERED', decision: 'PROCEDE' }); chk('Refund status: carrera perdida → 409', [r.s, r.j.error], [409, 'conflicto']); chk('Refund status: no deja evento', hayEvento(), false);
  log.length = 0; r = await post('/api/disputa/refunds/1/decision', { decision: 'PROCEDE' }); chk('Refund decision: carrera perdida → 409', [r.s, r.j.error], [409, 'conflicto']); chk('Refund decision: no deja evento', hayEvento(), false);
  log.length = 0; r = await post('/api/disputa/refunds/1/cancel', {}); chk('Refund cancel: carrera perdida → 409', [r.s, r.j.error], [409, 'conflicto']); chk('Refund cancel: no deja evento', hayEvento(), false);
  log.length = 0; r = await post('/api/disputa/duplicates/1/status', { status: 'ANSWERED', decision: 'DUPLICADA' }); chk('Dup status: carrera perdida → 409', [r.s, r.j.error], [409, 'conflicto']); chk('Dup status: no deja evento ni retención', hayEvento() || log.some(q => /comercio_ledger/.test(q)), false);
  log.length = 0; r = await (async () => { const x = await fetch(base + '/api/disputa/chargebacks/1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retenido: true }) }); return { s: x.status, j: await x.json() }; })();
  chk('CB patch: carrera perdida → 409', [r.s, r.j.error], [409, 'conflicto']);
  // los UPDATE llevan la condición de estado
  chk('los UPDATE de estado incluyen "and status="', log.concat([]).filter(q => /^update disputa\.chargebacks set/.test(q)).every(q => /and status=\$/.test(q)), true);
  srv.close();
  let pass = 0;
  for (const t of out) { console.log((t.pass ? 'PASS  ' : 'FAIL  ') + t.desc + (t.pass ? '' : `  → obtenido ${t.got}, esperado ${t.esperado}`)); if (t.pass) pass++; }
  console.log(`\n${pass}/${out.length} pruebas correctas`); process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
