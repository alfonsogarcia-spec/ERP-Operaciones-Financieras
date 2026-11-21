/* Conciliar contra un layout ya dispersado: lo que no aparece en el archivo es lo que NO se dispersó. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LD = require('../lib/layout-dispersado.js');

const HEAD = ['Concepto', 'Cuenta clabe del beneficiario', 'Código del banco del beneficiario', 'Nombre del beneficiario', 'RFC o CURP del beneficiario', 'Cantidad', 'Referencia numérica', 'Fecha de pago'];

test('filasDeHoja: encuentra el encabezado bajo una banda, lee CLABE numérica e importes con formato', () => {
  const aoa = [['POLIPAY'], [], HEAD,
    ['DISPERSION 357CPPX009902', 684180297001150008, 90684, 'ZZ', '', 176564.62, 1201126, ''],
    ['DISPERSION 357CPPX009902', '659422004000000006', 90659, 'Sucursal X', '', '$3,437.68', 1201126, ''],
    ['', '', '', '', '', '', '', '']];
  const f = LD.filasDeHoja(aoa);
  assert.equal(f.length, 2);
  assert.deepEqual(f.map(x => [x.clabe.slice(0, 15), x.cents]), [['684180297001150', 17656462], ['659422004000000', 343768]]);
  assert.equal(LD.filasDeHoja([['a', 'b'], [1, 2]]), null);
  // la CLABE guardada como número pierde los últimos dígitos en Excel: aun así cruza con la orden del corte
  const r = LD.conciliar([{ clave: 'x', clabe: '684180297001150008', cant: 176564.62, concepto: '' }], f.slice(0, 1));
  assert.equal(r.resultado[0].dispersado, true);
});

test('conciliar: lo que no aparece es NO dispersado; cada fila del archivo salda una sola orden', () => {
  const esperadas = [
    { clave: 'a', clabe: '659422004000000006', cant: 3437.68, concepto: 'DISPERSION 357CPPX009902' },
    { clave: 'b', clabe: '684180297001150008', cant: 176564.62, concepto: 'DISPERSION 357CPPX009902' },
    { clave: 'c', clabe: '684180297001150008', cant: 176564.62, concepto: 'DISPERSION 357CPPX009902' },  // misma CLABE e importe, otra orden (p. ej. recuperación)
    { clave: 'd', clabe: '111111111111111111', cant: 50, concepto: 'X' },
    { clave: 'e', clabe: '222222222222222222', cant: 80, concepto: 'X' }];
  const filas = [
    { clabe: '684180297001150008', cents: 17656462, concepto: 'dispersion 357cppx009902' },
    { clabe: '659422004000000006', cents: 343768, concepto: 'dispersion 357cppx009902' },
    { clabe: '222222222222222222', cents: 7000, concepto: 'x' },       // misma CLABE que e pero otro importe
    { clabe: '999999999999999999', cents: 100, concepto: 'x' }];       // no corresponde a nada
  const r = LD.conciliar(esperadas, filas);
  assert.deepEqual(r.resultado.map(x => [x.clave, x.dispersado]), [['a', true], ['b', true], ['c', false], ['d', false], ['e', false]]);
  assert.equal(r.sobrantes.length, 2);
  assert.deepEqual(r.distintas.map(d => [d.clave, d.en_archivo]), [['e', [70]]]);
});
