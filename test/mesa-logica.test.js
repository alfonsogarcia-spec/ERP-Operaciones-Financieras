/* Mesa de control (Credit Solvendom): flujo, motor de decisión, PLD y roles. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/mesa/flujo.js');
const M = require('../lib/mesa/motor.js');
const P = require('../lib/mesa/pld.js');
const R = require('../lib/mesa/roles.js');

test('flujo: acciones válidas por estado y niveles de firma por monto y riesgo', () => {
  assert.ok(F.accionValida('borrador', 'enviar') && F.accionValida('devuelta', 'enviar'));
  assert.ok(!F.accionValida('autorizada', 'rechazar') && !F.accionValida('decision', 'enviar') && !F.accionValida('borrador', 'autorizar'));
  const fac = { limite_mesa: 250000 };
  assert.deepEqual(F.nivelesRequeridos(100000, 'bajo', fac), ['mesa']);
  assert.deepEqual(F.nivelesRequeridos(300000, 'medio', fac), ['mesa', 'comite']);
  assert.deepEqual(F.nivelesRequeridos(300000, 'alto', fac), ['cumplimiento', 'mesa', 'comite']);
  assert.equal(F.nivelPendiente(['cumplimiento', 'mesa'], ['cumplimiento']), 'mesa');
  assert.equal(F.nivelPendiente(['mesa'], ['mesa']), null);
  assert.equal(F.semaforo(1, 2), 'ok'); assert.equal(F.semaforo(2, 2), 'alerta'); assert.equal(F.semaforo(3, 2), 'vencido');
});

test('motor: cuota francesa y su caso sin interés', () => {
  const c = M.cuota(120000, 0.36, 12, 'mensual');
  assert.equal(c.periodos, 12);
  assert.ok(c.cuota > 11900 && c.cuota < 12200, 'cuota ≈ 12,057');
  assert.equal(c.mensualizada, c.cuota);
  assert.equal(M.cuota(12000, 0, 12, 'mensual').cuota, 1000);
  assert.equal(M.cuota(52000, 0, 12, 'semanal').periodos, 52);
});

const base = () => ({
  monto: 100000, plazo_meses: 12, periodicidad: 'mensual', tasa_anual: 0.36,
  producto: { monto_min: 10000, monto_max: 500000, plazo_min: 3, plazo_max: 36 },
  solicitante: { tipo: 'moral', antiguedad_meses: 48, ingresos_mensuales: 120000, egresos_mensuales: 50000, otras_deudas_mensuales: 5000, score_buro: 690, pep: false },
  docs: { faltantes: [] }, pld: { pendientes: 0, confirmadas: 0, riesgo: 'bajo', consultado: true },
});

test('motor: solicitud sana → aprobar; cada incumplimiento cambia la recomendación', () => {
  assert.equal(M.evaluar(base()).recomendacion, 'aprobar');
  let e = base(); e.solicitante.score_buro = 580;
  assert.equal(M.evaluar(e).recomendacion, 'revision');
  e = base(); e.solicitante.score_buro = 500;
  assert.equal(M.evaluar(e).recomendacion, 'rechazar');
  e = base(); e.solicitante.ingresos_mensuales = 20000;                    // el pago ahoga el ingreso
  assert.equal(M.evaluar(e).recomendacion, 'rechazar');
  e = base(); e.monto = 900000;                                            // fuera del rango del producto
  assert.equal(M.evaluar(e).recomendacion, 'rechazar');
  e = base(); e.docs.faltantes = ['Identificación'];
  assert.equal(M.evaluar(e).recomendacion, 'incompleta');
  e = base(); e.pld.confirmadas = 1;
  assert.equal(M.evaluar(e).recomendacion, 'rechazar');
  e = base(); e.pld.pendientes = 1;
  assert.equal(M.evaluar(e).recomendacion, 'incompleta');
  e = base(); e.pld.riesgo = 'alto';
  assert.equal(M.evaluar(e).recomendacion, 'revision');
  e = base(); e.solicitante.score_buro = null;
  assert.equal(M.evaluar(e).recomendacion, 'revision', 'sin score: revisión manual');
});

test('motor: persona física valida edad al vencimiento; la huella cambia con los datos', () => {
  const e = base(); e.solicitante.tipo = 'fisica'; e.solicitante.edad = 74; e.plazo_meses = 24;
  assert.equal(M.evaluar(e).reglas.find(r => r.id === 'edad').resultado, 'rechazo');
  e.solicitante.edad = 40;
  assert.equal(M.evaluar(e).reglas.find(r => r.id === 'edad').resultado, 'cumple');
  const a = M.evaluar(base()).huella, b = M.evaluar({ ...base(), monto: 100001 }).huella;
  assert.notEqual(a, b);
  assert.equal(M.evaluar(base()).huella, a, 'misma entrada → misma huella');
  assert.equal(M.edadAl('1990-06-15', '2026-06-14'), 35); assert.equal(M.edadAl('1990-06-15', '2026-06-15'), 36);
});

test('pld: nombres con acentos, orden y sufijos; RFC exacto; riesgo por factores', () => {
  assert.equal(P.normalizar('José  de Jesús Pérez, S.A. de C.V.'), 'JOSE DE JESUS PEREZ S A DE C V');
  assert.ok(P.similitud('Jose de Jesus Perez Lopez', 'PEREZ LOPEZ JOSE JESUS') >= 0.99);
  assert.ok(P.similitud('Comercializadora Aurora SA de CV', 'Comercializadora Aurora') >= 0.99);
  assert.ok(P.similitud('Maria Gonzalez', 'Pedro Ramirez') < 0.3);
  const lista = [{ id: 1, fuente: 'UIF', nombre: 'JUAN CARLOS EJEMPLO ROBLES', rfc: 'EJRJ800101ABC' }, { id: 2, fuente: 'OFAC', nombre: 'OTRA PERSONA DISTINTA' }];
  const c = P.buscarCoincidencias({ nombre: 'Juan Carlos Ejemplo Robles', rfc: '' }, lista);
  assert.equal(c.length, 1); assert.equal(c[0].nivel, 'alta');
  const porRfc = P.buscarCoincidencias({ nombre: 'Nombre Distinto Total', rfc: 'ejrj800101abc' }, lista);
  assert.equal(porRfc[0].motivo, 'RFC idéntico');
  const parecido = P.buscarCoincidencias({ nombre: 'Juan Carlos Ejemplo', rfc: '' }, lista);
  assert.ok(parecido.length === 1 && ['alta', 'posible'].includes(parecido[0].nivel));
  assert.equal(P.buscarCoincidencias({ nombre: 'Persona Sin Relacion Alguna', rfc: '' }, lista).length, 0);
  assert.equal(P.riesgo({ tipo: 'fisica', monto: 100000, origen_recursos: 'Ventas' }).nivel, 'bajo');
  const alto = P.riesgo({ tipo: 'moral', monto: 3000000, pep: true, actividad: 'Casa de cambio', origen_recursos: '' });
  assert.equal(alto.nivel, 'alto'); assert.ok(alto.factores.length >= 4);
});

test('roles: cada rol solo hace lo suyo', () => {
  assert.ok(R.puede('admin', 'comite') && R.puede('admin', 'administrar'));
  assert.ok(R.puede('ejecutivo', 'crear') && !R.puede('ejecutivo', 'autorizar') && !R.puede('ejecutivo', 'ver_todas'));
  assert.ok(R.puede('mesa', 'autorizar') && !R.puede('mesa', 'comite') && !R.puede('mesa', 'validar_docs'));
  assert.ok(R.puede('cumplimiento', 'pld_revisar') && !R.puede('analista', 'pld_revisar'));
  assert.ok(!R.puede('consulta', 'crear') && R.puede('consulta', 'ver_todas'));
  assert.equal(R.puede('inexistente', 'crear'), false);
});
