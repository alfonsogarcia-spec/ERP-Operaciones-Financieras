'use strict';
/* Oficina Virtual Polipay — servidor web (sitio + API).
   Mismo patrón que ERP-Operaciones: Express, Supabase en schema propio, login Google con dominio permitido. */
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db/index.js');

const PORT = Number(process.env.PORT || 3100);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const ALLOWED_HD = (process.env.ALLOWED_HD || '').trim().toLowerCase();
const ADMINS = (process.env.OFICINA_ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const EN_RENDER = !!(process.env.RENDER || process.env.NODE_ENV === 'production');
const MODO_DEV = !GOOGLE_CLIENT_ID && !EN_RENDER;
const JWT_SECRET = process.env.JWT_SECRET || (EN_RENDER ? '' : 'solo-desarrollo-local');
if (!JWT_SECRET) throw new Error('JWT_SECRET no configurado.');
const COOKIE = 'oficina_sesion';
const ESTADOS = ['pendiente', 'en-proceso', 'en-revision', 'entregada', 'cancelada'];
const ACTIVIDAD_VENCE_H = 3;        // actividad abierta más vieja que esto se considera abandonada
const LANZAMIENTO_RAPIDO_S = 5;     // PostToolUse antes de esto = lanzamiento en segundo plano

let dbListo = false, dbKind = '', dbError = null;

const app = express();
// Express 4 no captura promesas rechazadas en handlers async: las enviamos al manejador de errores.
const Layer = require('express/lib/router/layer');
const handleOriginal = Layer.prototype.handle_request;
Layer.prototype.handle_request = function (req, res, next) {
  if (this.handle.length > 3) return handleOriginal.call(this, req, res, next);
  try { const r = this.handle(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); }
};
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://accounts.google.com'],
      frameSrc: ["'self'", 'https://accounts.google.com'],
      connectSrc: ["'self'", 'https://accounts.google.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      upgradeInsecureRequests: EN_RENDER ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  strictTransportSecurity: EN_RENDER ? { maxAge: 15552000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(express.json({ limit: '256kb' }));
const lim = (max) => rateLimit({ windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limit' } });
app.use('/api/auth/', lim(20));
app.use('/api/ingesta/', lim(600));
app.use('/api/', lim(240));

// ---------------------------------------------------------------- utilidades
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const txt = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) || null);
const leerCookie = (req, nombre) => {
  const c = req.headers.cookie || '';
  const m = c.split(/;\s*/).find(p => p.startsWith(nombre + '='));
  return m ? decodeURIComponent(m.slice(nombre.length + 1)) : null;
};
const exigirBD = (_req, res, next) => dbListo ? next() : res.status(503).json({ error: 'bd_no_disponible', mensaje: dbError || 'Iniciando…' });

function usuarioSesion(req) {
  if (MODO_DEV) return { email: 'dev@local', nombre: 'Desarrollo', admin: true };
  const t = leerCookie(req, COOKIE);
  if (!t) return null;
  try { const u = jwt.verify(t, JWT_SECRET); return { email: u.email, nombre: u.nombre, admin: ADMINS.includes(u.email) }; } catch { return null; }
}
const conSesion = (req, res, next) => { const u = usuarioSesion(req); if (!u) return res.status(401).json({ error: 'sin_sesion' }); req.usuario = u; next(); };
const soloAdmin = (req, res, next) => req.usuario.admin ? next() : res.status(403).json({ error: 'solo_admin' });

async function conToken(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!/^ofp_[a-f0-9]{48}$/.test(tok)) return res.status(401).json({ error: 'token_invalido' });
  const { rows } = await db.q('select id, usuario from tokens where hash = $1 and revocado is null', [sha(tok)]);
  if (!rows.length) return res.status(401).json({ error: 'token_invalido' });
  req.dispositivo = rows[0];
  db.q('update tokens set ultimo_uso = now() where id = $1', [rows[0].id]).catch(() => {});
  next();
}

// ---------------------------------------------------------------- salud y config
// Siempre 200 para que Render complete el despliegue; el estado real de la BD va en el cuerpo (ok/db/error).
app.get('/healthz', (_req, res) => res.status(200).json({ ok: dbListo, db: dbKind || null, error: dbError, version: require('./package.json').version }));
app.get('/api/config', (req, res) => res.json({ modo: 'remoto', googleClientId: GOOGLE_CLIENT_ID, dominio: ALLOWED_HD || null, dev: MODO_DEV, usuario: usuarioSesion(req) }));

// ---------------------------------------------------------------- login Google
app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'google_no_configurado' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: String(req.body?.credential || ''), audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.email_verified) return res.status(403).json({ error: 'correo_no_verificado' });
    if (ALLOWED_HD && String(p.hd || '').toLowerCase() !== ALLOWED_HD) return res.status(403).json({ error: 'dominio_no_permitido', mensaje: `Solo cuentas de ${ALLOWED_HD}.` });
    const email = p.email.toLowerCase();
    const token = jwt.sign({ email, nombre: p.name || email }, JWT_SECRET, { expiresIn: '12h' });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${EN_RENDER ? '; Secure' : ''}`);
    res.json({ ok: true, email, admin: ADMINS.includes(email) });
  } catch (e) {
    res.status(401).json({ error: 'token_google_invalido' });
  }
});
app.post('/api/auth/salir', (_req, res) => { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); res.json({ ok: true }); });

// ---------------------------------------------------------------- estado para el mapa
app.get('/api/estado', conSesion, exigirBD, async (req, res) => {
  const [ag, ta, ab, re, se] = await Promise.all([
    db.q('select id, rol, rol_id as "rolId", linea, linea_nombre as "lineaNombre", tipo from agentes order by id'),
    db.q(`select folio, titulo, solicitante, agentes, tipo, estado, entregable, proyecto, usuario, creada, actualizada from tareas
          where estado not in ('entregada','cancelada') or actualizada > now() - interval '7 days' order by actualizada desc limit 200`),
    db.q(`select id, agente, descripcion, proyecto, usuario, inicio from actividad where fin is null and inicio > now() - interval '${ACTIVIDAD_VENCE_H} hours'`),
    db.q(`select agente, descripcion, proyecto, usuario, inicio, fin, duracion_s from actividad where fin is not null order by fin desc limit 80`),
    db.q(`select sesion, proyecto, usuario, maquina, estado, prompt, inicio_turno, ultimo_evento, ultima_duracion_s from sesiones
          where ultimo_evento > now() - interval '7 days' order by ultimo_evento desc limit 40`),
  ]);
  const activos = {};
  for (const r of ab.rows) activos['a' + r.id] = { agente: r.agente, descripcion: r.descripcion, proyecto: r.proyecto, usuario: r.usuario, inicio: r.inicio };
  res.json({ agentes: ag.rows, tareas: ta.rows, actividad: { activos, recientes: re.rows }, sesiones: se.rows, usuario: req.usuario, servidor: new Date().toISOString() });
});

// ---------------------------------------------------------------- tokens de dispositivo (admins)
app.get('/api/tokens', conSesion, soloAdmin, exigirBD, async (_req, res) => {
  const { rows } = await db.q('select id, usuario, etiqueta, creado_por, creado, ultimo_uso, revocado from tokens order by creado desc');
  res.json({ tokens: rows });
});
app.post('/api/tokens', conSesion, soloAdmin, exigirBD, async (req, res) => {
  const usuario = txt(req.body?.usuario, 120)?.toLowerCase(), etiqueta = txt(req.body?.etiqueta, 80);
  if (!usuario || !/^[^@\s]+@[^@\s]+$/.test(usuario) || !etiqueta) return res.status(400).json({ error: 'datos_incompletos', mensaje: 'Indica correo y etiqueta del equipo.' });
  const token = 'ofp_' + crypto.randomBytes(24).toString('hex');
  await db.q('insert into tokens (hash, usuario, etiqueta, creado_por) values ($1, $2, $3, $4)', [sha(token), usuario, etiqueta, req.usuario.email]);
  res.json({ token, aviso: 'Cópialo ahora: no se vuelve a mostrar.' });
});
app.delete('/api/tokens/:id', conSesion, soloAdmin, exigirBD, async (req, res) => {
  await db.q('update tokens set revocado = now() where id = $1 and revocado is null', [Number(req.params.id) || 0]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- ingesta desde Claude Code (token de dispositivo)
app.post('/api/ingesta/evento', exigirBD, conToken, async (req, res) => {
  const b = req.body || {};
  const evento = txt(b.evento, 20), sesion = txt(b.sesion, 80) || 'sin-sesion';
  const proyecto = txt(b.proyecto, 80), maquina = txt(b.maquina, 80), usuario = req.dispositivo.usuario;
  const agente = txt(b.agente, 80), clave = txt(b.clave, 160), descripcion = txt(b.descripcion, 160);
  await db.q(`insert into sesiones (sesion, proyecto, usuario, maquina, ultimo_evento) values ($1,$2,$3,$4,now())
              on conflict (sesion) do update set proyecto = coalesce(excluded.proyecto, sesiones.proyecto), usuario = excluded.usuario,
              maquina = coalesce(excluded.maquina, sesiones.maquina), ultimo_evento = now()`, [sesion, proyecto, usuario, maquina]);
  if (evento === 'inicio' && agente && clave) {
    await db.q(`insert into actividad (sesion, clave, agente, descripcion, proyecto, usuario, maquina) values ($1,$2,$3,$4,$5,$6,$7)
                on conflict (sesion, clave) do nothing`, [sesion, clave, agente, descripcion || 'Trabajando', proyecto, usuario, maquina]);
  } else if (evento === 'fin' && clave) {
    await db.q(`update actividad set fin = now(), duracion_s = round(extract(epoch from now() - inicio))::int
                where sesion = $1 and clave = $2 and fin is null and now() - inicio >= interval '${LANZAMIENTO_RAPIDO_S} seconds'`, [sesion, clave]);
  } else if (evento === 'sub-fin' && agente) {
    await db.q(`update actividad set fin = now(), duracion_s = round(extract(epoch from now() - inicio))::int
                where id = (select id from actividad where sesion = $1 and agente = $2 and fin is null order by inicio limit 1)`, [sesion, agente]);
  } else if (evento === 'prompt') {
    await db.q(`update sesiones set estado = 'trabajando', prompt = $2, inicio_turno = now() where sesion = $1`, [sesion, descripcion || 'Atendiendo petición']);
  } else if (evento === 'stop') {
    await db.q(`update sesiones set estado = 'libre', ultima_duracion_s = round(extract(epoch from now() - coalesce(inicio_turno, now())))::int where sesion = $1`, [sesion]);
  } else {
    return res.status(400).json({ error: 'evento_invalido' });
  }
  res.json({ ok: true });
});

app.post('/api/ingesta/tarea', exigirBD, conToken, async (req, res) => {
  const b = req.body || {};
  if (b.accion === 'nueva') {
    const titulo = txt(b.titulo, 200), agentes = Array.isArray(b.agentes) ? b.agentes.map(a => txt(a, 80)).filter(Boolean).slice(0, 20) : [];
    if (!titulo || !agentes.length) return res.status(400).json({ error: 'datos_incompletos' });
    const { rows } = await db.q(`insert into tareas (folio, titulo, solicitante, agentes, tipo, proyecto, usuario)
      values ('T-' || lpad(nextval('tareas_folio_seq')::text, 4, '0'), $1, $2, $3::jsonb, $4, $5, $6) returning folio`,
      [titulo, txt(b.solicitante, 120) || req.dispositivo.usuario, JSON.stringify(agentes), b.comite ? 'comite' : 'tarea', txt(b.proyecto, 80), req.dispositivo.usuario]);
    return res.json({ folio: rows[0].folio });
  }
  if (b.accion === 'estado') {
    const folio = txt(b.folio, 20), estado = txt(b.estado, 20);
    if (!folio || !ESTADOS.includes(estado)) return res.status(400).json({ error: 'datos_incompletos' });
    const nota = txt(b.nota, 500);
    const { rowCount } = await db.q(`update tareas set estado = $2, actualizada = now(), entregable = coalesce($3, entregable),
      notas = case when $4::text is null then notas else notas || jsonb_build_array(jsonb_build_object('fecha', now(), 'nota', $4::text)) end
      where folio = $1`, [folio, estado, txt(b.entregable, 300), nota]);
    return rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'folio_no_existe' });
  }
  res.status(400).json({ error: 'accion_invalida' });
});

app.post('/api/ingesta/roster', exigirBD, conToken, async (req, res) => {
  const lista = Array.isArray(req.body?.agentes) ? req.body.agentes.slice(0, 300) : [];
  for (const a of lista) {
    const v = [txt(a.id, 80), txt(a.rol, 60), txt(a.rolId, 60), txt(a.linea, 40), txt(a.lineaNombre, 80), txt(a.tipo, 20)];
    if (v.some(x => !x)) continue;
    await db.q(`insert into agentes (id, rol, rol_id, linea, linea_nombre, tipo, actualizado) values ($1,$2,$3,$4,$5,$6,now())
      on conflict (id) do update set rol = excluded.rol, rol_id = excluded.rol_id, linea = excluded.linea,
      linea_nombre = excluded.linea_nombre, tipo = excluded.tipo, actualizado = now()`, v);
  }
  res.json({ ok: true, agentes: lista.length });
});

// ---------------------------------------------------------------- sitio
app.use(express.static(path.join(__dirname, 'public'), { maxAge: EN_RENDER ? '5m' : 0 }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'no_existe' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'error_interno' }); });

// En modo desarrollo (sin login) solo escucha en esta Mac; en Render escucha en todas las interfaces.
app.listen(PORT, MODO_DEV ? '127.0.0.1' : '0.0.0.0', () => console.log(`Oficina Polipay en http://127.0.0.1:${PORT}${MODO_DEV ? ' (modo desarrollo, sin login)' : ''}`));
db.initDB().then(k => { dbListo = true; dbKind = k; console.log('BD lista:', k); })
  .catch(e => { dbError = e.message; console.error('BD no disponible:', e.message); });
