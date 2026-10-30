'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { separarCorreos, MAX_CORREOS } = require('../lib/cards-destinatarios.js');

test('separa por renglones, comas, punto y coma y espacios', () => {
  const r = separarCorreos('ana@x.com\nbeto@x.com, carla@x.com; dani@x.com  eva@x.com\r\nfer@x.com');
  assert.deepEqual(r.validos.map(v => v.email), ['ana@x.com', 'beto@x.com', 'carla@x.com', 'dani@x.com', 'eva@x.com', 'fer@x.com']);
  assert.equal(r.invalidos.length, 0);
});

test('lee «Nombre <correo>» y «Nombre correo»', () => {
  const r = separarCorreos('Daniela Ruiz <Daniela@X.com>\n"Pérez, Juan" <juan@x.com>\nLuis Soto luis@x.com');
  assert.deepEqual(r.validos.map(v => [v.email, v.nombre]), [['daniela@x.com', 'Daniela Ruiz'], ['juan@x.com', 'Pérez Juan'], ['luis@x.com', 'Luis Soto']]);
  assert.equal(r.invalidos.length, 0);
});

test('quita repetidos (sin importar mayúsculas) y marca los inválidos', () => {
  const r = separarCorreos('ana@x.com, ANA@x.com, sin-arroba, otro@, @x.com, bien@x.com');
  assert.deepEqual(r.validos.map(v => v.email), ['ana@x.com', 'bien@x.com']);
  assert.equal(r.repetidosEnTexto, 1);
  assert.deepEqual(r.invalidos, ['sin-arroba', 'otro@', '@x.com']);
});

test('texto vacío o nulo no da nada y se topa en el máximo', () => {
  assert.equal(separarCorreos('').validos.length, 0);
  assert.equal(separarCorreos(null).validos.length, 0);
  const muchos = Array.from({ length: MAX_CORREOS + 1 }, (_, i) => `u${i}@x.com`).join('\n');
  assert.equal(separarCorreos(muchos).excede, true);
  assert.equal(separarCorreos(muchos.split('\n').slice(0, MAX_CORREOS).join('\n')).excede, false);
});
