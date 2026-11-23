/* lib/mesa/contabilidad.js — Mesa de control: pólizas contables del periodo, generadas desde los hechos (desembolsos, pagos y saldos), nunca capturadas a mano.
   Criterios (simplificados; el contador los valida antes de usarlos como contabilidad oficial):
     · desembolso: cartera vigente contra bancos, comisión de apertura (ingreso) e IVA trasladado;
     · cobranza: bancos contra intereses devengados por cobrar, capital, moratorios, IVA y saldos a favor;
     · devengo: el interés de cada pago periódico se reconoce día a día entre un vencimiento y el siguiente (se suspende con atraso ≥ días de cartera vencida);
     · traspaso: el capital con atraso ≥ días de cartera vencida pasa de vigente a vencida (y regresa si se regulariza), por la diferencia contra el cierre anterior;
     · estimación preventiva: reserva por tramo de atraso, registrada por la diferencia contra el cierre anterior. */
'use strict';
const A = require('./amortiza.js');
const U = require('./util.js');
const K = require('./core.js');
const CA = require('./cartera.js');

const S = K.S;
const r2 = A.r2;
const sumaLineas = ls => ({ debe: r2(ls.reduce((s, l) => s + l.debe, 0)), haber: r2(ls.reduce((s, l) => s + l.haber, 0)) });

/* previo = resumen guardado del periodo cerrado anterior ({vencida_saldo, estimacion}). Devuelve { polizas, resumen }. */
async function generar(q, periodo, cfg, previo) {
  const ini = U.inicioDePeriodo(periodo), fin = U.finDePeriodo(periodo), dv = cfg.cartera.dias_vencida;
  const polizas = [];
  const P = (fecha, tipo, concepto, origen, origenId, lineas) => {
    const ls = lineas.map(l => ({ cuenta: l.cuenta, debe: r2(l.debe || 0), haber: r2(l.haber || 0) })).filter(l => l.debe > 0.004 || l.haber > 0.004);
    if (!ls.length) return;
    const s = sumaLineas(ls), dif = r2(s.debe - s.haber);
    if (dif !== 0 && Math.abs(dif) <= 0.05) { const l = ls.find(x => x.cuenta === '2101') || ls[ls.length - 1]; if (dif > 0) l.haber = r2(l.haber + dif); else l.debe = r2(l.debe - dif); }
    polizas.push({ fecha, tipo, concepto, origen, origen_id: String(origenId), lineas: ls });
  };
  const lista = (await CA.cargar(q, fin, { estados: ['vigente', 'liquidado'] })).filter(x => x.credito.fecha_desembolso && x.credito.fecha_desembolso <= fin);

  // 1 · desembolsos confirmados en el periodo
  const des = (await q.query(`select d.id, d.monto, d.comision, d.neto, d.fecha_real::text f, c.folio, c.comision_apertura from ${S}mc_desembolsos d join ${S}mc_creditos c on c.id=d.credito_id where d.estado='confirmado' and d.fecha_real between $1::date and $2::date order by d.fecha_real, d.id`, [ini, fin])).rows;
  for (const d of des) {
    const monto = Number(d.monto), neto = Number(d.neto), base = r2(monto * Number(d.comision_apertura)), iva = r2(monto - neto - base);
    P(d.f, 'desembolso', `Desembolso del crédito ${d.folio}`, 'desembolso', d.id, [{ cuenta: '1301', debe: monto }, { cuenta: '1101', haber: neto }, { cuenta: '4102', haber: base }, { cuenta: '2101', haber: iva }]);
  }
  // 2 · pagos aplicados en el periodo
  for (const x of lista) for (const ap of x.st.aplicaciones.filter(a => a.fecha >= ini && a.fecha <= fin)) {
    P(ap.fecha, 'cobranza', `Pago a ${x.credito.folio} (${U.mxn(ap.monto)})`, 'pago', ap.id, [{ cuenta: '1101', debe: ap.monto }, { cuenta: '1303', haber: ap.interes }, { cuenta: '1301', haber: ap.capital }, { cuenta: '4103', haber: ap.mor }, { cuenta: '2101', haber: ap.iva }, { cuenta: '2301', haber: ap.exceso }]);
  }
  // 3 · devengo del interés del periodo (día a día entre vencimientos)
  const filasPor = new Map((await q.query(`select credito_id, num, fecha::text fecha, interes from ${S}mc_amortizacion where credito_id = any($1::int[]) order by credito_id, num`, [lista.map(x => x.credito.id)])).rows.reduce((m, r) => { (m.get(r.credito_id) || m.set(r.credito_id, []).get(r.credito_id)).push({ fecha: r.fecha, interes: Number(r.interes) }); return m; }, new Map()));
  let devengado = 0; const dia0 = A.iso(A.parse(ini) - 864e5);
  for (const x of lista) {
    if (x.credito.estado === 'vigente' && x.st.diasAtraso >= dv) continue;
    const fs = filasPor.get(x.credito.id) || []; let prev = x.credito.fecha_desembolso, dev = 0;
    for (const f of fs) { const a = prev > dia0 ? prev : dia0, b = f.fecha < fin ? f.fecha : fin, d = Math.max(0, A.dias(a, b)), tot = A.dias(prev, f.fecha); if (tot > 0 && d > 0) dev += f.interes * d / tot; prev = f.fecha; }
    devengado += dev;
  }
  devengado = r2(devengado); P(fin, 'devengo', `Intereses devengados del periodo ${periodo}`, 'devengo', periodo, [{ cuenta: '1303', debe: devengado }, { cuenta: '4101', haber: devengado }]);
  // 4 · traspaso a cartera vencida
  const vivos = lista.filter(x => x.credito.estado === 'vigente');
  const vencidaSaldo = r2(vivos.filter(x => x.st.diasAtraso >= dv).reduce((s, x) => s + x.st.saldoCapital, 0)), dT = r2(vencidaSaldo - (previo.vencida_saldo || 0));
  P(fin, 'traspaso', `${dT >= 0 ? 'Traspaso a' : 'Regreso de'} cartera vencida (saldo vencido ${U.mxn(vencidaSaldo)})`, 'traspaso', periodo, dT >= 0 ? [{ cuenta: '1302', debe: dT }, { cuenta: '1301', haber: dT }] : [{ cuenta: '1301', debe: -dT }, { cuenta: '1302', haber: -dT }]);
  // 5 · estimación preventiva
  const res = CA.resumen(vivos, cfg), dE = r2(res.estimacion - (previo.estimacion || 0));
  P(fin, 'estimacion', `Estimación preventiva del periodo (saldo ${U.mxn(res.estimacion)})`, 'estimacion', periodo, dE >= 0 ? [{ cuenta: '5101', debe: dE }, { cuenta: '1304', haber: dE }] : [{ cuenta: '1304', debe: -dE }, { cuenta: '5101', haber: -dE }]);
  return { polizas, resumen: { vencida_saldo: vencidaSaldo, estimacion: res.estimacion, capital: res.capital, imor: res.imor, devengado, desembolsos: des.length, pagos: lista.reduce((n, x) => n + x.st.aplicaciones.filter(a => a.fecha >= ini && a.fecha <= fin).length, 0) } };
}

module.exports = { generar, sumaLineas };
