/* Pruebas del catálogo y validación de MCC. Ejecuta: node test/mcc.test.js */
'use strict';
const M = require('../lib/mcc.js');
const out = []; const chk = (desc, got, esp) => out.push({ desc, got: JSON.stringify(got), esperado: JSON.stringify(esp), pass: JSON.stringify(got) === JSON.stringify(esp) });
chk('vacío = sin MCC', [M.normalizarMcc(''), M.normalizarMcc(null), M.normalizarMcc(undefined), M.normalizarMcc('  ')], [{ ok: true, mcc: null }, { ok: true, mcc: null }, { ok: true, mcc: null }, { ok: true, mcc: null }]);
chk('formato: 1–4 dígitos', [M.normalizarMcc('5812').mcc, M.normalizarMcc(5812).mcc, M.normalizarMcc(' 5541 ').mcc, M.normalizarMcc('742').mcc], [5812, 5812, 5541, 742]);
chk('formato inválido', ['58123', 'abcd', '58a2', '-581', '5812.0', '0', '0000'].map(v => M.normalizarMcc(v).ok), [false, false, false, false, false, false, false]);
chk('catálogo de "BD MCC.xlsx": 41 MCC únicos', [M.CATALOGO.length, new Set(M.CATALOGO.map(x => x.mcc)).size], [41, 41]);
chk('catálogo ordenado y con descripción', [M.CATALOGO.every((x, i, a) => i === 0 || a[i - 1].mcc < x.mcc), M.CATALOGO.every(x => x.descripcion && x.descripcion.length <= 300)], [true, true]);
chk('los MCC de 3 dígitos del archivo (0742, 0763, 0780) están', [742, 763, 780].map(m => M.enCatalogo(m)), [true, true, true]);
chk('pertenencia al catálogo', [M.enCatalogo(5812), M.enCatalogo('5411'), M.enCatalogo(5399), M.enCatalogo(7011), M.enCatalogo(58)], [true, true, true, false, false]);
chk('descripciones del archivo', [M.descripcionDe(5812), M.descripcionDe('4121'), M.descripcionDe(5399), M.descripcionDe(1234)], ['RESTAURANTES CAFETERIAS', 'TAXIS', 'Agregador', null]);
chk('giro: quita controles, espacios dobles y recorta a 300', [M.limpiarGiro('  Rest\u0000au\nrante   casual  '), M.limpiarGiro('x'.repeat(500)).length, M.limpiarGiro(null)], ['Rest au rante casual', 300, '']);
let pass = 0; for (const t of out) { console.log((t.pass ? 'PASS  ' : 'FAIL  ') + t.desc + (t.pass ? '' : `  → obtenido ${t.got}, esperado ${t.esperado}`)); if (t.pass) pass++; }
console.log(`\n${pass}/${out.length} pruebas correctas`); process.exit(pass === out.length ? 0 : 1);
