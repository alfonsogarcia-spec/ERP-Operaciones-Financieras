'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const R = require('../lib/reparto-comercio.js');

// Mismas tasas para todo el grupo: 2.5 % + IVA sobre TDC, sin banca ni costo por transacción.
const CAT = { tasas: { pac_tdd: 0.01, pac_tdc: 0.025, pac_amex: 0.03, pac_int: 0.03, costo_x_trx: 0, pct_banca: 0 }, costos: { int_tdd: 0, int_tdc: 0 } };
const PAR = E.PARAMS_DEF();
const calcular = txs => E.calcularCompensacion(txs, CAT, PAR, {});
const tx = (comercio, monto, producto = 'TDC') => ({ comercio, producto, monto });
const cta = (comercio, clabe) => ({ comercio, clabe, codigo_banco: 40012, banco: 'BBVA', beneficiario: 'BENEF ' + comercio });
const GEN = { clabe: '012180000000000001', codigo_banco: 40012, banco: 'BBVA', beneficiario: 'GRUPO SA' };
const suma = (r, k) => R.round2(r.partes.reduce((s, p) => s + p[k], 0));

test('sin cuentas de comercio, o sin transacciones de esos comercios, no hay reparto (se paga como siempre)', () => {
  const txs = [tx('Centro', 100000), tx('Norte', 60000)];
  const final = calcular(txs);
  assert.equal(R.repartir({ txs, cuentasComercio: [], calcular, final, general: GEN }), null);
  assert.equal(R.repartir({ txs, cuentasComercio: [cta('Sur', '012180000000000099')], calcular, final, general: GEN }), null);
});

test('cada comercio con CLABE recibe su parte; la suma es exactamente lo que calculó el grupo', () => {
  const txs = [tx('Centro', 100000), tx('Norte', 60000), tx('Sur', 40000)];
  const final = calcular(txs);
  const rep = R.repartir({ txs, cuentasComercio: [cta('Centro', '012180000000000011'), cta('Norte', '012180000000000022'), cta('Sur', '012180000000000033')], calcular, final, general: GEN });
  assert.equal(rep.partes.length, 3);
  assert.equal(suma(rep, 'disp_dom'), R.round2(final.disp_dom));
  const centro = rep.partes.find(p => p.comercio === 'Centro');
  assert.equal(centro.clabe, '012180000000000011'); assert.equal(centro.disp_dom, R.round2(calcular([tx('Centro', 100000)]).disp_dom));   // sin cargos = lo suyo
  assert.ok(rep.partes.every(p => !p.es_resto));
});

test('los comercios sin CLABE propia salen a la cuenta general del grupo ("resto")', () => {
  const txs = [tx('Centro', 100000), tx('Norte', 60000), tx('Sin cuenta', 40000)];
  const final = calcular(txs);
  const rep = R.repartir({ txs, cuentasComercio: [cta('Centro', '012180000000000011')], calcular, final, general: GEN });
  const resto = rep.partes.find(p => p.es_resto);
  assert.equal(rep.partes.length, 2);
  assert.equal(resto.clabe, GEN.clabe); assert.equal(resto.n_trx, 2);
  assert.equal(resto.disp_dom, R.round2(calcular([tx('Norte', 60000), tx('Sin cuenta', 40000)]).disp_dom));
  assert.equal(suma(rep, 'disp_dom'), R.round2(final.disp_dom));
});

test('los cargos del ledger se reparten en proporción al peso de cada comercio y nada se pierde', () => {
  const txs = [tx('Centro', 100000), tx('Norte', 60000), tx('Sur', 40000)];
  const bruto = calcular(txs);
  const final = { disp_dom: R.round2(bruto.disp_dom - 5000), disp_amex: 0 };       // contracargo de 5,000 aplicado al grupo
  const rep = R.repartir({ txs, cuentasComercio: [cta('Centro', '1'), cta('Norte', '2'), cta('Sur', '3')], calcular, final, general: GEN });
  assert.equal(suma(rep, 'disp_dom'), final.disp_dom);
  const centro = rep.partes.find(p => p.comercio === 'Centro'), solo = calcular([tx('Centro', 100000)]).disp_dom;
  assert.ok(Math.abs((solo - centro.disp_dom) - 5000 * 0.5) < 0.02);               // Centro pesa 50 %: absorbe 2,500
});

test('DOM y AMEX se reparten por separado, con su propio peso', () => {
  const txs = [tx('Centro', 100000, 'TDC'), tx('Norte', 50000, 'AMEX'), tx('Centro', 50000, 'AMEX')];
  const final = calcular(txs);
  const rep = R.repartir({ txs, cuentasComercio: [cta('Centro', '1'), cta('Norte', '2')], calcular, final, general: GEN });
  const norte = rep.partes.find(p => p.comercio === 'Norte');
  assert.equal(norte.disp_dom, 0);                                                  // Norte no tuvo débito/crédito nacional
  assert.ok(norte.disp_amex > 0);
  assert.equal(suma(rep, 'disp_dom'), R.round2(final.disp_dom)); assert.equal(suma(rep, 'disp_amex'), R.round2(final.disp_amex));
});

test('el redondeo no deja centavos sueltos: la suma siempre es exacta', () => {
  const txs = [tx('A', 33333.33), tx('B', 33333.33), tx('C', 33333.34)];
  const final = { disp_dom: 97100.01, disp_amex: 0 };
  const rep = R.repartir({ txs, cuentasComercio: [cta('A', '1'), cta('B', '2'), cta('C', '3')], calcular, final, general: GEN });
  assert.equal(suma(rep, 'disp_dom'), 97100.01);
});

test('el nombre del comercio se compara sin acentos, mayúsculas ni espacios de más', () => {
  const txs = [tx('  SUCURSAL   Mérida ', 10000)];
  const rep = R.repartir({ txs, cuentasComercio: [cta('sucursal merida', '1')], calcular, final: calcular(txs), general: GEN });
  assert.ok(rep && rep.partes.length === 1 && rep.partes[0].clabe === '1');
});

test('sin base para repartir (disponible bruto 0), el importe va a la cuenta general', () => {
  const txs = [tx('Centro', 0.001)];
  const rep = R.repartir({ txs, cuentasComercio: [cta('Centro', '1')], calcular: () => ({ disp_dom: 0, disp_amex: 0 }), final: { disp_dom: 120, disp_amex: 0 }, general: GEN });
  const resto = rep.partes.find(p => p.es_resto);
  assert.equal(resto.disp_dom, 120); assert.equal(resto.clabe, GEN.clabe);
});

test('cuentasDeFila: las del grupo sin afiliación valen para todas; las de afiliación solo para esa', () => {
  const cuentas = [{ id_grupo: 1, numero_afiliacion: '', comercio: 'A' }, { id_grupo: 1, numero_afiliacion: '111', comercio: 'B' }, { id_grupo: 2, numero_afiliacion: '', comercio: 'C' }, { id_grupo: 1, numero_afiliacion: '', comercio: '' }];
  assert.deepEqual(R.cuentasDeFila(cuentas, 1, '111').map(c => c.comercio), ['A', 'B']);
  assert.deepEqual(R.cuentasDeFila(cuentas, 1, '222').map(c => c.comercio), ['A']);
});

test('partesBloqueadas: con importe y sin CLABE o sin código de banco', () => {
  const rep = { partes: [{ comercio: 'A', clabe: '1', codigo_banco: 40012, disp_dom: 10, disp_amex: 0 }, { comercio: 'B', clabe: '', codigo_banco: 40012, disp_dom: 5, disp_amex: 0 }, { comercio: 'C', clabe: '', codigo_banco: null, disp_dom: 0, disp_amex: 0 }] };
  assert.deepEqual(R.partesBloqueadas(rep).map(p => p.comercio), ['B']);
});

test('reescalar: una retención dentro del corte baja las partes en proporción y la suma sigue exacta', () => {
  const rep = { partes: [{ comercio: 'A', es_resto: false, disp_dom: 60000, disp_amex: 0 }, { comercio: 'B', es_resto: false, disp_dom: 40000, disp_amex: 0 }, { comercio: 'Resto del grupo', es_resto: true, disp_dom: 0, disp_amex: 0 }] };
  const nuevo = R.reescalar(rep, { disp_dom: 95000, disp_amex: 0 });
  assert.equal(R.round2(nuevo.partes.reduce((s, p) => s + p.disp_dom, 0)), 95000);
  assert.equal(nuevo.partes[0].disp_dom, 57000); assert.equal(nuevo.partes[1].disp_dom, 38000);   // 60 % y 40 % de 95,000
  assert.equal(rep.partes[0].disp_dom, 60000);                                                   // no muta lo anterior
  assert.equal(R.reescalar(null, { disp_dom: 1, disp_amex: 0 }), null);
  const sinBase = R.reescalar({ partes: [{ comercio: 'A', es_resto: false, disp_dom: 0, disp_amex: 0 }, { comercio: 'Resto del grupo', es_resto: true, disp_dom: 0, disp_amex: 0 }] }, { disp_dom: 10, disp_amex: 0 });
  assert.equal(sinBase.partes[1].disp_dom, 10);                                                  // sin base: va al resto
});
