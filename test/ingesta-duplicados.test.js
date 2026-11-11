/* Candado de ingesta: la misma referencia + autorización solo puede repetirse en una devolución (monto negativo). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/ingesta-duplicados.js');

const f = (referencia, autorizacion, monto) => ({ referencia, autorizacion, monto });
const val = filas => { const v = D.agrupar(filas); return { v, enArchivo: D.repetidasEnArchivo(v) }; };

test('una venta sola no es repetida', () => assert.equal(val([f('R1', 'A1', 100)]).enArchivo.length, 0));
test('dos ventas con la misma referencia y autorización bloquean', () => assert.equal(val([f('R1', 'A1', 100), f('R1', 'A1', 100)]).enArchivo.length, 1));
test('venta + devolución (monto negativo) con la misma pareja: permitido', () => {
  const { v, enArchivo } = val([f('R1', 'A1', 1000), f('R1', 'A1', -1000)]);
  assert.equal(enArchivo.length, 0);
  assert.equal(D.devolucionesLigadas(v, []), 1);
});
test('varias devoluciones (parciales) de una misma venta: permitido', () => {
  const { v, enArchivo } = val([f('R1', 'A1', 1000), f('R1', 'A1', -300), f('R1', 'A1', -200)]);
  assert.equal(enArchivo.length, 0);
  assert.equal(D.devolucionesLigadas(v, []), 2);
});
test('dos ventas y una devolución: bloquea (hay una venta duplicada)', () => assert.equal(val([f('R1', 'A1', 500), f('R1', 'A1', 500), f('R1', 'A1', -500)]).enArchivo.length, 1));
test('un monto en cero NO es devolución', () => assert.equal(val([f('R1', 'A1', 100), f('R1', 'A1', 0)]).enArchivo.length, 1));
test('la devolución sola (sin su venta en el archivo) no es repetida', () => assert.equal(val([f('R1', 'A1', -100)]).enArchivo.length, 0));
test('misma referencia con otra autorización, o al revés, nunca es repetida', () => {
  assert.equal(val([f('R1', 'A1', 100), f('R1', 'A2', 100)]).enArchivo.length, 0);
  assert.equal(val([f('R1', 'A1', 100), f('R2', 'A1', 100)]).enArchivo.length, 0);
});
test('mayúsculas y espacios de más no engañan; filas sin referencia no se comparan', () => {
  assert.equal(val([f('r1', 'a1', 100), f(' R1 ', ' A1 ', 100)]).enArchivo.length, 1);
  assert.equal(val([f('', 'A1', 100), f('', 'A1', 100)]).enArchivo.length, 0);
  assert.equal(val([f('R1', '', 100), f('R1', '', 100)]).enArchivo.length, 1);   // los dos campos iguales (autorización vacía en ambas)
});
test('contra lo ya cargado: una venta nueva con pareja ya vendida bloquea; una devolución no', () => {
  const cargadas = [{ ref: 'R1', aut: 'A1', ventas: 1, devoluciones: 0, veces: 1 }];
  assert.equal(D.repetidasContraCargadas(D.agrupar([f('R1', 'A1', 100)]), cargadas).length, 1);
  const dev = D.agrupar([f('R1', 'A1', -100)]);
  assert.equal(D.repetidasContraCargadas(dev, cargadas).length, 0);
  assert.equal(D.devolucionesLigadas(dev, cargadas), 1);
});
test('contra lo ya cargado: si solo hay devoluciones cargadas, la venta puede entrar', () => {
  const cargadas = [{ ref: 'R1', aut: 'A1', ventas: 0, devoluciones: 1, veces: 1 }];
  assert.equal(D.repetidasContraCargadas(D.agrupar([f('R1', 'A1', 100)]), cargadas).length, 0);
});
test('contra lo ya cargado: un monto en cero repetido bloquea', () => {
  const cargadas = [{ ref: 'R1', aut: 'A1', ventas: 1, devoluciones: 0, veces: 1 }];
  assert.equal(D.repetidasContraCargadas(D.agrupar([f('R1', 'A1', 0)]), cargadas).length, 1);
});
