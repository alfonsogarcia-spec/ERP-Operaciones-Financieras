'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DN = require('../lib/datos-negocio.js');

test('productoDe: débito, crédito, internacional y AMEX; lo demás queda sin clasificar', () => {
  assert.equal(DN.productoDe('Débito'), 'tdd'); assert.equal(DN.productoDe('TDC'), 'tdc'); assert.equal(DN.productoDe('American Express'), 'amex');
  assert.equal(DN.productoDe('Internacional'), 'int'); assert.equal(DN.productoDe('Vale despensa'), 'otro'); assert.equal(DN.productoDe(''), 'otro');
});

test('canalDe: URL es e-commerce, chip/contactless/banda es TPV, MANUAL aparte y vacío sin clasificar', () => {
  assert.equal(DN.canalDe('URL'), 'E-commerce'); assert.equal(DN.canalDe('ecommerce'), 'E-commerce'); assert.equal(DN.canalDe('Link de pago'), 'E-commerce');
  for (const m of ['CHIP', 'CONTACTLESS', 'BANDA', 'NFC', 'EMV']) assert.equal(DN.canalDe(m), 'TPV', m);
  assert.equal(DN.canalDe('MANUAL'), 'Manual (tarjeta no presente)');
  assert.equal(DN.canalDe(''), 'Sin clasificar'); assert.equal(DN.canalDe(null), 'Sin clasificar');
});

test('agrupar: suma por clave, ordena por monto y calcula los porcentajes', () => {
  const r = DN.agrupar([{ clave: 'Débito', monto: 600, n: 6 }, { clave: 'DEBITO', monto: 0, n: 0 }, { clave: 'Crédito', monto: 300, n: 3 }, { clave: 'AMEX', monto: 100, n: 1 }], DN.productoDe, DN.PRODUCTOS);
  assert.deepEqual(r.map(x => x.etiqueta), ['Débito', 'Crédito', 'AMEX']);
  assert.equal(r[0].pct_monto, 60); assert.equal(r[1].pct_monto, 30); assert.equal(r[2].pct_trx, 10);
  assert.equal(r.reduce((s, x) => s + x.pct_monto, 0), 100);
});

test('anuales: suma por año calendario y marca parcial el año que el periodo no cubre completo', () => {
  const mensual = [{ mes: '2025-11', monto: 100, n: 1 }, { mes: '2025-12', monto: 50, n: 1 }, { mes: '2026-01', monto: 10, n: 1 }, { mes: '2026-02', monto: 20, n: 2 }];
  const a = DN.anuales(mensual, '2025-01-01', '2026-02-28');
  assert.deepEqual(a, [{ anio: 2025, monto: 150, n: 2, parcial: false }, { anio: 2026, monto: 30, n: 3, parcial: true }]);
  assert.equal(DN.anuales(mensual, '2025-06-01', '2026-02-28')[0].parcial, true);
});

test('girosMcc: agrupa por MCC con su descripción, deja el top y junta el resto; los sin MCC van aparte', () => {
  const filas = [{ mcc: 5812, giro: 'Restaurantes', monto: 500, n: 5, comercios: 2 }, { mcc: 5812, giro: '', monto: 100, n: 1, comercios: 1 },
    { mcc: 5411, giro: '', monto: 200, n: 2, comercios: 1 }, { mcc: 7011, giro: 'Hoteles', monto: 100, n: 1, comercios: 1 }, { mcc: null, giro: '', monto: 100, n: 1, comercios: 1 }];
  const g = DN.girosMcc(filas, 2);
  assert.equal(g.principales[0].mcc, '5812'); assert.equal(g.principales[0].monto, 600); assert.equal(g.principales[0].comercios, 3);
  assert.equal(g.principales[0].pct_monto, 60); assert.equal(g.principales.length, 2);
  assert.ok(g.principales[1].giro.length > 0);                        // la descripción sale del catálogo MCC si la afiliación no la trae
  assert.match(g.otros.giro, /Otros \(1 giros\)/); assert.equal(g.otros.monto, 100);
  assert.equal(g.sin_mcc.monto, 100); assert.equal(g.total_monto, 1000);
});

test('ensamblar: tasa de contracargos, ticket, nuevos por año con la base inicial y alta del ritmo anual', () => {
  const r = {
    mensualR: [{ mes: '2026-09', n: 10, monto: '1000', comercios: 3 }, { mes: '2026-10', n: 20, monto: '3000', comercios: 4 }],
    tot: { n: 30, monto: '4000', comercios: 5 }, u12: { n: 30, monto: '4000', comercios: 5 }, act30: 4, hist: { n: 6, primero: '2024-03-10' },
    nuevosR: [{ anio: 2024, n: 3 }, { anio: 2025, n: 2 }, { anio: 2026, n: 1 }], nuevos12: 2,
    prodR: [{ clave: 'TDC', monto: '3000', n: 20 }, { clave: 'TDD', monto: '1000', n: 10 }],
    canalR: [{ clave: 'URL', monto: '1000', n: 5 }, { clave: 'CHIP', monto: '2000', n: 15 }, { clave: '', monto: '1000', n: 10 }],
    mccR: [{ mcc: 5812, giro: null, monto: '4000', n: 30, comercios: 5 }],
    ccR: [{ mes: '2026-10', n: 3, monto: '60' }],
  };
  const d = DN.ensamblar(r, { desde: '2026-01-01', hasta: '2026-10-31' });
  assert.equal(d.volumen.ticket_promedio, 133.33);
  assert.equal(d.contracargos.tasa_pct_monto, 1.5); assert.equal(d.contracargos.tasa_pct_trx, 10); assert.equal(d.contracargos.mensual[0].tasa_pct, 2);   // 60 / 3,000 del mes
  assert.deepEqual(d.comercios.nuevos_por_anio.map(x => x.base_inicial), [true, false, false]);
  assert.equal(d.comercios.nuevos_ultimos_12_meses, 2);
  assert.equal(d.canales.agrupado.find(c => c.clave === 'Sin clasificar').pct_monto, 25); assert.equal(d.canales.sin_clasificar_pct, 25);
  assert.equal(d.tarjetas[0].etiqueta, 'Crédito'); assert.equal(d.tarjetas[0].pct_monto, 75);
  assert.equal(d.volumen.ultimos_12_meses.desde, '2025-11-01');
  // sin 12 meses de historial no se inventa un ritmo
  const corto = DN.ensamblar({ ...r, hist: { n: 6, primero: '2026-03-01' } }, { desde: '2026-01-01', hasta: '2026-10-31' });
  assert.equal(corto.comercios.nuevos_ultimos_12_meses, null);
});
