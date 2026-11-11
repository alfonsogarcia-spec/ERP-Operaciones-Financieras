/* ============================================================================
   lib/utilidad-panel.js — Utilidad del ingreso para el Panel general de POS. Funciones puras.

   UTILIDAD DEL INGRESO = comisión pactada (sin IVA) − costo de intercambio − fee Broxel. Es la misma definición que la utilidad del corte
   (engine.js · calcularCompensacion): el IVA no es ingreso; el costo por transacción y la banca no entran. El intercambio sale de lo
   transaccionado por producto con la tasa de la afiliación (TDD, TDC, AMEX, Internacional; si AMEX/Internacional no tienen tasa propia se usa la
   de Parámetros) y el fee Broxel de todo lo transaccionado. Cada fila (rows) trae lo que calcula computeContable.
   ========================================================================= */
'use strict';

function resultadoDe(rows, round2) {
  const R2 = round2 || (n => Math.round((Number(n) + Number.EPSILON) * 100) / 100);
  const S = k => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const monto = S('monto'), comision = S('com_tdd') + S('com_tdc') + S('com_amex') + S('com_int');
  const intercambio = { tdd: R2(S('int_tdd')), tdc: R2(S('int_tdc')), amex: R2(S('int_amex')), int: R2(S('int_int')) };
  intercambio.total = R2(intercambio.tdd + intercambio.tdc + intercambio.amex + intercambio.int);
  const feeBroxel = R2(S('broxel'));
  const total = R2(intercambio.total + feeBroxel);
  const utilidad = R2(comision - intercambio.total - feeBroxel);
  return {
    costos: { intercambio, fee_broxel: feeBroxel, total, pct_intercambio: monto ? intercambio.total / monto : 0, pct_fee_broxel: monto ? feeBroxel / monto : 0 },
    utilidad, margen_pct: comision ? utilidad / comision : null, utilidad_pct_monto: monto ? utilidad / monto : 0,
  };
}

/* ¿Los costos de esta afiliación están completos para confiar en la utilidad? Devuelve los motivos de revisión (vacío = completos).
   grupo: grupo del catálogo o null · tasas: renglón de tasas pactadas o null · costos: renglón de costos o null · m: monto por producto {tdd,tdc,amex,int}.
   Un costo guardado en 0 (Broxel, intercambio de débito o crédito con ventas) NO cae a Parámetros: infla la utilidad sin avisar. */
function alertasCostos({ grupo, tasas, costos, m }) {
  const out = [];
  if (!grupo) out.push('Sin grupo en el catálogo');
  else if (!tasas) out.push('Sin tasas pactadas');
  if (!costos) { out.push('Sin renglón de costos'); return out; }
  const cero = v => v != null && Number(v) === 0;
  if ((m && m.tdd > 0) && (costos.int_tdd == null || cero(costos.int_tdd))) out.push('Intercambio de débito en 0');
  if ((m && m.tdc > 0) && (costos.int_tdc == null || cero(costos.int_tdc))) out.push('Intercambio de crédito en 0');
  if (cero(costos.fee_broxel)) out.push('Costo Broxel en 0');
  return out;
}

/* Afiliaciones con costos incompletos a partir de las filas de computeContable (cada fila trae .afil, .razon, .alertas y .monto). */
function costosIncompletos(rows) {
  const por = new Map();
  for (const r of rows) {
    if (!(r.alertas && r.alertas.length)) continue;
    const e = por.get(String(r.afil)) || { afil: String(r.afil), razon: r.razon || '', motivos: new Set(), monto: 0 };
    r.alertas.forEach(a => e.motivos.add(a)); e.monto += Number(r.monto) || 0;
    por.set(e.afil, e);
  }
  return [...por.values()].map(e => ({ afil: e.afil, razon: e.razon, motivos: [...e.motivos], monto: Math.round(e.monto * 100) / 100 })).sort((a, b) => b.monto - a.monto);
}

module.exports = { resultadoDe, alertasCostos, costosIncompletos };
