/* ============================================================================
   server.js — Polipay POS Settlement (BRD-OP-AGR-001)
   Backend: TODA la lógica y el estado viven aquí. El front es solo espejo.
   - Motor: engine.js (única fuente de verdad).
   - Datos: Postgres (Supabase en prod · pglite en dev).
   - Excel: lib/excel.js (parseo y generación server-side).
   - Auth JWT + bcrypt, roles forzados por endpoint, inmutabilidad de cortes.
   ========================================================================= */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });   // .env por ruta absoluta (no depende del cwd)
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
if (!GOOGLE_CLIENT_ID) console.warn('⚠  GOOGLE_CLIENT_ID no definido: el login por Google no funcionará hasta configurarlo.');
// Restricción opcional al dominio Google Workspace (ej. ALLOWED_HD=polipay.io).
// Si está vacía, cualquier cuenta Google puede intentar (whitelist en BD sigue mandando).
const ALLOWED_HD = (process.env.ALLOWED_HD || '').trim().toLowerCase();
// Roles que requieren MFA (ej. MFA_REQUIRED_ROLES=admin,tesoreria).
// Vacío = MFA no requerida. La verificación es best-effort a nivel app (Google puede
// omitir la claim amr en el ID token); el enforcement 100% real vive en Google Workspace.
const MFA_REQUIRED_ROLES = String(process.env.MFA_REQUIRED_ROLES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// Métodos que consideramos MFA válidos si aparecen en payload.amr.
// mfa/otp/sms/tel = 2FA clásico. hwk/wia/swk = passkeys (hardware/Windows Hello/software).
// phr = phishing-resistant (passkeys biométricos). face/fpt = biométricos independientes.
const MFA_VALID_METHODS = new Set(['mfa', 'sms', 'otp', 'hwk', 'wia', 'swk', 'tel', 'phr', 'face', 'fpt', 'pop']);
function tieneMFA(payload) {
  if (!payload) return false;
  const amr = Array.isArray(payload.amr) ? payload.amr : [];
  return amr.some(m => MFA_VALID_METHODS.has(String(m).toLowerCase()));
}
const E = require('./engine.js');
const db = require('./db/index.js');
const X = require('./lib/excel.js');
const C = require('./lib/crypto.js');
const AL = require('./lib/alertas.js');
const WORM = require('./lib/worm.js');
const D = require('./lib/disputas.js');
const mountDisputasRoutes = require('./lib/disputas-routes.js');
if (!C.ready()) console.warn('⚠  Cifrado app-layer NO configurado (falta ENCRYPTION_KEY_V1 o HMAC_PEPPER). Dual-write escribirá "plain:" en las columnas cifradas.');

const app = express();
const PORT = process.env.PORT || 4174;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-cambia-en-produccion';
if (!process.env.JWT_SECRET) console.warn('⚠  JWT_SECRET no definido: usando secreto de desarrollo.');
// Detrás de un proxy (Render). Necesario para que req.ip / rate-limit lean X-Forwarded-For.
app.set('trust proxy', 1);

/* ---------- seguridad HTTP (Helmet + CSP) ---------- */
app.use(helmet({
  // CSP: solo cargas propias + Google Identity Services (script + iframe del popup).
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' en scripts se justifica por el <script> inline del index.html; se puede endurecer más adelante con nonces.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      frameSrc: ["'self'", 'https://accounts.google.com'],
      connectSrc: ["'self'", 'https://accounts.google.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],   // clickjacking
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,   // GIS puede fallar con COEP
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },  // permite el popup de Google
  strictTransportSecurity: { maxAge: 15552000, includeSubDomains: true, preload: false },   // 180 días HSTS
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

/* ---------- rate limits por IP ---------- */
const rlOpts = (max, mensaje) => ({
  windowMs: 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit', mensaje },
});
// Login Google: agresivo (evita brute force / abuso del verificador Google).
const loginLimiter = rateLimit(rlOpts(20, 'Demasiados intentos de inicio de sesión. Espera un minuto.'));
// API general: 300/min por IP (suficiente para uso normal, tapa robots).
const apiLimiter = rateLimit(rlOpts(300, 'Demasiadas solicitudes. Espera un minuto.'));
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

/* ---------- validación estricta de uploads (MIME + magic bytes) ---------- */
// Rechaza cualquier archivo que no sea xlsx/xls/csv, aunque el cliente mienta en el content-type.
function validaArchivo(req, res, next) {
  if (!req.file) return next();
  const buf = req.file.buffer;
  const nombre = String(req.file.originalname || '').toLowerCase();
  const ext = nombre.slice(nombre.lastIndexOf('.'));
  const mime = String(req.file.mimetype || '').toLowerCase();
  const okExt = ['.xlsx', '.xls', '.csv'].includes(ext);
  const okMime = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream',   // navegadores a veces mandan esto para xlsx
    'text/csv',
    'text/plain',
    '',
  ].includes(mime);
  // Magic bytes: xlsx=ZIP (50 4B 03 04), xls=OLE2 (D0 CF 11 E0 A1 B1 1A E1), csv=texto.
  const isZip = buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  const isOle2 = buf && buf.length >= 8 && buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0;
  const looksText = buf && buf.length > 0 && buf.slice(0, Math.min(buf.length, 4096)).every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128);
  const okMagic = (ext === '.xlsx' && isZip) || (ext === '.xls' && (isOle2 || isZip)) || (ext === '.csv' && looksText);
  if (!okExt || !okMime || !okMagic) return res.status(400).json({ error: 'archivo_invalido', mensaje: 'Sube un archivo .xlsx, .xls o .csv válido.' });
  next();
}

/* ---------- helpers ---------- */
const N = v => (v == null || v === '') ? null : Number(v);
const nrm = s => String(s == null ? '' : s).trim().toLowerCase();
const safeUser = u => ({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, foto_url: u.foto_url || null });
const ROLES = { admin: 'Administrador', operador: 'Operador (Operaciones)', tesoreria: 'Tesorería (valida)', bancos: 'Bancos (dispersa y cierra)', consulta: 'Consulta (solo lectura)' };
const ROLES_VALIDOS = Object.keys(ROLES);

// jti único por sesión — permite revocarla al cerrar sesión (blacklist en memoria).
const REVOKED_JTI = new Set();
function firmar(u) {
  const jti = crypto.randomBytes(12).toString('hex');
  return jwt.sign({ sub: u.id, rol: u.rol, nombre: u.nombre, email: u.email, jti }, JWT_SECRET, { expiresIn: '8h' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  if (!tok) return res.status(401).json({ error: 'sin_token' });
  try {
    const p = jwt.verify(tok, JWT_SECRET);
    if (p.jti && REVOKED_JTI.has(p.jti)) return res.status(401).json({ error: 'sesion_revocada' });
    req.user = p; next();
  }
  catch { return res.status(401).json({ error: 'token_invalido' }); }
}
const requiereRol = (...roles) => (req, res, next) =>
  roles.includes(req.user.rol) ? next() : res.status(403).json({ error: 'rol_no_autorizado', necesita: roles });
const dbReady = res => { if (!db.isReady()) { res.status(503).json({ error: 'db_no_lista' }); return false; } return true; };

// Extrae la IP real detrás del proxy de Render (X-Forwarded-For).
function realIp(req) {
  if (!req) return null;
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || null;
}

// Escritura auditable con hash-chain. Cada fila guarda hash = sha256(prev_hash || campos).
// Si alguien altera una fila retroactivamente, la cadena se rompe → detectable.
// opts: { resource_type, resource_id, success, actor }  — actor overrides req.user (para logins fallidos)
async function bit(req, accion, detalle, opts) {
  opts = opts || {};
  try {
    const usuario = opts.actor?.nombre || (req && req.user ? req.user.nombre : '—');
    const rol = opts.actor?.rol || (req && req.user ? req.user.rol : '—');
    const jti = req && req.user ? (req.user.jti || null) : null;
    const ip = realIp(req);
    const ua = req && req.headers ? (req.headers['user-agent'] || null) : null;
    const rtype = opts.resource_type || null;
    const rid = opts.resource_id ? String(opts.resource_id) : null;
    const success = opts.success === false ? false : true;
    // Trae el último hash para encadenar. Si es la primera fila, prev=null.
    const prev = (await db.query('select row_hash from bitacora where row_hash is not null order by id desc limit 1')).rows[0];
    const prev_hash = prev ? prev.row_hash : null;
    // Hash de los campos (incluye prev_hash → cadena rota si alguien altera algo).
    const material = [prev_hash || '', usuario, rol, accion, detalle || '', ip || '', ua || '', jti || '', rtype || '', rid || '', String(success)].join('|');
    const row_hash = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
    await db.query(
      'insert into bitacora(usuario,rol,accion,detalle,ip,user_agent,session_jti,resource_type,resource_id,success,prev_hash,row_hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [usuario, rol, accion, detalle || '', ip, ua, jti, rtype, rid, success, prev_hash, row_hash]
    );
    // Evaluar reglas de alerta (best-effort, en el mismo tick — no bloqueamos con await afuera de bit).
    evaluarAlertas({ usuario, rol, accion, detalle, ip, resource_type: rtype, resource_id: rid, success, ts: new Date().toISOString() });
  } catch (_e) { /* la bitácora nunca debe romper el flujo */ }
}

// Dispara alertas por SES a los admins activos. Se invoca desde bit() sin await.
function evaluarAlertas(fila) {
  if (!AL.ALERTAS_HABILITADAS || !sesEnabled()) return;
  (async () => {
    try {
      await AL.evaluar({
        db,
        adminEmails: async () => {
          // Trae emails y nombres de admins activos, descifrando al vuelo.
          const rows = (await db.query("select email, email_cifrado, nombre, nombre_cifrado from usuarios where rol='admin' and activo=true")).rows;
          return rows.map(u => {
            const email = descifraTexto(u.email_cifrado, u.email);
            const nombre = descifraTexto(u.nombre_cifrado, u.nombre) || email;
            return nombre ? `"${nombre}" <${email}>` : email;
          }).filter(Boolean);
        },
        armarAlertaHTML,
        sendSES,
        inlineImages: (function () {
          try {
            const buf = require('fs').readFileSync(path.join(__dirname, 'public', 'logo.png'));
            return [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: buf }];
          } catch (_e) { return []; }
        })(),
      }, fila);
    } catch (_e) { /* silencioso */ }
  })();
}

/* ---------- loaders de catálogo (coaccionan numeric→number) ---------- */
async function getParams() {
  const r = (await db.query('select * from params where id=1')).rows[0];
  return { IVA: Number(r.iva), tasa_int_amex: Number(r.tasa_int_amex), tasa_int_int: Number(r.tasa_int_int), fee_broxel: Number(r.fee_broxel), prodParams: r.prodparams };
}
async function getFeriados() { return (await db.query('select fecha::text as fecha from feriados order by fecha')).rows.map(r => r.fecha); }
async function getGrupos() { return (await db.query('select * from grupos')).rows; }
async function getAfiliaciones() {
  const rows = (await db.query('select * from afiliaciones')).rows;
  return rows.map(a => ({ ...a, razon_social: descifraTexto(a.razon_social_cifrada, a.razon_social) }));
}
async function getAfilGrupo() { return (await db.query('select * from afil_grupo')).rows; }
async function getCostos() { return (await db.query('select * from costos')).rows; }
async function getCuentas() {
  const rows = (await db.query('select * from cuentas')).rows;
  return rows.map(c => ({
    ...c,
    clabe: descifraTexto(c.clabe_cifrada, c.clabe),
    banco: descifraTexto(c.banco_cifrado, c.banco),
    razon_social_beneficiario: descifraTexto(c.razon_social_beneficiario_cifrada, c.razon_social_beneficiario),
  }));
}
// Descifra si viene versionado (v1:...); si falla o es plaintext legacy, devuelve el fallback.
function descifraTexto(cifrado, fallback) {
  if (!cifrado) return fallback;
  const s = String(cifrado);
  if (!s.startsWith('v1:') && !s.startsWith('v2:') && !s.startsWith('plain:')) return fallback;
  try { return C.decryptString(cifrado); } catch (_e) { return fallback; }
}
async function getBancos() { return (await db.query('select * from bancos order by nombre')).rows; }

async function insertMany(table, cols, rows) {
  if (!rows.length) return;
  const CH = 300;
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH);
    const ph = [], vals = [];
    chunk.forEach((r, ri) => { ph.push('(' + cols.map((_, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')'); cols.forEach(c => vals.push(r[c])); });
    await db.query('insert into ' + table + '(' + cols.join(',') + ') values ' + ph.join(','), vals);
  }
}

/* ---------- estado / health ---------- */
const PKG_VERSION = require('./package.json').version || '0.0.0';
// Commit SHA: Render inyecta RENDER_GIT_COMMIT automáticamente en cada deploy;
// en local se lee del repo con git; si nada aplica, queda 'dev'.
const COMMIT_SHA = (() => {
  const env = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '';
  if (env) return env.slice(0, 7);
  try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_e) { return 'dev'; }
})();
function estadoServicio() { return { ok: true, service: 'conciliacion-liquidacion', db: db.isReady(), backend: db.kind(), version: PKG_VERSION, commit: COMMIT_SHA, ts: Date.now() }; }
app.get('/healthz', (_req, res) => res.json(estadoServicio()));
app.get('/api/estado', (_req, res) => res.json(estadoServicio()));

/* ---------- login (Google Sign-In · whitelist) ---------- */
// Config pública para el front: Client ID de Google + roles (etiquetas).
app.get('/api/config-publica', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID, roles: ROLES });
});

// Recibe un ID token de Google (Google Identity Services devuelve `credential`).
// Valida firma + audience contra nuestro Client ID. Solo pasa si el email
// está registrado como usuario ACTIVO en la BD (whitelist explícito).
app.post('/api/login/google', loginLimiter, async (req, res) => {
  if (!dbReady(res)) return;
  if (!googleClient) return res.status(503).json({ error: 'google_no_configurado', mensaje: 'GOOGLE_CLIENT_ID no está definido en el servidor.' });
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'sin_credential' });
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    await bit(req, 'login_fail', `google_invalido: ${e.message}`, { success: false, actor: { nombre: '(anónimo)', rol: '—' } });
    return res.status(401).json({ error: 'google_invalido', mensaje: e.message });
  }
  if (!payload || !payload.email || !payload.email_verified) {
    await bit(req, 'login_fail', 'email_no_verificado', { success: false, actor: { nombre: '(anónimo)', rol: '—' } });
    return res.status(401).json({ error: 'email_no_verificado' });
  }
  // Segundo blindaje opcional: exigir cuenta Google Workspace del dominio permitido (hd).
  if (ALLOWED_HD && String(payload.hd || '').toLowerCase() !== ALLOWED_HD) {
    await bit(req, 'login_fail', `dominio_no_permitido: ${payload.email} (hd=${payload.hd || '—'})`, { success: false, actor: { nombre: payload.email, rol: '—' } });
    return res.status(403).json({ error: 'dominio_no_permitido', mensaje: `Solo cuentas de ${ALLOWED_HD} pueden iniciar sesión.` });
  }
  const email = String(payload.email).toLowerCase();
  // Cutover: primero busca por email_hash (cifrado v0.7+); fallback a lower(email) para filas legacy.
  const emailHash = C.hmacEmail(email);
  let u = (await db.query('select * from usuarios where email_hash=$1', [emailHash])).rows[0];
  if (!u) u = (await db.query('select * from usuarios where lower(email)=lower($1)', [email])).rows[0];
  if (!u) {
    await bit(req, 'login_fail', `no_autorizado: ${email}`, { success: false, actor: { nombre: email, rol: '—' } });
    return res.status(403).json({ error: 'no_autorizado', mensaje: 'Este correo no tiene acceso. Pide a un administrador que te agregue en Sistema → Usuarios.' });
  }
  if (!u.activo) {
    await bit(req, 'login_fail', `inactivo: ${email}`, { success: false, actor: { nombre: u.nombre || email, rol: u.rol }, resource_type: 'usuario', resource_id: u.id });
    return res.status(403).json({ error: 'inactivo', mensaje: 'Tu usuario está desactivado. Contacta a un administrador.' });
  }
  // Enforcement MFA best-effort por rol. Google Identity Services (el flujo del
  // botón "Acceder con Google") NO incluye la claim amr en el ID token la mayoría
  // de las veces, aunque el usuario haya usado passkey/2FA — es una limitación
  // documentada. Por eso solo rechazamos cuando amr está presente y NO indica MFA
  // (indica sesión activa sin 2FA). El enforcement 100% real vive en Google
  // Workspace (admin.google.com → Security → 2-Step Verification → Enforcement).
  if (MFA_REQUIRED_ROLES.length && MFA_REQUIRED_ROLES.includes(String(u.rol).toLowerCase())) {
    const amrPresente = Array.isArray(payload.amr) && payload.amr.length > 0;
    if (amrPresente && !tieneMFA(payload)) {
      await bit(req, 'login_fail', `mfa_sin_metodo: ${email} rol=${u.rol} amr=${payload.amr.join(',')}`, { success: false, actor: { nombre: u.nombre || email, rol: u.rol }, resource_type: 'usuario', resource_id: u.id });
      return res.status(403).json({
        error: 'mfa_requerido',
        motivo: 'mfa_sin_metodo',
        mensaje: `Tu rol (${u.rol}) requiere verificación en dos pasos activa en tu cuenta Google. Actívala en https://myaccount.google.com/signinoptions/two-step-verification y vuelve a iniciar sesión.`,
      });
    }
  }
  // Actualiza nombre/foto/last-login (solo campos suaves; email y rol no se tocan).
  const nombre = u.nombre || payload.name || email;
  const fotoUrl = payload.picture || u.foto_url || null;
  await db.query(
    'update usuarios set nombre=$2, foto_url=$3, ultimo_login_at=now(), nombre_cifrado=$4, email_hash=coalesce(email_hash,$5), email_cifrado=coalesce(email_cifrado,$6) where id=$1',
    [u.id, nombre, fotoUrl, C.encrypt(nombre), C.hmacEmail(u.email), C.encrypt(u.email)]
  );
  u.nombre = nombre; u.foto_url = fotoUrl;
  // Registrar amr para tener visibilidad de qué logins usaron MFA reforzado por Google.
  const amrStr = Array.isArray(payload.amr) && payload.amr.length ? payload.amr.join(',') : 'none';
  await bit(req, 'login_google', `${email} · amr=${amrStr} · hd=${payload.hd || '—'}`, { actor: { nombre: u.nombre, rol: u.rol }, resource_type: 'usuario', resource_id: u.id });
  res.json({ token: firmar(u), user: safeUser(u) });
});
app.get('/api/yo', auth, (req, res) => res.json({ id: req.user.sub, nombre: req.user.nombre, email: req.user.email, rol: req.user.rol }));
// Cierra la sesión del server-side: agrega el jti a la blacklist para que el mismo token no vuelva a autenticar.
app.post('/api/logout', auth, (req, res) => {
  if (req.user.jti) REVOKED_JTI.add(req.user.jti);
  res.json({ ok: true });
});

/* ---------- gestión de usuarios (solo admin) ---------- */
app.get('/api/usuarios', auth, requiereRol('admin'), async (_req, res) => {
  if (!dbReady(res)) return;
  const rows = (await db.query('select id,email,email_cifrado,nombre,nombre_cifrado,rol,activo,ultimo_login_at,creado_at,creado_por,foto_url from usuarios order by activo desc, rol, email')).rows;
  res.json(rows.map(u => ({
    id: u.id,
    email: descifraTexto(u.email_cifrado, u.email),
    nombre: descifraTexto(u.nombre_cifrado, u.nombre),
    rol: u.rol, activo: u.activo,
    ultimo_login_at: u.ultimo_login_at, creado_at: u.creado_at, creado_por: u.creado_por, foto_url: u.foto_url,
  })));
});
app.post('/api/usuarios', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const nombre = String(b.nombre || '').trim();
  const rol = String(b.rol || '').trim();
  const activo = b.activo === false ? false : true;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'email_invalido' });
  if (!nombre) return res.status(400).json({ error: 'nombre_requerido' });
  if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'rol_invalido', validos: ROLES_VALIDOS });
  if (b.id) {
    // Edición
    const id = parseInt(b.id, 10);
    const existente = (await db.query('select id,rol from usuarios where id=$1', [id])).rows[0];
    if (!existente) return res.status(404).json({ error: 'no_existe' });
    // Regla: no permitas quedarte sin admins activos.
    if ((existente.rol === 'admin') && (rol !== 'admin' || !activo)) {
      const admins = (await db.query("select count(*)::int as n from usuarios where rol='admin' and activo=true and id<>$1", [id])).rows[0].n;
      if (admins === 0) return res.status(409).json({ error: 'ultimo_admin', mensaje: 'No puedes dejar el sistema sin al menos un administrador activo.' });
    }
    await db.query(
      'update usuarios set email=$2, nombre=$3, rol=$4, activo=$5, email_hash=$6, email_cifrado=$7, nombre_cifrado=$8 where id=$1',
      [id, email, nombre, rol, activo, C.hmacEmail(email), C.encrypt(email), C.encrypt(nombre)]
    );
    await bit(req, 'usuario_editar', `email=${email} rol=${rol} activo=${activo}`, { resource_type: 'usuario', resource_id: id });
    return res.json({ ok: true, id });
  }
  // Alta (dedupe por hash + fallback a lower(email) para legacy)
  const eHash = C.hmacEmail(email);
  const dup = (await db.query('select id from usuarios where email_hash=$1 or lower(email)=lower($2)', [eHash, email])).rows[0];
  if (dup) return res.status(409).json({ error: 'email_duplicado' });
  const r = await db.query(
    'insert into usuarios(email,nombre,rol,activo,creado_por,email_hash,email_cifrado,nombre_cifrado) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',
    [email, nombre, rol, activo, req.user.nombre || req.user.email, C.hmacEmail(email), C.encrypt(email), C.encrypt(nombre)]
  );
  await bit(req, 'usuario_alta', `email=${email} rol=${rol}`, { resource_type: 'usuario', resource_id: r.rows[0].id });
  // Correo de bienvenida (best-effort, no bloquea el alta).
  let mail = { ok: false, motivo: 'ses_no_configurado' };
  if (activo && sesEnabled()) {
    try {
      const invitadoPor = req.user.nombre || req.user.email || '';
      const { subject, html, textFallback } = armarBienvenidaHTML({ email, nombre, rol }, invitadoPor, { logoSrc: 'cid:polipay-logo' });
      const logoPath = path.join(__dirname, 'public', 'logo.png');
      const logoBuf = require('fs').readFileSync(logoPath);
      const inlineImages = [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: logoBuf }];
      const messageId = await sendSES({ to: [`"${nombre}" <${email}>`], subject, html, textFallback, inlineImages });
      mail = { ok: true, messageId };
      await bit(req, 'usuario_bienvenida', `→ ${email} (${messageId})`);
    } catch (e) {
      mail = { ok: false, motivo: 'ses_error', error: e.message };
      await bit(req, 'usuario_bienvenida_error', `→ ${email} · ${e.message}`);
    }
  } else if (!activo) {
    mail = { ok: false, motivo: 'usuario_inactivo' };
  }
  res.json({ ok: true, id: r.rows[0].id, mail });
});
app.delete('/api/usuarios/:id', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  const id = parseInt(req.params.id, 10);
  if (id === req.user.sub) return res.status(409).json({ error: 'no_te_borres', mensaje: 'No puedes borrar tu propio usuario.' });
  const u = (await db.query('select rol,email from usuarios where id=$1', [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'no_existe' });
  if (u.rol === 'admin') {
    const admins = (await db.query("select count(*)::int as n from usuarios where rol='admin' and activo=true and id<>$1", [id])).rows[0].n;
    if (admins === 0) return res.status(409).json({ error: 'ultimo_admin', mensaje: 'No puedes borrar al último administrador activo.' });
  }
  await db.query('delete from usuarios where id=$1', [id]);
  await bit(req, 'usuario_baja', `email=${u.email}`, { resource_type: 'usuario', resource_id: id });
  res.json({ ok: true });
});

/* ============================================================================
   CATÁLOGOS
   ========================================================================= */
app.get('/api/catalogo/:tipo', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const t = req.params.tipo;
  try {
    if (t === 'grupos') return res.json(await getGrupos());
    if (t === 'afiliaciones') return res.json(await getAfiliaciones());
    if (t === 'afilgrupo') return res.json(await getAfilGrupo());
    if (t === 'costos') return res.json(await getCostos());
    if (t === 'cuentas') return res.json(await getCuentas());
    if (t === 'bancos') return res.json(await getBancos());
    if (t === 'feriados') return res.json(await getFeriados());
    if (t === 'params') return res.json(await getParams());
    if (t === 'grupos-full') { // grupos+afiliaciones+tasas+costos combinado para la vista
      const [ag, af, co] = await Promise.all([getAfilGrupo(), getAfiliaciones(), getCostos()]);
      const grp = await getGrupos();
      return res.json({ grupos: grp, afilGrupo: ag, afiliaciones: af, costos: co });
    }
    res.status(404).json({ error: 'tipo_desconocido' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Guardar parámetros (admin) + recalcular fechas de liquidación
app.put('/api/catalogo/params', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  const p = req.body || {};
  await db.query('update params set iva=$1,tasa_int_amex=$2,tasa_int_int=$3,fee_broxel=$4,prodparams=$5 where id=1',
    [p.IVA, p.tasa_int_amex, p.tasa_int_int, p.fee_broxel, JSON.stringify(p.prodParams)]);
  await bit(req, 'params', 'actualizó parámetros del ciclo');
  const n = await recalcularFechasLiq();
  res.json({ ok: true, recalculadas: n });
});

// Alta/edición de grupo+afiliación (admin)
app.post('/api/catalogo/grupo-afiliacion', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  const b = req.body || {};
  const idg = parseInt(b.id_grupo, 10); const afil = String(b.numero_afiliacion || '').replace(/\D/g, '');
  if (!idg || !afil || !String(b.nombre_cliente || '').trim()) return res.status(400).json({ error: 'faltan_datos' });
  for (const [k, v] of [['tdd', b.tasa_pac_tdd], ['tdc', b.tasa_pac_tdc], ['amex', b.tasa_pac_amex], ['int', b.tasa_pac_int], ['banca', b.pct_banca]]) {
    const val = Number(v) || 0; if (val < 0 || val >= 1) return res.status(400).json({ error: `tasa ${k} fuera de [0,1)` });
  }
  await db.query('insert into grupos(id_grupo,nombre_cliente,activo) values($1,$2,true) on conflict(id_grupo) do update set nombre_cliente=excluded.nombre_cliente', [idg, String(b.nombre_cliente).trim()]);
  await db.query('insert into afiliaciones(numero_afiliacion,razon_social,ult3,id_afiliacion) values($1,$2,$3,$4) on conflict(numero_afiliacion) do update set razon_social=excluded.razon_social',
    [afil, String(b.razon_social || '').trim(), E.ult3(afil), E.ult3(afil) + 'CPPX00']);
  await db.query(`insert into afil_grupo(id_grupo,numero_afiliacion,tasa_pac_tdd,tasa_pac_tdc,tasa_pac_amex,tasa_pac_int,costo_x_trx,pct_banca)
      values($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict(id_grupo,numero_afiliacion) do update set tasa_pac_tdd=excluded.tasa_pac_tdd,tasa_pac_tdc=excluded.tasa_pac_tdc,tasa_pac_amex=excluded.tasa_pac_amex,tasa_pac_int=excluded.tasa_pac_int,costo_x_trx=excluded.costo_x_trx,pct_banca=excluded.pct_banca`,
    [idg, afil, Number(b.tasa_pac_tdd) || 0, Number(b.tasa_pac_tdc) || 0, Number(b.tasa_pac_amex) || 0, Number(b.tasa_pac_int) || 0, Number(b.costo_x_trx) || 0, Number(b.pct_banca) || 0]);
  await db.query(`insert into costos(numero_afiliacion,int_tdd,int_tdc,int_amex,int_int,fee_broxel) values($1,$2,$3,$4,$5,$6)
      on conflict(numero_afiliacion) do update set int_tdd=excluded.int_tdd,int_tdc=excluded.int_tdc,int_amex=excluded.int_amex,int_int=excluded.int_int,fee_broxel=excluded.fee_broxel`,
    [afil, Number(b.int_tdd) || 0, Number(b.int_tdc) || 0, b.int_amex === '' || b.int_amex == null ? null : Number(b.int_amex), b.int_int === '' || b.int_int == null ? null : Number(b.int_int), b.fee_broxel === '' || b.fee_broxel == null ? null : Number(b.fee_broxel)]);
  await bit(req, 'catalogo', `alta/edición grupo ${idg} / afiliación ${afil}`);
  res.json({ ok: true });
});
app.delete('/api/catalogo/afil-grupo/:idg/:afil', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  await db.query('delete from afil_grupo where id_grupo=$1 and numero_afiliacion=$2', [parseInt(req.params.idg, 10), String(req.params.afil)]);
  await bit(req, 'catalogo', `eliminó afiliación ${req.params.afil} del grupo ${req.params.idg}`);
  res.json({ ok: true });
});

// Cuentas de liquidación (admin)
app.post('/api/catalogo/cuenta', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  const b = req.body || {};
  const cl = String(b.clabe || '').replace(/\D/g, ''); if (cl && !/^\d{18}$/.test(cl)) return res.status(400).json({ error: 'clabe_18' });
  if (!b.id_grupo) return res.status(400).json({ error: 'grupo' });
  const afil = String(b.numero_afiliacion || '').replace(/\D/g, '');
  const cod = b.banco ? (await db.query('select codigo_spei from bancos where lower(nombre)=lower($1)', [b.banco])).rows[0] : null;
  const codigo = cod ? cod.codigo_spei : null;
  const rzn = b.razon_social_beneficiario || '', bnc = b.banco || '';
  const clHash = cl ? C.hmac(cl) : null, clCif = cl ? C.encrypt(cl) : null;
  const rznCif = C.encrypt(rzn), bncCif = C.encrypt(bnc);
  if (b.id) {
    await db.query('update cuentas set id_grupo=$1,numero_afiliacion=$2,nombre_comercial=$3,razon_social_beneficiario=$4,banco=$5,clabe=$6,codigo_banco=$7,clabe_hash=$8,clabe_cifrada=$9,razon_social_beneficiario_cifrada=$10,banco_cifrado=$11 where id=$12',
      [parseInt(b.id_grupo, 10), afil, b.nombre_comercial || '', rzn, bnc, cl, codigo, clHash, clCif, rznCif, bncCif, b.id]);
  } else {
    // dedupe por grupo+afiliación
    const dup = (await db.query('select id from cuentas where id_grupo=$1 and coalesce(numero_afiliacion,\'\')=$2', [parseInt(b.id_grupo, 10), afil])).rows[0];
    if (dup) await db.query('update cuentas set nombre_comercial=$1,razon_social_beneficiario=$2,banco=$3,clabe=$4,codigo_banco=$5,clabe_hash=$6,clabe_cifrada=$7,razon_social_beneficiario_cifrada=$8,banco_cifrado=$9 where id=$10', [b.nombre_comercial || '', rzn, bnc, cl, codigo, clHash, clCif, rznCif, bncCif, dup.id]);
    else await db.query('insert into cuentas(id_grupo,numero_afiliacion,nombre_comercial,razon_social_beneficiario,banco,clabe,codigo_banco,clabe_hash,clabe_cifrada,razon_social_beneficiario_cifrada,banco_cifrado) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [parseInt(b.id_grupo, 10), afil, b.nombre_comercial || '', rzn, bnc, cl, codigo, clHash, clCif, rznCif, bncCif]);
  }
  await bit(req, b.id ? 'cuenta_editar' : 'cuenta_alta', `grupo ${b.id_grupo} afil ${afil || 'nivel-grupo'} clabe ${cl ? cl.slice(-4).padStart(cl.length, '*') : '—'}`, { resource_type: 'cuenta', resource_id: b.id });
  res.json({ ok: true });
});
app.delete('/api/catalogo/cuenta/:id', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return; await db.query('delete from cuentas where id=$1', [parseInt(req.params.id, 10)]);
  await bit(req, 'cuenta_baja', '', { resource_type: 'cuenta', resource_id: req.params.id }); res.json({ ok: true });
});

// Bancos (admin)
app.post('/api/catalogo/banco', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return; const b = req.body || {};
  if (!String(b.nombre || '').trim() || b.codigo_spei == null) return res.status(400).json({ error: 'faltan_datos' });
  await db.query('insert into bancos(nombre,codigo_spei) values($1,$2) on conflict(nombre) do update set codigo_spei=excluded.codigo_spei', [String(b.nombre).trim(), parseInt(b.codigo_spei, 10)]);
  await db.query('update cuentas set codigo_banco=$1 where lower(banco)=lower($2)', [parseInt(b.codigo_spei, 10), String(b.nombre).trim()]);
  await bit(req, 'catalogo', `banco ${b.nombre}`); res.json({ ok: true });
});
app.post('/api/catalogo/bancos-comunes', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  const comunes = [['STP', 90646], ['TRANSFER', 90684], ['KAPITAL', 90670], ['KUSPIT', 90653], ['ARCUS', 90716], ['ASP INTEGRA', 90659], ['BBVA MEXICO', 40012], ['SANTANDER', 40014], ['BANORTE', 40072], ['BANAMEX', 40002], ['HSBC', 40021], ['SCOTIABANK', 40044]];
  for (const [n, c] of comunes) await db.query('insert into bancos(nombre,codigo_spei) values($1,$2) on conflict(nombre) do nothing', [n, c]);
  await db.query('update cuentas set codigo_banco=b.codigo_spei from bancos b where lower(cuentas.banco)=lower(b.nombre) and cuentas.codigo_banco is null');
  await bit(req, 'catalogo', 'cargó bancos comunes'); res.json({ ok: true });
});

// Feriados (admin)
app.post('/api/catalogo/feriado', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return; const f = E.parseFecha((req.body || {}).fecha); if (!f) return res.status(400).json({ error: 'fecha' });
  await db.query('insert into feriados(fecha) values($1) on conflict(fecha) do nothing', [E.isoFecha(f)]);
  await recalcularFechasLiq(); res.json({ ok: true });
});
app.delete('/api/catalogo/feriado/:iso', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return; await db.query('delete from feriados where fecha=$1', [req.params.iso]); await recalcularFechasLiq(); res.json({ ok: true });
});
app.post('/api/catalogo/feriados-mx', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  for (const x of ['2026-01-01', '2026-02-02', '2026-03-16', '2026-05-01', '2026-09-16', '2026-11-16', '2026-12-25'])
    await db.query('insert into feriados(fecha) values($1) on conflict do nothing', [x]);
  await recalcularFechasLiq(); await bit(req, 'catalogo', 'cargó feriados MX 2026'); res.json({ ok: true });
});

// Importar catálogo por Excel (admin): grupos | cuentas
app.post('/api/catalogo/:tipo/import', auth, requiereRol('admin'), upload.single('archivo'), validaArchivo, async (req, res) => {
  if (!dbReady(res)) return;
  const parsed = req.file ? X.parseBuffer(req.file.buffer) : X.parseCSVText((req.body && req.body.csv) || '');
  const objs = parsed.objs; let n = 0;
  try {
    if (req.params.tipo === 'grupos') {
      for (const o of objs) {
        if (!o.id_grupo || !o.numero_afiliacion) continue; const idg = parseInt(o.id_grupo, 10); const afil = String(o.numero_afiliacion).replace(/\D/g, '');
        await db.query('insert into grupos(id_grupo,nombre_cliente,activo) values($1,$2,true) on conflict(id_grupo) do update set nombre_cliente=excluded.nombre_cliente', [idg, String(o.nombre_cliente || ('Grupo ' + idg))]);
        {
          const rzn = String(o.razon_social || '');
          await db.query('insert into afiliaciones(numero_afiliacion,razon_social,ult3,id_afiliacion,razon_social_cifrada) values($1,$2,$3,$4,$5) on conflict(numero_afiliacion) do update set razon_social=excluded.razon_social, razon_social_cifrada=excluded.razon_social_cifrada', [afil, rzn, E.ult3(afil), E.ult3(afil) + 'CPPX00', C.encrypt(rzn)]);
        }
        await db.query(`insert into afil_grupo(id_grupo,numero_afiliacion,tasa_pac_tdd,tasa_pac_tdc,tasa_pac_amex,tasa_pac_int,costo_x_trx,pct_banca) values($1,$2,$3,$4,$5,$6,$7,$8)
            on conflict(id_grupo,numero_afiliacion) do update set tasa_pac_tdd=excluded.tasa_pac_tdd,tasa_pac_tdc=excluded.tasa_pac_tdc,tasa_pac_amex=excluded.tasa_pac_amex,tasa_pac_int=excluded.tasa_pac_int,costo_x_trx=excluded.costo_x_trx,pct_banca=excluded.pct_banca`,
          [idg, afil, Number(o.tasa_pac_tdd) || 0, Number(o.tasa_pac_tdc) || 0, Number(o.tasa_pac_amex) || 0, Number(o.tasa_pac_int) || 0, Number(o.costo_x_trx) || 0, Number(o.pct_banca) || 0]);
        await db.query(`insert into costos(numero_afiliacion,int_tdd,int_tdc,int_amex,int_int,fee_broxel) values($1,$2,$3,$4,$5,$6)
            on conflict(numero_afiliacion) do update set int_tdd=excluded.int_tdd,int_tdc=excluded.int_tdc,int_amex=excluded.int_amex,int_int=excluded.int_int,fee_broxel=excluded.fee_broxel`,
          [afil, Number(o.int_tdd) || 0, Number(o.int_tdc) || 0, o.int_amex === '' || o.int_amex == null ? null : Number(o.int_amex), o.int_int === '' || o.int_int == null ? null : Number(o.int_int), o.fee_broxel === '' || o.fee_broxel == null ? null : Number(o.fee_broxel)]);
        n++;
      }
    } else if (req.params.tipo === 'cuentas') {
      for (const o of objs) {
        if (!o.id_grupo) continue; const idg = parseInt(o.id_grupo, 10); const afil = String(o.numero_afiliacion || '').replace(/\D/g, '');
        const cod = (await db.query('select codigo_spei from bancos where lower(nombre)=lower($1)', [o.banco || ''])).rows[0];
        const dup = (await db.query('select id from cuentas where id_grupo=$1 and coalesce(numero_afiliacion,\'\')=$2', [idg, afil])).rows[0];
        const rznV = String(o.razon_social_beneficiario || ''), bncV = String(o.banco || '');
        const clV = String(o.clabe || '').replace(/\D/g, '');
        const vals = [idg, afil, String(o.nombre_comercial || ''), rznV, bncV, clV, cod ? cod.codigo_spei : null, clV ? C.hmac(clV) : null, clV ? C.encrypt(clV) : null, C.encrypt(rznV), C.encrypt(bncV)];
        if (dup) await db.query('update cuentas set id_grupo=$1,numero_afiliacion=$2,nombre_comercial=$3,razon_social_beneficiario=$4,banco=$5,clabe=$6,codigo_banco=$7,clabe_hash=$8,clabe_cifrada=$9,razon_social_beneficiario_cifrada=$10,banco_cifrado=$11 where id=$12', [...vals, dup.id]);
        else await db.query('insert into cuentas(id_grupo,numero_afiliacion,nombre_comercial,razon_social_beneficiario,banco,clabe,codigo_banco,clabe_hash,clabe_cifrada,razon_social_beneficiario_cifrada,banco_cifrado) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', vals);
        n++;
      }
    } else return res.status(404).json({ error: 'tipo' });
    await bit(req, 'catalogo', `importó ${n} ${req.params.tipo}`);
    res.json({ ok: true, importadas: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================================
   TRANSACCIONES
   ========================================================================= */
async function recalcularFechasLiq() {
  const params = await getParams(); const feriados = await getFeriados();
  const txs = (await db.query('select id,fecha,hora,producto,fecha_liq::text as fecha_liq from transacciones')).rows;
  let n = 0;
  for (const t of txs) {
    const pk = E.prodKey(t.producto); const f = E.parseFecha(t.fecha); let iso = null;
    if (pk && f) { const fl = E.fechaLiquidacion(t.fecha, t.hora, t.producto, params, feriados); iso = fl ? E.isoFecha(fl) : null; }
    const cur = t.fecha_liq || null;
    if (cur !== iso) { await db.query('update transacciones set fecha_liq=$1 where id=$2', [iso, t.id]); n++; }
  }
  return n;
}

app.post('/api/transacciones/ingesta', auth, requiereRol('admin', 'operador'), upload.single('archivo'), validaArchivo, async (req, res) => {
  if (!dbReady(res)) return;
  const modo = (req.body && req.body.modo) || 'append';
  const parsed = req.file ? X.parseBuffer(req.file.buffer) : X.parseCSVText((req.body && req.body.csv) || '');
  const objs = parsed.objs;
  if (!objs.length) return res.status(400).json({ error: 'sin_datos' });
  const params = await getParams(); const feriados = await getFeriados();
  let validas = 0, invalidas = 0, monto = 0; const filas = [];
  for (const o of objs) {
    const t = {}; X.TX_COLS.forEach(c => t[c] = X.pickCol(o, c));
    t.cliente = String(t.cliente || '').trim(); t.comercio = String(t.comercio || '').trim();
    t.metodo = String(t.metodo || '').trim(); t.producto = String(t.producto || '').trim();
    t.numero_afiliacion = String(t.numero_afiliacion).replace(/\D/g, '');
    t.monto = E.parseMonto(t.monto);
    t.estatus = String(t.estatus || '').toUpperCase();
    t.hora = E.horaStr(t.hora);
    const f = E.parseFecha(t.fecha); t.fecha = f ? E.fmtFecha(f) : String(t.fecha || '').trim();
    const pk = E.prodKey(t.producto);
    const ok = /^\d+$/.test(t.numero_afiliacion) && !!pk && !!f && Number.isFinite(t.monto);
    if (!ok) invalidas++; else validas++;
    let fecha_liq = null; if (pk && f) { const fl = E.fechaLiquidacion(t.fecha, t.hora, t.producto, params, feriados); fecha_liq = fl ? E.isoFecha(fl) : null; }
    if (t.estatus === 'APROBADO') monto += t.monto;
    filas.push({ fecha: t.fecha, hora: t.hora, cliente: t.cliente, comercio: t.comercio, numero_afiliacion: t.numero_afiliacion, estatus: t.estatus, metodo: t.metodo, producto: t.producto, monto: t.monto, folio: String(t.folio || ''), referencia: String(t.referencia || ''), autorizacion: String(t.autorizacion || ''), terminal: String(t.terminal || ''), fecha_liq, cancelacion: t.monto < 0, invalida: !ok });
  }
  if (modo === 'replace') await db.query('delete from transacciones');
  // Asignar identificador de lote a todas las filas
  const ingestaId = 'ing_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const nombreArchivo = req.file ? (req.file.originalname || '') : (req.body && req.body.csv ? '(pegado)' : '');
  const ingestaAt = new Date().toISOString();
  filas.forEach(r => { r.ingesta_id = ingestaId; r.ingesta_fecha = ingestaAt; r.archivo_origen = nombreArchivo; r.cargado_por = req.user.nombre; });
  await insertMany('transacciones', ['fecha', 'hora', 'cliente', 'comercio', 'numero_afiliacion', 'estatus', 'metodo', 'producto', 'monto', 'folio', 'referencia', 'autorizacion', 'terminal', 'fecha_liq', 'cancelacion', 'invalida', 'ingesta_id', 'ingesta_fecha', 'archivo_origen', 'cargado_por'], filas);
  await bit(req, 'ingesta', `${validas} válidas, ${invalidas} inválidas (${modo}) · lote ${ingestaId} · archivo ${nombreArchivo}`);
  res.json({ validas, invalidas, monto: E.round2(monto), ingesta_id: ingestaId });
});

app.get('/api/transacciones', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const total = (await db.query('select count(*)::int n from transacciones')).rows[0].n;
  const apro = (await db.query("select count(*)::int n, coalesce(sum(monto),0) s from transacciones where upper(estatus)='APROBADO'")).rows[0];
  const items = (await db.query('select id,fecha,hora,cliente,numero_afiliacion,estatus,producto,monto,cancelacion,invalida,fecha_liq::text as fecha_liq from transacciones order by id limit 500')).rows.map(t => ({ ...t, monto: Number(t.monto), fecha_liq: t.fecha_liq || '' }));
  const diagnostico = await construirDiagnostico();
  res.json({ total, aprobadas: apro.n, montoAprobado: E.round2(Number(apro.s)), items, diagnostico });
});
app.delete('/api/transacciones', auth, requiereRol('admin', 'operador'), async (req, res) => {
  if (!dbReady(res)) return; await db.query('delete from transacciones'); await bit(req, 'ingesta', 'vació transacciones'); res.json({ ok: true });
});

// Lotes de ingesta ("Cargas recientes"): agrupa transacciones por ingesta_id.
// Las transacciones sin ingesta_id (histórico previo) se agrupan como lote virtual "hist".
app.get('/api/ingestas', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const rows = (await db.query(`
    select coalesce(ingesta_id,'hist') as id,
           max(coalesce(ingesta_fecha, now())) as fecha,
           max(coalesce(archivo_origen,'(carga histórica)')) as archivo,
           max(coalesce(cargado_por,'—')) as cargado_por,
           count(*)::int as n_trx,
           coalesce(sum(case when upper(estatus)='APROBADO' then monto else 0 end),0) as monto_aprobado
    from transacciones
    group by coalesce(ingesta_id,'hist')
    order by fecha desc nulls last
  `)).rows.map(r => ({ ...r, monto_aprobado: Number(r.monto_aprobado) }));
  res.json(rows);
});

// Borrar un lote de ingesta.
// - Bloquea si alguna trx del lote está usada por un corte Validado/Dispersado/Cerrado.
// - Si hay cortes Borrador que dependen del lote, los marca "obsoleto".
app.delete('/api/ingestas/:id', auth, requiereRol('admin', 'operador'), async (req, res) => {
  if (!dbReady(res)) return;
  const raw = String(req.params.id);
  const filtro = raw === 'hist' ? 'ingesta_id is null' : 'ingesta_id=$1';
  const params = raw === 'hist' ? [] : [raw];
  const total = (await db.query('select count(*)::int n from transacciones where ' + filtro, params)).rows[0].n;
  if (!total) return res.status(404).json({ error: 'lote_vacio_o_inexistente' });
  // Cortes que tocan fechas de liquidación cubiertas por este lote
  const cortes = (await db.query(
    `select distinct c.id_corte, c.estado, c.fecha_liq
     from cortes c
     where c.fecha_liq_iso in (
       select distinct fecha_liq from transacciones where ${filtro} and fecha_liq is not null
     )`,
    params
  )).rows;
  const cortesBloq = cortes.filter(c => ['Validado', 'Dispersado', 'Cerrado'].includes(c.estado));
  if (cortesBloq.length) {
    return res.status(409).json({ error: 'trx_en_corte_no_borrador', detalle: cortesBloq.map(c => ({ id_corte: c.id_corte, estado: c.estado, fecha_liq: c.fecha_liq })) });
  }
  // Marcar como obsoletos los cortes en Borrador afectados
  const cortesBorr = cortes.filter(c => c.estado === 'Borrador').map(c => c.id_corte);
  if (cortesBorr.length) await db.query('update cortes set obsoleto=true where id_corte = any($1)', [cortesBorr]);
  const del = await db.query('delete from transacciones where ' + filtro, params);
  await bit(req, 'ingesta', `borró lote ${raw} (${total} trx); cortes borrador marcados obsoleto: ${cortesBorr.join(',') || 'ninguno'}`);
  res.json({ ok: true, borradas: total, cortes_marcados_obsoletos: cortesBorr });
});

async function construirDiagnostico() {
  const tx = (await db.query("select producto,cliente,numero_afiliacion,monto from transacciones where upper(estatus)='APROBADO'")).rows;
  const [grupos, afilGrupo, costos] = [await getGrupos(), await getAfilGrupo(), await getCostos()];
  const prodM = {}, prodC = {}, cli = {}, af = {};
  let montoTotal = 0, cancel = 0, montoCancel = 0, conMonto0 = 0;
  for (const t of tx) { const m = Number(t.monto) || 0; montoTotal += m; if (m < 0) { cancel++; montoCancel += m; } if (m === 0) conMonto0++;
    const p = String(t.producto || '(vacío)'); prodC[p] = (prodC[p] || 0) + 1; prodM[p] = (prodM[p] || 0) + m;
    const c = String(t.cliente || '(vacío)'); cli[c] = (cli[c] || 0) + 1; const a = String(t.numero_afiliacion || '(vacío)'); af[a] = (af[a] || 0) + 1; }
  const productos = Object.keys(prodC).map(k => ({ k, n: prodC[k], monto: E.round2(prodM[k]), key: E.prodKey(k) }));
  const clientes = Object.keys(cli).map(k => ({ k, n: cli[k], grupo: (grupos.find(g => nrm(g.nombre_cliente) === nrm(k)) || {}).id_grupo || null }));
  const afiliaciones = Object.keys(af).map(k => ({ k, n: af[k], tasas: afilGrupo.some(a => String(a.numero_afiliacion) === k), costos: costos.some(c => String(c.numero_afiliacion) === k) }));
  return { montoTotal: E.round2(montoTotal), cancelaciones: cancel, montoCancel: E.round2(montoCancel), conMonto0, productos, clientes, afiliaciones };
}

/* ============================================================================
   CORTES
   ========================================================================= */
async function computeCorte(fechaLiqIso) {
  const txs = (await db.query("select cliente,numero_afiliacion,producto,monto from transacciones where fecha_liq=$1 and upper(estatus)='APROBADO'", [fechaLiqIso])).rows;
  // Contracargos pendientes para esta fecha: se aplican al bloque correspondiente.
  const ccRows = (await db.query("select * from contracargos where cargado_en_fecha=$1 and estatus='Pendiente'", [fechaLiqIso])).rows;
  const ccMap = new Map();  // key = grupo||afil||bloque -> {monto, ids:[]}
  for (const c of ccRows) {
    const k = `${nrm(c.grupo_cliente)}||${String(c.numero_afiliacion)}||${c.bloque}`;
    const cur = ccMap.get(k) || { monto: 0, ids: [] };
    cur.monto += Number(c.monto) || 0; cur.ids.push(c.id); ccMap.set(k, cur);
  }
  const [params, grupos, afilGrupo, costos, cuentas, bancos] = [await getParams(), await getGrupos(), await getAfilGrupo(), await getCostos(), await getCuentas(), await getBancos()];
  const grupoPorNombre = nombre => grupos.find(g => nrm(g.nombre_cliente) === nrm(nombre));
  const tasasDe = (idg, afil) => afilGrupo.find(a => String(a.id_grupo) === String(idg) && String(a.numero_afiliacion) === String(afil));
  const costosDe = afil => costos.find(c => String(c.numero_afiliacion) === String(afil));
  const bancoCod = nombre => { const b = bancos.find(x => nrm(x.nombre) === nrm(nombre)); return b ? b.codigo_spei : null; };
  const cuentaDe = (idg, afil) => {
    if (afil) { const m = cuentas.find(c => String(c.id_grupo) === String(idg) && String(c.numero_afiliacion || '') === String(afil)); if (m) return m; }
    return cuentas.find(c => String(c.id_grupo) === String(idg) && !String(c.numero_afiliacion || '')) || cuentas.find(c => String(c.id_grupo) === String(idg));
  };
  const groups = {};
  for (const t of txs) { const k = `${t.cliente}||${t.numero_afiliacion}`; (groups[k] = groups[k] || []).push({ producto: t.producto, monto: Number(t.monto) }); }
  const calculos = []; let total_comp = 0, total_disp = 0, total_monto = 0;
  for (const k of Object.keys(groups)) {
    const arr = groups[k]; const sep = k.split('||'); const cliente = sep[0], afil = sep[1];
    const g = grupoPorNombre(cliente); const idGrupo = g ? g.id_grupo : null;
    const tasas = idGrupo ? tasasDe(idGrupo, afil) : null; const co = costosDe(afil); const cuenta = idGrupo ? cuentaDe(idGrupo, afil) : null;
    const cat = {
      tasas: tasas ? { pac_tdd: Number(tasas.tasa_pac_tdd), pac_tdc: Number(tasas.tasa_pac_tdc), pac_amex: Number(tasas.tasa_pac_amex), pac_int: Number(tasas.tasa_pac_int), costo_x_trx: Number(tasas.costo_x_trx), pct_banca: Number(tasas.pct_banca) } : {},
      costos: co ? { int_tdd: Number(co.int_tdd), int_tdc: Number(co.int_tdc), int_amex: co.int_amex == null ? null : Number(co.int_amex), int_int: co.int_int == null ? null : Number(co.int_int), fee_broxel: co.fee_broxel == null ? null : Number(co.fee_broxel) } : {},
    };
    // Buscar contracargos pendientes para esta afiliación (usando el nombre del grupo del catálogo).
    const nomGrupo = g ? g.nombre_cliente : cliente;
    const cDom = ccMap.get(`${nrm(nomGrupo)}||${afil}||DOM`) || { monto: 0, ids: [] };
    const cAmex = ccMap.get(`${nrm(nomGrupo)}||${afil}||AMEX`) || { monto: 0, ids: [] };
    const ajustes = { financiamientos: 0, contracargos_dom: E.round2(cDom.monto), contracargos_amex: E.round2(cAmex.monto) };
    const r = E.calcularCompensacion(arr, cat, params, ajustes);
    const faltantes = []; if (!g) faltantes.push('grupo'); if (!tasas) faltantes.push('tasas'); if (!co) faltantes.push('costos'); if (!cuenta && Math.abs(r.disp_total) > 0.005) faltantes.push('cuenta');
    calculos.push({
      cliente, afil, id_grupo: idGrupo, razon: g ? g.nombre_cliente : cliente, concepto: idGrupo ? E.concepto(afil, idGrupo) : '',
      clabe: cuenta ? cuenta.clabe : '', codigo_banco: cuenta ? (cuenta.codigo_banco || bancoCod(cuenta.banco)) : null, banco: cuenta ? cuenta.banco : '', beneficiario: cuenta ? (cuenta.razon_social_beneficiario || cuenta.nombre_comercial) : '',
      calc: r, faltantes, ajustes, contracargos_ids: [...cDom.ids, ...cAmex.ids],
    });
    // Marcar ids "usados" para descontarlos de los huérfanos y del ccMap.
    ccMap.delete(`${nrm(nomGrupo)}||${afil}||DOM`); ccMap.delete(`${nrm(nomGrupo)}||${afil}||AMEX`);
    total_comp += r.comp_total; total_disp += r.disp_total; total_monto += r.m_tdd + r.m_tdc + r.m_amex + r.m_int;
  }
  let cuadra = true; calculos.forEach(c => { if (Math.abs(c.calc.diferencia) > 0.01) cuadra = false; });
  const bloqueos = calculos.filter(c => Math.abs(c.calc.disp_total) > 0.005 && (!c.clabe || !c.codigo_banco)).length;
  // Contracargos cargados que no cruzaron con ninguna transacción del día → advertencia
  const ccNoAplicados = [];
  for (const [k, v] of ccMap.entries()) ccNoAplicados.push({ key: k, monto: v.monto, ids: v.ids });
  return { calculos, total_comp: E.round2(total_comp), total_disp: E.round2(total_disp), total_monto: E.round2(total_monto), n_trx: txs.length, cuadra, bloqueos, cc_no_aplicados: ccNoAplicados };
}

app.get('/api/cortes/fechas', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const rows = (await db.query("select fecha_liq::text as fecha_liq, count(*)::int n from transacciones where fecha_liq is not null and upper(estatus)='APROBADO' group by fecha_liq order by fecha_liq")).rows;
  const sinLiq = (await db.query("select count(*)::int n from transacciones where fecha_liq is null and upper(estatus)='APROBADO'")).rows[0].n;
  res.json({ fechas: rows.map(r => ({ iso: r.fecha_liq, n: r.n })), sinLiq });
});

app.post('/api/cortes', auth, requiereRol('admin', 'operador'), async (req, res) => {
  if (!dbReady(res)) return;
  const iso = (req.body || {}).fecha_liq; if (!iso) return res.status(400).json({ error: 'fecha_liq' });
  // BLINDAJE: el reporte de contracargos del día debe estar cargado (aunque venga vacío).
  const rep = (await db.query('select fecha, n_contracargos, monto_total from contracargos_reporte_dia where fecha=$1', [iso])).rows[0];
  if (!rep) return res.status(409).json({ error: 'reporte_contracargos_faltante', fecha: iso, mensaje: 'Debes cargar el reporte de contracargos de ' + iso + ' antes de generar el corte (aunque venga sin registros).' });
  const c = await computeCorte(iso);
  const ins = (await db.query('insert into cortes(fecha_liq,fecha_liq_iso,estado,creado_por,total_monto,total_comp,total_disp,n_trx,cuadra,bloqueos) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id_corte',
    [E.fmtFecha(E.parseFecha(iso)), iso, 'Borrador', req.user.nombre, c.total_monto, c.total_comp, c.total_disp, c.n_trx, c.cuadra, c.bloqueos])).rows[0];
  const idCorte = ins.id_corte;
  await insertMany('calculos', ['corte_id', 'cliente', 'afil', 'id_grupo', 'razon', 'concepto', 'clabe', 'codigo_banco', 'banco', 'beneficiario', 'calc', 'faltantes', 'ajustes', 'contracargos_ids'],
    c.calculos.map(cc => ({ corte_id: idCorte, cliente: cc.cliente, afil: cc.afil, id_grupo: cc.id_grupo, razon: cc.razon, concepto: cc.concepto, clabe: cc.clabe, codigo_banco: cc.codigo_banco, banco: cc.banco, beneficiario: cc.beneficiario, calc: JSON.stringify(cc.calc), faltantes: JSON.stringify(cc.faltantes), ajustes: JSON.stringify(cc.ajustes), contracargos_ids: JSON.stringify(cc.contracargos_ids || []) })));
  await bit(req, 'corte_generar', `${E.fmtFecha(E.parseFecha(iso))}, ${c.calculos.length} grupos, contracargos cargados=${rep.n_contracargos||0}`, { resource_type: 'corte', resource_id: idCorte });
  res.json({ id_corte: idCorte, contracargos_no_aplicados: c.cc_no_aplicados });
});

app.get('/api/cortes', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const rows = (await db.query('select * from cortes order by id_corte desc')).rows.map(c => ({ ...c, total_monto: Number(c.total_monto), total_comp: Number(c.total_comp), total_disp: Number(c.total_disp) }));
  res.json(rows);
});
app.get('/api/cortes/:id', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const c = (await db.query('select * from cortes where id_corte=$1', [parseInt(req.params.id, 10)])).rows[0];
  if (!c) return res.status(404).json({ error: 'no_existe' });
  const cal = (await db.query('select * from calculos where corte_id=$1 order by id', [c.id_corte])).rows;
  res.json({ corte: { ...c, total_monto: Number(c.total_monto), total_comp: Number(c.total_comp), total_disp: Number(c.total_disp) }, calculos: cal });
});

function transicionValida(estado, accion) {
  return (accion === 'validar' && estado === 'Borrador') || (accion === 'dispersar' && estado === 'Validado') || (accion === 'cerrar' && estado === 'Dispersado');
}
app.post('/api/cortes/:id/:accion', auth, async (req, res, next) => {
  // La ruta específica /notificar se define más abajo — dejarla pasar.
  if (req.params.accion === 'notificar') return next();
  if (!dbReady(res)) return;
  const accion = req.params.accion; if (!['validar', 'dispersar', 'cerrar'].includes(accion)) return res.status(404).json({ error: 'accion' });
  // Segregación de funciones: tesorería valida, bancos dispersa y cierra. Admin puede todo.
  const rolOk = accion === 'validar' ? ['admin', 'tesoreria'] : accion === 'dispersar' ? ['admin', 'bancos'] : ['admin', 'bancos'];
  if (!rolOk.includes(req.user.rol)) return res.status(403).json({ error: 'rol_no_autorizado', necesita: rolOk });
  const c = (await db.query('select * from cortes where id_corte=$1', [parseInt(req.params.id, 10)])).rows[0];
  if (!c) return res.status(404).json({ error: 'no_existe' });
  if (['Dispersado', 'Cerrado'].includes(c.estado) && accion !== 'cerrar') return res.status(409).json({ error: 'corte_inmutable', estado: c.estado });
  if (!transicionValida(c.estado, accion)) return res.status(409).json({ error: 'transicion_invalida', estado: c.estado });
  if (accion === 'validar') {
    if (!c.cuadra || c.bloqueos) return res.status(409).json({ error: 'no_cuadra_o_bloqueado' });
    await db.query('update cortes set estado=$1,validado_por=$2 where id_corte=$3', ['Validado', req.user.nombre, c.id_corte]);
    // Marcar contracargos como Aplicado a este corte
    await db.query("update contracargos set estatus='Aplicado', aplicado_en_corte_id=$1 where id in (select cc::int from calculos, jsonb_array_elements_text(coalesce(contracargos_ids,'[]'::jsonb)) as cc where corte_id=$1)", [c.id_corte]);
  }
  if (accion === 'dispersar') await db.query('update cortes set estado=$1,dispersado_por=$2 where id_corte=$3', ['Dispersado', req.user.nombre, c.id_corte]);
  if (accion === 'cerrar') await db.query('update cortes set estado=$1 where id_corte=$2', ['Cerrado', c.id_corte]);
  await bit(req, 'corte_' + accion, `estado→${accion === 'validar' ? 'Validado' : accion === 'dispersar' ? 'Dispersado' : 'Cerrado'}`, { resource_type: 'corte', resource_id: c.id_corte });
  res.json({ ok: true });
});
app.delete('/api/cortes', auth, requiereRol('admin', 'operador'), async (req, res) => {
  if (!dbReady(res)) return;
  // Devolver contracargos Aplicados a Pendiente al vaciar cortes
  await db.query("update contracargos set estatus='Pendiente', aplicado_en_corte_id=null where estatus='Aplicado'");
  await db.query('delete from cortes'); await bit(req, 'corte', 'vació cortes'); res.json({ ok: true });
});
// Eliminar un corte individual (borra sus cálculos por FK cascade)
app.delete('/api/cortes/:id', auth, requiereRol('admin', 'operador'), async (req, res) => {
  if (!dbReady(res)) return;
  const id = parseInt(req.params.id, 10);
  const c = (await db.query('select estado from cortes where id_corte=$1', [id])).rows[0];
  if (!c) return res.status(404).json({ error: 'no_existe' });
  // Devolver a Pendiente los contracargos que este corte había marcado Aplicado
  await db.query("update contracargos set estatus='Pendiente', aplicado_en_corte_id=null where aplicado_en_corte_id=$1", [id]);
  await db.query('delete from cortes where id_corte=$1', [id]);
  await bit(req, 'corte_baja', `estado ${c.estado}`, { resource_type: 'corte', resource_id: id });
  res.json({ ok: true });
});

/* ---------- descargas .xlsx (generadas por el server) ---------- */
function enviarXLSX(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}
app.get('/api/cortes/:id/layout.xlsx', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const c = (await db.query('select *, fecha_liq_iso::text as fli from cortes where id_corte=$1', [parseInt(req.params.id, 10)])).rows[0];
  if (!c) return res.status(404).json({ error: 'no_existe' });
  const cal = (await db.query('select * from calculos where corte_id=$1', [c.id_corte])).rows
    .map(x => ({ ...x, calc: typeof x.calc === 'string' ? JSON.parse(x.calc) : x.calc }));
  // Órdenes de dispersión SEPARADAS: primero doméstico (nacional/INT), luego AMEX (aparte).
  // AMEX usa concepto DISPERSION <ult3>CPPXAMEX00<id_grupo>.
  const dom = [], amex = [];
  for (const x of cal) {
    const r = x.calc;
    if (Math.abs(r.disp_dom) > 0.005) dom.push({ concepto: x.concepto, clabe: x.clabe, cod: x.codigo_banco, benef: x.beneficiario, cant: E.round2(r.disp_dom), razon: x.razon, afil: x.afil });
    if (Math.abs(r.disp_amex) > 0.005) amex.push({ concepto: `DISPERSION ${E.ult3(x.afil)}CPPXAMEX00${x.id_grupo}`, clabe: x.clabe, cod: x.codigo_banco, benef: x.beneficiario, cant: E.round2(r.disp_amex), razon: x.razon, afil: x.afil });
  }
  const orders = [...dom, ...amex];
  const bloq = orders.filter(o => !o.clabe || !o.cod);
  if (bloq.length) return res.status(409).json({ error: 'bloqueado', detalle: bloq.map(o => ({ razon: o.razon, afil: o.afil, importe: o.cant, falta: !o.clabe ? 'CLABE' : 'codigo_banco' })) });
  // Plantilla LAYOUT (dispersor): 8 columnas. Se llenan solo las que tenemos; el resto en blanco.
  const head = [
    'Concepto',
    'Cuenta clabe del beneficiario',
    'Código del banco del beneficiario',
    'Nombre del beneficiario',
    'RFC o CURP del beneficiario',
    'Cantidad',
    'Referencia numérica',
    'Fecha de pago (Opcional, solo para transacciones futuras) Formato YYYY-mm-dd HH:mm',
  ];
  // Referencia numérica: "1" + DDMMYY del día en que se genera (zona Mexico_City). Ej: 05/08/26 -> 1050826
  const pz = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const gp = t => (pz.find(p => p.type === t) || {}).value || '';
  const referencia = Number(`1${gp('day')}${gp('month')}${gp('year')}`);
  // Nombre del beneficiario = nombre del GRUPO DE CLIENTE (o.razon)
  const rows = orders.map(o => [o.concepto, String(o.clabe), Number(o.cod) || o.cod, o.razon, '', o.cant, referencia, '']);
  await bit(req, 'layout', `exportó layout corte #${c.id_corte} (${orders.length} órdenes: ${dom.length} dom + ${amex.length} AMEX)`);
  enviarXLSX(res, `layout_spei_corte_${c.id_corte}_${c.fli}.xlsx`, X.buildXLSX([{ name: 'LAYOUT', aoa: [head, ...rows], cols: [{ wch: 22 }, { wch: 22 }, { wch: 16 }, { wch: 28 }, { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 40 }] }]));
});
app.get('/api/cortes/:id/reporte.xlsx', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const c = (await db.query('select *, fecha_liq_iso::text as fli from cortes where id_corte=$1', [parseInt(req.params.id, 10)])).rows[0];
  if (!c) return res.status(404).json({ error: 'no_existe' });
  const cal = (await db.query('select * from calculos where corte_id=$1', [c.id_corte])).rows.map(x => ({ ...x, calc: typeof x.calc === 'string' ? JSON.parse(x.calc) : x.calc }));
  await bit(req, 'reporte', `exportó reporte corte #${c.id_corte}`);
  const buf = await buildReporteXLSX(c, cal);
  enviarXLSX(res, `reporte_cliente_corte_${c.id_corte}_${c.fli}.xlsx`, buf);
});

// Reporte por cliente con el formato+estilo de PLANTILLA REPORTE.xlsx.
// Se usa exceljs (soporta estilos: fill/font/align/border/numFmt/freeze).
async function buildReporteXLSX(c, cal) {
  // Fecha larga en español: "06 de agosto de 2026"
  const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const iso = c.fli || (c.fecha_liq_iso && String(c.fecha_liq_iso).slice(0,10));
  const [ay, am, ad] = String(iso || '').split('-');
  const fechaLarga = ay ? `${ad} de ${MESES[+am - 1]} de ${ay}` : (c.fecha_liq || '');
  const N = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
  const hoyStr = (function(){ const p=N.formatToParts(new Date()); const g=t=>(p.find(x=>x.type===t)||{}).value; return `${g('day')}/${g('month')}/${g('year')}`; })();

  const head = ['Grupo','Afiliación','Concepto','Monto','Débito','Crédito','American Express','Internacional','A Compensar','Banca + IVA','A Dispersar','Diferencia'];
  const dataRows = cal.map(x => { const r = x.calc; return [
    x.razon,
    String(x.afil),
    x.concepto,
    E.round2(r.m_tdd + r.m_tdc + r.m_amex + r.m_int),
    E.round2(r.m_tdd),
    E.round2(r.m_tdc),
    E.round2(r.m_amex),
    E.round2(r.m_int),
    E.round2(r.comp_total),
    E.round2(r.banca + r.iva_banca),
    E.round2(r.disp_total),
    E.round2(r.diferencia),
  ]; });
  // Fila TOTAL
  const sumaBanca = cal.reduce((s, x) => s + (Number(x.calc.banca||0) + Number(x.calc.iva_banca||0)), 0);
  const totalRow = ['TOTAL','','',
    Number(c.total_monto),
    E.round2(cal.reduce((s,x)=>s+Number(x.calc.m_tdd||0),0)),
    E.round2(cal.reduce((s,x)=>s+Number(x.calc.m_tdc||0),0)),
    E.round2(cal.reduce((s,x)=>s+Number(x.calc.m_amex||0),0)),
    E.round2(cal.reduce((s,x)=>s+Number(x.calc.m_int||0),0)),
    Number(c.total_comp),
    E.round2(sumaBanca),
    Number(c.total_disp),
    '',
  ];

  // Colores/estilos de la plantilla original
  const AZUL_MARINO = 'FF051B3B';  // fila POLIPAY
  const AZUL_HEADER = 'FF3083F4';  // banda header + subtítulo
  const GRIS_META   = 'FF667085';  // corte + fecha, pie
  const NEGRO_TXT   = 'FF1A1A1A';  // texto datos
  const BLANCO      = 'FFFFFFFF';
  const FONT_NAME   = 'Montserrat';
  const NUMFMT      = '"$"#,##0.00;[Red]("$"#,##0.00);-';

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Polipay POS Settlement';
  const ws = wb.addWorksheet('Reporte por cliente', { views: [{ state: 'frozen', ySplit: 5 }] });

  // Anchos de columna (los de la plantilla)
  ws.columns = [
    { width: 24 }, { width: 13 }, { width: 24 }, { width: 15 },
    { width: 14 }, { width: 13 }, { width: 13 }, { width: 13 },
    { width: 15 }, { width: 14 }, { width: 15 }, { width: 13 },
  ];

  const fill = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });
  const setStyle = (row, opts) => {
    if (opts.height) row.height = opts.height;
    for (let col = 1; col <= 12; col++) {
      const cell = row.getCell(col);
      if (opts.fill) cell.fill = fill(opts.fill);
      if (opts.font) cell.font = Object.assign({ name: FONT_NAME }, opts.font);
      if (opts.align) cell.alignment = opts.align;
      if (opts.numFmt) cell.numFmt = opts.numFmt;
    }
  };

  // Fila 1: POLIPAY
  const r1 = ws.addRow(['POLIPAY']); ws.mergeCells('A1:L1');
  setStyle(r1, { height: 33.75, fill: AZUL_MARINO, font: { color: { argb: BLANCO }, bold: true, size: 20, name: FONT_NAME }, align: { horizontal: 'left', vertical: 'middle', indent: 1 } });

  // Fila 2: subtítulo
  const r2 = ws.addRow(['Reporte por Cliente  ·  Agregado por grupo y afiliación']); ws.mergeCells('A2:L2');
  setStyle(r2, { height: 21.75, fill: BLANCO, font: { color: { argb: AZUL_HEADER }, bold: true, size: 12, name: FONT_NAME }, align: { horizontal: 'left', vertical: 'middle', indent: 1 } });

  // Fila 3: corte + fecha
  const r3 = ws.addRow([`Corte ${c.id_corte}   |   ${fechaLarga}   |   Generado ${hoyStr}`]); ws.mergeCells('A3:L3');
  setStyle(r3, { height: 15.75, fill: BLANCO, font: { color: { argb: GRIS_META }, size: 9, name: FONT_NAME }, align: { horizontal: 'left', vertical: 'middle', indent: 1 } });

  // Fila 4: separador
  const r4 = ws.addRow(['']); ws.mergeCells('A4:L4');
  setStyle(r4, { height: 3.75, fill: BLANCO });

  // Fila 5: encabezados
  const r5 = ws.addRow(head);
  r5.height = 30;
  for (let col = 1; col <= 12; col++) {
    const cell = r5.getCell(col);
    cell.fill = fill(AZUL_HEADER);
    cell.font = { name: FONT_NAME, color: { argb: BLANCO }, bold: true, size: 10 };
    cell.alignment = { horizontal: col <= 3 ? 'left' : 'center', vertical: 'middle', indent: col <= 3 ? 1 : 0 };
  }

  // Filas de datos
  for (const dr of dataRows) {
    const rr = ws.addRow(dr); rr.height = 18;
    for (let col = 1; col <= 12; col++) {
      const cell = rr.getCell(col);
      cell.fill = fill(BLANCO);
      cell.font = { name: FONT_NAME, color: { argb: NEGRO_TXT }, size: 10 };
      if (col <= 3) cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      else { cell.alignment = { horizontal: 'right', vertical: 'middle' }; cell.numFmt = NUMFMT; }
    }
  }

  // Fila TOTAL
  const rt = ws.addRow(totalRow); rt.height = 22;
  for (let col = 1; col <= 12; col++) {
    const cell = rt.getCell(col);
    cell.fill = fill(BLANCO);
    cell.font = { name: FONT_NAME, color: { argb: NEGRO_TXT }, bold: true, size: 10 };
    if (col <= 3) cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    else { cell.alignment = { horizontal: 'right', vertical: 'middle' }; cell.numFmt = NUMFMT; }
    cell.border = { top: { style: 'thin', color: { argb: 'FFE4E6E7' } } };
  }

  // Separador antes del pie
  ws.addRow(['']).height = 8;

  // Pie
  const rp = ws.addRow([`Polipay POS Settlement · Generado ${hoyStr} por ${c.creado_por || '—'}   ·   Todas las cifras en MXN`]);
  const pieRow = rp.number; ws.mergeCells(`A${pieRow}:L${pieRow}`);
  setStyle(rp, { height: 25.5, font: { color: { argb: GRIS_META }, size: 8, name: FONT_NAME }, align: { horizontal: 'left', vertical: 'top', indent: 1 } });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/* ============================================================================
   CONTABLE — Registro contable (pólizas) por rango de fecha de liquidación
   Ingresos por comisión (tasa pactada + IVA) por producto (TDD/TDC/AMEX/INT),
   dispersión, e ingreso por banca (Telematic) + IVA. Por FECHA + AFILIACIÓN.
   ========================================================================= */
async function computeContable(desde, hasta) {
  const txs = (await db.query("select fecha_liq::text as fl, cliente, numero_afiliacion, producto, monto from transacciones where fecha_liq between $1 and $2 and upper(estatus)='APROBADO' order by fecha_liq", [desde, hasta])).rows;
  const [params, grupos, afilGrupo, costos, afiliaciones] = [await getParams(), await getGrupos(), await getAfilGrupo(), await getCostos(), await getAfiliaciones()];
  const grupoPorNombre = nombre => grupos.find(g => nrm(g.nombre_cliente) === nrm(nombre));
  const tasasDe = (idg, afil) => afilGrupo.find(a => String(a.id_grupo) === String(idg) && String(a.numero_afiliacion) === String(afil));
  const costosDe = afil => costos.find(c => String(c.numero_afiliacion) === String(afil));
  const razonDe = afil => { const a = afiliaciones.find(x => String(x.numero_afiliacion) === String(afil)); return a ? (a.razon_social || '') : ''; };
  const groups = {};
  for (const t of txs) { const k = `${t.fl}||${t.cliente}||${t.numero_afiliacion}`; (groups[k] = groups[k] || []).push({ producto: t.producto, monto: Number(t.monto) }); }
  const rows = [];
  for (const k of Object.keys(groups)) {
    const sep = k.split('||'); const fl = sep[0], cliente = sep[1], afil = sep[2];
    const g = grupoPorNombre(cliente); const idGrupo = g ? g.id_grupo : null;
    const tasas = idGrupo ? tasasDe(idGrupo, afil) : null; const co = costosDe(afil);
    const cat = {
      tasas: tasas ? { pac_tdd: Number(tasas.tasa_pac_tdd), pac_tdc: Number(tasas.tasa_pac_tdc), pac_amex: Number(tasas.tasa_pac_amex), pac_int: Number(tasas.tasa_pac_int), costo_x_trx: Number(tasas.costo_x_trx), pct_banca: Number(tasas.pct_banca) } : {},
      costos: co ? { int_tdd: Number(co.int_tdd), int_tdc: Number(co.int_tdc), int_amex: co.int_amex == null ? null : Number(co.int_amex), int_int: co.int_int == null ? null : Number(co.int_int), fee_broxel: co.fee_broxel == null ? null : Number(co.fee_broxel) } : {},
    };
    const r = E.calcularCompensacion(groups[k], cat, params, {});
    rows.push({ fl, afil, razon: razonDe(afil) || cliente,
      com_tdd: r.com_tdd, iva_tdd: r.iva_com_tdd, com_tdc: r.com_tdc, iva_tdc: r.iva_com_tdc,
      com_amex: r.com_amex, iva_amex: r.iva_com_amex, com_int: r.com_int, iva_int: r.iva_com_int,
      disp: r.disp_total, banca: r.banca, iva_banca: r.iva_banca });
  }
  rows.sort((a, b) => a.fl < b.fl ? -1 : a.fl > b.fl ? 1 : (String(a.afil) < String(b.afil) ? -1 : 1));
  return rows;
}
app.get('/api/contable/resumen', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const { desde, hasta } = req.query; if (!desde || !hasta) return res.status(400).json({ error: 'rango' });
  const rows = await computeContable(desde, hasta);
  const S = k => E.round2(rows.reduce((a, r) => a + (r[k] || 0), 0));
  res.json({ nRows: rows.length, afiliaciones: new Set(rows.map(r => r.afil)).size,
    totales: { com_tdd: S('com_tdd'), iva_tdd: S('iva_tdd'), com_tdc: S('com_tdc'), iva_tdc: S('iva_tdc'), com_amex: S('com_amex'), iva_amex: S('iva_amex'), com_int: S('com_int'), iva_int: S('iva_int'), disp: S('disp'), banca: S('banca'), iva_banca: S('iva_banca') } });
});
app.get('/api/contable.xlsx', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const { desde, hasta } = req.query; if (!desde || !hasta) return res.status(400).json({ error: 'rango' });
  const rows = await computeContable(desde, hasta);
  const ddmmyyyy = iso => { const f = E.parseFecha(iso); return f ? `${String(f.getDate()).padStart(2, '0')} ${String(f.getMonth() + 1).padStart(2, '0')} ${f.getFullYear()}` : iso; };
  // Encabezado de 2 filas con celdas combinadas (como la plantilla de referencia)
  const h1 = ['FECHA', 'AFILIACIÓN', 'RAZON SOCIAL', 'INGRESOS POR COMISION MCEB', '', '', '', '', '', '', '', 'DISPERSION DE MCEB', 'INGRESO POR COMISION TELEMATIC', ''];
  const h2 = ['', '', '', 'TDD', 'IVA', 'TDC', 'IVA', 'AMEX', 'IVA', 'INTERNACIONAL', 'IVA', '', 'BANCA', 'IVA'];
  // Valores en precisión contable completa. Se limpia solo el ruido de punto flotante
  // (redondeo a 10 decimales) sin perder precisión: 175.00000000000003 -> 175.
  const r10 = v => Math.round((Number(v) || 0) * 1e10) / 1e10;
  const data = rows.map(r => [ddmmyyyy(r.fl), String(r.afil), r.razon,
    r10(r.com_tdd), r10(r.iva_tdd), r10(r.com_tdc), r10(r.iva_tdc), r10(r.com_amex), r10(r.iva_amex), r10(r.com_int), r10(r.iva_int),
    r10(r.disp), r10(r.banca), r10(r.iva_banca)]);
  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }, { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } }, { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
    { s: { r: 0, c: 3 }, e: { r: 0, c: 10 } }, { s: { r: 0, c: 11 }, e: { r: 1, c: 11 } }, { s: { r: 0, c: 12 }, e: { r: 0, c: 13 } },
  ];
  const cols = [{ wch: 12 }, { wch: 12 }, { wch: 28 }].concat(Array(11).fill({ wch: 13 }));
  await bit(req, 'contable', `registro contable ${desde}..${hasta} (${rows.length} filas)`);
  // Formato de contabilidad (signo de pesos) en las columnas de importes (D..N = índices 3..13),
  // desde la fila de datos (índice 2). El valor guardado conserva su precisión completa.
  const fmt = { z: '"$"#,##0.00######', cols: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], rowFrom: 2 };
  enviarXLSX(res, `registro_contable_${desde}_a_${hasta}.xlsx`, X.buildXLSX([{ name: 'REGISTROS CONTABLES', aoa: [h1, h2, ...data], merges, cols, fmt }]));
});

/* ============================================================================
   CONTRACARGOS — Sección Operación → Contracargos.
   Se suben los reportes de "contracargos a retener" que ya genera el sistema
   externo. Cada reporte se guarda con su cargado_en_fecha (default: hoy MX,
   editable). El corte requiere que exista al menos una carga (aunque venga
   con 0 renglones) para su fecha.
   ========================================================================= */
function bloqueFromMarca(m) {
  const s = E.normStr(m || '');
  return (s === 'amex' || s === 'american express' || s === 'americanexpress' || s === 'ax') ? 'AMEX' : 'DOM';
}
function limpiaGrupo(g) {
  return String(g || '').replace(/^(grupo|group)\s+/i, '').trim();
}
async function getContracargoResumen(fecha) {
  const rep = (await db.query('select * from contracargos_reporte_dia where fecha=$1', [fecha])).rows[0];
  const items = (await db.query('select * from contracargos where cargado_en_fecha=$1 order by id', [fecha])).rows
    .map(x => ({ ...x, monto: Number(x.monto) }));
  return { fecha, reporte: rep || null, items };
}
app.get('/api/contracargos', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const fecha = req.query.fecha; if (!fecha) return res.status(400).json({ error: 'fecha' });
  res.json(await getContracargoResumen(fecha));
});
app.get('/api/contracargos/dias', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const rows = (await db.query('select r.fecha::text as fecha, r.n_contracargos, r.monto_total, r.cargado_por, r.cargado_at, (select count(*)::int from contracargos c where c.cargado_en_fecha=r.fecha and c.estatus=\'Pendiente\') as pendientes, (select count(*)::int from contracargos c where c.cargado_en_fecha=r.fecha and c.estatus=\'Aplicado\') as aplicados from contracargos_reporte_dia r order by r.fecha desc')).rows;
  res.json(rows);
});
// Huérfanos: pendientes con fecha < hoy (o < fecha específica)
app.get('/api/contracargos/huerfanos', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const antesDe = req.query.antes_de || new Date().toISOString().slice(0, 10);
  const rows = (await db.query("select cargado_en_fecha::text as fecha, count(*)::int as n, coalesce(sum(monto),0) as monto from contracargos where estatus='Pendiente' and cargado_en_fecha < $1 group by cargado_en_fecha order by cargado_en_fecha", [antesDe])).rows
    .map(r => ({ ...r, monto: Number(r.monto) }));
  res.json(rows);
});
// Ingesta del reporte (multipart: archivo + fecha)
app.post('/api/contracargos/ingesta', auth, requiereRol('admin', 'operador'), upload.single('archivo'), validaArchivo, async (req, res) => {
  if (!dbReady(res)) return;
  const fecha = (req.body && req.body.fecha) || null;
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha' });
  if (!req.file) return res.status(400).json({ error: 'archivo' });
  // Leer el buffer con SheetJS directamente (encabezados en fila 4, no aoaToObjects estándar)
  const XLSXlib = require('xlsx');
  const wb = XLSXlib.read(req.file.buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSXlib.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  // Buscar la fila del header (que contiene "Folio")
  let hdrRow = -1;
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    if (aoa[i] && aoa[i].some(v => String(v || '').trim().toLowerCase() === 'folio')) { hdrRow = i; break; }
  }
  if (hdrRow < 0) return res.status(400).json({ error: 'formato_reporte' });
  const head = aoa[hdrRow].map(h => E.normStr(h).replace(/\s+/g, ' '));
  const col = name => head.indexOf(E.normStr(name).replace(/\s+/g, ' '));
  const iFolio = col('Folio'), iFecReg = col('Fecha registro'), iAfil = col('Afiliación'), iComercio = col('Comercio'),
        iGrupo = col('Grupo de cliente'), iMarca = col('Marca'), iCanal = col('Canal'), iCodRazon = col('Código razón'),
        iCat = col('Categoría'), iMonto = col('Monto a retener'), iMoneda = col('Moneda'), iTicket = col('Ticket'),
        iAut = col('Autorización'), iU4 = col('Últimos 4'), iCaso = col('Caso / ARN'), iFecCbk = col('Fecha CBK'),
        iLim = col('Límite representment'), iEstado = col('Estado');
  const filas = [];
  for (let i = hdrRow + 1; i < aoa.length; i++) {
    const r = aoa[i]; if (!r) continue;
    const folio = String(r[iFolio] || '').trim();
    if (!folio || folio.toLowerCase() === 'total') continue;
    if (!/^cb/i.test(folio)) continue;
    const monto = E.parseMonto(iMonto >= 0 ? r[iMonto] : 0);
    const marca = String(r[iMarca] || '').trim().toUpperCase();
    filas.push({
      folio, fecha_registro: String(r[iFecReg] || ''), afil: String(r[iAfil] || '').replace(/\D/g, ''),
      comercio: String(r[iComercio] || ''), grupo: limpiaGrupo(r[iGrupo] || ''), marca,
      bloque: bloqueFromMarca(marca), canal: String(r[iCanal] || ''), codigo_razon: String(r[iCodRazon] || ''),
      categoria: String(r[iCat] || ''), monto, moneda: String(r[iMoneda] || ''),
      ticket: String(r[iTicket] || ''), aut: String(r[iAut] || ''), u4: String(r[iU4] || ''),
      caso: String(r[iCaso] || ''), fecha_cbk: String(r[iFecCbk] || ''), limite: String(r[iLim] || ''),
      estado: String(r[iEstado] || ''),
    });
  }
  // Upsert reporte-del-día (constancia)
  const total = filas.reduce((s, f) => s + f.monto, 0);
  // Dual-write: bytea claro + bytea cifrado (mismo Buffer, cifrado por lib/crypto).
  const archivoCif = C.ready() ? Buffer.from(C.encrypt(req.file.buffer), 'utf8') : null;
  await db.query(
    `insert into contracargos_reporte_dia(fecha,n_contracargos,monto_total,archivo_origen,archivo_bytes,archivo_bytes_cifrado,archivo_mime,cargado_por,cargado_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (fecha) do update set n_contracargos=excluded.n_contracargos, monto_total=excluded.monto_total, archivo_origen=excluded.archivo_origen, archivo_bytes=excluded.archivo_bytes, archivo_bytes_cifrado=excluded.archivo_bytes_cifrado, archivo_mime=excluded.archivo_mime, cargado_por=excluded.cargado_por, cargado_at=now()`,
    [fecha, filas.length, E.round2(total), req.file.originalname || '', req.file.buffer, archivoCif, req.file.mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', req.user.nombre]
  );
  // Upsert contracargos por origen_folio
  let insertados = 0, actualizados = 0, ignorados = 0;
  for (const f of filas) {
    // Si ya está Aplicado, no toca (avisa)
    const exist = (await db.query('select estatus from contracargos where origen_folio=$1', [f.folio])).rows[0];
    if (exist && exist.estatus === 'Aplicado') { ignorados++; continue; }
    const cols = ['origen_folio', 'cargado_en_fecha', 'fecha_registro', 'numero_afiliacion', 'comercio', 'grupo_cliente', 'marca', 'bloque', 'canal', 'codigo_razon', 'categoria', 'monto', 'moneda', 'ticket', 'autorizacion', 'ultimos_4', 'ultimos_4_cifrada', 'caso_arn', 'fecha_cbk', 'limite_representment', 'estado_origen', 'archivo_origen', 'creado_por'];
    const vals = [f.folio, fecha, f.fecha_registro, f.afil, f.comercio, f.grupo, f.marca, f.bloque, f.canal, f.codigo_razon, f.categoria, f.monto, f.moneda, f.ticket, f.aut, f.u4, C.encrypt(f.u4), f.caso, f.fecha_cbk, f.limite, f.estado, req.file.originalname || '', req.user.nombre];
    if (exist) {
      const sets = cols.slice(1).map((c, i) => c + '=$' + (i + 2)).join(',');
      await db.query('update contracargos set ' + sets + ' where origen_folio=$1', vals);
      actualizados++;
    } else {
      const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
      await db.query('insert into contracargos(' + cols.join(',') + ') values(' + ph + ')', vals);
      insertados++;
    }
  }
  await bit(req, 'contracargos', `carga ${fecha}: ${insertados} nuevos, ${actualizados} actualizados, ${ignorados} ya aplicados (total ${filas.length}, monto ${E.round2(total)})`);
  res.json({ fecha, filas: filas.length, insertados, actualizados, ignorados, monto_total: E.round2(total) });
});
app.delete('/api/contracargos/:id', auth, requiereRol('admin', 'operador'), async (req, res) => {
  if (!dbReady(res)) return;
  const id = parseInt(req.params.id, 10);
  const c = (await db.query('select estatus from contracargos where id=$1', [id])).rows[0];
  if (!c) return res.status(404).json({ error: 'no_existe' });
  if (c.estatus === 'Aplicado') return res.status(409).json({ error: 'ya_aplicado' });
  await db.query('delete from contracargos where id=$1', [id]);
  await bit(req, 'contracargos', `eliminó contracargo #${id}`);
  res.json({ ok: true });
});

/* ============================================================================
   INFORME DEL CORTE POR CORREO (Amazon SES)
   Genera el HTML del informe con marca Polipay. Endpoint preview HTML sin envío
   real (para verificar visual). El envío por SES se activará cuando estén las
   credenciales en el entorno (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION).
   ========================================================================= */
function fmtMXN(n){ return new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(Number(n)||0); }
function fmtInt(n){ return new Intl.NumberFormat('es-MX').format(Number(n)||0); }
function fmtDT(iso){ try{ return new Date(iso).toLocaleString('es-MX'); }catch(_){ return iso||''; } }

async function armarInformeHTML(idCorte, opts) {
  const logoSrc = (opts && opts.logoSrc) || '/public/logo.png';
  const c = (await db.query('select *, fecha_liq_iso::text as fli from cortes where id_corte=$1', [idCorte])).rows[0];
  if (!c) throw new Error('corte_no_existe');
  const cal = (await db.query('select * from calculos where corte_id=$1 order by id', [c.id_corte])).rows
    .map(x => ({ ...x, calc: typeof x.calc === 'string' ? JSON.parse(x.calc) : x.calc, ajustes: typeof x.ajustes === 'string' ? JSON.parse(x.ajustes) : x.ajustes }));
  // Top 5 por disp_total
  const top = [...cal].sort((a, b) => Math.abs(b.calc.disp_total) - Math.abs(a.calc.disp_total)).slice(0, 5);
  // Totales
  const tCC = cal.reduce((s, x) => s + (Number(x.ajustes.contracargos_dom || 0) + Number(x.ajustes.contracargos_amex || 0)), 0);
  const tUtil = cal.reduce((s, x) => s + Number(x.calc.utilidad || 0), 0);
  const cuadra = c.cuadra;
  const marca = cuadra ? '✓' : '✗';
  const estadoBadge = { Borrador: '#707070', Validado: '#157BF6', Dispersado: '#7C5CE6', Cerrado: '#4BB543' }[c.estado] || '#707070';

  const subject = `[Conciliación T+1] Corte #${c.id_corte} — liq ${c.fecha_liq} — A dispersar ${fmtMXN(c.total_disp)} ${marca}`;

  // Colores marca Polipay
  const brand = '#04003A', accent = '#157BF6', bandaAccent = '#157BF6', line = '#E4E6E7', ink = '#04003A', muted = '#707070', bg = '#F5F7FA', softBlue = '#EDF3FE';

  // Banda de sección azul (título blanco sobre fondo azul)
  const banda = titulo => `
    <tr><td style="background:${bandaAccent};padding:10px 16px;font:700 12px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">${titulo}</td></tr>`;

  // Celda KPI (usada dentro de una tabla de 4 columnas)
  const kpi = (label, value) => `
    <td style="padding:14px 16px;background:#fff;border-right:1px solid ${line};vertical-align:top;width:25%">
      <div style="font:600 11px/1.2 Montserrat,Arial,sans-serif;color:${muted};letter-spacing:.06em;text-transform:uppercase">${label}</div>
      <div style="font:700 20px/1.2 Montserrat,Arial,sans-serif;color:${ink};margin-top:6px;font-variant-numeric:tabular-nums">${value}</div>
    </td>`;

  // Fila del top 5 (fondo alternado como en el PDF)
  const topRow = (t, i) => `
    <tr>
      <td style="padding:10px 16px;background:${i%2?'#F7FAFF':'#fff'};font:700 13px/1.4 Montserrat,Arial,sans-serif;color:${ink}">${escapeHtml(t.razon)}</td>
      <td style="padding:10px 16px;background:${i%2?'#F7FAFF':'#fff'};font:400 13px/1.4 Montserrat,Arial,sans-serif;color:${ink};font-variant-numeric:tabular-nums">${escapeHtml(t.afil)}</td>
      <td style="padding:10px 16px;background:${i%2?'#F7FAFF':'#fff'};font:400 13px/1.4 Montserrat,Arial,sans-serif;color:${ink}">${escapeHtml(t.concepto||'')}</td>
      <td align="right" style="padding:10px 16px;background:${i%2?'#F7FAFF':'#fff'};font:700 13px/1.4 Montserrat,Arial,sans-serif;color:${ink};font-variant-numeric:tabular-nums">${fmtMXN(t.calc.disp_total)}</td>
    </tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:${bg};font-family:Montserrat,-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:${ink}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;margin:0 auto;background:#fff">

    <!-- Encabezado con logo y eyebrow -->
    <tr>
      <td style="padding:22px 32px 14px;border-bottom:3px solid ${brand}">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          <td><img src="${logoSrc}" alt="Polipay" height="34" style="display:block;height:34px;width:auto;border:0;outline:none;text-decoration:none"/></td>
          <td align="right" style="line-height:1.35">
            <div style="font:700 12px/1.2 Montserrat,Arial,sans-serif;color:${accent};letter-spacing:.09em;text-transform:uppercase">Polipay POS Settlement</div>
            <div style="font:400 11px/1.2 Montserrat,Arial,sans-serif;color:${muted};letter-spacing:.02em;text-transform:uppercase;margin-top:3px">Aviso automático de corte</div>
          </td>
        </tr></table>
      </td>
    </tr>

    <!-- Título -->
    <tr>
      <td style="padding:28px 32px 4px;font:800 30px/1.15 Montserrat,Arial,sans-serif;color:${ink}">Corte #${c.id_corte} · Liquidación ${escapeHtml(c.fecha_liq)}</td>
    </tr>
    <tr>
      <td style="padding:10px 32px 22px;font:600 11px/1 Montserrat,Arial,sans-serif;color:${muted};letter-spacing:.06em;text-transform:uppercase">
        Estado: <span style="display:inline-block;padding:6px 12px;border-radius:6px;background:${softBlue};color:${accent};font-weight:700;letter-spacing:.06em;margin:0 6px">${escapeHtml((c.estado||'').toUpperCase())}</span>
        &nbsp;|&nbsp; Cuadre: <span style="color:${cuadra?accent:'#CC0000'};font-weight:700">${cuadra?'✓ diferencia 0.00':'✗ revisar'}</span>
      </td>
    </tr>

    <!-- Información del corte -->
    <tr><td style="padding:0 32px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${line};border-collapse:collapse">
        ${banda('Información del corte')}
        <tr><td style="padding:0">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            ${kpi('Transacciones', fmtInt(c.n_trx))}
            ${kpi('Grupos', fmtInt(cal.length))}
            ${kpi('A compensar', '$ ' + fmtMXN(c.total_comp).replace('$',''))}
            ${kpi('A dispersar', '$ ' + fmtMXN(c.total_disp).replace('$',''))}
          </tr></table>
        </td></tr>
      </table>
    </td></tr>

    <!-- Información financiera -->
    <tr><td style="padding:22px 32px 0">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${line};border-collapse:collapse">
        ${banda('Información financiera')}
        <tr>
          <td style="padding:14px 16px;background:#fff;font:400 14px/1.4 Montserrat,Arial,sans-serif;color:${ink}">Contracargos aplicados</td>
          <td align="right" style="padding:14px 16px;background:#fff;font:700 14px/1.4 Montserrat,Arial,sans-serif;color:${ink};font-variant-numeric:tabular-nums">$ ${fmtMXN(tCC).replace('$','')}</td>
        </tr>
        <tr>
          <td style="padding:14px 16px;background:${softBlue};border-top:1px solid ${line};font:400 14px/1.4 Montserrat,Arial,sans-serif;color:${ink}">Utilidad</td>
          <td align="right" style="padding:14px 16px;background:${softBlue};border-top:1px solid ${line};font:700 14px/1.4 Montserrat,Arial,sans-serif;color:${ink};font-variant-numeric:tabular-nums">$ ${fmtMXN(tUtil).replace('$','')}</td>
        </tr>
      </table>
      <div style="margin-top:8px;font:400 11px/1.4 Montserrat,Arial,sans-serif;color:${muted}">Todas nuestras operaciones son en moneda nacional mexicana.</div>
    </td></tr>

    <!-- Top 5 dispersiones -->
    <tr><td style="padding:22px 32px 0">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${line};border-collapse:collapse">
        ${banda('Top 5 dispersiones')}
        <tr style="background:${softBlue}">
          <th align="left"  style="padding:10px 16px;font:700 11px/1 Montserrat,Arial,sans-serif;color:${ink};letter-spacing:.06em;text-transform:uppercase">Comercio</th>
          <th align="left"  style="padding:10px 16px;font:700 11px/1 Montserrat,Arial,sans-serif;color:${ink};letter-spacing:.06em;text-transform:uppercase">Afiliación</th>
          <th align="left"  style="padding:10px 16px;font:700 11px/1 Montserrat,Arial,sans-serif;color:${ink};letter-spacing:.06em;text-transform:uppercase">Descripción</th>
          <th align="right" style="padding:10px 16px;font:700 11px/1 Montserrat,Arial,sans-serif;color:${ink};letter-spacing:.06em;text-transform:uppercase">Importe</th>
        </tr>
        ${top.map((t,i)=>topRow(t,i)).join('')}
      </table>
    </td></tr>

    <!-- Adjuntos -->
    <tr><td style="padding:26px 32px 6px">
      <div style="font:700 12px/1 Montserrat,Arial,sans-serif;color:${accent};letter-spacing:.09em;text-transform:uppercase">Adjuntos</div>
      <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:10px">
        <tr><td style="padding:4px 8px 4px 0;vertical-align:middle"><span style="display:inline-block;width:8px;height:8px;background:${accent};border-radius:1px"></span></td><td style="font:400 13px/1.5 Montserrat,Arial,sans-serif;color:${ink}">layout_spei_corte_${c.id_corte}_${c.fli}.xlsx</td></tr>
        <tr><td style="padding:4px 8px 4px 0;vertical-align:middle"><span style="display:inline-block;width:8px;height:8px;background:${accent};border-radius:1px"></span></td><td style="font:400 13px/1.5 Montserrat,Arial,sans-serif;color:${ink}">reporte_cliente_corte_${c.id_corte}_${c.fli}.xlsx</td></tr>
      </table>
    </td></tr>

    <!-- Pie -->
    <tr>
      <td style="padding:22px 32px 26px;border-top:1px solid ${line};font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted}">
        Generado por ${escapeHtml(c.creado_por || '—')} · ${fmtDT(c.creado_at)}<br>
        Este correo se envía automáticamente. Sistema: polipay-conciliacion-liquidacion.onrender.com
      </td>
    </tr>

    <!-- Franja negra final -->
    <tr>
      <td style="background:${brand};padding:14px 32px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          <td style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">Polipay POS Settlement</td>
          <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">ops.agregador@polipay.io</td>
        </tr></table>
      </td>
    </tr>
  </table>
</body></html>`;
  return { subject, html, c, cal, tCC, tUtil };
}
function escapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch])); }

// Preview HTML del informe (solo para ver en el navegador, sin enviar)
app.get('/api/cortes/:id/informe-preview.html', auth, async (req, res) => {
  if (!dbReady(res)) return;
  try {
    const { html } = await armarInformeHTML(parseInt(req.params.id, 10));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

/* ============================================================================
   Correo de BIENVENIDA para un usuario recién dado de alta.
   Mismo diseño y paleta que el informe de corte (marca Polipay, logo inline).
   opts.logoSrc:  para preview (URL) o para envío ('cid:polipay-logo').
   ========================================================================= */
function permisosPorRol(rol) {
  const M = {
    admin: [
      'Configuración total del sistema (catálogos, parámetros, destinatarios).',
      'Gestión de usuarios: dar de alta, editar y desactivar accesos.',
      'Ingesta de transacciones y contracargos; generar y borrar cortes.',
      'Validar, dispersar, cerrar y notificar cortes por correo.',
    ],
    operador: [
      'Ingesta diaria de transacciones y reporte de contracargos.',
      'Generar cortes (compensación, dispersión y cuadre).',
      'Ver todos los cortes, catálogos y bitácora.',
      'No puede validar, dispersar ni editar catálogos.',
    ],
    tesoreria: [
      'Validar los cortes que generó Operaciones (Borrador → Validado).',
      'Notificar el corte a los destinatarios por correo (📧).',
      'Ver todos los cortes, catálogos y bitácora.',
      'No puede generar, dispersar ni cerrar cortes.',
    ],
    bancos: [
      'Confirmar dispersión de cortes validados (Validado → Dispersado).',
      'Cerrar el corte una vez completada la dispersión (Dispersado → Cerrado).',
      'Notificar el corte a los destinatarios por correo (📧).',
      'Ver todos los cortes, catálogos y bitácora.',
      'No puede generar cortes ni validar.',
    ],
    consulta: [
      'Solo lectura: puede ver toda la operación.',
      'Descargar layouts SPEI, reportes por cliente y registro contable.',
      'Ideal para auditoría, contabilidad externa o gerencia.',
      'No puede modificar, cargar ni transicionar nada.',
    ],
  };
  return M[rol] || [];
}
function armarBienvenidaHTML(user, invitadoPor, opts) {
  opts = opts || {};
  const brand = '#051B3B', accent = '#3083F4', muted = '#667085', line = '#e5e7eb', ink = '#1A1A1A';
  const rolLabel = ROLES[user.rol] || user.rol;
  const bullets = permisosPorRol(user.rol);
  const appUrl = opts.appUrl || process.env.APP_URL || 'https://polipay-conciliacion-liquidacion.onrender.com';
  const logo = opts.logoSrc || 'cid:polipay-logo';
  const subject = `Bienvenido/a a Polipay POS Settlement — acceso ${rolLabel}`;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head><body style="margin:0;padding:0;background:#f4f6fb;font-family:Montserrat,Arial,sans-serif;color:${ink}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6fb;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid ${line};border-radius:12px;overflow:hidden">

        <!-- Header marca (blanco + separador gris) -->
        <tr><td style="background:#ffffff;padding:26px 32px;border-bottom:1px solid ${line}">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td><img src="${logo}" alt="Polipay" height="34" style="display:block;height:34px;border:0"></td>
            <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:${brand};letter-spacing:.12em;text-transform:uppercase">Polipay POS Settlement</td>
          </tr></table>
        </td></tr>

        <!-- Franja acento -->
        <tr><td style="height:6px;background:${accent}"></td></tr>

        <!-- Cuerpo -->
        <tr><td style="padding:34px 40px 8px">
          <div style="font:700 22px/1.25 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 8px">¡Bienvenido/a, ${escapeHtml(user.nombre)}!</div>
          <div style="font:400 14px/1.6 Montserrat,Arial,sans-serif;color:${muted};margin:0 0 22px">
            Te dieron acceso al sistema de conciliación <b style="color:${ink}">POLIPAY POS SETTLEMENT</b> | MCEB S.A de C.V.
          </div>

          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${line};border-radius:10px;overflow:hidden;margin:0 0 24px">
            <tr><td style="padding:14px 18px;background:#f9fafb;border-bottom:1px solid ${line};font:700 11px/1 Montserrat,Arial,sans-serif;color:${muted};letter-spacing:.12em;text-transform:uppercase">Tu acceso</td></tr>
            <tr><td style="padding:16px 18px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink}">
                <tr><td width="120" style="color:${muted}">Correo</td><td><b>${escapeHtml(user.email)}</b></td></tr>
                <tr><td style="color:${muted}">Rol</td><td><span style="display:inline-block;background:${accent};color:#fff;font:700 11px/1 Montserrat,Arial,sans-serif;padding:5px 10px;border-radius:999px;letter-spacing:.06em;text-transform:uppercase">${escapeHtml(rolLabel)}</span></td></tr>
                ${invitadoPor ? `<tr><td style="color:${muted}">Invitado por</td><td>${escapeHtml(invitadoPor)}</td></tr>` : ''}
              </table>
            </td></tr>
          </table>

          <div style="font:700 13px/1 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 10px;letter-spacing:.05em;text-transform:uppercase">Qué puedes hacer</div>
          <ul style="margin:0 0 24px;padding:0 0 0 18px;font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink}">
            ${bullets.map(b => `<li style="margin:2px 0">${escapeHtml(b)}</li>`).join('')}
          </ul>

          ${MFA_REQUIRED_ROLES.includes(String(user.rol).toLowerCase()) ? `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #F0C674;background:#FFFBEB;border-radius:10px;margin:0 0 24px">
            <tr><td style="padding:16px 18px">
              <div style="font:700 12px/1 Montserrat,Arial,sans-serif;color:#B45309;letter-spacing:.12em;text-transform:uppercase;margin:0 0 8px">⚠ Verificación en dos pasos requerida</div>
              <div style="font:400 13px/1.6 Montserrat,Arial,sans-serif;color:${ink};margin:0 0 12px">
                Tu rol <b>${escapeHtml(rolLabel)}</b> requiere que tu cuenta Google tenga <b>verificación en dos pasos (2FA)</b> activa. Sin esto, el sistema puede rechazar tu inicio de sesión.
              </div>
              <div style="font:700 12px/1 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 8px;letter-spacing:.05em;text-transform:uppercase">Antes de tu primer login</div>
              <ol style="margin:0;padding:0 0 0 18px;font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink}">
                <li>Abre <a href="https://myaccount.google.com/signinoptions/two-step-verification" style="color:${accent}">myaccount.google.com/signinoptions/two-step-verification</a></li>
                <li>Haz clic en <b>Empezar</b> y sigue el asistente (recomendado: usar Google Authenticator).</li>
                <li>Verifica que quede como <b>Activada</b>.</li>
                <li>Regresa a este correo y entra a Polipay POS Settlement.</li>
              </ol>
            </td></tr>
          </table>
          ` : ''}

          <div style="font:700 13px/1 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 10px;letter-spacing:.05em;text-transform:uppercase">Cómo entrar</div>
          <ol style="margin:0 0 22px;padding:0 0 0 18px;font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink}">
            <li>Abre el sistema en el enlace de abajo.</li>
            <li>Haz clic en <b>Acceder con Google</b>.</li>
            <li>Selecciona la cuenta <b>${escapeHtml(user.email)}</b> (debe ser una cuenta Google real con ese correo).</li>
          </ol>

          <div style="text-align:center;margin:8px 0 18px">
            <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font:700 13px/1 Montserrat,Arial,sans-serif;padding:14px 26px;border-radius:8px;letter-spacing:.04em">Entrar a Polipay POS Settlement →</a>
          </div>

          <div style="font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted};margin:20px 0 0;padding:14px 16px;background:#f9fafb;border:1px solid ${line};border-radius:8px">
            <b style="color:${ink}">Solo cuentas autorizadas.</b> El sistema acepta login únicamente con Google usando este correo. Si no reconoces esta invitación, ignora este mensaje o escribe a <a href="mailto:ops.agregador@polipay.io" style="color:${accent}">ops.agregador@polipay.io</a>.
          </div>
        </td></tr>

        <!-- Footer meta -->
        <tr><td style="padding:22px 32px 26px;border-top:1px solid ${line};font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted}">
          Este correo se envía automáticamente al dar de alta un usuario. Sistema: polipay-conciliacion-liquidacion.onrender.com
        </td></tr>

        <!-- Franja negra final -->
        <tr><td style="background:${brand};padding:14px 32px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">Polipay POS Settlement</td>
            <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">ops.agregador@polipay.io</td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const textFallback = `Bienvenido/a a Polipay POS Settlement.\nAcceso: ${user.email} (rol ${rolLabel}). Entra con Google en ${appUrl}.`;
  return { subject, html, textFallback };
}

// Preview HTML del correo de bienvenida (solo admin; para diseñar sin enviar).
app.get('/api/usuarios/bienvenida-preview.html', auth, requiereRol('admin'), (req, res) => {
  const nombre = String(req.query.nombre || 'Nombre Apellido');
  const email = String(req.query.email || 'nuevo.usuario@polipay.io');
  const rol = ROLES_VALIDOS.includes(String(req.query.rol || '')) ? String(req.query.rol) : 'operador';
  const invitadoPor = String(req.query.por || (req.user.nombre || req.user.email || ''));
  const { html } = armarBienvenidaHTML({ nombre, email, rol }, invitadoPor, { logoSrc: '/public/logo.png' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/* ============================================================================
   Correo de ALERTA de seguridad (Fase 3.2). Misma paleta Polipay que los
   otros correos. Un solo layout para todas las reglas; el contenido
   (regla_titulo, motivo, campos, sugerencia) lo pasa lib/alertas.js.
   ========================================================================= */
function armarAlertaHTML(a, logoSrc) {
  const brand = '#051B3B', accent = '#3083F4', muted = '#667085', line = '#e5e7eb', ink = '#1A1A1A', warn = '#B45309';
  const logo = logoSrc || 'cid:polipay-logo';
  const subject = `⚠️ Alerta de seguridad — ${a.regla_titulo}`;
  const filas = (a.campos || []).map(([k, v]) => `<tr><td width="150" style="color:${muted};padding:6px 0">${escapeHtml(k)}</td><td style="padding:6px 0"><b>${escapeHtml(String(v == null ? '—' : v))}</b></td></tr>`).join('');
  const cuando = a.cuando ? new Date(a.cuando).toLocaleString('es-MX') : new Date().toLocaleString('es-MX');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head><body style="margin:0;padding:0;background:#f4f6fb;font-family:Montserrat,Arial,sans-serif;color:${ink}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6fb;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid ${line};border-radius:12px;overflow:hidden">
        <tr><td style="background:#ffffff;padding:26px 32px;border-bottom:1px solid ${line}">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td><img src="${logo}" alt="Polipay" height="34" style="display:block;height:34px;border:0"></td>
            <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:${brand};letter-spacing:.12em;text-transform:uppercase">Polipay POS Settlement</td>
          </tr></table>
        </td></tr>
        <tr><td style="height:6px;background:${warn}"></td></tr>
        <tr><td style="padding:34px 40px 8px">
          <div style="font:700 12px/1 Montserrat,Arial,sans-serif;color:${warn};letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px">⚠ Alerta de seguridad</div>
          <div style="font:700 22px/1.25 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 8px">${escapeHtml(a.regla_titulo)}</div>
          <div style="font:400 14px/1.6 Montserrat,Arial,sans-serif;color:${muted};margin:0 0 22px">${escapeHtml(a.motivo)}</div>

          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${line};border-radius:10px;overflow:hidden;margin:0 0 24px">
            <tr><td style="padding:14px 18px;background:#f9fafb;border-bottom:1px solid ${line};font:700 11px/1 Montserrat,Arial,sans-serif;color:${muted};letter-spacing:.12em;text-transform:uppercase">Detalles del evento</td></tr>
            <tr><td style="padding:14px 18px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink}">
                ${filas}
                <tr><td width="150" style="color:${muted};padding:6px 0">Cuándo</td><td style="padding:6px 0"><b>${escapeHtml(cuando)}</b></td></tr>
              </table>
            </td></tr>
          </table>

          <div style="font:700 13px/1 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 10px;letter-spacing:.05em;text-transform:uppercase">Sugerencia</div>
          <div style="font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink};margin:0 0 22px">${escapeHtml(a.sugerencia)}</div>

          <div style="text-align:center;margin:8px 0 18px">
            <a href="https://polipay-conciliacion-liquidacion.onrender.com" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font:700 13px/1 Montserrat,Arial,sans-serif;padding:14px 26px;border-radius:8px;letter-spacing:.04em">Abrir Bitácora en Polipay POS Settlement →</a>
          </div>

          <div style="font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted};margin:20px 0 0;padding:14px 16px;background:#f9fafb;border:1px solid ${line};border-radius:8px">
            Estas alertas se envían automáticamente cuando el sistema detecta un patrón que amerita revisión. Si crees que es un falso positivo, ajustamos los umbrales.
          </div>
        </td></tr>
        <tr><td style="padding:22px 32px 26px;border-top:1px solid ${line};font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted}">
          Sistema: polipay-conciliacion-liquidacion.onrender.com
        </td></tr>
        <tr><td style="background:${brand};padding:14px 32px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">Polipay POS Settlement</td>
            <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">ops.agregador@polipay.io</td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const textFallback = `[Alerta de seguridad] ${a.regla_titulo}\n${a.motivo}\n` + (a.campos || []).map(([k, v]) => `${k}: ${v}`).join('\n') + `\nCuándo: ${cuando}\nSugerencia: ${a.sugerencia}`;
  return { subject, html, textFallback };
}

// Preview HTML por regla (solo admin). Ejemplos: /api/alertas/preview.html?regla=login_fail_ip
app.get('/api/alertas/preview.html', auth, requiereRol('admin'), (req, res) => {
  const reglaId = String(req.query.regla || 'login_fail_ip');
  const regla = AL.REGLAS.find(r => r.id === reglaId) || AL.REGLAS[0];
  // Fila sintética para renderizar el correo con valores de ejemplo.
  const filaSample = { usuario: 'Alfonso García', rol: 'admin', accion: 'login_fail', detalle: 'no_autorizado: ejemplo@externo.com', ip: '187.132.44.10', resource_id: 42, ts: new Date().toISOString() };
  const det = regla.detalles(filaSample, { n: 7 });
  const { html } = armarAlertaHTML({ regla_titulo: regla.titulo, motivo: det.motivo, campos: det.campos, sugerencia: det.sugerencia, cuando: filaSample.ts }, '/public/logo.png');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Envío manual de correo de prueba (admin). Útil para verificar SES + diseño sin esperar un evento.
app.post('/api/alertas/prueba', auth, requiereRol('admin'), async (req, res) => {
  if (!sesEnabled()) return res.status(503).json({ error: 'ses_no_configurado' });
  if (!AL.ALERTAS_HABILITADAS) return res.status(503).json({ error: 'alertas_deshabilitadas' });
  const to = await (async () => {
    const rows = (await db.query("select email, email_cifrado, nombre, nombre_cifrado from usuarios where rol='admin' and activo=true")).rows;
    return rows.map(u => {
      const email = descifraTexto(u.email_cifrado, u.email);
      const nombre = descifraTexto(u.nombre_cifrado, u.nombre) || email;
      return nombre ? `"${nombre}" <${email}>` : email;
    });
  })();
  if (!to.length) return res.status(400).json({ error: 'sin_admins' });
  const { subject, html, textFallback } = armarAlertaHTML({
    regla_titulo: 'Correo de prueba',
    motivo: 'Este es un envío manual desde el endpoint /api/alertas/prueba. Si lo recibes, SES + destinatarios admin están configurados correctamente.',
    campos: [['Solicitado por', req.user.nombre || req.user.email], ['IP', realIp(req)], ['Ambiente', db.kind()]],
    sugerencia: 'Ninguna acción requerida. Este es un correo de prueba.',
    cuando: new Date().toISOString(),
  }, 'cid:polipay-logo');
  try {
    const logoPath = path.join(__dirname, 'public', 'logo.png');
    const logoBuf = require('fs').readFileSync(logoPath);
    const messageId = await sendSES({ to, subject, html, textFallback, inlineImages: [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: logoBuf }] });
    await bit(req, 'alerta_prueba', `enviada a ${to.length} admin(s)`);
    res.json({ ok: true, enviados: to.length, messageId });
  } catch (e) {
    await bit(req, 'alerta_prueba_error', e.message, { success: false });
    res.status(500).json({ error: 'ses_error', mensaje: e.message });
  }
});

/* ============================================================================
   WORM · Snapshot diario de bitácora (Sprint 3.3). Sin AWS: se envía como
   adjunto cifrado por correo a los admins. Reusa ENCRYPTION_KEY_V1.
   ========================================================================= */
function armarWormHTML(s, logoSrc) {
  const brand = '#051B3B', accent = '#3083F4', muted = '#667085', line = '#e5e7eb', ink = '#1A1A1A';
  const logo = logoSrc || 'cid:polipay-logo';
  const subject = `[WORM] Bitácora del ${s.fecha} · ${s.n_registros} registros`;
  const cuando = new Date().toLocaleString('es-MX');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Montserrat,Arial,sans-serif;color:${ink}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6fb;padding:24px 0"><tr><td align="center">
    <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid ${line};border-radius:12px;overflow:hidden">
      <tr><td style="background:#ffffff;padding:26px 32px;border-bottom:1px solid ${line}">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          <td><img src="${logo}" alt="Polipay" height="34" style="display:block;height:34px;border:0"></td>
          <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:${brand};letter-spacing:.12em;text-transform:uppercase">Polipay POS Settlement</td>
        </tr></table>
      </td></tr>
      <tr><td style="height:6px;background:${accent}"></td></tr>
      <tr><td style="padding:34px 40px 8px">
        <div style="font:700 12px/1 Montserrat,Arial,sans-serif;color:${accent};letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px">WORM · Snapshot de auditoría</div>
        <div style="font:700 22px/1.25 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 8px">Bitácora del ${escapeHtml(s.fecha)}</div>
        <div style="font:400 14px/1.6 Montserrat,Arial,sans-serif;color:${muted};margin:0 0 22px">
          Copia inmutable de la bitácora del día para retención de auditoría. Archiva este correo (o configura auto-archive en Gmail) para conservar la evidencia por al menos 90 días.
        </div>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${line};border-radius:10px;overflow:hidden;margin:0 0 24px">
          <tr><td style="padding:14px 18px;background:#f9fafb;border-bottom:1px solid ${line};font:700 11px/1 Montserrat,Arial,sans-serif;color:${muted};letter-spacing:.12em;text-transform:uppercase">Contenido</td></tr>
          <tr><td style="padding:14px 18px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink}">
              <tr><td width="200" style="color:${muted}">Día cubierto</td><td><b>${escapeHtml(s.fecha)}</b></td></tr>
              <tr><td style="color:${muted}">Registros</td><td><b>${s.n_registros}</b></td></tr>
              <tr><td style="color:${muted}">SHA-256 (plaintext)</td><td style="font-family:monospace;font-size:11px;word-break:break-all">${escapeHtml(s.hash)}</td></tr>
              <tr><td style="color:${muted}">Tamaño cifrado</td><td>${s.bytes} bytes</td></tr>
              <tr><td style="color:${muted}">Origen</td><td>${escapeHtml(s.origen || 'auto')}</td></tr>
              <tr><td style="color:${muted}">Enviado</td><td>${escapeHtml(cuando)}</td></tr>
            </table>
          </td></tr>
        </table>

        <div style="font:700 13px/1 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 10px;letter-spacing:.05em;text-transform:uppercase">Cómo descifrar el adjunto</div>
        <div style="font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink};margin:0 0 12px">
          El adjunto <code>bitacora_${escapeHtml(s.fecha)}.jsonl.enc</code> está cifrado con AES-256-GCM. Para leerlo necesitas la variable <code>ENCRYPTION_KEY_V1</code> (guardada en Render, respalda una copia en 1Password).
        </div>
        <pre style="background:#0b1220;color:#e5e7eb;font:400 11px/1.5 Menlo,monospace;padding:14px 16px;border-radius:8px;overflow-x:auto;margin:0 0 22px">ENCRYPTION_KEY_V1=&lt;pega tu llave&gt; \\
node -e "
const fs=require('fs'), c=require('crypto');
const s=fs.readFileSync('bitacora_${escapeHtml(s.fecha)}.jsonl.enc','utf8').split(':');
const iv=Buffer.from(s[1],'base64'), ct=Buffer.from(s[2],'base64'), tag=Buffer.from(s[3],'base64');
const d=c.createDecipheriv('aes-256-gcm',Buffer.from(process.env.ENCRYPTION_KEY_V1,'hex'),iv);
d.setAuthTag(tag);
console.log(Buffer.concat([d.update(ct),d.final()]).toString('utf8'));
" &gt; bitacora_${escapeHtml(s.fecha)}.jsonl</pre>

        <div style="font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted};margin:20px 0 0;padding:14px 16px;background:#f9fafb;border:1px solid ${line};border-radius:8px">
          <b style="color:${ink}">Integridad:</b> el SHA-256 del texto plano queda registrado tanto aquí como en la tabla worm_snapshots. Cualquier cambio retroactivo en la bitácora se detecta comparando ese hash con el que da el descifrado.
        </div>
      </td></tr>
      <tr><td style="padding:22px 32px 26px;border-top:1px solid ${line};font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted}">
        Sistema: polipay-conciliacion-liquidacion.onrender.com · No respondas a este correo.
      </td></tr>
      <tr><td style="background:${brand};padding:14px 32px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          <td style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">Polipay POS Settlement</td>
          <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">ops.agregador@polipay.io</td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const textFallback = `[WORM] Bitácora del ${s.fecha} · ${s.n_registros} registros · SHA-256 ${s.hash}. Adjunto cifrado en bitacora_${s.fecha}.jsonl.enc — usa ENCRYPTION_KEY_V1 para descifrar.`;
  return { subject, html, textFallback };
}

// Dependencias reutilizables para lib/worm.js
function wormDeps() {
  return {
    db, C,
    adminEmails: async () => {
      const rows = (await db.query("select email, email_cifrado, nombre, nombre_cifrado from usuarios where rol='admin' and activo=true")).rows;
      return rows.map(u => {
        const email = descifraTexto(u.email_cifrado, u.email);
        const nombre = descifraTexto(u.nombre_cifrado, u.nombre) || email;
        return nombre ? `"${nombre}" <${email}>` : email;
      });
    },
    armarWormHTML,
    sendSES,
    inlineImages: (function () {
      try { const buf = require('fs').readFileSync(path.join(__dirname, 'public', 'logo.png')); return [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: buf }]; }
      catch (_e) { return []; }
    })(),
  };
}

// Preview HTML del correo WORM (admin) — sin datos sensibles, solo diseño.
app.get('/api/worm/preview.html', auth, requiereRol('admin'), (_req, res) => {
  const { html } = armarWormHTML({
    fecha: WORM.isoDia(WORM.ayerUTC()),
    n_registros: 42,
    hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    bytes: 12345,
    origen: 'preview',
  }, '/public/logo.png');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Ejecuta el snapshot manualmente (admin). fecha opcional (YYYY-MM-DD); default ayer UTC.
app.post('/api/worm/enviar', auth, requiereRol('admin'), async (req, res) => {
  if (!sesEnabled()) return res.status(503).json({ error: 'ses_no_configurado' });
  const fecha = String(req.query.fecha || req.body?.fecha || WORM.isoDia(WORM.ayerUTC()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha_invalida' });
  try {
    const r = await WORM.ejecutar(wormDeps(), fecha, 'manual');
    if (!r.ok) return res.status(409).json(r);
    await bit(req, 'worm_enviar', `${fecha}: ${r.n_registros} registros → ${r.enviados_a} admin(s)`, { resource_type: 'worm', resource_id: fecha });
    res.json(r);
  } catch (e) {
    await bit(req, 'worm_enviar_error', `${fecha}: ${e.message}`, { success: false });
    res.status(500).json({ error: 'worm_error', mensaje: e.message });
  }
});

// Estado: últimos snapshots + días pendientes desde el más antiguo con bitácora.
app.get('/api/worm/status', auth, requiereRol('admin'), async (_req, res) => {
  const snaps = (await db.query('select fecha::text as fecha, n_registros, hash_sha256, bytes_cifrado, message_id, enviado_at, origen from worm_snapshots order by fecha desc limit 60')).rows;
  const cont = (await db.query('select count(*)::int as n from worm_snapshots')).rows[0].n;
  res.json({ total: cont, ultimos: snaps, habilitado: String(process.env.WORM_HABILITADO || 'true').toLowerCase() !== 'false' });
});

/* ============================================================================
   Correo de notificación al COMERCIO por una disputa (Sprint 7 Disputas).
   Usa la misma paleta Polipay y logo inline. Se llama para CB, refund y dup.
   ========================================================================= */
function armarNotifDisputaHTML(n, opts) {
  opts = opts || {};
  const brand = '#051B3B', accent = '#3083F4', muted = '#667085', line = '#e5e7eb', ink = '#1A1A1A';
  const logo = opts.logoSrc || 'cid:polipay-logo';
  const tipoTxt = n.tipo === 'refund' ? 'Devolución sospechosa' : n.tipo === 'duplicate' ? 'Posible transacción duplicada' : 'Contracargo (chargeback)';
  const subject = `[${n.folio}] ${tipoTxt} en tu comercio · Polipay`;
  const filas = (n.campos || []).map(([k, v]) => `<tr><td width="180" style="color:${muted};padding:6px 0">${escapeHtml(k)}</td><td style="padding:6px 0"><b>${escapeHtml(String(v == null ? '—' : v))}</b></td></tr>`).join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Montserrat,Arial,sans-serif;color:${ink}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6fb;padding:24px 0"><tr><td align="center">
    <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid ${line};border-radius:12px;overflow:hidden">
      <tr><td style="background:#ffffff;padding:26px 32px;border-bottom:1px solid ${line}">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          <td><img src="${logo}" alt="Polipay" height="34" style="display:block;height:34px;border:0"></td>
          <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:${brand};letter-spacing:.12em;text-transform:uppercase">Polipay POS Settlement</td>
        </tr></table>
      </td></tr>
      <tr><td style="height:6px;background:${accent}"></td></tr>
      <tr><td style="padding:34px 40px 8px">
        <div style="font:700 12px/1 Montserrat,Arial,sans-serif;color:${accent};letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px">${escapeHtml(tipoTxt)}</div>
        <div style="font:700 22px/1.25 Montserrat,Arial,sans-serif;color:${brand};margin:0 0 8px">Estimado(a) ${escapeHtml(n.destinatario_nombre || 'contacto')},</div>
        <div style="font:400 14px/1.6 Montserrat,Arial,sans-serif;color:${muted};margin:0 0 22px">
          Te notificamos que se registró un caso en tu comercio <b style="color:${ink}">${escapeHtml(n.merchant || '—')}</b> que requiere tu atención. Los detalles están abajo.
          ${n.fecha_limite_respuesta ? '<br><br><b style="color:'+ink+'">Fecha límite para tu respuesta: '+escapeHtml(n.fecha_limite_respuesta)+'</b>.' : ''}
        </div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${line};border-radius:10px;overflow:hidden;margin:0 0 24px">
          <tr><td style="padding:14px 18px;background:#f9fafb;border-bottom:1px solid ${line};font:700 11px/1 Montserrat,Arial,sans-serif;color:${muted};letter-spacing:.12em;text-transform:uppercase">Detalles del caso</td></tr>
          <tr><td style="padding:14px 18px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font:400 13px/1.7 Montserrat,Arial,sans-serif;color:${ink}">${filas}</table>
          </td></tr>
        </table>
        ${n.mensaje_extra ? `<div style="font:400 13px/1.6 Montserrat,Arial,sans-serif;color:${ink};margin:0 0 20px;padding:14px 16px;background:#f9fafb;border:1px solid ${line};border-radius:8px">${escapeHtml(n.mensaje_extra)}</div>` : ''}
        <div style="font:400 13px/1.6 Montserrat,Arial,sans-serif;color:${ink};margin:0 0 22px">
          Por favor responde a este correo con la <b>evidencia y documentación</b> que justifique la venta o autorice la devolución. Si no recibimos respuesta antes de la fecha límite, procederemos con la aceptación del caso.
        </div>
        <div style="font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted};margin:20px 0 0;padding:14px 16px;background:#f9fafb;border:1px solid ${line};border-radius:8px">
          Este mensaje fue enviado automáticamente por el sistema de Polipay POS Settlement. Cualquier duda escribe a <a href="mailto:ops.agregador@polipay.io" style="color:${accent}">ops.agregador@polipay.io</a>.
        </div>
      </td></tr>
      <tr><td style="padding:22px 32px 26px;border-top:1px solid ${line};font:400 12px/1.6 Montserrat,Arial,sans-serif;color:${muted}">
        Sistema: polipay-conciliacion-liquidacion.onrender.com · Polipay · MCEB
      </td></tr>
      <tr><td style="background:${brand};padding:14px 32px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          <td style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">Polipay POS Settlement</td>
          <td align="right" style="font:700 11px/1 Montserrat,Arial,sans-serif;color:#fff;letter-spacing:.09em;text-transform:uppercase">ops.agregador@polipay.io</td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const textFallback = `[${n.folio}] ${tipoTxt} · Comercio ${n.merchant} · Fecha límite ${n.fecha_limite_respuesta || 'no aplica'}. Responde con evidencia. Polipay POS Settlement.`;
  return { subject, html, textFallback };
}

/* ============================================================================
   DESTINATARIOS del correo de notificación
   ========================================================================= */
app.get('/api/destinatarios', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const rows = (await db.query('select * from destinatarios order by activo desc, email')).rows;
  res.json(rows.map(d => ({
    ...d,
    email: descifraTexto(d.email_cifrado, d.email),
    nombre: descifraTexto(d.nombre_cifrado, d.nombre),
  })));
});
app.post('/api/destinatarios', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'email_invalido' });
  const tipo = ['to', 'cc', 'bcc'].includes(String(b.tipo || '').toLowerCase()) ? String(b.tipo).toLowerCase() : 'to';
  const nombreD = String(b.nombre || '').trim();
  const eHash = C.hmacEmail(email), eCif = C.encrypt(email), nCif = C.encrypt(nombreD);
  if (b.id) {
    await db.query('update destinatarios set email=$1,nombre=$2,tipo=$3,activo=$4,email_hash=$5,email_cifrado=$6,nombre_cifrado=$7 where id=$8', [email, nombreD, tipo, !!b.activo, eHash, eCif, nCif, b.id]);
  } else {
    await db.query('insert into destinatarios(email,nombre,tipo,activo,creado_por,email_hash,email_cifrado,nombre_cifrado) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(email) do update set nombre=excluded.nombre, tipo=excluded.tipo, activo=excluded.activo, email_hash=excluded.email_hash, email_cifrado=excluded.email_cifrado, nombre_cifrado=excluded.nombre_cifrado',
      [email, nombreD, tipo, b.activo !== false, req.user.nombre, eHash, eCif, nCif]);
  }
  await bit(req, b.id ? 'destinatario_editar' : 'destinatario_alta', `${email} (${tipo})`, { resource_type: 'destinatario', resource_id: b.id });
  res.json({ ok: true });
});
app.delete('/api/destinatarios/:id', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return;
  await db.query('delete from destinatarios where id=$1', [parseInt(req.params.id, 10)]);
  await bit(req, 'destinatario_baja', '', { resource_type: 'destinatario', resource_id: req.params.id });
  res.json({ ok: true });
});

/* ============================================================================
   ENVÍO POR AMAZON SES (SendRawEmail con adjuntos)
   Credenciales por env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION.
   Remitente verificado: SES_FROM (por defecto ops.agregador@polipay.io).
   ========================================================================= */
function sesEnabled() {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION);
}
const SES_FROM = process.env.SES_FROM || 'ops.agregador@polipay.io';
const SES_FROM_NAME = process.env.SES_FROM_NAME || 'Polipay · Operaciones · MCEB';

function buildMime({ from, fromName, to, cc, bcc, subject, html, attachments, inlineImages, textFallback }) {
  // Estructura MIME:
  // multipart/mixed (adjuntos)
  //   └─ multipart/related (imágenes inline via cid:)
  //         └─ multipart/alternative (text + html)
  //         └─ imágenes inline
  //   └─ adjuntos (xlsx, etc.)
  const rand = () => 'polipay_' + Math.random().toString(36).slice(2);
  const bMixed = rand(), bRelated = rand(), bAlt = rand();
  const enc = s => `=?UTF-8?B?${Buffer.from(String(s), 'utf8').toString('base64')}?=`;
  const b64 = buf => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
  const L = [];
  L.push(`From: ${fromName ? `${enc(fromName)} <${from}>` : from}`);
  if (to && to.length) L.push(`To: ${to.join(', ')}`);
  if (cc && cc.length) L.push(`Cc: ${cc.join(', ')}`);
  // BCC deliberadamente NO en headers (queda oculto). SES lo entrega via Destinations.
  L.push(`Subject: ${enc(subject)}`);
  L.push('MIME-Version: 1.0');
  L.push(`Content-Type: multipart/mixed; boundary="${bMixed}"`);
  L.push('');
  L.push(`--${bMixed}`);
  L.push(`Content-Type: multipart/related; boundary="${bRelated}"`);
  L.push('');
  L.push(`--${bRelated}`);
  L.push(`Content-Type: multipart/alternative; boundary="${bAlt}"`);
  L.push('');
  const textFb = textFallback || 'Correo automático de Polipay POS Settlement. Consulta el detalle en la versión HTML de este mensaje.';
  L.push(`--${bAlt}`);
  L.push('Content-Type: text/plain; charset=UTF-8');
  L.push('Content-Transfer-Encoding: base64');
  L.push('');
  L.push(b64(Buffer.from(textFb, 'utf8')));
  L.push(`--${bAlt}`);
  L.push('Content-Type: text/html; charset=UTF-8');
  L.push('Content-Transfer-Encoding: base64');
  L.push('');
  L.push(b64(Buffer.from(html, 'utf8')));
  L.push(`--${bAlt}--`);
  // imágenes inline (referenciadas en el HTML como cid:<cid>)
  for (const img of (inlineImages || [])) {
    L.push(`--${bRelated}`);
    L.push(`Content-Type: ${img.contentType || 'image/png'}`);
    L.push('Content-Transfer-Encoding: base64');
    L.push(`Content-ID: <${img.cid}>`);
    L.push(`Content-Disposition: inline; filename="${img.filename || (img.cid + '.png')}"`);
    L.push('');
    L.push(b64(img.content));
  }
  L.push(`--${bRelated}--`);
  // adjuntos regulares (xlsx)
  for (const a of (attachments || [])) {
    L.push(`--${bMixed}`);
    L.push(`Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename}"`);
    L.push('Content-Transfer-Encoding: base64');
    L.push(`Content-Disposition: attachment; filename="${a.filename}"`);
    L.push('');
    L.push(b64(a.content));
  }
  L.push(`--${bMixed}--`);
  return L.join('\r\n');
}

async function sendSES({ to, cc, bcc, subject, html, attachments, inlineImages, textFallback }) {
  const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
  const client = new SESClient({
    region: process.env.AWS_REGION,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
  });
  const raw = buildMime({ from: SES_FROM, fromName: SES_FROM_NAME, to, cc, bcc, subject, html, attachments, inlineImages, textFallback });
  // Destinations debe incluir TODOS (To+Cc+Bcc). El BCC no aparece en headers, así queda oculto.
  const Destinations = [...(to || []), ...(cc || []), ...(bcc || [])];
  const cmd = new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(raw, 'utf8') },
    Destinations,
  });
  const out = await client.send(cmd);
  return out.MessageId;
}

/* ============================================================================
   NOTIFICAR CORTE — envía el informe a los destinatarios activos, con
   layout.xlsx + reporte.xlsx adjuntos generados en memoria.
   ========================================================================= */
async function armarAdjuntosCorte(idCorte) {
  const c = (await db.query('select *, fecha_liq_iso::text as fli from cortes where id_corte=$1', [idCorte])).rows[0];
  if (!c) throw new Error('corte_no_existe');
  const cal = (await db.query('select * from calculos where corte_id=$1 order by id', [c.id_corte])).rows
    .map(x => ({ ...x, calc: typeof x.calc === 'string' ? JSON.parse(x.calc) : x.calc }));
  // Layout (mismo formato que /api/cortes/:id/layout.xlsx)
  const dom = [], amex = [];
  for (const x of cal) {
    const r = x.calc;
    if (Math.abs(r.disp_dom) > 0.005) dom.push({ concepto: x.concepto, clabe: x.clabe, cod: x.codigo_banco, benef: x.beneficiario, cant: E.round2(r.disp_dom), razon: x.razon });
    if (Math.abs(r.disp_amex) > 0.005) amex.push({ concepto: `DISPERSION ${E.ult3(x.afil)}CPPXAMEX00${x.id_grupo}`, clabe: x.clabe, cod: x.codigo_banco, benef: x.beneficiario, cant: E.round2(r.disp_amex), razon: x.razon });
  }
  const orders = [...dom, ...amex];
  const pz = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const gp = t => (pz.find(p => p.type === t) || {}).value || '';
  const referencia = Number(`1${gp('day')}${gp('month')}${gp('year')}`);
  const headL = ['Concepto', 'Cuenta clabe del beneficiario', 'Código del banco del beneficiario', 'Nombre del beneficiario', 'RFC o CURP del beneficiario', 'Cantidad', 'Referencia numérica', 'Fecha de pago (Opcional, solo para transacciones futuras) Formato YYYY-mm-dd HH:mm'];
  const rowsL = orders.map(o => [o.concepto, String(o.clabe || ''), Number(o.cod) || o.cod, o.razon, '', o.cant, referencia, '']);
  const layoutBuf = X.buildXLSX([{ name: 'LAYOUT', aoa: [headL, ...rowsL] }]);
  // Reporte por cliente (con estilos de la plantilla)
  const reporteBuf = await buildReporteXLSX(c, cal);
  const adj = [
    { filename: `layout_spei_corte_${c.id_corte}_${c.fli}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: layoutBuf },
    { filename: `reporte_cliente_corte_${c.id_corte}_${c.fli}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: reporteBuf },
  ];
  // Reporte de contracargos del día — se adjunta TAL CUAL fue subido (sin modificar).
  // Preferimos archivo_bytes_cifrado (v0.7+); fallback a archivo_bytes plaintext (legacy).
  const rep = (await db.query('select archivo_origen, archivo_bytes, archivo_bytes_cifrado, archivo_mime from contracargos_reporte_dia where fecha=$1', [c.fli])).rows[0];
  if (rep) {
    let buf = null;
    if (rep.archivo_bytes_cifrado) {
      const cifBytes = Buffer.isBuffer(rep.archivo_bytes_cifrado) ? rep.archivo_bytes_cifrado : Buffer.from(rep.archivo_bytes_cifrado);
      try { buf = C.decrypt(cifBytes.toString('utf8')); } catch (_e) { buf = null; }
    }
    if (!buf && rep.archivo_bytes) buf = Buffer.isBuffer(rep.archivo_bytes) ? rep.archivo_bytes : Buffer.from(rep.archivo_bytes);
    if (buf) {
      const nombre = rep.archivo_origen && String(rep.archivo_origen).trim() ? rep.archivo_origen : `reporte_contracargos_${c.fli}.xlsx`;
      adj.push({ filename: nombre, contentType: rep.archivo_mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: buf });
    }
  }
  return adj;
}

app.post('/api/cortes/:id/notificar', auth, requiereRol('admin', 'tesoreria', 'bancos'), async (req, res) => {
  if (!dbReady(res)) return;
  if (!sesEnabled()) return res.status(503).json({ error: 'ses_no_configurado', mensaje: 'Configura AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY y AWS_REGION en el entorno del servidor.' });
  const idCorte = parseInt(req.params.id, 10);
  const destRaw = (await db.query("select email,email_cifrado,nombre,nombre_cifrado,tipo from destinatarios where activo=true order by email")).rows;
  if (!destRaw.length) return res.status(400).json({ error: 'sin_destinatarios', mensaje: 'Agrega al menos un destinatario activo en Sistema → Destinatarios.' });
  const dest = destRaw.map(d => ({
    email: descifraTexto(d.email_cifrado, d.email),
    nombre: descifraTexto(d.nombre_cifrado, d.nombre),
    tipo: d.tipo,
  }));
  const fmtAddr = d => d.nombre ? `"${d.nombre}" <${d.email}>` : d.email;
  const to  = dest.filter(d => (d.tipo || 'to') === 'to' ).map(fmtAddr);
  const cc  = dest.filter(d => (d.tipo || 'to') === 'cc' ).map(fmtAddr);
  const bcc = dest.filter(d => (d.tipo || 'to') === 'bcc').map(fmtAddr);
  if (!to.length) return res.status(400).json({ error: 'sin_to', mensaje: 'Debes tener al menos un destinatario en TO (Para). Los CC/CCO solos no bastan.' });
  try {
    // Logo inline (cid) para que se muestre en Gmail/Outlook sin bloqueos externos.
    const logoPath = path.join(__dirname, 'public', 'logo.png');
    const logoBuf = require('fs').readFileSync(logoPath);
    const inlineImages = [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: logoBuf }];
    const { subject, html } = await armarInformeHTML(idCorte, { logoSrc: 'cid:polipay-logo' });
    const attachments = await armarAdjuntosCorte(idCorte);
    const messageId = await sendSES({ to, cc, bcc, subject, html, attachments, inlineImages });
    await bit(req, 'notificar', `corte #${idCorte} enviado (to:${to.length}, cc:${cc.length}, bcc:${bcc.length}, msg ${messageId})`);
    res.json({ ok: true, enviados: dest.length, to: to.length, cc: cc.length, bcc: bcc.length, messageId });
  } catch (e) {
    await bit(req, 'notificar', `error corte #${idCorte}: ${e.message}`);
    res.status(500).json({ error: 'ses_error', mensaje: e.message });
  }
});

// Plantillas (cualquiera autenticado)
app.get('/api/plantilla/:tipo.xlsx', auth, (req, res) => {
  const t = req.params.tipo; let sheet;
  if (t === 'transacciones') sheet = { name: 'Transacciones', aoa: [X.TX_COLS, ['03/08/2026', '14:20', 'DEAL', 'Comercio Demo', '7194416', 'APROBADO', 'VISA', 'Débito', 1000, 'F001', 'REF001', 'A12345', 'T01']] };
  else if (t === 'grupos') sheet = { name: 'Grupos', aoa: [['id_grupo', 'nombre_cliente', 'numero_afiliacion', 'razon_social', 'tasa_pac_tdd', 'tasa_pac_tdc', 'tasa_pac_amex', 'tasa_pac_int', 'costo_x_trx', 'pct_banca', 'int_tdd', 'int_tdc', 'int_amex', 'int_int', 'fee_broxel'], [3, 'DEAL', '7194416', 'Deal Comercializadora SA', 0.025, 0.029, 0.035, 0.038, 0, 0.005, 0.011, 0.015, 0.0247, 0.0302, 0.0028]] };
  else if (t === 'cuentas') sheet = { name: 'Cuentas', aoa: [['id_grupo', 'numero_afiliacion', 'nombre_comercial', 'razon_social_beneficiario', 'banco', 'clabe'], [3, '7194416', 'DEAL', 'Deal Comercializadora SA', 'STP', '646180123456789012']] };
  else return res.status(404).json({ error: 'tipo' });
  enviarXLSX(res, `plantilla_${t}.xlsx`, X.buildXLSX([sheet]));
});

// GET /api/bitacora — queryable con filtros y paginación.
// Filtros: usuario, rol, accion (contains), resource_type, resource_id, ip,
//          success ('true'/'false'), desde (ISO), hasta (ISO), q (búsqueda libre en detalle),
//          limit (default 100, max 500), offset.
app.get('/api/bitacora', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const f = req.query || {};
  const conds = [], vals = [];
  const add = (sql, v) => { conds.push(sql.replace('$?', '$' + (vals.length + 1))); vals.push(v); };
  if (f.usuario)       add("lower(usuario) like '%' || lower($?) || '%'", String(f.usuario));
  if (f.rol)           add('rol=$?', String(f.rol));
  if (f.accion)        add("accion like '%' || $? || '%'", String(f.accion));
  if (f.resource_type) add('resource_type=$?', String(f.resource_type));
  if (f.resource_id)   add('resource_id=$?', String(f.resource_id));
  if (f.ip)            add('ip=$?', String(f.ip));
  if (f.success === 'true' || f.success === 'false') add('success=$?', f.success === 'true');
  if (f.desde && /^\d{4}-\d{2}-\d{2}/.test(f.desde)) add('ts >= $?', String(f.desde));
  if (f.hasta && /^\d{4}-\d{2}-\d{2}/.test(f.hasta)) add('ts <  ($?::timestamptz + interval \'1 day\')', String(f.hasta));
  if (f.q)             add("detalle ilike '%' || $? || '%'", String(f.q));
  const where = conds.length ? ' where ' + conds.join(' and ') : '';
  const limit = Math.min(parseInt(f.limit, 10) || 100, 500);
  const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
  const total = parseInt((await db.query('select count(*)::int as n from bitacora' + where, vals)).rows[0].n, 10);
  const rows = (await db.query(
    'select id, ts, usuario, rol, accion, detalle, ip, user_agent, session_jti, resource_type, resource_id, success from bitacora' + where + ' order by id desc limit ' + limit + ' offset ' + offset,
    vals
  )).rows;
  res.json({ total, limit, offset, rows });
});

// Export CSV para auditores. Mismos filtros que arriba (sin paginación, hasta 10k filas).
app.get('/api/bitacora.csv', auth, requiereRol('admin', 'tesoreria'), async (req, res) => {
  if (!dbReady(res)) return;
  const f = req.query || {};
  const conds = [], vals = [];
  const add = (sql, v) => { conds.push(sql.replace('$?', '$' + (vals.length + 1))); vals.push(v); };
  if (f.usuario)       add("lower(usuario) like '%' || lower($?) || '%'", String(f.usuario));
  if (f.rol)           add('rol=$?', String(f.rol));
  if (f.accion)        add("accion like '%' || $? || '%'", String(f.accion));
  if (f.resource_type) add('resource_type=$?', String(f.resource_type));
  if (f.resource_id)   add('resource_id=$?', String(f.resource_id));
  if (f.success === 'true' || f.success === 'false') add('success=$?', f.success === 'true');
  if (f.desde && /^\d{4}-\d{2}-\d{2}/.test(f.desde)) add('ts >= $?', String(f.desde));
  if (f.hasta && /^\d{4}-\d{2}-\d{2}/.test(f.hasta)) add('ts <  ($?::timestamptz + interval \'1 day\')', String(f.hasta));
  if (f.q)             add("detalle ilike '%' || $? || '%'", String(f.q));
  const where = conds.length ? ' where ' + conds.join(' and ') : '';
  const rows = (await db.query('select ts, usuario, rol, accion, detalle, ip, resource_type, resource_id, success from bitacora' + where + ' order by id desc limit 10000', vals)).rows;
  const csvCell = v => { const s = v == null ? '' : String(v); return /["\n,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['fecha_hora', 'usuario', 'rol', 'accion', 'detalle', 'ip', 'resource_type', 'resource_id', 'success'];
  const lines = [head.join(',')].concat(rows.map(r => [r.ts.toISOString(), r.usuario, r.rol, r.accion, r.detalle, r.ip, r.resource_type, r.resource_id, r.success].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bitacora_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('﻿' + lines.join('\n'));   // BOM para Excel
});

// Verificar integridad de la cadena de hashes (admin). Recorre todo, valida cada row_hash.
// Reporta cuántas filas revisó, si la cadena está íntegra, y la primera fila corrupta si la hay.
app.get('/api/bitacora/verificar-integridad', auth, requiereRol('admin'), async (_req, res) => {
  if (!dbReady(res)) return;
  const rows = (await db.query('select id, ts, usuario, rol, accion, detalle, ip, user_agent, session_jti, resource_type, resource_id, success, prev_hash, row_hash from bitacora order by id asc')).rows;
  let previo = null, ok = 0, primera_falla = null, sin_hash = 0;
  for (const r of rows) {
    if (!r.row_hash) { sin_hash++; continue; }   // filas antiguas anteriores a hash-chain
    const esperado_prev = previo == null ? null : previo;
    if (r.prev_hash !== esperado_prev) {
      primera_falla = { id: r.id, motivo: 'prev_hash no coincide', esperado: esperado_prev, actual: r.prev_hash };
      break;
    }
    const material = [r.prev_hash || '', r.usuario, r.rol, r.accion, r.detalle || '', r.ip || '', r.user_agent || '', r.session_jti || '', r.resource_type || '', r.resource_id || '', String(r.success)].join('|');
    const hash_calc = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
    if (hash_calc !== r.row_hash) {
      primera_falla = { id: r.id, motivo: 'row_hash no coincide (fila alterada)', esperado: hash_calc, actual: r.row_hash };
      break;
    }
    previo = r.row_hash; ok++;
  }
  res.json({
    total: rows.length,
    verificadas: ok,
    sin_hash_legacy: sin_hash,
    integra: !primera_falla,
    primera_falla,
  });
});

/* ---------- Módulo DISPUTAS (Sprint 1 · portado de sistema Python Contracargos) ---------- */
mountDisputasRoutes(app, { auth, requiereRol, bit, db, C, D, upload, sesEnabled, sendSES, armarNotifDisputaHTML, path, fs: require('fs'), X, enviarXLSX });

/* ---------- Webhook público para ingesta de contracargos (Disputas Sprint 6) ----------
   Autentica con X-Webhook-Token; se compara HMAC contra providers.webhook_token_hash.
   Idempotente por (provider_id, external_id): si ya existe, retorna el mismo folio.
   Rate limit específico: 120/min por IP para tolerar ingestas por lotes de proveedores.
--------------------------------------------------------------------------------------- */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limit' },
});
app.post('/api/webhooks/contracargos', webhookLimiter, express.json({ limit: '2mb' }), async (req, res) => {
  const token = req.headers['x-webhook-token'];
  if (!token) return res.status(401).json({ error: 'sin_token' });
  const tokenHash = C.hmac(String(token));
  const provider = (await db.query('select id, nombre, activo from disputa.providers where webhook_token_hash=$1', [tokenHash])).rows[0];
  if (!provider || !provider.activo) return res.status(401).json({ error: 'token_invalido' });
  const body = req.body || {};
  const external_id = body.external_id ? String(body.external_id).trim() : null;
  if (!external_id) return res.status(400).json({ error: 'external_id_requerido' });
  // Dedup por (provider_id, external_id)
  const existente = (await db.query('select id, folio from disputa.chargebacks where provider_id=$1 and external_id=$2', [provider.id, external_id])).rows[0];
  if (existente) return res.json({ ok: true, deduplicado: true, id: existente.id, folio: existente.folio });
  // Resolver reason_code por (brand, codigo) si viene, o dejar null.
  let reason_code_id = null;
  if (body.brand && body.reason_code_raw) {
    const rc = (await db.query('select id from disputa.reason_codes where brand=$1 and codigo=$2', [String(body.brand).toUpperCase(), String(body.reason_code_raw).trim()])).rows[0];
    if (rc) reason_code_id = rc.id;
  }
  const brand = ['VISA', 'MASTERCARD', 'AMEX', 'CARNET', 'NACIONAL', 'INTERNACIONAL', 'OTHER'].includes(body.brand) ? body.brand : 'OTHER';
  const channel = ['POS', 'ECOMMERCE', 'MOTO', 'RECURRING', 'OTHER'].includes(body.channel) ? body.channel : 'OTHER';
  const card_presence = channel === 'POS' ? 'CARD_PRESENT' : 'CARD_NOT_PRESENT';
  const cycle = ['RETRIEVAL', 'FIRST_CHARGEBACK', 'REPRESENTMENT', 'PRE_ARBITRATION', 'ARBITRATION'].includes(body.cycle) ? body.cycle : 'FIRST_CHARGEBACK';
  const arn = body.arn ? String(body.arn).trim() : null;
  const case_number = body.case_number ? String(body.case_number).trim() : null;
  const amount = body.disputed_amount != null && body.disputed_amount !== '' ? Number(body.disputed_amount) : null;
  const merchant_name = body.merchant_name ? String(body.merchant_name).trim() : null;
  const afil = body.merchant_affiliation ? String(body.merchant_affiliation).replace(/\D/g, '') : null;
  const fecha_evento = body.fecha_evento && /^\d{4}-\d{2}-\d{2}$/.test(body.fecha_evento) ? body.fecha_evento : new Date().toISOString().slice(0, 10);
  const fecha_recepcion = new Date().toISOString().slice(0, 10);
  const fecha_limite_comercio = await D.computarLimiteComercio(db, fecha_recepcion, reason_code_id);
  const fecha_limite_representacion = await D.computarLimiteRepresentacion(db, fecha_recepcion, reason_code_id);
  // Resolver merchant por afiliacion_hash si existe.
  let merchant_id = null;
  if (afil) {
    const m = (await db.query('select id from disputa.merchants where afiliacion_hash=$1', [C.hmac(afil)])).rows[0];
    if (m) merchant_id = m.id;
  }
  const folio = await D.generarFolio(db, 'CB', 'chargebacks');
  const cols = ['folio', 'folio_hash', 'provider_id', 'merchant_id', 'reason_code_id', 'external_id', 'external_id_hash',
    'arn', 'arn_cifrado', 'arn_hash', 'case_number', 'case_number_cifrado',
    'brand', 'card_presence', 'channel', 'cycle', 'status', 'reason_code_raw', 'reason_description',
    'disputed_amount_cifrado', 'currency_code',
    'merchant_name', 'merchant_name_cifrado', 'merchant_affiliation', 'merchant_affiliation_hash',
    'fecha_evento', 'fecha_recepcion', 'fecha_limite_comercio', 'fecha_limite_representacion',
    'origen', 'creado_por'];
  const vals = [folio, C.hmac(folio), provider.id, merchant_id, reason_code_id, external_id, C.hmac(external_id),
    arn, C.encrypt(arn), arn ? C.hmac(arn) : null, case_number, C.encrypt(case_number),
    brand, card_presence, channel, cycle, 'NEW', body.reason_code_raw || null, body.reason_description || null,
    C.encrypt(amount != null ? String(amount) : null), (body.currency_code || 'MXN').toUpperCase().slice(0, 3),
    merchant_name, C.encrypt(merchant_name), afil, afil ? C.hmac(afil) : null,
    fecha_evento, fecha_recepcion, fecha_limite_comercio, fecha_limite_representacion,
    'webhook', 'webhook:' + provider.nombre];
  const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
  const r = await db.query(`insert into disputa.chargebacks(${cols.join(',')}) values(${ph}) returning id, folio`, vals);
  const idNuevo = r.rows[0].id;
  await D.agregarEventoCB(db, idNuevo, { tipo: 'created', estado_nuevo: 'NEW', actor: 'webhook:' + provider.nombre, detalle: 'Alta vía webhook · external_id=' + external_id });
  await db.query('update disputa.providers set ultima_sync=now() where id=$1', [provider.id]);
  // Registrar en bitácora (hash-chain + posible alerta 'disputa_webhook_lote' si hay volumen).
  await bit(req, 'disputa_cb_webhook', `folio=${folio} · provider=${provider.nombre} · external_id=${external_id}`, {
    actor: { nombre: 'webhook:' + provider.nombre, rol: '—' },
    resource_type: 'disputa_cb', resource_id: idNuevo,
  });
  res.status(201).json({ ok: true, deduplicado: false, id: idNuevo, folio: r.rows[0].folio });
});

// Regenera el token del webhook para un provider (solo admin). Devuelve el token en claro UNA sola vez.
app.post('/api/disputa/providers/:id/regenerate-token', auth, requiereRol('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const token = crypto.randomBytes(24).toString('hex');
  const r = await db.query('update disputa.providers set webhook_token_hash=$1, actualizado_at=now() where id=$2 returning id, nombre', [C.hmac(token), id]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_existe' });
  await bit(req, 'disputa_provider_token', `id=${id}`, { resource_type: 'disputa_provider', resource_id: id });
  res.json({ ok: true, provider: r.rows[0], webhook_token: token, mensaje: 'Guarda este token ahora — no se puede volver a mostrar.' });
});

/* ---------- estáticos + SPA ---------- */
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ---------- arranque ---------- */
(async () => {
  try { const kind = await db.initDB(); console.log('Base de datos:', kind); }
  catch (e) { console.error('No se pudo inicializar la BD:', e.message); }
  app.listen(PORT, () => console.log(`Polipay POS Settlement en http://localhost:${PORT}`));
  // Agenda el snapshot WORM diario (best-effort; si SES no está o falla, se reintenta).
  if (sesEnabled()) WORM.agendar(wormDeps());
})();
