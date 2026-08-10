/* ============================================================================
   test/crypto.test.js — Tests unitarios de lib/crypto.js
   Ejecuta: node test/crypto.test.js
   ========================================================================= */
'use strict';
const crypto = require('crypto');

// Fijamos llaves antes de requerir el módulo (crypto.js lee env al cargar).
process.env.ENCRYPTION_KEY_V1 = crypto.randomBytes(32).toString('hex');
process.env.HMAC_PEPPER = crypto.randomBytes(32).toString('hex');

const C = require('../lib/crypto.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, 'got:', got); }
}
function throws(name, fn) {
  try { fn(); fail++; console.log('FAIL', name, 'no lanzó'); }
  catch (_) { pass++; console.log('PASS', name); }
}

/* ---------- ready() ---------- */
ok('ready() true cuando hay key + pepper', C.ready() === true);

/* ---------- encrypt / decrypt (roundtrip) ---------- */
const plain = 'CLABE 012180001234567890';
const ct = C.encrypt(plain);
ok('encrypt devuelve string versionado', typeof ct === 'string' && ct.startsWith('v1:'), ct);
ok('encrypt tiene 4 secciones separadas por :', ct.split(':').length === 4);
ok('decrypt recupera el original', C.decryptString(ct) === plain, C.decryptString(ct));

/* ---------- IVs distintos (misma entrada → cifrado distinto) ---------- */
const c1 = C.encrypt('same input'), c2 = C.encrypt('same input');
ok('mismo texto → cifrados distintos (IV random)', c1 !== c2);
ok('ambos descifran al mismo original', C.decryptString(c1) === 'same input' && C.decryptString(c2) === 'same input');

/* ---------- Detección de manipulación (GCM tag) ---------- */
throws('ciphertext modificado → falla decrypt', () => {
  const parts = ct.split(':');
  // corrompemos el ciphertext: cambiamos primer char del ct base64
  const bad = parts[0] + ':' + parts[1] + ':A' + parts[2].slice(1) + ':' + parts[3];
  C.decrypt(bad);
});
throws('tag modificado → falla decrypt', () => {
  const parts = ct.split(':');
  const bad = parts[0] + ':' + parts[1] + ':' + parts[2] + ':A' + parts[3].slice(1);
  C.decrypt(bad);
});

/* ---------- null / vacío ---------- */
ok('encrypt(null) → null', C.encrypt(null) === null);
ok('encrypt("") → null', C.encrypt('') === null);
ok('decryptString(null) → null', C.decryptString(null) === null);

/* ---------- Buffers (para archivo_bytes) ---------- */
const bin = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0xFF, 0x00, 0x11]);
const encBin = C.encrypt(bin);
const dec = C.decrypt(encBin);
ok('encrypt/decrypt Buffer preserva bytes', Buffer.isBuffer(dec) && Buffer.compare(dec, bin) === 0);
ok('archivo con magic ZIP se recupera intacto', dec[0] === 0x50 && dec[1] === 0x4B && dec[2] === 0x03 && dec[3] === 0x04);

/* ---------- HMAC determinístico + normalización email ---------- */
const h1 = C.hmacEmail('Alfonso.Garcia@POLIPAY.io');
const h2 = C.hmacEmail(' alfonso.garcia@polipay.io ');
const h3 = C.hmacEmail('alfonso.garcia@polipay.io');
ok('hmacEmail normaliza (case + trim)', h1 === h2 && h2 === h3, {h1, h2, h3});
ok('hmac formato hm1:...', h1.startsWith('hm1:') && h1.length === 4 + 64);
const hDif = C.hmacEmail('otro@polipay.io');
ok('emails distintos → hashes distintos', h1 !== hDif);

/* ---------- Peppers distintos → hashes distintos ---------- */
// Cambio de pepper en runtime no aplica (se lee al require), pero verifiquemos que
// dos entradas distintas dan hashes distintos aunque compartan prefijo.
ok('hash es determinístico', C.hmacEmail('x@y.io') === C.hmacEmail('x@y.io'));

/* ---------- Resumen ---------- */
console.log(`\n${pass}/${pass + fail} pruebas de crypto correctas`);
process.exit(fail === 0 ? 0 : 1);
