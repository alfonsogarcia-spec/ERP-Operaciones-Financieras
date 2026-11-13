/* Inventario administrativo con PEPS: el costo de cada salida sale de las capas más antiguas primero. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/inventario-peps.js');

let n = 0;
const ent = (fecha, cantidad, costo, o = {}) => ({ id: ++n, tipo: 'entrada', concepto: 'compra', fecha, cantidad, costo_unitario: costo, documento: 'F-' + n, ...o });
const sal = (fecha, cantidad, o = {}) => ({ id: ++n, tipo: 'salida', concepto: 'consumo_interno', fecha, cantidad, ...o });

test('PEPS: la salida consume primero la capa más antigua y se valúa a SU costo', () => {
  const k = P.kardex([ent('2026-01-01', 10, 100), ent('2026-02-01', 10, 150), sal('2026-03-01', 12)]);
  const s = k.filas[2];
  assert.equal(s.costo_total, 10 * 100 + 2 * 150);                                  // 1,300: 10 de la capa vieja + 2 de la nueva
  assert.deepEqual(s.consumos.map(c => [c.cantidad, c.costo_unitario]), [[10, 100], [2, 150]]);
  assert.equal(k.existencia, 8); assert.equal(k.valor, 8 * 150);                    // lo que queda es de la capa más NUEVA
  assert.deepEqual(k.capas.map(c => [c.restante, c.costo_unitario]), [[8, 150]]);
});
test('el saldo corre renglón por renglón y la valuación cuadra con las capas restantes', () => {
  const k = P.kardex([ent('2026-01-01', 5, 10), sal('2026-01-02', 2), ent('2026-01-03', 5, 20), sal('2026-01-04', 4)]);
  assert.deepEqual(k.filas.map(f => f.saldo_cantidad), [5, 3, 8, 4]);
  assert.equal(k.filas[3].costo_total, 3 * 10 + 1 * 20);                            // 3 de la primera capa (lo que quedaba) + 1 de la segunda
  assert.equal(k.valor, k.capas.reduce((a, c) => a + c.restante * c.costo_unitario, 0));
});
test('salida sin existencia suficiente: error con folio, fecha y faltante', () => {
  const k = P.kardex([ent('2026-01-01', 3, 10), sal('2026-01-02', 5)]);
  assert.ok(k.error); assert.equal(k.error.faltante, 2); assert.equal(k.error.fecha, '2026-01-02');
});
test('una entrada con fecha ANTERIOR recalcula el costo de salidas posteriores', () => {
  const base = [ent('2026-02-01', 10, 150), sal('2026-03-01', 5)];
  assert.equal(P.kardex(base).filas[1].costo_total, 750);
  const conVieja = [...base, ent('2026-01-01', 10, 100)];                           // llegó tarde pero es de enero
  assert.equal(P.kardex(conVieja).filas.find(f => f.tipo === 'salida').costo_total, 500);   // ahora la salida sale de la capa de enero
});
test('el mismo día, las entradas van antes que las salidas (aunque se capturaron después)', () => {
  const movs = [sal('2026-01-05', 4), ent('2026-01-05', 4, 25)];
  assert.equal(P.kardex(movs).error, null);
});
test('anular una entrada ya consumida deja salidas sin existencia: se detecta', () => {
  const movs = [ent('2026-01-01', 5, 10), sal('2026-01-02', 5)];
  assert.ok(P.simularAnulacion(movs, movs[0].id).error);
  assert.equal(P.simularAnulacion([...movs, ent('2026-01-03', 1, 10)], movs[0].id).error !== null, true);
  const ok = [ent('2026-01-01', 5, 10), ent('2026-01-02', 5, 12), sal('2026-01-03', 5)];
  assert.equal(P.simularAnulacion(ok, ok[1].id).error, null);                      // la capa anulada no era necesaria
});
test('simular un alta rechaza una salida que dejaría sin existencia a una salida ya registrada', () => {
  const movs = [ent('2026-01-01', 5, 10), sal('2026-01-10', 4)];
  const nueva = sal('2026-01-05', 3);                                               // con fecha anterior: se llevaría 3 y la del día 10 ya no alcanza
  assert.ok(P.simularAlta(movs, nueva).error);
});
test('decimales: cantidades a 4 decimales y totales a 2 sin errores de redondeo flotante', () => {
  const k = P.kardex([ent('2026-01-01', 3, 0.1), ent('2026-01-02', 0.3, 0.2), sal('2026-01-03', 3.3)]);
  assert.equal(k.filas[2].costo_total, 0.36);
  assert.equal(k.existencia, 0);
});
test('costoDeSalida estima el costo de la siguiente salida sin registrarla', () => {
  const k = P.kardex([ent('2026-01-01', 10, 100), ent('2026-02-01', 10, 150)]);
  assert.equal(P.costoDeSalida(k.capas, 12), 1300); assert.equal(P.costoDeSalida(k.capas, 21), null);
});
test('validación de capturas manuales', () => {
  const hoy = P.hoyMX();
  const v = o => P.validarMovimiento({ tipo: 'entrada', concepto: 'compra', fecha: hoy, cantidad: 5, costo_unitario: 10, documento: 'F-1', ...o });
  assert.deepEqual(v({}), []);
  assert.match(v({ cantidad: 0 }).join(), /cantidad/); assert.match(v({ costo_unitario: -1 }).join(), /costo/); assert.match(v({ costo_unitario: undefined }).join(), /costo/);
  assert.match(v({ documento: '' }).join(), /documento/); assert.match(v({ fecha: '2099-01-01' }).join(), /futura/); assert.match(v({ fecha: '2026-02-31' }).join(), /fecha/);
  assert.match(v({ concepto: 'merma' }).join(), /concepto/);                         // merma no es una entrada
  assert.match(P.validarMovimiento({ tipo: 'salida', concepto: 'merma', fecha: hoy, cantidad: 1 }).join(), /nota/);
  assert.match(P.validarMovimiento({ tipo: 'salida', concepto: 'entrega', fecha: hoy, cantidad: 1 }).join(), /Empresa y la Unidad/);
  assert.deepEqual(P.validarMovimiento({ tipo: 'salida', concepto: 'entrega', fecha: hoy, cantidad: 1, empresa: 'ACME', unidad: 'Matriz' }), []);
});
