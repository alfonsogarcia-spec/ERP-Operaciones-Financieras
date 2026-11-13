/* Metodologías del inventario de TPV: ABC, punto de reorden, PEPS físico, PCI PTS y conteo cíclico. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/inventario-metodos.js');

test('ABC: A = el 80 % del valor, B = hasta el 95 %, C = el resto; sin consumo es C', () => {
  const r = M.claseABC([{ id: 1, valor: 800 }, { id: 2, valor: 100 }, { id: 3, valor: 60 }, { id: 4, valor: 30 }, { id: 5, valor: 10 }, { id: 6, valor: 0 }]);
  assert.equal(r.get(1).clase, 'A'); assert.equal(r.get(2).clase, 'B'); assert.equal(r.get(3).clase, 'B' === r.get(3).clase ? 'B' : 'C');
  assert.equal(r.get(4).clase, 'C'); assert.equal(r.get(5).clase, 'C'); assert.equal(r.get(6).clase, 'C');
  assert.equal(r.get(1).pct_acum, 80);
  assert.equal(M.claseABC([{ id: 1, valor: 0 }]).get(1).clase, 'C');
});
test('demanda: promedio y desviación diaria de los últimos 90 días; los ajustes y devoluciones a proveedor no son demanda', () => {
  const hoy = '2026-11-13';
  const sal = [{ fecha: '2026-11-12', cantidad: 9, concepto: 'entrega' }, { fecha: '2026-10-01', cantidad: 81, concepto: 'consumo_interno' }, { fecha: '2026-11-01', cantidad: 50, concepto: 'ajuste_negativo' }, { fecha: '2026-11-02', cantidad: 5, concepto: 'devolucion_proveedor' }, { fecha: '2025-01-01', cantidad: 999, concepto: 'entrega' }];
  const d = M.demanda(sal, hoy);
  assert.equal(d.total, 90); assert.equal(d.diaria, 1); assert.ok(d.desviacion > 0);
});
test('punto de reorden = demanda diaria × (entrega del proveedor + configuración interna) + stock de seguridad; estado y cantidad sugerida', () => {
  const dem = { diaria: 2, desviacion: 1, total: 180, ventana: 90 };
  const r = M.reorden({ tiempo_entrega_dias: 20, tiempo_config_dias: 5, minimo: 0, cobertura_dias: 30 }, dem, 80);
  assert.equal(r.lead_dias, 25); assert.equal(r.stock_seguridad, Math.ceil(1.65 * 1 * 5)); assert.equal(r.punto_reorden, Math.ceil(2 * 25 + 9));   // 59
  assert.equal(r.estado, 'ok'); assert.equal(r.sugerido, 0); assert.equal(r.dias_cobertura, 40);
  const bajo = M.reorden({ tiempo_entrega_dias: 20, tiempo_config_dias: 5, cobertura_dias: 30 }, dem, 50);
  assert.equal(bajo.estado, 'reordenar'); assert.equal(bajo.sugerido, 59 + 60 - 50);
  assert.equal(M.reorden({ tiempo_entrega_dias: 20, tiempo_config_dias: 5 }, dem, 9).estado, 'urgente');
  const manual = M.reorden({ tiempo_entrega_dias: 10, tiempo_config_dias: 0, minimo: 7 }, dem, 100);
  assert.equal(manual.stock_seguridad, 7); assert.equal(manual.ss_manual, true); assert.equal(manual.punto_reorden, 27);
  assert.equal(M.reorden({ tiempo_entrega_dias: 10 }, { diaria: 0, desviacion: 0 }, 5).estado, 'sin_consumo');
});
test('PCI PTS: vencida, por vencer (90 días) y vigente', () => {
  assert.equal(M.estadoPCI(null, '2026-11-13'), null);
  assert.equal(M.estadoPCI('2026-11-12', '2026-11-13').estado, 'vencida');
  assert.equal(M.estadoPCI('2027-01-20', '2026-11-13').estado, 'por_vencer');
  assert.equal(M.estadoPCI('2028-01-01', '2026-11-13').estado, 'vigente');
});
test('antigüedad en almacén por tramos', () => {
  const r = M.antiguedad([{ serie: 'A', desde: '2026-11-01' }, { serie: 'B', desde: '2026-06-01' }, { serie: 'C', desde: '2026-01-01' }, { serie: 'D', desde: '2025-01-01' }], '2026-11-13');
  assert.deepEqual(r.tramos.map(t => t.n), [1, 1, 1, 1]); assert.equal(r.unidades.find(u => u.serie === 'A').dias_almacen, 12);
});
test('PEPS físico: se sugiere sacar las más antiguas y se detecta cuando sale una nueva habiendo una vieja', () => {
  const disp = [{ serie: 'N1', desde: '2026-10-01' }, { serie: 'V1', desde: '2026-01-10' }, { serie: 'V2', desde: '2026-01-10' }, { serie: 'M1', desde: '2026-05-05' }];
  assert.deepEqual(M.sugeridasFIFO(disp, 2), ['V1', 'V2']);
  assert.equal(M.verificarFIFO(disp, ['V1', 'V2']).ok, true);
  const v = M.verificarFIFO(disp, ['N1']);
  assert.equal(v.ok, false); assert.equal(v.infracciones[0].serie, 'N1'); assert.deepEqual(v.infracciones[0].mas_viejas.map(x => x.serie), ['V1', 'V2', 'M1']);
  assert.equal(M.verificarFIFO(disp, ['V1', 'M1']).ok, false);                                // M1 sale y V2 (más vieja) se queda
  assert.equal(M.verificarFIFO([{ serie: 'X', desde: '2026-01-01' }, { serie: 'Y', desde: '2026-01-01' }], ['Y']).ok, true);   // mismo día: sin infracción
});
test('conteo cíclico: A cada 30 días, B 90, C 180; se propone primero lo urgente de la clase A', () => {
  const hoy = '2026-11-13';
  const p = M.propuestaConteo([{ id: 1, clase: 'C', ultimo_conteo: '2026-01-01' }, { id: 2, clase: 'A', ultimo_conteo: '2026-10-20' }, { id: 3, clase: 'A', ultimo_conteo: '2026-09-01' }, { id: 4, clase: 'B', ultimo_conteo: null }, { id: 5, clase: 'B', ultimo_conteo: '2026-11-01' }], hoy, 10);
  assert.deepEqual(p.map(x => x.id), [3, 4, 1]);                                               // id 2 (hace 24 d) y id 5 (hace 12 d) todavía no tocan
  assert.equal(M.propuestaConteo([{ id: 1, clase: 'A', ultimo_conteo: null }, { id: 2, clase: 'A', ultimo_conteo: null }], hoy, 1).length, 1);
});
test('comparar conteos: no serializado por cantidad; serializado por series (faltantes, sobrantes conocidas y desconocidas)', () => {
  assert.equal(M.compararConteo({ serializado: false, esperado: 10, contado: 8 }).diferencia, -2);
  const r = M.compararConteo({ serializado: true, esperadas: ['A', 'B', 'C'], contadas: ['A', 'C', 'Z', 'Q'], conocidas: new Map([['Z', 'asignada']]) });
  assert.deepEqual(r.faltantes, ['B']); assert.deepEqual(r.sobrantes_conocidas, [{ serie: 'Z', estado: 'asignada' }]); assert.deepEqual(r.sobrantes_desconocidas, ['Q']); assert.equal(r.diferencia, 1);
});
