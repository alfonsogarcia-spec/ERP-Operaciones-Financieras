// El correo del corte mostraba el grupo equivocado cuando una afiliación está en varios grupos.
const test = require('node:test'), assert = require('node:assert/strict');
const { razonDePendiente } = require('../lib/dispersion-pendiente');

const cal = [
  { afil: '9868351', id_grupo: 7, razon: 'GRUPO DG' },
  { afil: '9868351', id_grupo: 12, razon: 'CATEDRALES DEL FUTBOL' },
  { afil: '1111111', id_grupo: 3, razon: 'SOLO UNO' },
];

test('afiliación compartida: usa el grupo del pendiente, no la última fila del corte', () => {
  assert.equal(razonDePendiente({ numero_afiliacion: '9868351', id_grupo: 12, grupo_cliente: 'Catedrales' }, cal), 'CATEDRALES DEL FUTBOL');
  assert.equal(razonDePendiente({ numero_afiliacion: '9868351', id_grupo: 7, grupo_cliente: 'DG' }, cal), 'GRUPO DG');
});
test('el grupo del pendiente no operó en este corte: usa el grupo con el que se registró', () => {
  assert.equal(razonDePendiente({ numero_afiliacion: '9868351', id_grupo: 99, grupo_cliente: 'Otro Grupo' }, cal), 'Otro Grupo');
});
test('pendiente viejo sin id_grupo ni grupo: afiliación única se resuelve, compartida no se adivina', () => {
  assert.equal(razonDePendiente({ numero_afiliacion: '1111111', id_grupo: null, grupo_cliente: null }, cal), 'SOLO UNO');
  assert.equal(razonDePendiente({ numero_afiliacion: '9868351', id_grupo: null, grupo_cliente: null }, cal), '');
});
test('id_grupo llega como texto o número', () => {
  assert.equal(razonDePendiente({ numero_afiliacion: 9868351, id_grupo: '12' }, cal), 'CATEDRALES DEL FUTBOL');
});
