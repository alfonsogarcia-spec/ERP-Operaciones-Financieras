/* Correo de Cards: cuando el depósito deja un neto distinto del cotizado, las cifras van lado a lado y con nombre propio. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CORREO = require('../lib/cards-correo.js');

const base = { folio: 'FND-2026-000032', empresa_comercial: 'PEDRO CHECA', empresa_nombre: 'INTERCONEXIONES KACHTWROW', ruta: 'INTERCONEXIONES KACHTWROW', solicitante_nombre: 'Fatima Rivas',
  comision_pct: 1.5, iva_pct: 16, ceps: [], notas: null };
const cotizado = { ...base, fondeo: 50576.66, comision: 758.65, iva: 121.38, monto_esperado: 51456.69, fondeo_solicitado: 50576.66, monto_recibido: null };
const conCep = { ...base, fondeo: 50000, comision: 750, iva: 120, monto_esperado: 51456.69, fondeo_solicitado: 50576.66, monto_recibido: 50870 };

test('antes del CEP: se muestra lo cotizado, sin comparación', () => {
  const c = CORREO.armarCorreoFondeo({ tipo: 'por_asignar', fondeo: cotizado, ceps: [] });
  assert.match(c.html, /Total a depositar/);
  assert.doesNotMatch(c.html, /Depositó la empresa/);
});
test('el CEP cambia las cifras: correo «Monto actualizado» con lo solicitado, lo depositado y lo que se asigna', () => {
  const c = CORREO.armarCorreoFondeo({ tipo: 'actualizado', fondeo: conCep, ceps: [], avisos: ['Confirma con el comercial'] });
  assert.match(c.subject, /Monto actualizado/);
  assert.match(c.subject, /\$50,870\.00 depositados/);
  for (const txt of ['Solicitado (neto)', 'A depositar según la solicitud', 'Depositó la empresa (CEP)', 'Diferencia contra lo solicitado', 'Se asigna (neto)']) assert.ok(c.html.includes(txt), txt);
  assert.match(c.html, /−\$576\.66 netos/);
  assert.match(c.html, /REEMPLAZA las cifras del anterior/);
  assert.ok(c.text.includes('Se asigna (neto): $50,000.00'));
});
test('si lo depositado coincide con lo cotizado no aparece la comparación', () => {
  const igual = { ...conCep, fondeo: 50576.66, comision: 758.65, iva: 121.38, monto_recibido: 51456.69 };
  const c = CORREO.armarCorreoFondeo({ tipo: 'por_asignar', fondeo: igual, ceps: [] });
  assert.doesNotMatch(c.html, /Depositó la empresa/);
  assert.match(c.html, /Total recibido/);
});
test('el correo de saldo asignado también deja claro el neto asignado cuando hubo diferencia', () => {
  const c = CORREO.armarCorreoFondeo({ tipo: 'asignado', fondeo: conCep, ceps: [] });
  assert.match(c.html, /Se asigna \(neto\)/);
});
