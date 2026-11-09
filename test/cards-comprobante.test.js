'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CMP = require('../lib/cards-comprobante.js');

const L = (montos, extra) => ({ formato: 'pdf', legible: montos.length > 0, montos, texto: '', ...(extra || {}) });
const IMG = { formato: 'imagen', legible: false, montos: [], texto: '', aviso: 'Las imágenes no se leen automáticamente.' };

test('montosDeTexto: importes con $, comas y decimales; ignora fechas, folios y CLABE', () => {
  const m = CMP.montosDeTexto('Saldo asignado: $300,000.00 el 09/11/2026 folio 20261109 CLABE 012180001234567890 comisión 1,500.5 IVA 240.00 total 300000.00 pesos $ 5000');
  assert.deepStrictEqual(m, [300000, 1500.5, 240, 300000, 5000]);
  assert.deepStrictEqual(CMP.montosDeTexto('sin importes 2026-11-09 ref 12345'), []);
});

test('el monto calculado aparece en el archivo → validado por lectura', () => {
  const r = CMP.evaluarComprobante(L([1500, 300000]), { esperado: 300000 });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.origen, 'lectura'); assert.strictEqual(r.monto, 300000);
  assert.strictEqual(r.checks[0].estado, 'ok');
});

test('tolera un centavo de diferencia, no más', () => {
  assert.strictEqual(CMP.evaluarComprobante(L([300000.01]), { esperado: 300000 }).ok, true);
  assert.strictEqual(CMP.evaluarComprobante(L([300000.02]), { esperado: 300000 }).ok, false);
});

test('importes leídos pero ninguno es el calculado → rechaza y lista lo que trae', () => {
  const r = CMP.evaluarComprobante(L([250000, 1500]), { esperado: 300000 });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'monto_no_coincide');
  assert.match(r.mensaje, /250,000\.00/); assert.match(r.mensaje, /300,000\.00/);
  assert.strictEqual(r.checks[0].estado, 'difiere');
});

test('si trae el total depositado (con comisión e IVA) lo explica', () => {
  const r = CMP.evaluarComprobante(L([301740]), { esperado: 300000, recibido: 301740 });
  assert.strictEqual(r.ok, false); assert.match(r.mensaje, /total depositado/);
});

test('captura/imagen: sin monto capturado pide capturarlo; con monto debe coincidir', () => {
  assert.strictEqual(CMP.evaluarComprobante(IMG, { esperado: 300000 }).codigo, 'monto_requerido');
  assert.strictEqual(CMP.evaluarComprobante(IMG, { esperado: 300000, capturado: 'abc' }).codigo, 'monto_requerido');
  assert.strictEqual(CMP.evaluarComprobante(IMG, { esperado: 300000, capturado: '0' }).codigo, 'monto_invalido');
  assert.strictEqual(CMP.evaluarComprobante(IMG, { esperado: 300000, capturado: '299,999.98' }).codigo, 'monto_no_coincide');
  const ok = CMP.evaluarComprobante(IMG, { esperado: 300000, capturado: '$300,000.00' });
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.origen, 'captura');
});

test('PDF/Excel sin importes legibles cae a captura manual', () => {
  const r = CMP.evaluarComprobante({ formato: 'pdf', legible: false, montos: [], texto: '', aviso: 'El PDF no trae texto legible.' }, { esperado: 100 });
  assert.strictEqual(r.codigo, 'monto_requerido'); assert.match(r.mensaje, /PDF no trae texto/);
});

test('un archivo legible que no trae el monto NO se puede forzar con una captura', () => {
  const r = CMP.evaluarComprobante(L([250000]), { esperado: 300000, capturado: '300000' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'monto_no_coincide');
});

test('mencionaDestino: nombre de la entidad/empresa, correo del usuario o CLABE', () => {
  const t = 'RESUMEN ACME DEMO SA DE CV JUAN.PEREZ@ACME.COM';
  assert.strictEqual(CMP.mencionaDestino(t, { empresa_nombre: 'Acme Demo SA de CV' }), true);
  assert.strictEqual(CMP.mencionaDestino(t, { correo_usuario: 'juan.perez@acme.com' }), true);
  assert.strictEqual(CMP.mencionaDestino(t, { empresa_nombre: 'Otra Empresa' }), false);
  assert.strictEqual(CMP.mencionaDestino('', { empresa_nombre: 'Acme' }), null);
});
