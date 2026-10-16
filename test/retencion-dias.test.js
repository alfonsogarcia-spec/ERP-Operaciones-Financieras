/* Pruebas del cálculo de "días retenido" (desde la retención hasta la liberación).
   Ejecuta: node test/retencion-dias.test.js  → sale con código ≠0 si algo falla. */
'use strict';
const D = require('../lib/disputas.js');
const out = []; const chk = (desc, got, esp) => out.push({ desc, got: JSON.stringify(got), esperado: JSON.stringify(esp), pass: JSON.stringify(got) === JSON.stringify(esp) });
const R = (o) => { const r = D.calcRetencion({ tipo: 'CB', hoy: '2026-10-20', ...o }); return [r.estado, r.dias, r.excede]; };

chk('días entre fechas', D.diasEntre('2026-10-19', '2026-11-02'), 14);
chk('cruza fin de año', D.diasEntre('2026-12-30', '2027-01-02'), 3);
// Contracargos
chk('abierto y retenido → en curso hasta hoy', R({ status: 'NOTIFIED', ini: '2026-10-10' }), ['en_curso', 10, false]);
chk('ganado sin pulsar Liberar → por liberar (sigue corriendo hasta hoy)', R({ status: 'WON', ini: '2026-10-01', fecha_cierre: '2026-10-15' }), ['por_liberar', 19, false]);
chk('ganado y liberado → liberado (hasta la fecha de liberación)', R({ status: 'WON', ini: '2026-10-01', fecha_cierre: '2026-10-15', liberado_at: '2026-10-17' }), ['liberado', 16, false]);
chk('ganado que nunca se retuvo → sin retención', R({ status: 'WON', programada: '2026-10-05' }), ['sin_retencion', null, false]);
chk('cancelado tras retener → el dinero sigue retenido (solo WON se libera)', R({ status: 'CANCELLED', ini: '2026-10-01', fecha_cierre: '2026-10-05' }), ['definitiva', 4, false]);
chk('vencido (EXPIRED) → se retiene (definitiva)', R({ status: 'EXPIRED', ini: '2026-10-01', fecha_cierre: '2026-10-06' }), ['definitiva', 5, false]);
chk('vencido (EXPIRED) aún sin corte → por retener', R({ status: 'EXPIRED', programada: '2026-10-21' }), ['por_retener', null, false]);
chk('perdido → definitiva', R({ status: 'LOST', ini: '2026-10-01', fecha_cierre: '2026-10-12' }), ['definitiva', 11, false]);
chk('aceptado → definitiva', R({ status: 'ACCEPTED', ini: '2026-10-01', fecha_cierre: '2026-10-12' }), ['definitiva', 11, false]);
chk('aún sin corte, programado → por retener', R({ status: 'NOTIFIED', programada: '2026-10-21' }), ['por_retener', null, false]);
chk('cancelado sin haber retenido → sin retención', R({ status: 'CANCELLED', programada: '2026-10-21' }), ['sin_retencion', null, false]);
chk('perdido pero aún sin corte → por retener', R({ status: 'LOST', programada: '2026-10-21' }), ['por_retener', null, false]);
chk('más de 45 días naturales abierto → excede', R({ status: 'UNDER_REVIEW', ini: '2026-08-01' }), ['en_curso', 80, true]);
chk('internacional: 80 días no excede (límite 180)', R({ status: 'UNDER_REVIEW', ini: '2026-08-01', brand: 'INTERNACIONAL' }), ['en_curso', 80, false]);
chk('internacional: 181 días sí excede', R({ status: 'UNDER_REVIEW', ini: '2026-04-22', brand: 'INTERNACIONAL' }), ['en_curso', 181, true]);
chk('cerrado sin fecha_cierre usa hoy', R({ status: 'LOST', ini: '2026-10-10' }), ['definitiva', 10, false]);
// Duplicados
const Rd = (o) => { const r = D.calcRetencion({ tipo: 'DUP', hoy: '2026-10-20', ...o }); return [r.estado, r.dias]; };
chk('dup DUPLICADA retenido → definitiva', Rd({ status: 'ANSWERED', decision: 'DUPLICADA', ini: '2026-10-10', fecha_cierre: '2026-10-09' }), ['definitiva', 0]);
chk('dup cancelado tras retener → sigue retenido', Rd({ status: 'CANCELLED', ini: '2026-10-10', fecha_cierre: '2026-10-14' }), ['definitiva', 4]);
chk('dup vencido (EXPIRED) → se retiene', Rd({ status: 'EXPIRED', ini: '2026-10-10', fecha_cierre: '2026-10-14' }), ['definitiva', 4]);
chk('dup NO_DUPLICADA nunca retiene', Rd({ status: 'ANSWERED', decision: 'NO_DUPLICADA' }), ['sin_retencion', null]);
chk('dup DUPLICADA programada aún sin corte → por retener', Rd({ status: 'ANSWERED', decision: 'DUPLICADA', programada: '2026-10-21' }), ['por_retener', null]);
// Devoluciones sospechosas
const Rr = (o) => { const r = D.calcRetencion({ tipo: 'REF', hoy: '2026-10-20', ...o }); return [r.estado, r.dias]; };
chk('refund PROCEDE retenido → definitiva', Rr({ status: 'ANSWERED', decision: 'PROCEDE', ini: '2026-10-10', fecha_cierre: '2026-10-15' }), ['definitiva', 5]);
chk('refund PROCEDE aún sin corte → por retener', Rr({ status: 'ANSWERED', decision: 'PROCEDE', programada: '2026-10-21' }), ['por_retener', null]);
chk('refund NO_PROCEDE nunca retiene', Rr({ status: 'ANSWERED', decision: 'NO_PROCEDE', programada: '2026-10-21' }), ['sin_retencion', null]);
chk('refund vencido (EXPIRED) → se retiene', Rr({ status: 'EXPIRED', programada: '2026-10-21' }), ['por_retener', null]);
// Tiempo por estatus
const ev = [{ estado_nuevo: 'NEW', ts: '2026-10-01T10:00:00Z' }, { estado_nuevo: 'NOTIFIED', ts: '2026-10-02T10:00:00Z' }, { estado_nuevo: 'WON', ts: '2026-10-12T10:00:00Z' }];
chk('tiempo por estatus (cerrado)', D.diasPorEstatus(ev, '2026-10-20', '2026-10-12').map(t => [t.estado, t.dias]), [['NEW', 1], ['NOTIFIED', 10], ['WON', null]]);
chk('tiempo por estatus (abierto)', D.diasPorEstatus(ev.slice(0, 2), '2026-10-20').map(t => [t.estado, t.dias]), [['NEW', 1], ['NOTIFIED', 18]]);

let pass = 0;
for (const t of out) { console.log((t.pass ? 'PASS  ' : 'FAIL  ') + t.desc + (t.pass ? '' : `  → obtenido ${t.got}, esperado ${t.esperado}`)); if (t.pass) pass++; }
console.log(`\n${pass}/${out.length} pruebas correctas`);
process.exit(pass === out.length ? 0 : 1);
