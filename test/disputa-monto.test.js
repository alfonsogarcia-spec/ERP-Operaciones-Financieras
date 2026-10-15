/* Pruebas del monto de un caso de disputa. node test/disputa-monto.test.js
   Caso real: un duplicado salía con "Monto: —" en el correo aunque se había capturado. */
'use strict';
const { montoDelCaso } = require('../lib/disputa-monto.js');
const dec = s => (s == null ? null : String(s).replace(/^enc:/, ''));   // "descifrado" de juguete
const out = []; const chk = (d, got, esp) => out.push({ d, got, esp, pass: got === esp });

chk('Duplicado: usa el monto del cobro duplicado (B)', montoDelCaso({ tx_a_monto_cifrado: 'enc:500', tx_b_monto_cifrado: 'enc:500.50' }, dec), 500.5);
chk('Duplicado: si solo se capturó el de A, usa ese', montoDelCaso({ tx_a_monto_cifrado: 'enc:1250' }, dec), 1250);
chk('Duplicado sin monto capturado → null (el correo muestra "—")', montoDelCaso({ tx_a_monto_cifrado: null, tx_b_monto_cifrado: null }, dec), null);
chk('Contracargo: sigue usando disputed_amount_cifrado', montoDelCaso({ disputed_amount_cifrado: 'enc:3000', amount_cifrado: 'enc:1' }, dec), 3000);
chk('Devolución: sigue usando amount_cifrado', montoDelCaso({ amount_cifrado: 'enc:80' }, dec), 80);
chk('Monto ilegible no produce NaN: pasa al siguiente campo', montoDelCaso({ disputed_amount_cifrado: 'enc:abc', tx_b_monto_cifrado: 'enc:99' }, dec), 99);
chk('Monto ilegible y sin respaldo → null', montoDelCaso({ amount_cifrado: 'enc:abc' }, dec), null);
chk('Caso vacío → null', montoDelCaso({}, dec), null);
chk('Monto 0 es un monto válido (no se confunde con "sin monto")', montoDelCaso({ tx_b_monto_cifrado: 'enc:0' }, dec), 0);

let pass = 0; for (const t of out) { console.log((t.pass ? 'PASS  ' : 'FAIL  ') + t.d + (t.pass ? '' : `  → obtenido ${t.got}, esperado ${t.esp}`)); if (t.pass) pass++; }
console.log(`\n${pass}/${out.length} pruebas correctas`); process.exit(pass === out.length ? 0 : 1);
