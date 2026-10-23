// CEP de fondeos: solo PDF / XML / PNG / JPG reales (se revisa el contenido, no solo la extensión).
const test = require('node:test'), assert = require('node:assert/strict');
const { tipoCep } = require('../lib/cards-routes');

const b = s => Buffer.from(s, 'latin1');
test('PDF y XML válidos', () => {
  assert.equal(tipoCep(b('%PDF-1.7\n...'), 'CEP.pdf'), 'application/pdf');
  assert.equal(tipoCep(b('<?xml version="1.0"?><SPEI/>'), 'cep.XML'), 'application/xml');
  assert.equal(tipoCep(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b('  <SPEI/>')]), 'cep.xml'), 'application/xml');
});
test('imágenes por firma', () => {
  assert.equal(tipoCep(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'cep.png'), 'image/png');
  assert.equal(tipoCep(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), 'cep.jpg'), 'image/jpeg');
  assert.equal(tipoCep(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), 'cep.jpeg'), 'image/jpeg');
});
test('se rechaza lo que no coincide con su extensión o no es CEP', () => {
  assert.equal(tipoCep(b('MZ-ejecutable'), 'cep.pdf'), null);
  assert.equal(tipoCep(b('%PDF-1.4'), 'cep.xml'), null);
  assert.equal(tipoCep(b('hola'), 'cep.xml'), null);
  assert.equal(tipoCep(b('%PDF-1.4'), 'cep.exe'), null);
  assert.equal(tipoCep(b('%PDF-1.4'), 'sin_extension'), null);
});
