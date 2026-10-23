// Fondeos de Cards (BSO): desglose de lo recibido, cotización y CLABE.
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('../lib/cards-fondeo');

test('ejemplo del negocio: 301,740 = 300,000 + 1,500 de comisión (0.5%) + 240 de IVA', () => {
  assert.deepEqual(F.desglosarRecibido(301740, 0.5, 16), { recibido: 301740, fondeo: 300000, comision: 1500, iva: 240, redondeo: 0 });
});
test('cotización inversa: para fondear 300,000 deben mandar 301,740', () => {
  assert.deepEqual(F.desglosarFondeo(300000, 0.5, 16), { fondeo: 300000, comision: 1500, iva: 240, total: 301740 });
});
test('ida y vuelta: desglosar(total(f)) devuelve f para montos redondos', () => {
  for (const f of [1000, 25000, 150000, 987654.32, 1500000]) {
    const t = F.desglosarFondeo(f, 0.5, 16).total;
    const d = F.desglosarRecibido(t, 0.5, 16);
    assert.ok(Math.abs(d.fondeo - f) <= 0.02, `${f} → ${t} → ${d.fondeo}`);
    assert.ok(Math.abs(d.redondeo) <= 0.02);
  }
});
test('la suma de las partes cuadra con lo recibido (con centavos de redondeo)', () => {
  for (const r of [12345.67, 100000.01, 301000, 55555.55]) {
    const d = F.desglosarRecibido(r, 0.5, 16);
    assert.equal(F.round2(d.fondeo + d.comision + d.iva + d.redondeo), r);
  }
});
test('comisión 0% y tasas distintas', () => {
  assert.deepEqual(F.desglosarRecibido(5000, 0, 16), { recibido: 5000, fondeo: 5000, comision: 0, iva: 0, redondeo: 0 });
  assert.equal(F.desglosarFondeo(100000, 1, 16).total, 101160);
  assert.equal(F.desglosarFondeo(100000, 1, 0).total, 101000);
});
test('CLABE: dígito verificador', () => {
  assert.equal(F.clabeValida('002010077777777771'), true);   // ejemplo público de Banxico
  assert.equal(F.clabeValida('002010077777777772'), false);   // verificador incorrecto
  assert.equal(F.clabeValida('0020100777777777'), false);      // corta
  assert.equal(F.clabeValida('00201007777777777a'), false);
  assert.equal(F.clabeValida('0020 1007 7777 7777 71'), true); // acepta espacios
  assert.equal(F.normalizarClabe(' 0020-1007-7777-7777-71 '), '002010077777777771');
});
test('tasas efectivas: la propia, o la del ancestro más cercano', () => {
  const m = new Map([
    [1, { parent_id: null, comision_pct: 0.5, iva_pct: 16 }],
    [2, { parent_id: 1, comision_pct: null, iva_pct: null }],
    [3, { parent_id: 2, comision_pct: 0.75, iva_pct: null }],
  ]);
  assert.deepEqual(F.tasasEfectivas(1, m), { comision_pct: 0.5, iva_pct: 16 });
  assert.deepEqual(F.tasasEfectivas(2, m), { comision_pct: 0.5, iva_pct: 16 });
  assert.deepEqual(F.tasasEfectivas(3, m), { comision_pct: 0.75, iva_pct: 16 });
  assert.deepEqual(F.tasasEfectivas(99, m), { comision_pct: null, iva_pct: null });
});
