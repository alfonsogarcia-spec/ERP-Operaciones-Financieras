/* Series del inventario administrativo: el estado de cada terminal sale de reproducir los movimientos. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/inventario-series.js');

let n = 0;
const ent = (fecha, series, o = {}) => ({ id: ++n, tipo: 'entrada', concepto: 'compra', fecha, cantidad: series.length, series, ...o });
const sal = (fecha, series, o = {}) => ({ id: ++n, tipo: 'salida', concepto: 'entrega', fecha, cantidad: series.length, series, empresa_id: 7, empresa: 'ACME', unidad: 'Sucursal Norte', ...o });

test('una serie entra a almacén, se asigna a Empresa/Unidad y luego regresa por devolución de cliente', () => {
  const r = S.estadoSeries([ent('2026-01-01', ['sn1', 'SN2']), sal('2026-01-05', ['sn1']), ent('2026-02-01', ['SN1'], { concepto: 'devolucion_cliente' }), sal('2026-02-10', ['SN1'], { empresa: 'BETA', unidad: 'Matriz', empresa_id: 9 })]);
  assert.deepEqual(r.errores, []);
  const s1 = r.series.get('SN1');
  assert.equal(s1.estado, 'asignada'); assert.equal(s1.empresa, 'BETA'); assert.equal(s1.unidad, 'Matriz'); assert.equal(s1.empresa_id, 9);
  assert.equal(s1.historial.length, 4);
  assert.equal(r.series.get('SN2').estado, 'almacen');
});
test('no se puede entregar una serie que no está en almacén ni una que no existe', () => {
  const r = S.estadoSeries([ent('2026-01-01', ['A1']), sal('2026-01-02', ['A1']), sal('2026-01-03', ['A1'], { unidad: 'Otra' }), sal('2026-01-04', ['ZZ9'])]);
  assert.equal(r.errores.length, 2);
  assert.match(r.errores[0].mensaje, /ya está asignada a ACME \/ Sucursal Norte/); assert.match(r.errores[1].mensaje, /no existe en el inventario/);
});
test('una compra no acepta una serie ya conocida; la devolución de cliente solo series que estuvieron asignadas', () => {
  const dup = S.estadoSeries([ent('2026-01-01', ['A1']), ent('2026-01-02', ['A1'])]);
  assert.match(dup.errores[0].mensaje, /ya está en almacén/);
  const dev = S.estadoSeries([ent('2026-01-01', ['A1']), ent('2026-01-02', ['A1'], { concepto: 'devolucion_cliente' })]);
  assert.match(dev.errores[0].mensaje, /ya está en almacén/);
  const nunca = S.estadoSeries([ent('2026-01-02', ['Q1'], { concepto: 'devolucion_cliente' })]);
  assert.match(nunca.errores[0].mensaje, /nunca estuvo asignada/);
});
test('merma o devolución a proveedor dan de baja la serie; baja no vuelve a entrar como compra', () => {
  const r = S.estadoSeries([ent('2026-01-01', ['A1', 'A2']), sal('2026-01-02', ['A1'], { concepto: 'merma' }), ent('2026-01-03', ['A1'])]);
  assert.equal(r.series.get('A1').estado, 'baja'); assert.match(r.errores[0].mensaje, /ya se dio de baja/);
});
test('una serie repetida dentro del mismo movimiento se marca; el orden por fecha manda sobre el folio', () => {
  assert.match(S.estadoSeries([ent('2026-01-01', ['A1', 'a1'])]).errores[0].mensaje, /repetida/);
  const tarde = [sal('2026-01-05', ['A1']), ent('2026-01-01', ['A1'])];                // la entrada se capturó después pero es anterior
  assert.deepEqual(S.estadoSeries(tarde).errores, []);
});
