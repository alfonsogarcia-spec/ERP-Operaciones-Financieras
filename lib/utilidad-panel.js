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

module.exports = { resultadoDe };
