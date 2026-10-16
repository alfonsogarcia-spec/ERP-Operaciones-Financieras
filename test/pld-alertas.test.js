/* Pruebas de los detectores de alertas POL-CUM-FOR-006 (funciones puras, sin BD).
   Ejecuta: node test/pld-alertas.test.js → sale con código ≠0 si algo falla. */
'use strict';
const P = require('../lib/pld-alertas.js');
const out = []; const chk = (desc, got, esp) => out.push({ desc, got: JSON.stringify(got), esperado: JSON.stringify(esp), pass: JSON.stringify(got) === JSON.stringify(esp) });
const p = P.normalizarParametros({});
const rxF = P.regexPalabras(p.palabras_fondos);
let seq = 0;
// t = segundos desde las 10:00:00
const fila = (t, o = {}) => P.normFila(Object.assign({ id: ++seq, folio: 'F' + seq, f: '2026-10-15', hora: new Date((10 * 3600 + t) * 1000).toISOString().slice(11, 19), ts_s: 10 * 3600 + t, terminal: 'T1', numero_afiliacion: '9989455', comercio: 'C', cliente: 'G', bin6: '506406', ultimos4: '1000', tarjeta_key: null, monto: 100, estatus: 'APROBADO', estatus_fin: '', motivo: '' }, o), rxF);

// ---- parámetros
chk('defaults del documento: AV-1 30k–50k, BL-2 50k, RT-1 50%/10 min, RT-2 >9 en 8 min, RT-3 3 min, RT-5 4,500–9,999',
  [p.av1_min, p.av1_max, p.bl2_monto, p.rt1_tasa_pct, p.rt1_ventana_min, p.rt2_max_tarjetas, p.rt2_ventana_min, p.rt3_ventana_min, p.rt5_min, p.rt5_max], [30000, 50000, 50000, 50, 10, 9, 8, 3, 4500, 9999]);
chk('parámetro inválido cae al valor por defecto', P.normalizarParametros({ rt1_tasa_pct: 500, rt2_ventana_min: 'abc' }).rt1_tasa_pct, 50);
chk('rango invertido se descarta', [P.normalizarParametros({ av1_min: 60000, av1_max: 40000 }).av1_min, P.normalizarParametros({ av1_min: 60000, av1_max: 40000 }).av1_max], [30000, 50000]);
chk('se puede desactivar una regla', P.normalizarParametros({ 'act_RT-3': false })['act_RT-3'], false);
chk('todas las reglas del documento existen (9 + BL-1)', P.REGLAS.map(r => r.id), ['AV-1', 'AV-2', 'RT-1', 'RT-2', 'RT-3', 'RT-4', 'RT-5', 'RT-6', 'BL-1', 'BL-2']);

// ---- RT-1 tasa de rechazo
let rows = [fila(0, { estatus: 'RECHAZADO' }), fila(60, { estatus: 'RECHAZADO' }), fila(120, { estatus: 'APROBADO' }), fila(180, { estatus: 'RECHAZADO' }), fila(240, { estatus: 'APROBADO' })];
chk('RT-1: 3 de 5 rechazados en 4 min (60%) → alerta', P.detRT1(rows, p).length, 1);
rows = [fila(0, { estatus: 'RECHAZADO' }), fila(60, { estatus: 'APROBADO' }), fila(120, { estatus: 'APROBADO' }), fila(180, { estatus: 'APROBADO' }), fila(240, { estatus: 'APROBADO' })];
chk('RT-1: 1 de 5 (20%) → sin alerta', P.detRT1(rows, p).length, 0);
rows = [fila(0, { estatus: 'RECHAZADO' }), fila(900, { estatus: 'RECHAZADO' }), fila(1800, { estatus: 'RECHAZADO' }), fila(2700, { estatus: 'RECHAZADO' })];
chk('RT-1: 100% de rechazo pero separados más de 10 min → sin alerta', P.detRT1(rows, p).length, 0);
rows = [fila(0, { estatus: 'RECHAZADO' }), fila(60, { estatus: 'RECHAZADO' })];
chk('RT-1: 2 operaciones (bajo el mínimo) → sin alerta', P.detRT1(rows, p).length, 0);
chk('RT-1: nivel SUSPENDER', P.detRT1([fila(0, { estatus: 'RECHAZADO' }), fila(10, { estatus: 'RECHAZADO' }), fila(20, { estatus: 'RECHAZADO' }), fila(30, { estatus: 'RECHAZADO' })], p)[0].nivel, 'SUSPENDER');

// ---- RT-2 volumen inusual
const tarjetas = n => Array.from({ length: n }, (_, i) => fila(i * 30, { ultimos4: String(1000 + i * 7).padStart(4, '0'), tarjeta_key: 'k' + i }));
chk('RT-2: 10 tarjetas distintas en 4.5 min (más de 9 en <8 min) → alerta', P.detRT2(tarjetas(10), p).length, 1);
chk('RT-2: 9 tarjetas (no más de 9) → sin alerta', P.detRT2(tarjetas(9), p).length, 0);
chk('RT-2: 10 operaciones de la MISMA tarjeta → sin alerta', P.detRT2(Array.from({ length: 10 }, (_, i) => fila(i * 30, { tarjeta_key: 'misma' })), p).length, 0);
chk('RT-2: 10 tarjetas repartidas en 20 min → sin alerta', P.detRT2(Array.from({ length: 10 }, (_, i) => fila(i * 130, { ultimos4: String(2000 + i * 7), tarjeta_key: 'z' + i })), p).length, 0);

// ---- RT-3 conectividad PAN
chk('RT-3: terminaciones 1000,1001,1002 en 2 min → alerta', P.detRT3([fila(0, { ultimos4: '1000' }), fila(50, { ultimos4: '1001' }), fila(100, { ultimos4: '1002' })], p).length, 1);
chk('RT-3: terminaciones no consecutivas → sin alerta', P.detRT3([fila(0, { ultimos4: '1000' }), fila(50, { ultimos4: '1005' }), fila(100, { ultimos4: '1010' })], p).length, 0);
chk('RT-3: consecutivas pero en más de 3 min → sin alerta', P.detRT3([fila(0, { ultimos4: '1000' }), fila(120, { ultimos4: '1001' }), fila(300, { ultimos4: '1002' })], p).length, 0);
chk('RT-3: solo 2 consecutivas (mínimo 3) → sin alerta', P.detRT3([fila(0, { ultimos4: '1000' }), fila(50, { ultimos4: '1001' })], p).length, 0);

// ---- RT-4 vaciado escalonado y AV-2
const fi = (t, m) => fila(t, { monto: m, estatus: 'RECHAZADO', motivo: 'FONDOS INSUFICIENTES', tarjeta_key: 'K', ultimos4: '4242' });
chk('RT-4: 10,000 → 5,000 → 2,000 (aprobado) tras rechazo por fondos → alerta', P.detRT4([fi(0, 10000), fila(120, { monto: 5000, estatus: 'RECHAZADO', motivo: 'FONDOS INSUFICIENTES', tarjeta_key: 'K', ultimos4: '4242' }), fila(240, { monto: 2000, estatus: 'APROBADO', tarjeta_key: 'K', ultimos4: '4242' })], p).length, 1);
chk('RT-4: montos que NO decrecen → sin alerta', P.detRT4([fi(0, 1000), fi(60, 5000), fi(120, 9000)], p).length, 0);
chk('RT-4: el primero no es fondos insuficientes → sin alerta', P.detRT4([fila(0, { monto: 10000, estatus: 'RECHAZADO', motivo: 'TARJETA VENCIDA', tarjeta_key: 'K', ultimos4: '4242' }), fila(60, { monto: 5000, tarjeta_key: 'K', ultimos4: '4242' }), fila(120, { monto: 2000, tarjeta_key: 'K', ultimos4: '4242' })], p).length, 0);
chk('AV-2: 3 rechazos por fondos con montos decrecientes → aviso', P.detAV2([fi(0, 9000), fi(100, 5000), fi(200, 1000)], p).map(a => a.nivel), ['AVISO']);
chk('AV-2: solo 2 rechazos (no "mayor a 2") → sin alerta', P.detAV2([fi(0, 9000), fi(100, 5000)], p).length, 0);

// ---- RT-6 micro-cobros
const mc = (t, m) => fila(t, { monto: m });
chk('RT-6: $1,$5,$10 seguidos de $8,000 en 5 min → alerta', P.detRT6([mc(0, 1), mc(30, 5), mc(60, 10), mc(300, 8000)], p).length, 1);
chk('RT-6: micro-cobros sin cobro alto después → sin alerta', P.detRT6([mc(0, 1), mc(30, 5), mc(60, 10), mc(300, 200)], p).length, 0);
chk('RT-6: alto valor 40 min después → sin alerta', P.detRT6([mc(0, 1), mc(30, 5), mc(60, 10), mc(2600, 8000)], p).length, 0);
chk('RT-6: solo 2 micro-cobros → sin alerta', P.detRT6([mc(0, 1), mc(30, 5), mc(60, 8000)], p).length, 0);

// ---- texto del documento
chk('palabras de fondos insuficientes reconocidas', ['FONDOS INSUFICIENTES', 'Sin fondos', 'INSUFFICIENT FUNDS', 'TARJETA VENCIDA'].map(t => !!rxF.test(t)), [true, true, true, false]);
chk('palabras de tarjeta robada/perdida', ['TARJETA ROBADA', 'PERDIDA', 'stolen card', 'APROBADA'].map(t => !!P.regexPalabras(p.palabras_robada).test(t)), [true, true, true, false]);

// ---- el motivo viene en la columna Estatus
chk('rechazo = estatus con el motivo (fondos, robada, perdida, rechazado…)', ['FONDOS INSUFICIENTES', 'TARJETA ROBADA', 'TARJETA PERDIDA', 'RECHAZADO', 'PIN INCORRECTO'].map(e => fila(0, { estatus: e }).rechazada), [true, true, true, true, true]);
chk('NO es rechazo: aprobado, cancelado, devolución, reverso, pendiente', ['APROBADO', 'CANCELADO', 'CANCELACION', 'DEVOLUCION', 'REVERSADO', 'PENDIENTE'].map(e => fila(0, { estatus: e }).rechazada), [false, false, false, false, false, false]);
chk('fondos insuficientes se detecta en el estatus', fila(0, { estatus: 'FONDOS INSUFICIENTES' }).fondos, true);

// ---- acciones ejecutables y correo
const C = require('../lib/pld-correo.js');
const al = (regla, nivel, o = {}) => Object.assign({ regla, nivel, fecha: '2026-10-16', hora_ini: '11:00:00', hora_fin: '11:03:00', terminal: 'T-9', comercio: 'COM X', afil: '9989455', bin: '506406', tarjeta: '', monto: 1234, n_ops: 3, detalle: 'detalle <b>x</b>' }, o);
chk('acción BL-2: bloquear el BIN y la afiliación', /BLOQUEAR el BIN 506406 para la afiliación 9989455/.test(P.accionEjecutable(al('BL-2', 'BLOQUEO'))), true);
chk('acción RT-3: suspender la terminal', /SUSPENDER la terminal T-9/.test(P.accionEjecutable(al('RT-3', 'SUSPENDER'))), true);
chk('acción AV-1: aviso, sin suspensión', /^AVISO/.test(P.accionEjecutable(al('AV-1', 'AVISO'))), true);
const reglas = Object.fromEntries(P.REGLAS.map(r => [r.id, { titulo: r.titulo, nivel: r.nivel }]));
const mail = C.armarCorreoAlertas({ alertas: [al('RT-3', 'SUSPENDER'), al('BL-2', 'BLOQUEO'), al('AV-1', 'AVISO')], reglas, nombre: 'Ana' });
chk('correo: asunto con conteo por nivel y bloqueo primero', mail.subject, '[PLD] ⚠ 1 bloqueo · 1 suspender · 1 aviso — alertas por operativa inusual');
chk('correo: incluye la acción ejecutable de cada alerta', (mail.html.match(/Acción: /g) || []).length, 3);
chk('correo: el HTML de los datos va escapado', /detalle &lt;b&gt;x&lt;\/b&gt;/.test(mail.html) && !/detalle <b>x/.test(mail.html), true);
chk('correo: el bloqueo aparece antes que suspender y aviso', mail.html.indexOf('BLOQUEO ·') < mail.html.indexOf('SUSPENDER ·') && mail.html.indexOf('SUSPENDER ·') < mail.html.indexOf('AVISO ·'), true);
chk('correo: más de 25 alertas de un nivel se resumen', C.armarCorreoAlertas({ alertas: Array.from({ length: 30 }, () => al('BL-2', 'BLOQUEO')), reglas }).html.includes('y 5 más'), true);
chk('parámetros de correo por defecto (activo, 3 días)', [p.correo_activo, p.correo_dias], [true, 3]);
chk('correo_dias inválido cae al valor por defecto', P.normalizarParametros({ correo_dias: -5 }).correo_dias, 3);

// ---- el export trae "APROBADA"
const CI = require('../lib/cumplimiento-ingesta.js');
const nf = est => CI.normalizarFila({ fecha_local: '31/12/2025', hora_local: '23:13:16', monto: 100, estatus: est, bin: '493000', ultimos_4: '3539', id: 1 }, s => 'h' + s);
chk('ingesta: "APROBADA" se normaliza a "APROBADO"', [nf('APROBADA').r.estatus, nf('Aprobado').r.estatus, nf('RECHAZADA').r.estatus], ['APROBADO', 'APROBADO', 'RECHAZADA']);

let pass = 0;
for (const t of out) { console.log((t.pass ? 'PASS  ' : 'FAIL  ') + t.desc + (t.pass ? '' : `  → obtenido ${t.got}, esperado ${t.esperado}`)); if (t.pass) pass++; }
console.log(`\n${pass}/${out.length} pruebas correctas`);
process.exit(pass === out.length ? 0 : 1);
