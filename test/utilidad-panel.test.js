/* Utilidad del ingreso del Panel: comisión (sin IVA) − intercambio − fee Broxel, igual que la utilidad del corte. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const { resultadoDe } = require('../lib/utilidad-panel.js');

// Mismo cálculo que computeContable arma por (día, cliente, afiliación)
function fila(txs, tasas, costos, params) {
  const r = E.calcularCompensacion(txs, { tasas, costos }, params, {});
  return { monto: r.m_tdd + r.m_tdc + r.m_amex + r.m_int, com_tdd: r.com_tdd, com_tdc: r.com_tdc, com_amex: r.com_amex, com_int: r.com_int,
    int_tdd: r.int_tdd, int_tdc: r.int_tdc, int_amex: r.int_amex, int_int: r.int_int, broxel: r.broxel, utilidad: r.utilidad };
}
const PARAMS = { IVA: 0.16, tasa_int_amex: 0.0247, tasa_int_int: 0.0302, fee_broxel: 0.0028 };
const TASAS = { pac_tdd: 0.012, pac_tdc: 0.021, pac_amex: 0.029, pac_int: 0.032, costo_x_trx: 0, pct_banca: 0 };
const COSTOS = { int_tdd: 0.005, int_tdc: 0.011, int_amex: 0.017, int_int: 0.019, fee_broxel: 0.0028 };
const TXS = [{ producto: 'Débito', monto: 10000 }, { producto: 'Crédito', monto: 20000 }, { producto: 'American Express', monto: 5000 }, { producto: 'Internacional', monto: 1000 }];

test('caso calculado a mano: 717 de comisión − 374 de intercambio − 100.80 de fee Broxel = 242.20 de utilidad', () => {
  const r = resultadoDe([fila(TXS, TASAS, COSTOS, PARAMS)]);
  // comisión: 10,000×1.2% + 20,000×2.1% + 5,000×2.9% + 1,000×3.2% = 120 + 420 + 145 + 32 = 717
  // intercambio: 50 + 220 + 85 + 19 = 374 · fee Broxel: 36,000 × 0.28% = 100.80
  assert.deepEqual(r.costos.intercambio, { tdd: 50, tdc: 220, amex: 85, int: 19, total: 374 });
  assert.equal(r.costos.fee_broxel, 100.8);
  assert.equal(r.costos.total, 474.8);
  assert.equal(r.utilidad, 242.2);
  assert.ok(Math.abs(r.margen_pct - 242.2 / 717) < 1e-9);
});
test('coincide con la utilidad del corte (engine) fila por fila', () => {
  const f1 = fila(TXS, TASAS, COSTOS, PARAMS), f2 = fila([{ producto: 'Débito', monto: 4321.55 }, { producto: 'American Express', monto: 999.99 }], TASAS, { ...COSTOS, int_amex: null }, PARAMS);
  const r = resultadoDe([f1, f2]);
  assert.ok(Math.abs(r.utilidad - (f1.utilidad + f2.utilidad)) < 0.011, `${r.utilidad} vs ${f1.utilidad + f2.utilidad}`);
});
test('sin tasa propia de AMEX/Internacional usa la de Parámetros; sin fee propio, el de Parámetros', () => {
  const f = fila([{ producto: 'American Express', monto: 10000 }, { producto: 'Internacional', monto: 10000 }], TASAS, { int_tdd: 0.005, int_tdc: 0.011, int_amex: null, int_int: null, fee_broxel: null }, PARAMS);
  const r = resultadoDe([f]);
  assert.equal(r.costos.intercambio.amex, 247);      // 2.47 %
  assert.equal(r.costos.intercambio.int, 302);       // 3.02 %
  assert.equal(r.costos.fee_broxel, 56);             // 0.28 % de 20,000
});
test('si el costo supera al ingreso la utilidad es negativa; sin ingreso no hay margen', () => {
  const caro = fila([{ producto: 'Débito', monto: 10000 }], { ...TASAS, pac_tdd: 0.003 }, COSTOS, PARAMS);   // cobra 0.3 %, intercambio 0.5 % + fee 0.28 %
  assert.ok(resultadoDe([caro]).utilidad < 0);
  const vacio = resultadoDe([]);
  assert.equal(vacio.utilidad, 0);
  assert.equal(vacio.margen_pct, null);
});
