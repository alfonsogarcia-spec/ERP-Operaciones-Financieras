/* lib/mesa/routes.js — Credit Solvendom · Mesa de control de una SOFOM (núcleo). API bajo /api/cartera/mc/*  (el prefijo /api/cartera/ ya lo
   reconocen el límite de cuerpo JSON y el acceso de las personas que solo entran a Credit Solvendom).
   Reglas que esta capa hace cumplir en el servidor (la pantalla solo las muestra):
     · cada acción exige el permiso de su rol y que la solicitud esté en un estado que la admita;
     · segregación: quien captura no verifica ni autoriza; quien verifica no autoriza; cada nivel de firma lo da una persona distinta
       (excepción: el único administrador activo puede autoaprobar con comentario ≥ 20 caracteres, y queda marcado y en alerta);
     · versión por solicitud (409 si alguien más la cambió) y datos sensibles cifrados;
     · toda acción deja un asiento en la bitácora encadenada, en la misma transacción que el cambio. */
'use strict';
const multer = require('multer');
const CR = require('../crypto.js');
const F = require('./flujo.js');
const M = require('./motor.js');
const P = require('./pld.js');
const RL = require('./roles.js');
const B = require('./bitacora.js');
const CFG = require('./config.js');
const K = require('./core.js');
const EJ = require('./ejemplos.js');

const S = K.S;
const MAX_ARCHIVO = 15 * 1024 * 1024;
// Tipos del expediente: PDF, fotos (también las del celular), Word/Excel/CSV y XML (CFDI). Se decide por la extensión; el tipo MIME que manda el navegador es solo respaldo.
const EXT_OK = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', xml: 'application/xml', txt: 'text/plain' };
const MIMES = Object.values(EXT_OK).concat(['text/xml']);
const tipoArchivo = f => { const ext = String(f.originalname || '').toLowerCase().split('.').pop(); return EXT_OK[ext] || (MIMES.includes(f.mimetype) && f.mimetype !== 'application/octet-stream' ? f.mimetype : null); };
let _db = null;

const E = (status, mensaje, extra) => Object.assign(new Error(mensaje), { status, extra });
const rolDe = req => req.user.rol_cartera;
const quien = req => ({ usuario: String(req.user.email || '').toLowerCase(), nombre: req.user.nombre || '', rol: rolDe(req) });
const txt = (v, max) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max || 500) : null; };
const numOpt = (v, nom, min, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); if (!Number.isFinite(n) || n < (min ?? 0) || n > (max ?? 1e12)) throw E(400, `${nom} no es válido.`);
  return n;
};
const hoyISO = () => new Date().toISOString().slice(0, 10);
const sumaDias = (iso, d) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

/* ---------- captura: validación de lo que manda la pantalla ---------- */
const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/, CURP_RE = /^[A-Z]{4}\d{6}[HMX][A-Z]{2}[A-Z]{3}[A-Z0-9]\d$/, MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function validarCaptura(b, producto, { completo } = {}) {
  const s = b.solicitante || {}, x = b.solicitud || {};
  if (!['fisica', 'moral'].includes(s.tipo)) throw E(400, 'Indica si el solicitante es persona física o moral.');
  const nombre = txt(s.nombre, 200); if (!nombre || nombre.length < 3) throw E(400, 'Escribe el nombre o razón social del solicitante.');
  const rfc = K.limpiaId(s.rfc), curp = K.limpiaId(s.curp);
  if (rfc && (!RFC_RE.test(rfc) || rfc.length !== (s.tipo === 'fisica' ? 13 : 12))) throw E(400, `El RFC no es válido para persona ${s.tipo} (${s.tipo === 'fisica' ? '13' : '12'} caracteres).`);
  if (curp && !CURP_RE.test(curp)) throw E(400, 'La CURP no es válida (18 caracteres).');
  const email = txt(s.email, 200); if (email && !MAIL_RE.test(email)) throw E(400, 'El correo no es válido.');
  let fn = s.fecha_nacimiento ? String(s.fecha_nacimiento).slice(0, 10) : null;
  if (fn && (!/^\d{4}-\d{2}-\d{2}$/.test(fn) || isNaN(new Date(fn)))) throw E(400, 'La fecha de nacimiento no es válida.');
  if (s.tipo === 'moral') fn = fn || null;
  const sol = {
    producto_id: Number(x.producto_id), monto: numOpt(x.monto, 'El monto', 1), plazo_meses: numOpt(x.plazo_meses, 'El plazo', 1, 600), periodicidad: txt(x.periodicidad, 20) || 'mensual',
    tasa_anual: numOpt(x.tasa_anual, 'La tasa', 0, 5), destino: txt(x.destino, 300), ingresos_mensuales: numOpt(x.ingresos_mensuales, 'El ingreso mensual'), egresos_mensuales: numOpt(x.egresos_mensuales, 'Los egresos mensuales'),
    otras_deudas_mensuales: numOpt(x.otras_deudas_mensuales, 'Los pagos de otras deudas'), antiguedad_meses: x.antiguedad_meses === '' || x.antiguedad_meses == null ? null : Math.round(numOpt(x.antiguedad_meses, 'La antigüedad', 0, 1200)),
    score_buro: x.score_buro === '' || x.score_buro == null ? null : Math.round(numOpt(x.score_buro, 'El score', 0, 1000)), garantia: txt(x.garantia, 500), notas: txt(x.notas, 1000),
  };
  if (!producto) throw E(400, 'Elige un producto.');
  if (!sol.monto) throw E(400, 'Escribe el monto solicitado.');
  if (!sol.plazo_meses) throw E(400, 'Escribe el plazo en meses.');
  if (!producto.periodicidades.includes(sol.periodicidad)) throw E(400, `Este producto solo admite periodicidad ${producto.periodicidades.join(' o ')}.`);
  if (sol.tasa_anual == null) sol.tasa_anual = producto.tasa_default;
  if (sol.tasa_anual < producto.tasa_min || sol.tasa_anual > producto.tasa_max) throw E(400, `La tasa debe estar entre ${(producto.tasa_min * 100).toFixed(2)}% y ${(producto.tasa_max * 100).toFixed(2)}% anual para este producto.`);
  const sl = {
    tipo: s.tipo, nombre, rfc, curp, fecha_nacimiento: fn, nacionalidad: (txt(s.nacionalidad, 3) || 'MX').toUpperCase(), actividad: txt(s.actividad, 200), domicilio: txt(s.domicilio, 400), telefono: txt(s.telefono, 30),
    email, pep: !!s.pep, beneficiario_controlador: txt(s.beneficiario_controlador, 300), origen_recursos: txt(s.origen_recursos, 300),
  };
  if (completo) {
    const falta = [];
    if (!sl.rfc) falta.push('RFC'); if (!sl.domicilio) falta.push('domicilio'); if (!sl.telefono && !sl.email) falta.push('teléfono o correo'); if (!sl.actividad) falta.push('actividad');
    if (!sl.origen_recursos) falta.push('origen de los recursos');
    if (s.tipo === 'fisica') { if (!sl.curp) falta.push('CURP'); if (!sl.fecha_nacimiento) falta.push('fecha de nacimiento'); } else if (!sl.beneficiario_controlador) falta.push('beneficiario controlador');
    if (!sol.destino) falta.push('destino del crédito'); if (!sol.ingresos_mensuales) falta.push('ingreso mensual'); if (sol.antiguedad_meses == null) falta.push('antigüedad');
    if (falta.length) throw E(400, `Para enviar a verificación falta: ${falta.join(', ')}.`, { faltan: falta });
  }
  if (sl.fecha_nacimiento && s.tipo === 'fisica' && M.edadAl(sl.fecha_nacimiento) < 18) throw E(400, 'El solicitante es menor de edad.');
  return { solicitante: sl, solicitud: sol };
}

async function productoDe(q, id) {
  const r = (await q.query(`select * from ${S}mc_productos where id=$1`, [id])).rows[0];
  return r ? K.mapProducto(r) : null;
}
async function adminsActivos(q) {
  return Number((await q.query("select count(*)::int n from usuarios where activo and (rol='admin' or rol_cartera='admin')")).rows[0].n);
}
async function asegurarDocs(t, solicitudId, ctxDocs) {
  for (const tipo of ctxDocs) await t.query(`insert into ${S}mc_documentos(solicitud_id,tipo) values($1,$2) on conflict (solicitud_id,tipo) do nothing`, [solicitudId, tipo]);
}
async function folioNuevo(t) {
  const n = Number((await t.query(`select nextval('${S}mc_folio_seq') n`)).rows[0].n);
  return `SOL-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`;
}
const guardarSolicitante = async (t, id, sl) => t.query(`update ${S}mc_solicitantes set tipo=$2, nombre=$3, rfc_hash=$4, rfc_cifrado=$5, curp_cifrado=$6, fecha_nacimiento=$7, nacionalidad=$8, actividad=$9, domicilio_cifrado=$10,
    telefono_cifrado=$11, email_cifrado=$12, pep=$13, beneficiario_controlador=$14, origen_recursos=$15, actualizado_at=now() where id=$1`,
  [id, sl.tipo, sl.nombre, K.rfcHash(sl.rfc), K.cif(sl.rfc), K.cif(sl.curp), sl.fecha_nacimiento, sl.nacionalidad, sl.actividad, K.cif(sl.domicilio), K.cif(sl.telefono), K.cif(sl.email), sl.pep, sl.beneficiario_controlador, sl.origen_recursos]);

/* ¿Qué puede hacer ESTA persona con ESTA solicitud ahora? La pantalla solo pinta botones con esto; el servidor lo vuelve a exigir al ejecutar. */
function accionesDe(req, c, solo) {
  const y = quien(req), r = y.rol, est = c.sol.estado, soy = c.sol.ejecutivo === y.usuario, admin = r === 'admin', P_ = p => RL.puede(r, p);
  const previos = new Set([c.sol.ejecutivo, c.verificador, ...c.firmantes].filter(Boolean));
  const conflicto = u => previos.has(u);
  const nivel = c.nivelPendiente;
  const firma = nivel === 'cumplimiento' ? P_('pld_revisar') : nivel === 'mesa' ? P_('autorizar') : nivel === 'comite' ? P_('comite') : false;
  return {
    editar: P_('editar') && F.EDITABLES.includes(est) && (soy || admin),
    enviar: P_('enviar') && F.accionValida(est, 'enviar') && (soy || admin),
    subir_docs: (P_('editar') && F.EDITABLES.includes(est) && (soy || admin)) || (P_('validar_docs') && est === 'verificacion'),
    validar_docs: P_('validar_docs') && est === 'verificacion',
    pld_consultar: P_('pld_consulta') && ['verificacion', 'decision'].includes(est),
    pld_revisar: P_('pld_revisar') && ['verificacion', 'decision'].includes(est),
    verificar: P_('verificar') && est === 'verificacion',
    autorizar: !!(est === 'decision' && nivel && firma),
    nivel_firma: est === 'decision' ? nivel : null,
    conflicto_firma: est === 'decision' && nivel && firma ? conflicto(y.usuario) : false,
    rechazar: P_('rechazar') && F.accionValida(est, 'rechazar'),
    devolver: P_('devolver') && F.accionValida(est, 'devolver'),
    cancelar: P_('cancelar') && F.accionValida(est, 'cancelar') && (soy || admin),
    ver_bitacora: P_('bitacora'),
  };
}

function montar(app, { auth, db, correo }) {
  _db = db;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARCHIVO } });
  const upl = campo => (req, res, next) => upload.single(campo)(req, res, err => err ? res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo pesa más de 15 MB.' : 'No se pudo leer el archivo.' }) : next());
  const ruta = (metodo, path, permisos, fn, mw) => app[metodo](path, auth, ...(mw ? [mw] : []), async (req, res) => {
    try {
      if (!rolDe(req)) throw E(403, 'No tienes acceso a Credit Solvendom.');
      if (permisos && !permisos.some(p => RL.puede(rolDe(req), p))) throw E(403, 'Tu rol no tiene permiso para esta acción.');
      await fn(req, res);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
      console.error('[mesa]', path, e); res.status(500).json({ error: 'Error del servidor. Intenta de nuevo.' });
    }
  });
  const puedeVer = (req, sol) => RL.puede(rolDe(req), 'ver_todas') || sol.ejecutivo === quien(req).usuario;
  const cargarCtx = async (req, id, q) => {
    const cfg = await CFG.cargar(q || db);
    const c = await K.contexto(q || db, id, cfg);
    if (!c) throw E(404, 'No existe esa solicitud.');
    if (!puedeVer(req, c.sol)) throw E(403, 'Esa solicitud no es tuya.');
    return { c, cfg };
  };
  const asiento = (t, req, accion, entidad, id, resumen, detalle) => { const y = quien(req); return B.anotar(t, { usuario: y.usuario, rol: y.rol, accion, entidad, entidad_id: id, resumen, detalle }); };
  const cambiarEstado = (t, id, estado, extra) => {
    const sets = ['estado=$2', 'estado_desde=now()', 'version=version+1', 'actualizado_at=now()'], args = [id, estado];
    for (const [k, v] of Object.entries(extra || {})) { args.push(v); sets.push(`${k}=$${args.length}`); }
    return t.query(`update ${S}mc_solicitudes set ${sets.join(', ')} where id=$1`, args);
  };

  /* ---- quién soy ---- */
  ruta('get', '/api/cartera/mc/yo', null, async (req, res) => {
    const y = quien(req); res.setHeader('Cache-Control', 'no-store');
    res.json({ acceso: true, usuario: y.usuario, nombre: y.nombre, rol: y.rol, rolNombre: (RL.ROLES[y.rol] || {}).nombre || y.rol, permisos: RL.permisosDe(y.rol), catalogoPermisos: RL.PERMISOS, roles: RL.lista(), matriz: Object.fromEntries(Object.entries(RL.ROLES).map(([id, r]) => [id, r.permisos])) });
  });

  /* ---- catálogos y parámetros ---- */
  ruta('get', '/api/cartera/mc/catalogos', null, async (req, res) => {
    const cfg = await CFG.cargar(db);
    const productos = (await db.query(`select * from ${S}mc_productos where activo order by nombre`)).rows.map(K.mapProducto);
    res.json({ productos, estados: F.ESTADOS, orden: F.ORDEN, abiertos: F.ABIERTOS, motivos: cfg.motivos_rechazo, documentos: cfg.documentos, sla: cfg.sla, facultades: cfg.facultades, periodos: Object.keys(M.PERIODOS), recomendaciones: M.RECOMENDACIONES });
  });
  ruta('get', '/api/cartera/mc/config', null, async (req, res) => { res.json({ config: await CFG.cargar(db), defaults: CFG.DEFAULT, puede_editar: RL.puede(rolDe(req), 'administrar') }); });
  ruta('put', '/api/cartera/mc/config', ['administrar'], async (req, res) => {
    const v = CFG.validar(req.body || {}); if (!v.ok) throw E(400, v.error);
    const antes = await CFG.cargar(db);
    await db.tx(async t => {
      const actual = (await t.query(`select valor from ${S}mc_config where clave='general'`)).rows[0];
      const base = actual ? (typeof actual.valor === 'string' ? JSON.parse(actual.valor) : actual.valor) : {};
      const guardar = CFG.mezcla(base, v.cfg);
      await t.query(`insert into ${S}mc_config(clave,valor,actualizado,actualizado_por) values('general',$1,now(),$2) on conflict (clave) do update set valor=$1, actualizado=now(), actualizado_por=$2`, [JSON.stringify(guardar), quien(req).usuario]);
      await asiento(t, req, 'config_editar', 'config', 'general', 'Cambió facultades, política o parámetros PLD', { secciones: Object.keys(v.cfg), antes: Object.fromEntries(Object.keys(v.cfg).map(k => [k, antes[k]])), despues: v.cfg });
    });
    res.json({ ok: true, config: await CFG.cargar(db) });
  });

  /* ---- productos ---- */
  const validarProducto = b => {
    const p = {};
    p.clave = txt(b.clave, 40); if (!p.clave || !/^[a-z0-9_-]{3,40}$/.test(p.clave)) throw E(400, 'La clave del producto va en minúsculas, sin espacios (3 a 40 caracteres).');
    p.nombre = txt(b.nombre, 120); if (!p.nombre) throw E(400, 'Escribe el nombre del producto.');
    p.tipo = ['simple', 'revolvente'].includes(b.tipo) ? b.tipo : 'simple';
    p.monto_min = numOpt(b.monto_min, 'El monto mínimo', 0) ?? 0; p.monto_max = numOpt(b.monto_max, 'El monto máximo', 1); if (!p.monto_max || p.monto_max < p.monto_min) throw E(400, 'El monto máximo debe ser mayor al mínimo.');
    p.plazo_min = Math.round(numOpt(b.plazo_min, 'El plazo mínimo', 1, 600) ?? 1); p.plazo_max = Math.round(numOpt(b.plazo_max, 'El plazo máximo', 1, 600)); if (!p.plazo_max || p.plazo_max < p.plazo_min) throw E(400, 'El plazo máximo debe ser mayor al mínimo.');
    p.tasa_min = numOpt(b.tasa_min, 'La tasa mínima', 0, 5) ?? 0; p.tasa_max = numOpt(b.tasa_max, 'La tasa máxima', 0, 5); p.tasa_default = numOpt(b.tasa_default, 'La tasa de referencia', 0, 5);
    if (p.tasa_max == null || p.tasa_max < p.tasa_min) throw E(400, 'La tasa máxima debe ser mayor o igual a la mínima.');
    if (p.tasa_default == null || p.tasa_default < p.tasa_min || p.tasa_default > p.tasa_max) throw E(400, 'La tasa de referencia debe quedar entre la mínima y la máxima.');
    p.tasa_moratoria = numOpt(b.tasa_moratoria, 'La tasa moratoria', 0, 5);
    p.periodicidades = (Array.isArray(b.periodicidades) ? b.periodicidades : []).filter(x => M.PERIODOS[x]); if (!p.periodicidades.length) throw E(400, 'Elige al menos una periodicidad.');
    p.comision_apertura = numOpt(b.comision_apertura, 'La comisión de apertura', 0, 1) ?? 0;
    const permitidas = ['pti_max', 'pti_rechazo', 'score_min', 'score_rechazo', 'antig_min', 'antig_rechazo', 'edad_min', 'edad_max'];
    p.politica = {}; for (const k of permitidas) if (b.politica && b.politica[k] !== undefined && b.politica[k] !== '' && b.politica[k] !== null) { const n = Number(b.politica[k]); if (!Number.isFinite(n) || n < 0) throw E(400, `La política "${k}" no es válida.`); p.politica[k] = n; }
    p.docs_extra = (Array.isArray(b.docs_extra) ? b.docs_extra : []).map(x => String(x).trim()).filter(Boolean).slice(0, 20);
    p.activo = b.activo !== false;
    return p;
  };
  const prodArgs = p => [p.clave, p.nombre, p.tipo, p.activo, p.monto_min, p.monto_max, p.plazo_min, p.plazo_max, p.tasa_min, p.tasa_max, p.tasa_default, p.tasa_moratoria, p.periodicidades, p.comision_apertura, JSON.stringify(p.politica), JSON.stringify(p.docs_extra)];
  ruta('get', '/api/cartera/mc/productos', null, async (req, res) => {
    const todos = RL.puede(rolDe(req), 'administrar');
    res.json((await db.query(`select * from ${S}mc_productos ${todos ? '' : 'where activo'} order by activo desc, nombre`)).rows.map(K.mapProducto));
  });
  ruta('post', '/api/cartera/mc/productos', ['administrar'], async (req, res) => {
    const p = validarProducto(req.body || {});
    const id = await db.tx(async t => {
      if ((await t.query(`select 1 from ${S}mc_productos where clave=$1`, [p.clave])).rows.length) throw E(409, 'Ya existe un producto con esa clave.');
      const r = await t.query(`insert into ${S}mc_productos(clave,nombre,tipo,activo,monto_min,monto_max,plazo_min,plazo_max,tasa_min,tasa_max,tasa_default,tasa_moratoria,periodicidades,comision_apertura,politica,docs_extra,actualizado_por)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`, [...prodArgs(p), quien(req).usuario]);
      await asiento(t, req, 'producto_alta', 'producto', r.rows[0].id, `Creó el producto ${p.nombre}`, p);
      return r.rows[0].id;
    });
    res.status(201).json({ ok: true, id });
  });
  ruta('put', '/api/cartera/mc/productos/:id', ['administrar'], async (req, res) => {
    const id = Number(req.params.id), p = validarProducto(req.body || {});
    await db.tx(async t => {
      const antes = (await t.query(`select * from ${S}mc_productos where id=$1`, [id])).rows[0]; if (!antes) throw E(404, 'No existe ese producto.');
      if (Number(req.body._v) !== antes.version) throw E(409, 'Otra persona cambió este producto. Recarga y vuelve a intentar.');
      if ((await t.query(`select 1 from ${S}mc_productos where clave=$1 and id<>$2`, [p.clave, id])).rows.length) throw E(409, 'Ya existe otro producto con esa clave.');
      await t.query(`update ${S}mc_productos set clave=$3,nombre=$4,tipo=$5,activo=$6,monto_min=$7,monto_max=$8,plazo_min=$9,plazo_max=$10,tasa_min=$11,tasa_max=$12,tasa_default=$13,tasa_moratoria=$14,periodicidades=$15,comision_apertura=$16,politica=$17,docs_extra=$18,
        version=version+1, actualizado_at=now(), actualizado_por=$2 where id=$1`, [id, quien(req).usuario, ...prodArgs(p)]);
      await asiento(t, req, 'producto_editar', 'producto', id, `Editó el producto ${p.nombre}`, { antes: K.mapProducto(antes), despues: p });
    });
    res.json({ ok: true });
  });

  /* ---- solicitudes: listado, alta, detalle, edición ---- */
  ruta('get', '/api/cartera/mc/solicitudes', null, async (req, res) => {
    const y = quien(req), q = req.query, cfg = await CFG.cargar(db);
    const w = [], a = [];
    const add = (cond, v) => { a.push(v); w.push(cond.replace('?', '$' + a.length)); };
    if (!RL.puede(y.rol, 'ver_todas') || q.mias === '1') add('s.ejecutivo = ?', y.usuario);
    if (q.estado) add('s.estado = ?', String(q.estado));
    if (q.abiertas === '1') w.push(`s.estado in ('borrador','devuelta','verificacion','decision')`);
    if (q.producto) add('s.producto_id = ?', Number(q.producto));
    if (q.q) { const t = String(q.q).trim(); a.push('%' + t.toLowerCase() + '%'); const n = a.length; a.push(K.rfcHash(t)); w.push(`(lower(s.folio) like $${n} or lower(c.nombre) like $${n} or (c.rfc_hash is not null and c.rfc_hash = $${n + 1}))`); }
    const where = w.length ? 'where ' + w.join(' and ') : '';
    const limite = 10, off = Math.max(0, Number(q.pag) || 0) * limite;
    const total = Number((await db.query(`select count(*)::int n from ${S}mc_solicitudes s join ${S}mc_solicitantes c on c.id=s.solicitante_id ${where}`, a)).rows[0].n);
    const filas = (await db.query(`select s.id, s.folio, s.estado, s.estado_desde, s.monto, s.plazo_meses, s.ejecutivo_nombre, s.version, s.es_ejemplo, s.monto_autorizado, s.creado_at,
        c.nombre, c.tipo as tipo_persona, p.nombre as producto,
        (select recomendacion from ${S}mc_evaluaciones e where e.solicitud_id=s.id order by e.id desc limit 1) as recomendacion
      from ${S}mc_solicitudes s join ${S}mc_solicitantes c on c.id=s.solicitante_id join ${S}mc_productos p on p.id=s.producto_id ${where}
      order by (s.estado in ('borrador','devuelta','verificacion','decision')) desc, s.estado_desde desc, s.id desc limit ${limite} offset ${off}`, a)).rows
      .map(r => { const dias = F.diasEntre(r.estado_desde); return { ...r, monto: K.num(r.monto), monto_autorizado: K.num(r.monto_autorizado), dias, semaforo: F.ABIERTOS.includes(r.estado) ? F.semaforo(dias, cfg.sla[r.estado]) : null }; });
    res.json({ total, pag: Math.floor(off / limite), por_pag: limite, filas });
  });

  ruta('post', '/api/cartera/mc/solicitudes', ['crear'], async (req, res) => {
    const b = req.body || {}, producto = await productoDe(db, Number((b.solicitud || {}).producto_id));
    if (!producto || !producto.activo) throw E(400, 'Elige un producto activo.');
    const v = validarCaptura(b, producto), cfg = await CFG.cargar(db), y = quien(req);
    const r = await db.tx(async t => {
      let sid; const hash = K.rfcHash(v.solicitante.rfc);
      const ya = hash ? (await t.query(`select id from ${S}mc_solicitantes where rfc_hash=$1 order by id limit 1`, [hash])).rows[0] : null;
      if (ya) sid = ya.id; else sid = (await t.query(`insert into ${S}mc_solicitantes(tipo,nombre) values($1,$2) returning id`, [v.solicitante.tipo, v.solicitante.nombre])).rows[0].id;
      await guardarSolicitante(t, sid, v.solicitante);
      const folio = await folioNuevo(t), x = v.solicitud;
      const id = (await t.query(`insert into ${S}mc_solicitudes(folio,solicitante_id,producto_id,monto,plazo_meses,periodicidad,tasa_anual,destino,ingresos_mensuales,egresos_mensuales,otras_deudas_mensuales,antiguedad_meses,score_buro,garantia,notas,ejecutivo,ejecutivo_nombre)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [folio, sid, producto.id, x.monto, x.plazo_meses, x.periodicidad, x.tasa_anual, x.destino, x.ingresos_mensuales, x.egresos_mensuales, x.otras_deudas_mensuales, x.antiguedad_meses, x.score_buro, x.garantia, x.notas, y.usuario, y.nombre])).rows[0].id;
      await asegurarDocs(t, id, K.docsRequeridos(cfg, v.solicitante.tipo, producto));
      await asiento(t, req, 'solicitud_alta', 'solicitud', id, `Creó la solicitud ${folio} por ${x.monto} (${producto.nombre}) para ${v.solicitante.nombre}`, { folio, producto: producto.clave, monto: x.monto, plazo: x.plazo_meses, solicitante_reutilizado: !!ya });
      return { id, folio, solicitante_reutilizado: !!ya };
    });
    res.status(201).json({ ok: true, ...r });
  });

  ruta('get', '/api/cartera/mc/solicitudes/:id', null, async (req, res) => {
    const { c, cfg } = await cargarCtx(req, Number(req.params.id));
    const linea = (await db.query(`select ts, usuario, rol, accion, resumen from ${S}mc_bitacora where entidad='solicitud' and entidad_id=$1 order by id desc limit 200`, [String(c.sol.id)])).rows;
    const dias = F.diasEntre(c.sol.estado_desde);
    res.json({
      solicitud: { ...c.sol, dias_en_etapa: dias, semaforo: F.ABIERTOS.includes(c.sol.estado) ? F.semaforo(dias, cfg.sla[c.sol.estado]) : null, sla: cfg.sla[c.sol.estado] || null },
      solicitante: c.solicitante, producto: c.producto, documentos: c.docsReq, documentos_extra: c.docs.filter(d => !c.requeridos.includes(d.tipo)),
      pld: c.pld, riesgo: c.riesgo, evaluacion: c.evaluacion, evaluacion_guardada: c.guardada, decisiones: c.decisiones,
      niveles: c.niveles, firmados: c.firmados, nivel_pendiente: c.nivelPendiente, acciones: accionesDe(req, c), linea, credito: (await db.query(`select id, folio, estado from ${S}mc_creditos where solicitud_id=$1`, [c.sol.id])).rows[0] || null,
      cuota: c.evaluacion.cuota, estados: F.ESTADOS,
    });
  });

  ruta('put', '/api/cartera/mc/solicitudes/:id', ['editar'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {};
    await db.tx(async t => {
      const { c, cfg } = await cargarCtx(req, id, t);
      if (!accionesDe(req, c).editar) throw E(409, 'Esta solicitud ya no se puede editar en su estado actual (o no es tuya).');
      if (Number(b._v) !== c.sol.version) throw E(409, 'Alguien más cambió esta solicitud. Recárgala para ver la versión actual.', { codigo: 'version' });
      const producto = await productoDe(t, Number((b.solicitud || {}).producto_id) || c.sol.producto_id); if (!producto || !producto.activo) throw E(400, 'Elige un producto activo.');
      const v = validarCaptura(b, producto), x = v.solicitud;
      await guardarSolicitante(t, c.sol.solicitante_id, v.solicitante);
      await t.query(`update ${S}mc_solicitudes set producto_id=$2,monto=$3,plazo_meses=$4,periodicidad=$5,tasa_anual=$6,destino=$7,ingresos_mensuales=$8,egresos_mensuales=$9,otras_deudas_mensuales=$10,antiguedad_meses=$11,score_buro=$12,garantia=$13,notas=$14,
        version=version+1, actualizado_at=now() where id=$1`, [id, producto.id, x.monto, x.plazo_meses, x.periodicidad, x.tasa_anual, x.destino, x.ingresos_mensuales, x.egresos_mensuales, x.otras_deudas_mensuales, x.antiguedad_meses, x.score_buro, x.garantia, x.notas]);
      await asegurarDocs(t, id, K.docsRequeridos(cfg, v.solicitante.tipo, producto));
      const campos = []; for (const k of ['monto', 'plazo_meses', 'tasa_anual', 'periodicidad', 'destino', 'ingresos_mensuales', 'egresos_mensuales', 'otras_deudas_mensuales', 'antiguedad_meses', 'score_buro']) if (String(c.sol[k] ?? '') !== String(x[k] ?? '')) campos.push(k);
      for (const k of ['nombre', 'tipo', 'actividad', 'pep', 'nacionalidad', 'origen_recursos', 'beneficiario_controlador']) if (String(c.solicitante[k] ?? '') !== String(v.solicitante[k] ?? '')) campos.push(k);
      if (K.limpiaId(c.solicitante.rfc) !== v.solicitante.rfc) campos.push('rfc'); if (K.limpiaId(c.solicitante.curp) !== v.solicitante.curp) campos.push('curp');
      await asiento(t, req, 'solicitud_editar', 'solicitud', id, `Editó ${c.sol.folio}${campos.length ? ': ' + campos.join(', ') : ' (sin cambios de fondo)'}`, { campos, monto_antes: c.sol.monto, monto_despues: x.monto });
    });
    res.json({ ok: true });
  });

  /* ---- documentos ---- */
  ruta('post', '/api/cartera/mc/solicitudes/:id/documentos', null, async (req, res) => {
    const id = Number(req.params.id), tipo = txt(req.body.tipo, 200), vigencia = req.body.vigencia ? String(req.body.vigencia).slice(0, 10) : null;
    if (!req.file) throw E(400, 'Elige el archivo del documento.');
    const mimeOk = tipoArchivo(req.file); if (!mimeOk) throw E(400, 'Ese tipo de archivo no se acepta. Sube PDF, imagen (JPG, PNG, WEBP, HEIC), Word, Excel, CSV o XML.');
    req.file.mimetype = mimeOk;
    if (vigencia && !/^\d{4}-\d{2}-\d{2}$/.test(vigencia)) throw E(400, 'La vigencia no es una fecha válida.');
    await db.tx(async t => {
      const { c } = await cargarCtx(req, id, t);
      if (!accionesDe(req, c).subir_docs) throw E(409, 'No puedes subir documentos a esta solicitud en este momento.');
      if (!c.requeridos.includes(tipo)) throw E(400, 'Ese documento no se pide para esta solicitud.');
      await asegurarDocs(t, id, [tipo]);
      await t.query(`update ${S}mc_documentos set estado='recibido', archivo_nombre=$3, archivo_mime=$4, archivo_tam=$5, archivo_cifrado=$6, vigencia=$7, comentario=null, subido_por=$8, subido_at=now(), revisado_por=null, revisado_at=null
        where solicitud_id=$1 and tipo=$2`, [id, tipo, String(req.file.originalname || 'documento').slice(0, 200), req.file.mimetype, req.file.size, K.cifArchivo(req.file.buffer), vigencia, quien(req).usuario]);
      await asiento(t, req, 'documento_subir', 'solicitud', id, `Subió «${tipo}» a ${c.sol.folio} (${req.file.originalname}, ${Math.round(req.file.size / 1024)} KB)`, { tipo, tam: req.file.size, mime: req.file.mimetype });
    });
    res.json({ ok: true });
  }, upl('archivo'));

  ruta('patch', '/api/cartera/mc/solicitudes/:id/documentos', ['validar_docs'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, tipo = txt(b.tipo, 200), estado = b.estado, com = txt(b.comentario, 500);
    if (!['validado', 'rechazado'].includes(estado)) throw E(400, 'La revisión es «validado» o «rechazado».');
    if (estado === 'rechazado' && (!com || com.length < 10)) throw E(400, 'Explica por qué se rechaza el documento (mínimo 10 caracteres).');
    await db.tx(async t => {
      const { c } = await cargarCtx(req, id, t);
      if (!accionesDe(req, c).validar_docs) throw E(409, 'Los documentos solo se validan mientras la solicitud está en verificación.');
      const d = c.docs.find(x => x.tipo === tipo); if (!d || !d.tiene_archivo) throw E(400, 'Ese documento aún no tiene archivo.');
      if (estado === 'validado' && d.vigencia && d.vigencia < hoyISO()) throw E(409, 'El documento está vencido: pide uno vigente.');
      if (estado === 'validado' && d.subido_por === quien(req).usuario && !(rolDe(req) === 'admin' && (await adminsActivos(t)) <= 1)) throw E(409, 'Quien subió el documento no puede validarlo.');
      await t.query(`update ${S}mc_documentos set estado=$3, comentario=$4, revisado_por=$5, revisado_at=now() where solicitud_id=$1 and tipo=$2`, [id, tipo, estado, com, quien(req).usuario]);
      await asiento(t, req, estado === 'validado' ? 'documento_validar' : 'documento_rechazar', 'solicitud', id, `${estado === 'validado' ? 'Validó' : 'Rechazó'} «${tipo}» de ${c.sol.folio}${com ? ': ' + com : ''}`, { tipo, estado });
    });
    res.json({ ok: true });
  });

  ruta('get', '/api/cartera/mc/solicitudes/:id/documentos/archivo', null, async (req, res) => {
    const id = Number(req.params.id), tipo = txt(req.query.tipo, 200);
    const { c } = await cargarCtx(req, id);
    const d = (await db.query(`select archivo_nombre, archivo_mime, archivo_cifrado from ${S}mc_documentos where solicitud_id=$1 and tipo=$2`, [id, tipo])).rows[0];
    if (!d || !d.archivo_cifrado) throw E(404, 'Ese documento no tiene archivo.');
    const buf = K.descifArchivo(d.archivo_cifrado); if (!buf) throw E(500, 'No se pudo descifrar el archivo.');
    await db.tx(async t => asiento(t, req, 'documento_descarga', 'solicitud', id, `Descargó «${tipo}» de ${c.sol.folio}`, { tipo }));
    res.setHeader('Content-Type', d.archivo_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(d.archivo_nombre || 'documento')}"`);
    res.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  });

  /* ---- PLD: consulta contra listas y resolución de coincidencias ---- */
  ruta('post', '/api/cartera/mc/solicitudes/:id/pld', ['pld_consulta'], async (req, res) => {
    const id = Number(req.params.id); let out;
    await db.tx(async t => {
      const { c, cfg } = await cargarCtx(req, id, t);
      if (!accionesDe(req, c).pld_consultar) throw E(409, 'La consulta PLD se hace con la solicitud en verificación o decisión.');
      const listas = (await t.query(`select id, fuente, tipo, nombre, rfc, curp from ${S}mc_listas where vigente`)).rows;
      const hits = P.buscarCoincidencias({ nombre: c.solicitante.nombre, rfc: c.solicitante.rfc, curp: c.solicitante.curp }, listas, cfg.pld);
      const cid = (await t.query(`insert into ${S}mc_pld_consultas(solicitud_id,huella,listas_vigentes,coincidencias,ejecutada_por) values($1,$2,$3,$4,$5) returning id`, [id, K.huellaPersona(c.solicitante), listas.length, hits.length, quien(req).usuario])).rows[0].id;
      for (const h of hits) await t.query(`insert into ${S}mc_pld_coincidencias(consulta_id,solicitud_id,lista_id,fuente,nombre,rfc,score,nivel,motivo) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [cid, id, h.lista_id, h.fuente, h.nombre, h.rfc, h.score, h.nivel, h.motivo]);
      await asiento(t, req, 'pld_consulta', 'solicitud', id, `Consultó listas PLD para ${c.sol.folio}: ${hits.length} coincidencia(s) en ${listas.length} registros vigentes`, { coincidencias: hits.length, listas: listas.length });
      out = { listas: listas.length, coincidencias: hits.length };
    });
    res.json({ ok: true, ...out });
  });
  ruta('patch', '/api/cartera/mc/pld/coincidencias/:cid', ['pld_revisar'], async (req, res) => {
    const cid = Number(req.params.cid), b = req.body || {}, com = txt(b.comentario, 500);
    if (!['descartada', 'confirmada'].includes(b.estado)) throw E(400, 'Resuelve la coincidencia como «descartada» o «confirmada».');
    if (!com || com.length < 15) throw E(400, 'Explica la resolución (mínimo 15 caracteres): queda en la bitácora.');
    await db.tx(async t => {
      const k = (await t.query(`select * from ${S}mc_pld_coincidencias where id=$1`, [cid])).rows[0]; if (!k) throw E(404, 'No existe esa coincidencia.');
      const { c } = await cargarCtx(req, k.solicitud_id, t);
      if (!c.pld.consulta || c.pld.consulta.id !== k.consulta_id) throw E(409, 'Esa coincidencia es de una consulta anterior: vuelve a consultar.');
      await t.query(`update ${S}mc_pld_coincidencias set estado=$2, revisado_por=$3, revisado_at=now(), comentario=$4 where id=$1`, [cid, b.estado, quien(req).usuario, com]);
      await asiento(t, req, b.estado === 'confirmada' ? 'pld_confirmar' : 'pld_descartar', 'solicitud', c.sol.id, `${b.estado === 'confirmada' ? 'Confirmó' : 'Descartó'} la coincidencia con «${k.nombre}» (${k.fuente}) en ${c.sol.folio}: ${com}`, { coincidencia: cid, fuente: k.fuente, score: Number(k.score) });
    });
    res.json({ ok: true });
  });
  ruta('get', '/api/cartera/mc/pld/pendientes', ['pld_revisar', 'ver_todas'], async (req, res) => {
    const filas = (await db.query(`select k.id, k.fuente, k.nombre as lista_nombre, k.score, k.nivel, k.motivo, k.solicitud_id, s.folio, s.estado, c.nombre
      from ${S}mc_pld_coincidencias k join ${S}mc_solicitudes s on s.id=k.solicitud_id join ${S}mc_solicitantes c on c.id=s.solicitante_id
      where k.estado='pendiente' and s.estado in ('verificacion','decision') and k.consulta_id = (select max(id) from ${S}mc_pld_consultas where solicitud_id=k.solicitud_id) order by k.score desc, k.id`)).rows.map(r => ({ ...r, score: K.num(r.score) }));
    res.json(filas);
  });

  /* ---- listas PLD ---- */
  ruta('get', '/api/cartera/mc/listas', ['pld_consulta', 'pld_revisar', 'administrar'], async (req, res) => {
    const q = req.query, a = [], w = ['vigente'];
    if (q.q) { a.push('%' + String(q.q).toLowerCase() + '%'); w.push(`(lower(nombre) like $${a.length} or lower(coalesce(rfc,'')) like $${a.length})`); }
    if (q.fuente) { a.push(String(q.fuente)); w.push(`fuente=$${a.length}`); }
    const resumen = (await db.query(`select fuente, count(*)::int n, max(cargado_at) ultima, bool_or(es_ejemplo) ejemplo from ${S}mc_listas where vigente group by fuente order by fuente`)).rows;
    const off = Math.max(0, Number(q.pag) || 0) * 25;
    const total = Number((await db.query(`select count(*)::int n from ${S}mc_listas where ${w.join(' and ')}`, a)).rows[0].n);
    const filas = (await db.query(`select id, fuente, tipo, nombre, rfc, curp, notas, es_ejemplo, cargado_at, cargado_por from ${S}mc_listas where ${w.join(' and ')} order by id desc limit 25 offset ${off}`, a)).rows;
    res.json({ resumen, total, pag: Math.floor(off / 25), por_pag: 25, filas });
  });
  const insertarListas = async (t, filas, quienEs) => {
    let n = 0;
    for (let i = 0; i < filas.length; i += 400) {
      const lote = filas.slice(i, i + 400), a = [], v = [];
      lote.forEach(f => { const b = a.length; a.push(f.fuente, f.tipo, f.nombre, P.normalizar(f.nombre), f.rfc || null, f.curp || null, f.notas || null, quienEs); v.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`); });
      await t.query(`insert into ${S}mc_listas(fuente,tipo,nombre,nombre_norm,rfc,curp,notas,cargado_por) values ${v.join(',')}`, a); n += lote.length;
    }
    return n;
  };
  ruta('post', '/api/cartera/mc/listas', ['pld_revisar', 'administrar'], async (req, res) => {
    const b = req.body || {}, f = { fuente: txt(b.fuente, 80), tipo: b.tipo === 'empresa' ? 'empresa' : 'persona', nombre: txt(b.nombre, 250), rfc: K.limpiaId(b.rfc) || null, curp: K.limpiaId(b.curp) || null, notas: txt(b.notas, 400) };
    if (!f.fuente || !f.nombre) throw E(400, 'Indica la fuente de la lista y el nombre.');
    await db.tx(async t => { await insertarListas(t, [f], quien(req).usuario); await asiento(t, req, 'lista_alta', 'lista', f.fuente, `Agregó «${f.nombre}» a la lista ${f.fuente}`, { fuente: f.fuente }); });
    res.status(201).json({ ok: true });
  });
  ruta('post', '/api/cartera/mc/listas/importar', ['pld_revisar', 'administrar'], async (req, res) => {
    if (!req.file) throw E(400, 'Sube un archivo .xlsx o .csv con las columnas fuente, tipo, nombre, rfc, curp, notas.');
    const XLSX = require('xlsx');
    let aoa; try { const wb = XLSX.read(req.file.buffer, { type: 'buffer' }); aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }); } catch (e) { throw E(400, 'No se pudo leer el archivo.'); }
    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
    const hi = aoa.findIndex(r => (r || []).some(c => norm(c) === 'nombre')); if (hi < 0) throw E(400, 'No encontré la columna «nombre» en el archivo.');
    const cab = aoa[hi].map(norm), col = n => cab.indexOf(n);
    const fuenteForm = txt(req.body.fuente, 80);
    const filas = [], omitidas = [];
    aoa.slice(hi + 1).forEach((r, i) => {
      const nombre = txt(r[col('nombre')], 250); if (!nombre) { if ((r || []).some(c => String(c).trim())) omitidas.push(hi + i + 2); return; }
      const fuente = txt(r[col('fuente')], 80) || fuenteForm; if (!fuente) { omitidas.push(hi + i + 2); return; }
      filas.push({ fuente, tipo: norm(r[col('tipo')]) === 'empresa' ? 'empresa' : 'persona', nombre, rfc: K.limpiaId(r[col('rfc')]) || null, curp: K.limpiaId(r[col('curp')]) || null, notas: txt(r[col('notas')], 400) });
    });
    if (!filas.length) throw E(400, 'El archivo no trae filas con nombre y fuente.', { omitidas: omitidas.slice(0, 20) });
    if (filas.length > 200000) throw E(413, 'El archivo trae más de 200,000 filas. Divídelo.');
    const reemplazar = req.body.reemplazar === '1' || req.body.reemplazar === 'true';
    const fuentes = [...new Set(filas.map(f => f.fuente))]; let retiradas = 0;
    const n = await db.tx(async t => {
      if (reemplazar) for (const f of fuentes) retiradas += (await t.query(`update ${S}mc_listas set vigente=false where vigente and fuente=$1 and not es_ejemplo returning id`, [f])).rows.length;
      const c = await insertarListas(t, filas, quien(req).usuario);
      await asiento(t, req, 'lista_importar', 'lista', fuentes.join(', ').slice(0, 120), `Importó ${c} registro(s) a ${fuentes.join(', ')}${reemplazar ? ` (retiró ${retiradas} anteriores)` : ''}`, { fuentes, cargados: c, retirados: retiradas, omitidas: omitidas.length, archivo: req.file.originalname });
      return c;
    });
    res.json({ ok: true, cargados: n, retirados: retiradas, omitidas: omitidas.length, filas_omitidas: omitidas.slice(0, 20) });
  }, upl('archivo'));
  ruta('post', '/api/cartera/mc/listas/:id/baja', ['pld_revisar', 'administrar'], async (req, res) => {
    const id = Number(req.params.id);
    await db.tx(async t => {
      const r = await t.query(`update ${S}mc_listas set vigente=false where id=$1 and vigente returning nombre, fuente`, [id]); if (!r.rows.length) throw E(404, 'No existe ese registro de lista.');
      await asiento(t, req, 'lista_baja', 'lista', id, `Dio de baja «${r.rows[0].nombre}» de la lista ${r.rows[0].fuente}`, { fuente: r.rows[0].fuente });
    });
    res.json({ ok: true });
  });

  /* ---- evaluación del motor ---- */
  ruta('post', '/api/cartera/mc/solicitudes/:id/evaluar', null, async (req, res) => {
    const id = Number(req.params.id);
    let out;
    await db.tx(async t => {
      const { c } = await cargarCtx(req, id, t);
      const guarda = ['verificacion', 'decision'].includes(c.sol.estado);
      let evalId = c.guardada && c.guardada.vigente ? c.guardada.id : null;
      if (guarda && !evalId) {
        evalId = (await t.query(`insert into ${S}mc_evaluaciones(solicitud_id,huella,entrada,reglas,politica,recomendacion,creado_por) values($1,$2,$3,$4,$5,$6,$7) returning id`,
          [id, c.evaluacion.huella, JSON.stringify(c.entrada), JSON.stringify(c.evaluacion.reglas), JSON.stringify(c.evaluacion.politica), c.evaluacion.recomendacion, quien(req).usuario])).rows[0].id;
        await asiento(t, req, 'evaluacion', 'solicitud', id, `Evaluó ${c.sol.folio}: ${M.RECOMENDACIONES[c.evaluacion.recomendacion]}`, { recomendacion: c.evaluacion.recomendacion, resumen: c.evaluacion.resumen, evaluacion: evalId });
      }
      out = { evaluacion: c.evaluacion, guardada: guarda, id: evalId };
    });
    res.json({ ok: true, ...out });
  });

  /* ---- acciones de la mesa ---- */
  ruta('post', '/api/cartera/mc/solicitudes/:id/accion', null, async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, accion = String(b.accion || ''), com = txt(b.comentario, 1000), y = quien(req);
    if (!F.ACCIONES[accion]) throw E(400, 'Acción desconocida.');
    let resultado = {};
    await db.tx(async t => {
      const { c, cfg } = await cargarCtx(req, id, t);
      if (Number(b._v) !== c.sol.version) throw E(409, 'Alguien más cambió esta solicitud. Recárgala para ver la versión actual.', { codigo: 'version' });
      if (!F.accionValida(c.sol.estado, accion)) throw E(409, `Esa acción no aplica a una solicitud ${F.ESTADOS[c.sol.estado].t.toLowerCase()}.`);
      const A = accionesDe(req, c), unico = rolDe(req) === 'admin' && (await adminsActivos(t)) <= 1;
      const requiere = (ok, msg) => { if (!ok) throw E(403, msg || 'Tu rol no puede hacer esto con esta solicitud.'); };
      const minCom = (n, que) => { if (!com || com.length < n) throw E(400, `${que} (mínimo ${n} caracteres).`); };
      const dec = (nivel, decision, extra) => t.query(`insert into ${S}mc_decisiones(solicitud_id,nivel,decision,comentario,usuario,usuario_nombre,rol,evaluacion_id,recomendacion,contra_motor,autoaprobada,monto,tasa,plazo)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [id, nivel, decision, com, y.usuario, y.nombre, y.rol, c.guardada ? c.guardada.id : null, c.guardada ? c.guardada.recomendacion : null, !!(extra && extra.contra), !!(extra && extra.auto), extra && extra.monto || null, extra && extra.tasa || null, extra && extra.plazo || null]);

      if (accion === 'enviar') {
        requiere(A.enviar, 'Solo quien capturó la solicitud (o un administrador) puede enviarla.');
        const producto = c.producto; validarCaptura({ solicitante: c.solicitante, solicitud: c.sol }, producto, { completo: true });
        const sinArchivo = c.docsReq.filter(d => !d.tiene_archivo).map(d => d.tipo), rech = c.docsReq.filter(d => d.estado === 'rechazado').map(d => d.tipo);
        if (sinArchivo.length || rech.length) throw E(400, `Falta cargar o corregir documentos: ${[...sinArchivo, ...rech].join(', ')}.`, { faltan: [...sinArchivo, ...rech] });
        await cambiarEstado(t, id, 'verificacion'); await asiento(t, req, 'solicitud_enviar', 'solicitud', id, `Envió ${c.sol.folio} a verificación`, { desde: c.sol.estado });
      } else if (accion === 'verificar') {
        requiere(A.verificar);
        if (c.faltantes.length) throw E(409, `Faltan documentos por validar: ${c.faltantes.join(', ')}.`);
        if (!c.pld.vigente) throw E(409, 'Consulta las listas PLD (los datos del solicitante cambiaron o no se ha consultado).');
        if (c.pld.pendientes) throw E(409, 'Hay coincidencias de listas por resolver: Cumplimiento debe descartarlas o confirmarlas.');
        if (c.evaluacion.recomendacion === 'incompleta') throw E(409, 'Faltan datos para evaluar: ' + c.evaluacion.reglas.filter(r => r.resultado === 'pendiente').map(r => r.nombre).join(', ') + '.');
        const conf = [c.sol.ejecutivo].includes(y.usuario);
        if (conf) { if (!unico) throw E(403, 'Quien capturó la solicitud no puede verificarla.'); minCom(20, 'Eres la persona que la capturó y el único administrador: justifica la verificación'); }
        const evalId = (await t.query(`insert into ${S}mc_evaluaciones(solicitud_id,huella,entrada,reglas,politica,recomendacion,creado_por) values($1,$2,$3,$4,$5,$6,$7) returning id`,
          [id, c.evaluacion.huella, JSON.stringify(c.entrada), JSON.stringify(c.evaluacion.reglas), JSON.stringify(c.evaluacion.politica), c.evaluacion.recomendacion, y.usuario])).rows[0].id;
        c.guardada = { id: evalId, recomendacion: c.evaluacion.recomendacion };
        await dec('verificacion', 'verifica', { auto: conf });
        await cambiarEstado(t, id, 'decision');
        await asiento(t, req, 'solicitud_verificar', 'solicitud', id, `Cerró la verificación de ${c.sol.folio}; el motor recomienda: ${M.RECOMENDACIONES[c.evaluacion.recomendacion]}${conf ? ' (AUTOAPROBADA: capturó y verificó)' : ''}`, { recomendacion: c.evaluacion.recomendacion, evaluacion: evalId, autoaprobada: conf });
      } else if (accion === 'devolver') {
        requiere(A.devolver); minCom(15, 'Escribe qué debe corregir el ejecutivo');
        await dec('devolucion', 'devuelve'); await cambiarEstado(t, id, 'devuelta');
        await asiento(t, req, 'solicitud_devolver', 'solicitud', id, `Devolvió ${c.sol.folio}: ${com}`, { desde: c.sol.estado });
      } else if (accion === 'rechazar') {
        requiere(A.rechazar); const motivo = txt(b.motivo, 120);
        if (!motivo || !cfg.motivos_rechazo.includes(motivo)) throw E(400, 'Elige el motivo del rechazo.');
        minCom(15, 'Explica el rechazo');
        await dec('rechazo', 'rechaza', { contra: c.guardada && c.guardada.recomendacion === 'aprobar' });
        await cambiarEstado(t, id, 'rechazada', { motivo_rechazo: motivo, comentario_cierre: com });
        await asiento(t, req, 'solicitud_rechazar', 'solicitud', id, `Rechazó ${c.sol.folio} (${motivo}): ${com}`, { motivo });
      } else if (accion === 'cancelar') {
        requiere(A.cancelar, 'Solo quien capturó la solicitud (o un administrador) puede cancelarla.'); minCom(10, 'Escribe el motivo de la cancelación');
        await dec('cancelacion', 'cancela'); await cambiarEstado(t, id, 'cancelada', { comentario_cierre: com });
        await asiento(t, req, 'solicitud_cancelar', 'solicitud', id, `Canceló ${c.sol.folio}: ${com}`, {});
      } else if (accion === 'autorizar') {
        requiere(A.autorizar, 'No te toca firmar esta solicitud en este momento.');
        const nivel = c.nivelPendiente;
        if (!c.guardada || !c.guardada.vigente) throw E(409, 'La evaluación del motor está desactualizada: vuelve a evaluar antes de firmar.', { codigo: 'evaluacion' });
        if (c.pld.confirmadas > 0) throw E(409, 'Hay una coincidencia confirmada en listas: no se puede autorizar. Rechaza la solicitud.');
        if (c.evaluacion.recomendacion === 'incompleta') throw E(409, 'La información está incompleta.');
        const conflicto = A.conflicto_firma; let auto = false;
        if (conflicto) { if (!unico) throw E(403, 'Quien capturó, verificó o ya firmó esta solicitud no puede firmar otro nivel. Debe firmar otra persona.'); auto = true; }
        const contra = c.guardada.recomendacion !== 'aprobar';
        if (auto || contra) minCom(20, auto && contra ? 'Autoaprobas y vas contra la recomendación del motor: justifícalo' : auto ? 'Eres el único administrador y ya participaste en esta solicitud: justifica la autorización' : 'Vas contra la recomendación del motor: justifícalo');
        const monto = numOpt(b.monto_autorizado, 'El monto autorizado', 1) ?? c.sol.monto, plazo = Math.round(numOpt(b.plazo_autorizado, 'El plazo autorizado', 1, 600) ?? c.sol.plazo_meses), tasa = numOpt(b.tasa_autorizada, 'La tasa autorizada', 0, 5) ?? c.sol.tasa_anual;
        const pr = c.producto;
        if (monto > c.sol.monto) throw E(400, 'No se puede autorizar más de lo solicitado.');
        if (monto < pr.monto_min || plazo < pr.plazo_min || plazo > pr.plazo_max || tasa < pr.tasa_min || tasa > pr.tasa_max) throw E(400, 'Monto, plazo o tasa fuera de los límites del producto.');
        await dec(nivel, 'aprueba', { contra, auto, monto, tasa, plazo });
        const faltan = c.niveles.filter(n => !c.firmados.includes(n) && n !== nivel);
        if (faltan.length) await asiento(t, req, 'solicitud_firma', 'solicitud', id, `Firmó ${c.sol.folio} como ${nivel}; falta: ${faltan.join(', ')}${auto ? ' (AUTOAPROBADA)' : ''}${contra ? ' (contra el motor)' : ''}`, { nivel, faltan, auto, contra });
        else {
          const vig = sumaDias(hoyISO(), Number(cfg.facultades.vigencia_dias) || 30);
          await cambiarEstado(t, id, 'autorizada', { monto_autorizado: monto, tasa_autorizada: tasa, plazo_autorizado: plazo, autorizada_en: new Date().toISOString(), vigencia_hasta: vig, comentario_cierre: com });
          await asiento(t, req, 'solicitud_autorizar', 'solicitud', id, `Autorizó ${c.sol.folio} por ${monto} a ${plazo} meses al ${(tasa * 100).toFixed(2)}% (firma ${nivel})${auto ? ' · AUTOAPROBADA' : ''}${contra ? ' · CONTRA EL MOTOR' : ''}`, { nivel, monto, plazo, tasa, vigencia_hasta: vig, auto, contra });
        }
        resultado = { final: !faltan.length, falta: faltan };
      }
    });
    res.json({ ok: true, ...resultado });
  });

  /* ---- tablero ---- */
  ruta('get', '/api/cartera/mc/tablero', null, async (req, res) => {
    const y = quien(req), cfg = await CFG.cargar(db), todas = RL.puede(y.rol, 'ver_todas'), admin = y.rol === 'admin';
    const filtro = todas ? '' : 'and s.ejecutivo=$1', args = todas ? [] : [y.usuario];
    const abiertas = (await db.query(`select s.id, s.folio, s.estado, s.estado_desde, s.monto, s.ejecutivo, s.ejecutivo_nombre, c.nombre from ${S}mc_solicitudes s join ${S}mc_solicitantes c on c.id=s.solicitante_id
      where s.estado in ('borrador','devuelta','verificacion','decision') ${filtro} order by s.estado_desde`, args)).rows.map(r => ({ ...r, monto: K.num(r.monto), dias: F.diasEntre(r.estado_desde) }));
    const embudo = F.ABIERTOS.map(e => { const l = abiertas.filter(r => r.estado === e); return { estado: e, n: l.length, monto: l.reduce((s, r) => s + r.monto, 0), dias_prom: l.length ? Math.round(l.reduce((s, r) => s + r.dias, 0) / l.length * 10) / 10 : 0, vencidas: l.filter(r => F.semaforo(r.dias, cfg.sla[e]) === 'vencido').length, sla: cfg.sla[e] }; });
    const k30 = (await db.query(`select
        count(*) filter (where estado='autorizada')::int aut, coalesce(sum(monto_autorizado) filter (where estado='autorizada'),0) monto_aut,
        count(*) filter (where estado='rechazada')::int rech,
        avg(extract(epoch from (estado_desde - creado_at))/86400) filter (where estado in ('autorizada','rechazada')) dias_decision
      from ${S}mc_solicitudes s where estado_desde >= now() - interval '30 days' and estado in ('autorizada','rechazada') ${filtro}`, args)).rows[0];
    const devueltas30 = Number((await db.query(`select count(*)::int n from ${S}mc_decisiones d join ${S}mc_solicitudes s on s.id=d.solicitud_id where d.decision='devuelve' and d.creado_at >= now() - interval '30 days' ${filtro}`, args)).rows[0].n);
    const motivos = (await db.query(`select motivo_rechazo as motivo, count(*)::int n from ${S}mc_solicitudes s where estado='rechazada' and estado_desde >= now() - interval '30 days' ${filtro} group by 1 order by 2 desc limit 6`, args)).rows;
    const alertas = { autoaprobadas: 0, contra_motor: 0, vigencias: 0 };
    if (todas) {
      const a = (await db.query(`select count(*) filter (where autoaprobada)::int auto, count(*) filter (where contra_motor and decision='aprueba')::int contra from ${S}mc_decisiones where creado_at >= now() - interval '30 days'`)).rows[0];
      alertas.autoaprobadas = a.auto; alertas.contra_motor = a.contra;
      alertas.vigencias = Number((await db.query(`select count(*)::int n from ${S}mc_solicitudes where estado='autorizada' and vigencia_hasta <= current_date + 7`)).rows[0].n);
    }
    // «Para hoy»: lo que le toca a ESTA persona según su rol, lo más atrasado primero.
    const hoy = [], r = y.rol, P_ = p => RL.puede(r, p);
    const meter = (x, texto, tipo) => hoy.push({ id: x.id, folio: x.folio, nombre: x.nombre, texto, tipo: tipo || x.estado, dias: x.dias, semaforo: F.semaforo(x.dias, cfg.sla[x.estado]), monto: x.monto });
    for (const x of abiertas) {
      if (x.estado === 'devuelta' && (P_('editar')) && (admin || x.ejecutivo === y.usuario)) meter(x, 'Devuelta: atiende los comentarios y reenvía');
      if (x.estado === 'borrador' && P_('editar') && (admin || x.ejecutivo === y.usuario) && x.dias >= 2) meter(x, 'Borrador sin enviar');
      if (x.estado === 'verificacion' && (P_('verificar') || P_('validar_docs') || P_('pld_consulta'))) meter(x, 'En verificación: valida documentos y PLD');
    }
    if (P_('autorizar') || P_('pld_revisar') || P_('comite')) {
      for (const x of abiertas.filter(z => z.estado === 'decision').slice(0, 100)) {
        const c = await K.contexto(db, x.id, cfg); if (!c) continue;
        const n = c.nivelPendiente, puede = n === 'cumplimiento' ? P_('pld_revisar') : n === 'mesa' ? P_('autorizar') : n === 'comite' ? P_('comite') : false;
        if (puede) meter(x, `Espera tu firma como ${n}${c.guardada ? ' · motor: ' + M.RECOMENDACIONES[c.guardada.recomendacion].toLowerCase() : ''}`, 'firma');
      }
    }
    if (P_('pld_revisar')) {
      const n = Number((await db.query(`select count(*)::int n from ${S}mc_pld_coincidencias k join ${S}mc_solicitudes s on s.id=k.solicitud_id where k.estado='pendiente' and s.estado in ('verificacion','decision') and k.consulta_id=(select max(id) from ${S}mc_pld_consultas where solicitud_id=k.solicitud_id)`)).rows[0].n);
      if (n) hoy.unshift({ id: null, folio: 'PLD', nombre: `${n} coincidencia(s) de listas por resolver`, texto: 'Abre «Listas y PLD»', tipo: 'pld', dias: 0, semaforo: 'alerta', monto: null });
    }
    hoy.sort((a, b) => (b.semaforo === 'vencido') - (a.semaforo === 'vencido') || b.dias - a.dias);
    const cierre = (k30.aut || 0) + (k30.rech || 0);
    res.json({ embudo, abiertas: abiertas.length, kpi: { autorizadas: k30.aut || 0, monto_autorizado: K.num(k30.monto_aut) || 0, rechazadas: k30.rech || 0, tasa_aprobacion: cierre ? Math.round((k30.aut || 0) / cierre * 1000) / 10 : null,
      dias_decision: k30.dias_decision == null ? null : Math.round(Number(k30.dias_decision) * 10) / 10, devueltas: devueltas30 }, motivos, alertas, para_hoy: hoy.slice(0, 30), todas });
  });

  /* ---- bitácora ---- */
  ruta('get', '/api/cartera/mc/bitacora', ['bitacora'], async (req, res) => {
    const q = req.query, a = [], w = [];
    const add = (c, v) => { a.push(v); w.push(c.replace('?', '$' + a.length)); };
    if (q.entidad) add('entidad = ?', String(q.entidad)); if (q.accion) add('accion = ?', String(q.accion));
    if (q.usuario) add('lower(usuario) like ?', '%' + String(q.usuario).toLowerCase() + '%');
    if (q.q) add('(lower(resumen) like ? )', '%' + String(q.q).toLowerCase() + '%');
    if (q.desde) add('ts >= ?::date', String(q.desde).slice(0, 10)); if (q.hasta) add("ts < (?::date + 1)", String(q.hasta).slice(0, 10));
    const where = w.length ? 'where ' + w.join(' and ') : '', off = Math.max(0, Number(q.pag) || 0) * 25;
    const total = Number((await db.query(`select count(*)::int n from ${S}mc_bitacora ${where}`, a)).rows[0].n);
    const filas = (await db.query(`select id, ts, usuario, rol, accion, entidad, entidad_id, resumen from ${S}mc_bitacora ${where} order by id desc limit 25 offset ${off}`, a)).rows.map(r => ({ ...r, id: Number(r.id) }));
    res.json({ total, pag: Math.floor(off / 25), por_pag: 25, filas });
  });
  ruta('get', '/api/cartera/mc/bitacora/verificar', ['bitacora'], async (req, res) => { res.json(await B.verificar(db)); });

  /* ---- ejemplos (solo para probar; marcados y borrables) ---- */
  ruta('post', '/api/cartera/mc/ejemplos', ['administrar'], async (req, res) => {
    const r = await EJ.crear(db, { quien: quien(req), cfg: await CFG.cargar(db) });
    res.json({ ok: true, ...r });
  });
  ruta('delete', '/api/cartera/mc/ejemplos', ['administrar'], async (req, res) => {
    const r = await EJ.borrar(db, { quien: quien(req) });
    res.json({ ok: true, ...r });
  });

  // Ciclo completo: formalización, desembolso, cartera, cobranza, conciliación, fondeo, contabilidad, reportes y UIF
  const H = { db, ruta, E, quien, rolDe, asiento, upl, txt, numOpt, adminsActivos, correo };
  require('./creditos-routes.js').montar(app, H);
  require('./finanzas-routes.js').montar(app, H);
  // Corte semanal de ingresos por facturar a contabilidad: revisa cada hora si hoy toca (día configurado) y lo hace y manda; si falló el envío, reintenta el mismo día.
  if (correo && process.env.MESA_ENVIO_AUTO !== '0') {
    const revisar = async () => { try { const r = await require('./ingresos.js').envioAutomatico(db, correo); if (r && r.envio && r.envio.error) console.warn('[mesa] envío semanal a contabilidad:', r.envio.mensaje); } catch (e) { console.warn('[mesa] envío semanal a contabilidad falló:', e.message); } };
    setTimeout(revisar, 90 * 1000).unref(); setInterval(revisar, 60 * 60 * 1000).unref();
  }
}

/* Asiento cuando alguien recibe o cambia su acceso a Credit Solvendom (la edición de usuarios vive en Administración). */
function anotarAcceso(req, email, esAdmin, verbo, rolPos, rolCartera) {
  if (!_db) return Promise.resolve();
  const y = quien(req);
  return _db.tx(t => B.anotar(t, { usuario: y.usuario, rol: y.rol, accion: 'acceso', entidad: 'acceso', entidad_id: String(email || '').toLowerCase(),
    resumen: `${verbo} el acceso de ${String(email || '').toLowerCase()}: POS=${rolPos || '—'}, Credit Solvendom=${rolCartera || '—'}${esAdmin ? ' (ADMINISTRADOR)' : ''}`, detalle: { admin: !!esAdmin, pos: rolPos || null, cartera: rolCartera || null } }));
}

module.exports = { montar, anotarAcceso, accionesDe, validarCaptura };
