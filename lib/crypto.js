/* ============================================================================
   lib/crypto.js — Cifrado app-layer para columnas sensibles.

   • Cifrado reversible: AES-256-GCM. Formato de salida:
       "v{N}:{iv_b64}:{ciphertext_b64}:{tag_b64}"
     - v{N}: versión de llave (permite rotación sin downtime).
     - iv: 12 bytes aleatorio por operación (crítico para GCM).
     - tag: 16 bytes de autenticación (detecta manipulación).

   • Hash determinístico: HMAC-SHA256 con pepper.
     Formato: "hm1:{hash_hex}" — versionado también para poder rotar el pepper.
     Se usa para columnas que necesitan lookup por igualdad (ej. usuarios.email
     en el login) sin exponer el valor original.

   • Llaves por env var:
       ENCRYPTION_KEY_V1 = 32 bytes hex (64 chars)
       HMAC_PEPPER       = 32 bytes hex (recomendado)
     Si faltan, el módulo NO cifra: pasa el valor original con prefijo "plain:"
     para evitar corromper datos si alguien arranca el server mal configurado.
     En arranque, server.js debe llamar assertReady() para abortar si faltan
     llaves en producción.

   • Rotación: agregar ENCRYPTION_KEY_V2, incrementar CURRENT_KEY_VERSION.
     decrypt() sabe leer v1 o v2; encrypt() usa la más nueva.
   ========================================================================= */
'use strict';
const crypto = require('crypto');

const AES_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Registro de llaves por versión (hex string → Buffer).
// Rotación: agregar 'v2': <hex>, cambiar CURRENT.
const KEYS = {};
const parseKey = (hex, tag) => {
  if (!hex) return null;
  const buf = Buffer.from(String(hex).trim(), 'hex');
  if (buf.length !== 32) throw new Error(`${tag} debe ser 32 bytes (64 hex chars); recibido ${buf.length}`);
  return buf;
};
if (process.env.ENCRYPTION_KEY_V1) KEYS.v1 = parseKey(process.env.ENCRYPTION_KEY_V1, 'ENCRYPTION_KEY_V1');
if (process.env.ENCRYPTION_KEY_V2) KEYS.v2 = parseKey(process.env.ENCRYPTION_KEY_V2, 'ENCRYPTION_KEY_V2');

// La llave más nueva disponible. encrypt() la usa siempre.
const CURRENT_VERSION = KEYS.v2 ? 'v2' : (KEYS.v1 ? 'v1' : null);

const PEPPER = process.env.HMAC_PEPPER ? Buffer.from(String(process.env.HMAC_PEPPER).trim(), 'hex') : null;

function ready() { return !!(CURRENT_VERSION && PEPPER); }
function assertReady() {
  if (!CURRENT_VERSION) throw new Error('crypto_no_key: ENCRYPTION_KEY_V1 no definida');
  if (!PEPPER) throw new Error('crypto_no_pepper: HMAC_PEPPER no definida');
}

/* ---------- cifrado reversible (AES-256-GCM) ---------- */
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  if (!CURRENT_VERSION) return 'plain:' + String(plain);   // fallback dev
  const key = KEYS[CURRENT_VERSION];
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const isBuffer = Buffer.isBuffer(plain);
  const buf = isBuffer ? plain : Buffer.from(String(plain), 'utf8');
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CURRENT_VERSION}:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}
function decrypt(payload) {
  if (payload == null) return null;
  const s = String(payload);
  if (s.startsWith('plain:')) return s.slice(6);
  const parts = s.split(':');
  if (parts.length !== 4) throw new Error('crypto_formato');
  const [ver, ivB, ctB, tagB] = parts;
  const key = KEYS[ver];
  if (!key) throw new Error(`crypto_llave_desconocida: ${ver}`);
  const iv = Buffer.from(ivB, 'base64');
  const ct = Buffer.from(ctB, 'base64');
  const tag = Buffer.from(tagB, 'base64');
  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  const buf = Buffer.concat([decipher.update(ct), decipher.final()]);
  return buf;   // callers convierten a string si aplica
}
function decryptString(payload) {
  const b = decrypt(payload);
  return b == null ? null : (Buffer.isBuffer(b) ? b.toString('utf8') : String(b));
}

/* ---------- hash determinístico (HMAC-SHA256) ---------- */
// Normaliza SIEMPRE antes de hashear para que "Alfonso@X" y " alfonso@x " colisionen.
function normalizeEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function hmac(value, opts) {
  if (value == null || value === '') return null;
  if (!PEPPER) return 'plain:' + String(value);   // fallback dev
  const s = (opts && opts.email) ? normalizeEmail(value) : String(value);
  const h = crypto.createHmac('sha256', PEPPER).update(s, 'utf8').digest('hex');
  return `hm1:${h}`;
}
const hmacEmail = v => hmac(v, { email: true });

/* ---------- generadores de llaves (dev/rotación) ---------- */
function generateKey() { return crypto.randomBytes(32).toString('hex'); }
function generatePepper() { return crypto.randomBytes(32).toString('hex'); }

module.exports = { encrypt, decrypt, decryptString, hmac, hmacEmail, normalizeEmail, ready, assertReady, generateKey, generatePepper, CURRENT_VERSION };
