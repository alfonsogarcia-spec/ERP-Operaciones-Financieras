/* Mesa de control: tabla de amortización, CAT y estado de un crédito (pagos, moratorios, atraso). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/mesa/amortiza.js');

const base = { monto: 120000, tasaAnual: 0.36, plazoMeses: 12, periodicidad: 'mensual', fechaDesembolso: '2026-01-31', ivaPct: 0.16 };
const mk = () => ({ filas: A.tabla(base), tasaMor: 0.72, ivaPct: 0.16, fechaDesembolso: base.fechaDesembolso });

test('fechas: mensual ajusta al fin de mes; quincenal y semanal por días', () => {
  assert.equal(A.fechaPago('2026-01-31', 'mensual', 1), '2026-02-28');
  assert.equal(A.fechaPago('2026-01-31', 'mensual', 2), '2026-03-31');
  assert.equal(A.fechaPago('2026-01-31', 'mensual', 12), '2027-01-31');
  assert.equal(A.fechaPago('2026-01-01', 'quincenal', 2), '2026-01-31');
  assert.equal(A.fechaPago('2026-01-01', 'semanal', 3), '2026-01-22');
});

test('tabla: capital suma el monto, el saldo termina en cero y el IVA va sobre el interés', () => {
  const t = A.tabla(base);
  assert.equal(t.length, 12);
  assert.equal(A.r2(t.reduce((s, f) => s + f.capital, 0)), 120000);
  assert.equal(t[11].saldo, 0);
  assert.equal(t[0].iva, A.r2(t[0].interes * 0.16));
  assert.ok(Math.abs((t[0].capital + t[0].interes) - (t[5].capital + t[5].interes)) < 0.05, 'cuota fija (capital + interés)');
  assert.equal(A.tabla({ ...base, tasaAnual: 0, plazoMeses: 4 }).map(f => f.capital).join(), '30000,30000,30000,30000');
  assert.equal(A.tabla({ ...base, periodicidad: 'quincenal' }).length, 24);
});

test('CAT: mayor que la tasa nominal con comisión y 0 sin costo', () => {
  const t = A.tabla(base);
  const sinCom = A.cat(120000, 0, t, base.fechaDesembolso), conCom = A.cat(120000, 2400, t, base.fechaDesembolso);
  assert.ok(sinCom > 0.36 && sinCom < 0.5, 'CAT sin comisión ≈ tasa efectiva: ' + sinCom);
  assert.ok(conCom > sinCom, 'la comisión sube el CAT');
  assert.equal(A.cat(1000, 0, A.tabla({ ...base, monto: 1000, tasaAnual: 0 }), base.fechaDesembolso), 0);
});

test('estado: sin pagos, a tiempo, nada vencido; vencida una cuota, corre atraso y moratorios con IVA', () => {
  const c = mk();
  let e = A.estado(c, [], '2026-02-15');
  assert.equal(e.diasAtraso, 0); assert.equal(e.vencido.total, 0); assert.equal(e.saldoCapital, 120000); assert.equal(e.proximo.num, 1); assert.equal(e.bucket, 'al_corriente');
  e = A.estado(c, [], '2026-03-10');                                        // la cuota 1 venció el 28/feb: 10 días de atraso
  assert.equal(e.diasAtraso, 10); assert.equal(e.cuotasVencidas, 1); assert.equal(e.bucket, '1-30');
  const cap1 = c.filas[0].capital;
  assert.equal(e.moratorios, A.r2(cap1 * 0.72 / 360 * 10), 'moratorio = capital vencido × tasa/360 × días');
  assert.equal(e.ivaMoratorios, A.r2(e.moratorios * 0.16));
  assert.equal(e.vencido.total, A.r2(c.filas[0].total + e.moratorios + e.ivaMoratorios));
  const e2 = A.estado(c, [], '2026-06-30'); assert.equal(e2.bucket, '91+'); assert.ok(e2.diasAtraso > 90);
});

test('estado: pago exacto de la cuota la deja pagada; el orden es moratorios → interés → IVA → capital', () => {
  const c = mk(), f1 = c.filas[0];
  let e = A.estado(c, [{ id: 1, fecha: '2026-02-28', monto: f1.total }], '2026-03-01');
  assert.equal(e.filas[0].pagada, true); assert.equal(e.diasAtraso, 0); assert.equal(e.moratorios, 0);
  assert.equal(e.saldoCapital, A.r2(120000 - f1.capital));
  // pago tarde de la cuota 1 el 10/mar: primero paga moratorios, luego queda parte de la cuota
  const e10 = A.estado(c, [], '2026-03-10'), mor = e10.moratorios + e10.ivaMoratorios;
  e = A.estado(c, [{ id: 1, fecha: '2026-03-10', monto: A.r2(mor + f1.interes) }], '2026-03-10');
  assert.equal(e.moratorios, 0); assert.equal(e.filas[0].pInt, 0, 'cubrió moratorios e interés'); assert.equal(e.filas[0].pIva, f1.iva); assert.equal(e.filas[0].pCap, f1.capital);
  assert.equal(e.aplicaciones[0].mor, e10.moratorios);
});

test('estado: pago que sobra adelanta cuotas; pago total deja el crédito liquidado', () => {
  const c = mk(), f = c.filas;
  let e = A.estado(c, [{ id: 1, fecha: '2026-02-28', monto: A.r2(f[0].total + f[1].total) }], '2026-03-01');
  assert.equal(e.filas[1].pagada, true); assert.equal(e.aplicaciones[0].adelanto, f[1].total); assert.equal(e.proximo.num, 3);
  const todo = f.reduce((s, x) => s + x.total, 0);
  e = A.estado(c, f.map((x, i) => ({ id: i + 1, fecha: x.fecha, monto: x.total })), '2027-02-01');
  assert.equal(e.liquidado, true); assert.equal(e.saldoCapital, 0); assert.equal(e.pagado, A.r2(todo)); assert.equal(e.proximo, null);
  assert.equal(A.estado(c, [], '2026-03-10').liquidado, false);
});

test('estado: pagos fuera de orden o después del corte no cuentan; la estimación sube con el atraso', () => {
  const c = mk();
  const e = A.estado(c, [{ id: 2, fecha: '2026-05-01', monto: 50000 }, { id: 1, fecha: '2026-02-28', monto: c.filas[0].total }], '2026-03-15');
  assert.equal(e.aplicaciones.length, 1, 'el pago de mayo es posterior al corte');
  assert.equal(A.bucket(0), 'al_corriente'); assert.equal(A.bucket(45), '31-60'); assert.equal(A.bucket(120), '91+');
  assert.equal(A.estimacion(100000, 0), 1000); assert.equal(A.estimacion(100000, 120), 100000);
  assert.ok(A.estimacion(100000, 20) < A.estimacion(100000, 50));
});
