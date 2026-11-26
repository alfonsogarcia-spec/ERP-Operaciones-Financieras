/* lib/solicitudes/routes.js — Portal de solicitudes de clientes (POS). API bajo /api/sc/*.
   Reglas que hace cumplir el servidor (la pantalla solo las muestra):
     · el cliente solo ve y toca lo de su grupo; Comercial solo lo de los clientes que tiene asignados; Operación, Coordinación y Dirección solo ven lo que ya se liberó;
     · cada paso exige el rol y el estado correctos y que esté completa la parte que le toca (cliente → comercial → operación);
     · segregación: quien ejecuta no valida; si la solicitud es crítica firman Coordinación y Dirección, personas distintas
       (excepción: el único administrador activo puede autoaprobar con comentario ≥ 20 caracteres y queda marcado);
     · versión por solicitud (409 si alguien más la cambió); archivos cifrados; todo paso deja un asiento encadenado en sc_eventos, en la misma transacción. */
'use strict';
const crypto = require('crypto');
const multer = require('multer');
const CR = require('../crypto.js');
const CAT = require('./catalogo.js');
const F = require('./flujo.js');
const V = require('./validar.js');
const POS = require('./pos.js');
const MAIL = require('./correos.js');
const IMP = require('./impresion.js');
const PDF = require('./pdf.js');

const MAX_ARCHIVO = 15 * 1024 * 1024;
const EXT_OK = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', xml: 'application/xml', txt: 'text/plain' };
const tipoArchivo = f => EXT_OK[String(f.originalname || '').toLowerCase().split('.').pop()] || null;
// Archivos: si el entorno no tiene llaves de cifrado, crypto.encrypt() corrompería los bytes; se guardan en base64 ('b64:'). Con llaves, AES-256-GCM sobre el Buffer.
const cifArchivo = buf => (CR.CURRENT_VERSION ? CR.encrypt(buf) : 'b64:' + Buffer.from(buf).toString('base64'));
const descifArchivo = v => { if (v == null) return null; const s = String(v); if (s.startsWith('b64:')) return Buffer.from(s.slice(4), 'base64'); const b = CR.decrypt(s); return b == null ? null : (Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8')); };

const E = (status, mensaje, extra) => Object.assign(new Error(mensaje), { status, extra });
const txt = (v, max) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max || 500) : null; };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const SLA_COMERCIAL_DIAS = 1, SLA_VALIDACION_DIAS = 1;

// Suma días hábiles (sin sábado, domingo ni feriados de POS).
function sumaHabiles(desde, n, feriados) {
  const d = new Date(desde); let k = 0;
  while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6 && !feriados.has(d.toISOString().slice(0, 10))) k++; }
  return d;
}

function montar(app, { auth, db, C, bit, correo, appUrl }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARCHIVO } });
  const upl = campo => (req, res, next) => upload.single(campo)(req, res, err => err ? res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo pesa más de 15 MB.' : 'No se pudo leer el archivo.' }) : next());
  const rolDe = req => req.user.rol_solicitudes;
  const quien = req => ({ id: Number(req.user.sub) || null, usuario: String(req.user.email || '').toLowerCase(), nombre: req.user.nombre || '', rol: rolDe(req) });
  const portalUrl = () => (appUrl ? appUrl() : (process.env.APP_URL || 'https://polipay-conciliacion-liquidacion.onrender.com'));
  const ruta = (metodo, path, roles, fn, mw) => app[metodo](path, auth, ...(mw ? [mw] : []), async (req, res) => {
    try {
      if (!rolDe(req) || !F.ROLES[rolDe(req)]) throw E(403, 'No tienes acceso al portal de solicitudes.');
      if (roles && !roles.includes(rolDe(req))) throw E(403, 'Tu rol no tiene permiso para esta acción.');
      res.setHeader('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
      console.error('[solicitudes]', path, e); res.status(500).json({ error: 'Error del servidor. Intenta de nuevo.' });
    }
  });

  /* ---------- alcance: qué clientes (grupos) ve cada quien ---------- */
  async function alcance(req, q) {
    const rol = rolDe(req), id = Number(req.user.sub);
    if (rol === 'cliente') return (await (q || db).query('select c.id_grupo from sc_contactos c join sc_clientes k on k.id_grupo = c.id_grupo join usuarios u on u.id = c.usuario_id where c.usuario_id = $1 and c.activo and k.activo and u.activo', [id])).rows.map(r => r.id_grupo);
    // Comercial ve sus unidades de negocio: las que tiene asignadas como Ejecutivo Comercial y aquellas donde está dado de alta como contacto «account manager».
    if (rol === 'comercial') return (await (q || db).query(`select id_grupo from sc_clientes where ejecutivo_id = $1 union select id_grupo from sc_contactos where usuario_id = $1 and tipo = 'account_manager' and activo`, [id])).rows.map(r => r.id_grupo);
    return null;
  }
  const veGrupo = (alc, g) => alc === null || alc.includes(Number(g));
  const unicoAdmin = async q => Number((await (q || db).query("select count(*)::int n from usuarios where rol = 'admin' and activo")).rows[0].n) <= 1;

  async function feriados(q) {
    try { return new Set((await (q || db).query('select fecha::text f from feriados')).rows.map(r => String(r.f).slice(0, 10))); } catch (_e) { return new Set(); }
  }

  /* ---------- lectura de una solicitud ---------- */
  const SEL = `select s.*, g.nombre_cliente as cliente, u.nombre as ejecutivo_nombre, (s.estado = any($1::text[]) and s.vence_at is not null and s.vence_at < now()) as vencida
                 from sc_solicitudes s left join grupos g on g.id_grupo = s.id_grupo left join sc_clientes k on k.id_grupo = s.id_grupo left join usuarios u on u.id = k.ejecutivo_id`;
  async function cargar(req, id, q, bloquear) {
    const alc = await alcance(req, q);
    if (bloquear) await (q || db).query('select id from sc_solicitudes where id = $1 for update', [id]);
    const s = (await (q || db).query(`${SEL} where s.id = $2`, [F.ABIERTAS, id])).rows[0];
    if (!s) throw E(404, 'No existe esa solicitud.');
    if (!veGrupo(alc, s.id_grupo) || !F.veEstado(rolDe(req), s.estado)) throw E(404, 'No existe esa solicitud.');
    if (rolDe(req) === 'cliente' && s.estado === 'borrador' && s.solicitante !== quien(req).usuario) throw E(404, 'No existe esa solicitud.');
    return s;
  }
  const juntos = s => ({ ...(s.datos || {}), ...(s.datos_comercial || {}), ...(s.datos_operacion || {}) });
  const etapaDe = (t, key) => { const sec = t.secciones.find(x => x.campos.some(c => c.key === key)); return sec ? sec.llena : null; };
  const camposDe = (t, etapa) => t.secciones.filter(s => s.llena === etapa).flatMap(s => s.campos);

  // Qué etapas puede editar este rol en este estado.
  function editables(rol, estado) {
    const out = [];
    if ((rol === 'cliente' && ['borrador', 'devuelta'].includes(estado)) || (['comercial', 'dir_comercial', 'admin'].includes(rol) && ['borrador', 'devuelta', 'revision_comercial'].includes(estado))) out.push('cliente');
    if (['comercial', 'dir_comercial', 'admin'].includes(rol) && estado === 'revision_comercial') out.push('comercial');
    if (['operacion', 'admin'].includes(rol) && estado === 'ejecucion') out.push('operacion');
    return out;
  }

  const titulo = (tipo, d) => {
    switch (tipo) {
      case 'alta_subafiliado': return txt(d.nombre_comercial, 160);
      case 'alta_afiliacion': return txt(d.razon_social || d.nombre_comercial, 160);
      case 'usuario_suite': return txt(`${d.tipo_solicitud || 'Usuario'}${d.usuario_email ? ': ' + d.usuario_email : ''}`, 160);
      case 'cambio_datos_sub': return txt(`Sub afiliado ${d.id_sub || ''}${d.afil_principal ? ' · afiliación ' + d.afil_principal : ''}`, 160);
      default: return txt(d.afil_principal ? `Afiliación ${d.afil_principal}` : null, 160);
    }
  };

  /* ---------- bitácora de la solicitud (encadenada) ---------- */
  async function evento(t, req, s, accion, { estado_ant, estado_nvo, detalle, visible, meta } = {}) {
    const y = quien(req); const ts = new Date().toISOString();
    const prev = (await t.query('select hash from sc_eventos where solicitud_id = $1 order by id desc limit 1', [s.id])).rows[0];
    const prevHash = prev ? prev.hash : '';
    const hash = sha([prevHash, s.id, ts, y.usuario, accion, estado_nvo || '', detalle || '', JSON.stringify(meta || {})].join('|'));
    await t.query(`insert into sc_eventos(solicitud_id, ts, actor, actor_nombre, actor_rol, accion, estado_ant, estado_nvo, detalle, visible_cliente, meta, prev_hash, hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [s.id, ts, y.usuario, y.nombre, y.rol, accion, estado_ant || null, estado_nvo || null, detalle || null, !!visible, meta ? JSON.stringify(meta) : null, prevHash || null, hash]);
  }

  /* ---------- avisos por correo (después de guardar; nunca tumban la acción) ---------- */
  async function usuariosConRol(rol) { return (await db.query('select email from usuarios where activo and rol_solicitudes = $1', [rol])).rows.map(r => r.email); }
  async function avisar(accion, s, nota, adjuntos) {
    try {
      const a = MAIL.AVISOS[accion]; if (!a || !correo || !correo.activo || !correo.activo()) return;
      const dest = new Set(), cc = new Set();
      const resolver = async (tok, dst) => {
        if (tok === 'solicitante' && s.solicitante) dst.add(s.solicitante);
        else if (tok === 'ejecutivo') {
          const e = s.ejecutivo || (await db.query('select u.email from sc_clientes k join usuarios u on u.id = k.ejecutivo_id where k.id_grupo = $1', [s.id_grupo])).rows[0]?.email; if (e) dst.add(e);
          (await db.query("select u.email from sc_contactos c join usuarios u on u.id = c.usuario_id where c.id_grupo = $1 and c.tipo = 'account_manager' and c.activo and u.activo", [s.id_grupo])).rows.forEach(r => r.email && dst.add(String(r.email).toLowerCase()));
        }
        else if (tok === 'dirComercialSiSinEjecutivo') { if (!dst.size && !s.ejecutivo) (await usuariosConRol('dir_comercial')).forEach(x => dst.add(x)); }
        else if (tok === 'rol:direccionSiAplica') { if (s.requiere_direccion) (await usuariosConRol('direccion')).forEach(x => dst.add(x)); }
        else if (tok.startsWith('rol:')) (await usuariosConRol(tok.slice(4))).forEach(x => dst.add(x));
      };
      for (const tok of a.a) await resolver(tok, dest);
      for (const tok of (a.cc || [])) await resolver(tok, cc);
      cc.forEach(x => dest.has(x) && cc.delete(x));
      if (!dest.size) return;
      const t = CAT.tipo(s.tipo);
      const m = MAIL.armar({ titulo: a.asunto, folio: s.folio, tipo: t ? t.corto : s.tipo, cliente: s.cliente, estado: s.estado, mensaje: a.msg, nota, url: portalUrl(), paraCliente: a.paraCliente });
      await correo.enviar({ to: [...dest], cc: [...cc], subject: `${a.asunto} · ${s.folio}`, html: m.html, text: m.text, ...(adjuntos && adjuntos.length ? { attachments: adjuntos } : {}) });
    } catch (e) { console.warn('[solicitudes] correo:', e.message); }
  }

  /* ---------- lo que ve cada rol de una solicitud ---------- */
  const PARTE_CLIENTE_COMERCIAL = k => /^(tasa_|monto_fijo|esquema_liq)/.test(k);
  function filtrarParaCliente(s, t) {
    const privados = new Set(t.secciones.flatMap(x => x.campos).filter(c => c.privado).map(c => c.key));
    const com = Object.fromEntries(Object.entries(s.datos_comercial || {}).filter(([k]) => PARTE_CLIENTE_COMERCIAL(k)));
    const op = s.estado === 'completada' ? Object.fromEntries(Object.entries(s.datos_operacion || {}).filter(([k]) => !privados.has(k) && k !== 'obs_operacion')) : {};
    return { ...s, datos_comercial: com, datos_operacion: op, referencia_pos: {}, alertas: [], ejecutivo: null, liberada_por: null, ejecutada_por: null, validada_por: null, direccion_por: null, motivo_direccion: null };
  }
  const TXT_CLIENTE = { liberar: 'Tu solicitud pasó a Operación', tomar: 'Operación empezó a ejecutar tu solicitud', ejecutar: 'Tu solicitud se ejecutó y está en validación', validar: 'Tu solicitud se completó', devolver: 'Necesitamos que completes o corrijas tu solicitud', rechazar: 'Tu solicitud fue rechazada', cancelar: 'La solicitud se canceló' };
  const eventosCliente = evs => evs.filter(e => e.visible_cliente).map(e => ({ id: e.id, ts: e.ts, accion: e.accion, estado_nvo: e.estado_nvo, detalle: TXT_CLIENTE[e.accion] ? TXT_CLIENTE[e.accion] + (e.meta && e.meta.comentario && ['devolver', 'rechazar', 'cancelar'].includes(e.accion) ? ': ' + e.meta.comentario : '') : e.detalle, actor_nombre: e.actor_rol === 'cliente' ? e.actor_nombre : 'Polipay' }));
  const ABIERTA = e => F.ABIERTAS.includes(e);
  const fila = (s, rol) => ({ id: s.id, folio: s.folio, tipo: s.tipo, tipo_nombre: (CAT.tipo(s.tipo) || {}).corto || s.tipo, id_grupo: s.id_grupo, cliente: s.cliente, titulo: s.titulo, afiliacion: s.afiliacion,
    estado: s.estado, estado_nombre: (rol === 'cliente' ? F.ESTADOS[s.estado].cliente : F.ESTADOS[s.estado].nombre), tono: F.ESTADOS[s.estado].tono,
    enviada_at: s.enviada_at, vence_at: ABIERTA(s.estado) ? s.vence_at : null, vencida: !!s.vencida, critica: !!s.requiere_direccion, creado_at: s.creado_at, actualizado_at: s.actualizado_at, cerrada_at: s.cerrada_at,
    solicitante_nombre: s.solicitante_nombre, ejecutivo_nombre: rol === 'cliente' ? null : s.ejecutivo_nombre });

  /* ====================================================================== quién soy + catálogo */
  let limpiadas = false;   // la unidad de negocio es el grupo de cliente: se retiran una vez los grupos de afiliaciones que se habían creado solos y nadie usa
  const limpiaAutomaticas = async () => { if (limpiadas) return; limpiadas = true; try { await db.query("delete from sc_unidades where creado_por = 'automático (POS)' and id not in (select unidad_id from sc_contacto_unidades)"); } catch (e) { limpiadas = false; console.warn('[solicitudes] limpieza:', e.message); } };
  ruta('get', '/api/sc/yo', null, async (req, res) => {
    await limpiaAutomaticas();
    const y = quien(req), alc = await alcance(req);
    let grupos = [];
    if (alc === null) grupos = (await db.query('select g.id_grupo, g.nombre_cliente as nombre, coalesce(k.activo,false) as portal from grupos g left join sc_clientes k on k.id_grupo = g.id_grupo order by g.nombre_cliente')).rows;
    else if (alc.length) grupos = (await db.query('select id_grupo, nombre_cliente as nombre, true as portal from grupos where id_grupo = any($1::int[]) order by nombre_cliente', [alc])).rows;
    res.json({ usuario: y.usuario, nombre: y.nombre, rol: y.rol, rolNombre: F.ROLES[y.rol].nombre, staff: F.esStaff(y.rol), grupos, tipos: CAT.TIPOS.map(CAT.publico), estados: F.ESTADOS, orden: F.ORDEN, roles: F.lista(),
      puede_crear: ['cliente', 'comercial', 'dir_comercial', 'admin'].includes(y.rol), puede_clientes: ['comercial', 'dir_comercial', 'admin'].includes(y.rol), puede_asignar: ['dir_comercial', 'admin'].includes(y.rol) });
  });
  ruta('get', '/api/sc/catalogo', null, async (req, res) => {
    const g = Number(req.query.id_grupo); const alc = await alcance(req);
    if (!Number.isFinite(g) || !veGrupo(alc, g)) throw E(403, 'Ese cliente no es tuyo.');
    const restr = rolDe(req) === 'cliente' ? await POS.restriccionDe(db, Number(req.user.sub), g) : null;
    const c = await POS.catalogoGrupo(db, g, restr); if (!c) throw E(404, 'No existe ese grupo de cliente.');
    // Datos de la persona para precargar sus solicitudes (nombre, correo, puesto, teléfono).
    const ct = (await db.query('select puesto, telefono from sc_contactos where usuario_id = $1 and id_grupo = $2', [Number(req.user.sub), g])).rows[0] || {};
    res.json({ ...c, perfil: { nombre: req.user.nombre || '', email: String(req.user.email || '').toLowerCase(), puesto: ct.puesto || '', telefono: ct.telefono || '' } });
  });

  /* ====================================================================== clientes y contactos */
  ruta('get', '/api/sc/ejecutivos', ['comercial', 'dir_comercial', 'admin', 'consulta'], async (req, res) => {
    res.json((await db.query("select id, nombre, email, rol_solicitudes as rol from usuarios where activo and rol_solicitudes in ('comercial','dir_comercial') order by nombre")).rows);
  });
  ruta('get', '/api/sc/clientes', ['comercial', 'dir_comercial', 'admin', 'consulta'], async (req, res) => {
    const alc = await alcance(req);
    const rows = (await db.query(
      `select g.id_grupo, g.nombre_cliente as nombre, coalesce(k.activo,false) as portal, k.ejecutivo_id, u.nombre as ejecutivo, k.notas,
              (select count(*)::int from sc_contactos c where c.id_grupo = g.id_grupo and c.activo) as contactos,
              (select count(*)::int from afil_grupo ag where ag.id_grupo = g.id_grupo) as unidades,
              (select count(*)::int from sc_solicitudes s where s.id_grupo = g.id_grupo and s.estado = any($1::text[])) as abiertas
         from grupos g left join sc_clientes k on k.id_grupo = g.id_grupo left join usuarios u on u.id = k.ejecutivo_id order by g.nombre_cliente`, [F.ABIERTAS])).rows;
    res.json(rows.filter(r => veGrupo(alc, r.id_grupo)));
  });
  ruta('put', '/api/sc/clientes/:id', ['comercial', 'dir_comercial', 'admin'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}; const alc = await alcance(req);
    const g = (await db.query('select id_grupo from grupos where id_grupo = $1', [id])).rows[0]; if (!g) throw E(404, 'No existe ese grupo de cliente.');
    const rol = rolDe(req);
    if (rol === 'comercial' && !veGrupo(alc, id)) throw E(403, 'Ese cliente no es tuyo.');
    const actual = (await db.query('select * from sc_clientes where id_grupo = $1', [id])).rows[0];
    let ejecutivo = actual ? actual.ejecutivo_id : null;
    if (b.ejecutivo_id !== undefined) {
      if (!['dir_comercial', 'admin'].includes(rol)) throw E(403, 'Solo la Dirección Comercial o un administrador asigna al Ejecutivo Comercial.');
      ejecutivo = b.ejecutivo_id === null || b.ejecutivo_id === '' ? null : Number(b.ejecutivo_id);
      if (ejecutivo && !(await db.query("select 1 from usuarios where id = $1 and activo and rol_solicitudes in ('comercial','dir_comercial')", [ejecutivo])).rows.length) throw E(400, 'Ese usuario no es Ejecutivo Comercial.');
    }
    const activo = b.activo === undefined ? (actual ? actual.activo : true) : !!b.activo;
    await db.query(`insert into sc_clientes(id_grupo, ejecutivo_id, activo, notas, creado_por) values($1,$2,$3,$4,$5)
      on conflict (id_grupo) do update set ejecutivo_id = $2, activo = $3, notas = coalesce($4, sc_clientes.notas), actualizado_at = now()`, [id, ejecutivo, activo, b.notas === undefined ? null : txt(b.notas, 500), quien(req).usuario]);
    if (bit) await bit(req, 'sc_cliente_editar', `grupo=${id} ejecutivo=${ejecutivo || '—'} portal=${activo}`, { resource_type: 'sc_cliente', resource_id: id });
    res.json({ ok: true });
  });
  ruta('get', '/api/sc/clientes/:id/contactos', ['comercial', 'dir_comercial', 'admin', 'consulta'], async (req, res) => {
    const id = Number(req.params.id); if (!veGrupo(await alcance(req), id)) throw E(403, 'Ese cliente no es tuyo.');
    const rows = (await db.query('select c.usuario_id, c.tipo, u.email, u.nombre, c.puesto, c.telefono, c.activo, u.ultimo_login_at from sc_contactos c join usuarios u on u.id = c.usuario_id where c.id_grupo = $1 order by c.tipo, c.activo desc, u.nombre', [id])).rows;
    const asig = (await db.query('select usuario_id, unidad_id from sc_contacto_unidades where id_grupo = $1', [id])).rows;
    res.json(rows.map(r => ({ ...r, unidades: asig.filter(a => a.usuario_id === r.usuario_id).map(a => a.unidad_id) })));
  });
  // Unidades de negocio a las que tiene acceso un contacto (vacío = todo el cliente). Solo acepta unidades activas del mismo cliente.
  async function asignarUnidades(q, uid, idGrupo, ids) {
    const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite))];
    const validas = lista.length ? (await q.query('select id from sc_unidades where id_grupo = $1 and activo and id = any($2::int[])', [idGrupo, lista])).rows.map(r => r.id) : [];
    if (validas.length !== lista.length) throw E(400, 'Hay una unidad de negocio que no es de este cliente.');
    await q.query('delete from sc_contacto_unidades where usuario_id = $1 and id_grupo = $2', [uid, idGrupo]);
    for (const u of validas) await q.query('insert into sc_contacto_unidades(usuario_id, id_grupo, unidad_id) values($1,$2,$3)', [uid, idGrupo, u]);
  }
  ruta('post', '/api/sc/clientes/:id/contactos', ['comercial', 'dir_comercial', 'admin'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}; if (!veGrupo(await alcance(req), id)) throw E(403, 'Ese cliente no es tuyo.');
    if (!(await db.query('select 1 from grupos where id_grupo = $1', [id])).rows.length) throw E(404, 'No existe ese grupo de cliente.');
    const email = String(b.email || '').trim().toLowerCase(), nombre = txt(b.nombre, 120);
    const tipoC = b.tipo === 'account_manager' ? 'account_manager' : 'cliente';
    if (!V.MAIL_RE.test(email)) throw E(400, 'El correo no es válido.');
    if (!nombre) throw E(400, 'Escribe el nombre de la persona.');
    const ex = (await db.query('select id, rol, rol_solicitudes, activo from usuarios where email_hash = $1 or lower(email) = $2', [C.hmacEmail(email), email])).rows[0];
    let uid;
    if (tipoC === 'cliente') {
      if (ex) {
        if (ex.rol !== 'cliente') throw E(409, 'Ese correo ya es de un usuario interno de Polipay. Para darle acceso a esta unidad elige el tipo «Account manager».');
        uid = ex.id; await db.query("update usuarios set activo = true, rol_solicitudes = 'cliente', nombre = $2 where id = $1", [uid, nombre]);
      } else {
        uid = (await db.query(`insert into usuarios(email, nombre, rol, rol_solicitudes, activo, creado_por, email_hash, email_cifrado, nombre_cifrado) values($1,$2,'cliente','cliente',true,$3,$4,$5,$6) returning id`,
          [email, nombre, quien(req).usuario, C.hmacEmail(email), C.encrypt(email), C.encrypt(nombre)])).rows[0].id;
      }
    } else {
      // Uso interno: un account manager es una persona de Polipay con rol Comercial en el portal; aquí solo se le da la unidad de negocio.
      if (ex) {
        if (ex.rol === 'cliente') throw E(409, 'Ese correo ya es de un contacto de cliente. Usa el correo de Polipay del account manager.');
        uid = ex.id;
        if (ex.rol !== 'admin' && !['comercial', 'dir_comercial'].includes(ex.rol_solicitudes)) {
          if (ex.rol_solicitudes) throw E(409, `Esa persona ya tiene el rol «${ex.rol_solicitudes}» en el portal; un account manager debe ser Comercial. Cámbialo en Administración → Usuarios.`);
          await db.query("update usuarios set rol_solicitudes = 'comercial', activo = true where id = $1", [uid]);
        }
      } else {
        uid = (await db.query(`insert into usuarios(email, nombre, rol, rol_solicitudes, activo, creado_por, email_hash, email_cifrado, nombre_cifrado) values($1,$2,'solicitudes','comercial',true,$3,$4,$5,$6) returning id`,
          [email, nombre, quien(req).usuario, C.hmacEmail(email), C.encrypt(email), C.encrypt(nombre)])).rows[0].id;
      }
    }
    await db.query(`insert into sc_clientes(id_grupo, creado_por) values($1,$2) on conflict (id_grupo) do nothing`, [id, quien(req).usuario]);
    await db.query(`insert into sc_contactos(usuario_id, id_grupo, puesto, telefono, creado_por, tipo) values($1,$2,$3,$4,$5,$6)
      on conflict (usuario_id, id_grupo) do update set activo = true, puesto = $3, telefono = $4, tipo = $6`, [uid, id, txt(b.puesto, 80), txt(b.telefono, 30), quien(req).usuario, tipoC]);
    if (tipoC === 'cliente') await asignarUnidades(db, uid, id, b.unidades);
    if (bit) await bit(req, 'sc_contacto_alta', `grupo=${id} ${email} tipo=${tipoC}`, { resource_type: 'sc_cliente', resource_id: id });
    let aviso = false;
    try {
      if (correo && correo.activo && correo.activo()) {
        const g = (await db.query('select nombre_cliente from grupos where id_grupo = $1', [id])).rows[0];
        const m = MAIL.armar({ titulo: 'Te dimos acceso al portal de solicitudes', folio: 'Acceso', tipo: 'Portal de clientes', cliente: g && g.nombre_cliente, estado: 'completada', mensaje: `Ya puedes pedir altas de comercios, afiliaciones y usuarios, y seguir cada solicitud. Entra con «Entrar con Google» usando esta misma cuenta: ${email}.`, url: portalUrl(), paraCliente: true });
        await correo.enviar({ to: [email], subject: 'Acceso al portal de solicitudes de Polipay', html: m.html, text: m.text }); aviso = true;
      }
    } catch (e) { console.warn('[solicitudes] correo de acceso:', e.message); }
    res.status(201).json({ ok: true, usuario_id: uid, aviso });
  });
  ruta('put', '/api/sc/clientes/:id/contactos/:uid', ['comercial', 'dir_comercial', 'admin'], async (req, res) => {
    const id = Number(req.params.id), uid = Number(req.params.uid), b = req.body || {}; if (!veGrupo(await alcance(req), id)) throw E(403, 'Ese cliente no es tuyo.');
    const c = (await db.query('select * from sc_contactos where id_grupo = $1 and usuario_id = $2', [id, uid])).rows[0]; if (!c) throw E(404, 'No existe ese contacto.');
    const activo = b.activo === undefined ? c.activo : !!b.activo;
    if (b.unidades !== undefined) await asignarUnidades(db, uid, id, b.unidades);
    await db.query('update sc_contactos set activo = $3, puesto = $4, telefono = $5 where id_grupo = $1 and usuario_id = $2', [id, uid, activo, b.puesto === undefined ? c.puesto : txt(b.puesto, 80), b.telefono === undefined ? c.telefono : txt(b.telefono, 30)]);
    // Sin ningún cliente activo, la persona ya no entra al sistema.
    const otros = (await db.query('select count(*)::int n from sc_contactos where usuario_id = $1 and activo', [uid])).rows[0].n;
    await db.query("update usuarios set activo = $2 where id = $1 and rol = 'cliente'", [uid, otros > 0]);   // el account manager es personal de Polipay: solo pierde esta unidad de negocio
    if (bit) await bit(req, 'sc_contacto_editar', `grupo=${id} usuario=${uid} activo=${activo}`, { resource_type: 'sc_cliente', resource_id: id });
    res.json({ ok: true });
  });

  /* ====================================================================== unidades de negocio del cliente */
  const duenoDe = async (req, id) => { if (!veGrupo(await alcance(req), id)) throw E(403, 'Ese cliente no es tuyo.'); if (!(await db.query('select 1 from grupos where id_grupo = $1', [id])).rows.length) throw E(404, 'No existe ese grupo de cliente.'); };
  const listaTxt = (v, max) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\n;]+/)).map(x => String(x).trim().slice(0, max || 120)).filter(Boolean))];
  ruta('get', '/api/sc/clientes/:id/unidades', ['comercial', 'dir_comercial', 'admin', 'consulta'], async (req, res) => {
    const id = Number(req.params.id); await duenoDe(req, id);
    const afs = await POS.afiliacionesDe(db, id);
    res.json({ unidades: await POS.unidadesDe(db, id), afiliaciones: afs.map(a => ({ numero: a.numero, razon_social: a.razon_social })), comercios_pos: await POS.comerciosDe(db, id, afs.map(a => a.numero)) });
  });
  ruta('post', '/api/sc/clientes/:id/unidades/importar', ['comercial', 'dir_comercial', 'admin'], async (req, res) => {
    const id = Number(req.params.id); await duenoDe(req, id);
    const n = await POS.importarUnidades(db, id, quien(req).usuario);
    if (bit) await bit(req, 'sc_unidades_importar', `grupo=${id} creadas=${n}`, { resource_type: 'sc_cliente', resource_id: id });
    res.json({ ok: true, creadas: n });
  });
  ruta('post', '/api/sc/clientes/:id/unidades', ['comercial', 'dir_comercial', 'admin'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}; await duenoDe(req, id);
    const nombre = txt(b.nombre, 120); if (!nombre) throw E(400, 'Escribe el nombre de la unidad de negocio.');
    if ((await db.query('select 1 from sc_unidades where id_grupo = $1 and lower(nombre) = lower($2)', [id, nombre])).rows.length) throw E(409, 'Ya existe una unidad de negocio con ese nombre.');
    const r = await db.query('insert into sc_unidades(id_grupo, nombre, afiliaciones, comercios, creado_por) values($1,$2,$3,$4,$5) returning id', [id, nombre, listaTxt(b.afiliaciones, 30), listaTxt(b.comercios), quien(req).usuario]);
    if (bit) await bit(req, 'sc_unidad_alta', `grupo=${id} ${nombre}`, { resource_type: 'sc_cliente', resource_id: id });
    res.status(201).json({ ok: true, id: r.rows[0].id });
  });
  ruta('put', '/api/sc/clientes/:id/unidades/:uid', ['comercial', 'dir_comercial', 'admin'], async (req, res) => {
    const id = Number(req.params.id), uid = Number(req.params.uid), b = req.body || {}; await duenoDe(req, id);
    const u = (await db.query('select * from sc_unidades where id = $1 and id_grupo = $2', [uid, id])).rows[0]; if (!u) throw E(404, 'No existe esa unidad de negocio.');
    const nombre = b.nombre === undefined ? u.nombre : txt(b.nombre, 120); if (!nombre) throw E(400, 'Escribe el nombre de la unidad de negocio.');
    if ((await db.query('select 1 from sc_unidades where id_grupo = $1 and lower(nombre) = lower($2) and id <> $3', [id, nombre, uid])).rows.length) throw E(409, 'Ya existe una unidad de negocio con ese nombre.');
    await db.query('update sc_unidades set nombre = $2, afiliaciones = $3, comercios = $4, activo = $5 where id = $1',
      [uid, nombre, b.afiliaciones === undefined ? u.afiliaciones : listaTxt(b.afiliaciones, 30), b.comercios === undefined ? u.comercios : listaTxt(b.comercios), b.activo === undefined ? u.activo : !!b.activo]);
    if (bit) await bit(req, 'sc_unidad_editar', `grupo=${id} unidad=${uid}`, { resource_type: 'sc_cliente', resource_id: id });
    res.json({ ok: true });
  });

  /* ====================================================================== solicitudes: lista, alta, detalle */
  // Filtro común de la lista y del registro exportable. Respeta el alcance de cada rol.
  async function filtroLista(req) {
    const alc = await alcance(req), rol = rolDe(req), q = req.query;
    const where = [], args = [F.ABIERTAS];
    const add = (sql, v) => { args.push(v); where.push(sql.replace(/\$#/g, '$' + args.length)); };
    if (alc !== null) add('s.id_grupo = any($#::int[])', alc.length ? alc : [-1]);
    if (['operacion', 'coordinacion', 'direccion'].includes(rol)) add('s.estado <> all($#::text[])', F.PREVIOS_A_OPERACION.slice()); else if (rol === 'consulta') where.push("s.estado <> 'borrador'");
    if (rol === 'cliente') add("(s.estado <> 'borrador' or s.solicitante = $#)", quien(req).usuario);
    if (q.estado === 'abiertas') where.push('s.estado = any($1::text[])');
    else if (q.estado) { const es = String(q.estado).split(',').filter(x => F.ESTADOS[x]); if (es.length) add('s.estado = any($#::text[])', es); }
    if (q.tipo && CAT.tipo(q.tipo)) add('s.tipo = $#', q.tipo);
    if (q.id_grupo) add('s.id_grupo = $#', Number(q.id_grupo));
    if (q.vencidas === '1') where.push('(s.estado = any($1::text[]) and s.vence_at is not null and s.vence_at < now())');
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.desde || '')) add("s.creado_at >= ($#::date)::timestamptz", q.desde);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.hasta || '')) add("s.creado_at < (($#::date) + 1)::timestamptz", q.hasta);
    if (q.q) add("(lower(s.folio) like $# or lower(coalesce(s.titulo,'')) like $# or lower(coalesce(g.nombre_cliente,'')) like $# or lower(coalesce(s.afiliacion,'')) like $#)", '%' + String(q.q).toLowerCase().slice(0, 60) + '%');
    return { fixed: where.length ? ' where ' + where.join(' and ') : '', args, rol };
  }
  ruta('get', '/api/sc/solicitudes', null, async (req, res) => {
    const { fixed, args, rol } = await filtroLista(req); const q = req.query;
    const pagina = Math.max(1, Number(q.pagina) || 1), por = 25;
    const total = (await db.query(`select (count(*) filter (where $1::text[] is not null))::int n from sc_solicitudes s left join grupos g on g.id_grupo = s.id_grupo${fixed}`, args)).rows[0].n;
    const filas = (await db.query(`${SEL}${fixed} order by (s.estado = any($1::text[])) desc, s.actualizado_at desc limit ${por} offset ${(pagina - 1) * por}`, args)).rows;
    res.json({ total, pagina, por, filas: filas.map(s => fila(s, rol)) });
  });

  // Registro de TODAS las solicitudes (de cualquier tipo y estado) en Excel: una hoja general y una por tipo con todos sus datos. Equivale a las bitácoras de los procedimientos
  // (activaciones de sub afiliados, usuarios, cambios). Solo personal de Polipay; cada quien exporta lo que ve.
  ruta('get', '/api/sc/registro.xlsx', ['comercial', 'dir_comercial', 'operacion', 'coordinacion', 'direccion', 'consulta', 'admin'], async (req, res) => {
    const ExcelJS = require('exceljs'); const { fixed, args } = await filtroLista(req);
    const rows = (await db.query(`${SEL}${fixed} order by s.creado_at, s.id limit 20000`, args)).rows;
    const wb = new ExcelJS.Workbook(); wb.creator = 'Polipay · Solicitudes'; wb.created = new Date();
    const fT = v => (v ? new Date(v) : null); const dias = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 864e5 * 10) / 10 : null);
    const cabecera = ws => { ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF04003A' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.columns.forEach(c => { c.width = Math.min(46, Math.max(12, String(c.header).length + 4)); }); ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } }; };
    const g = wb.addWorksheet('Solicitudes');
    g.columns = [['Folio', 'folio'], ['Tipo', 'tipo'], ['Formato', 'formato'], ['Cliente', 'cliente'], ['Afiliación', 'afiliacion'], ['Solicitud', 'titulo'], ['Estado', 'estado'], ['Creada', 'creado'], ['Enviada', 'enviada'], ['Liberada', 'liberada'], ['Ejecutada', 'ejecutada'], ['Cerrada', 'cerrada'], ['Días enviada → cerrada', 'dias'],
      ['Devoluciones', 'dev'], ['Solicitante', 'solicitante'], ['Ejecutivo Comercial', 'ejecutivo'], ['Libera', 'libera'], ['Ejecuta', 'ejecuta'], ['Valida', 'valida'], ['Dirección', 'direccion'], ['Crítica', 'critica'], ['Motivo (rechazo o cancelación)', 'motivo']].map(([header, key]) => ({ header, key }));
    for (const s of rows) { const t = CAT.tipo(s.tipo) || {}; g.addRow({ folio: s.folio, tipo: t.corto || s.tipo, formato: t.formato, cliente: s.cliente, afiliacion: s.afiliacion, titulo: s.titulo, estado: (F.ESTADOS[s.estado] || {}).nombre, creado: fT(s.creado_at), enviada: fT(s.enviada_at), liberada: fT(s.liberada_at), ejecutada: fT(s.ejecutada_at), cerrada: fT(s.cerrada_at),
      dias: dias(s.enviada_at, s.cerrada_at), dev: s.devoluciones, solicitante: s.solicitante, ejecutivo: s.ejecutivo, libera: s.liberada_por, ejecuta: s.ejecutada_por, valida: s.validada_por, direccion: s.direccion_por, critica: s.requiere_direccion ? 'Sí' : 'No', motivo: s.motivo }); }
    ['creado', 'enviada', 'liberada', 'ejecutada', 'cerrada'].forEach(k => { g.getColumn(k).numFmt = 'dd/mm/yyyy hh:mm'; }); cabecera(g);
    for (const t of CAT.TIPOS) {
      const mios = rows.filter(s => s.tipo === t.id); if (!mios.length) continue;
      const campos = t.secciones.flatMap(sec => sec.campos.filter(c => !c.privado).map(c => ({ c, key: c.key })));
      const w = wb.addWorksheet(t.corto.slice(0, 31));
      w.columns = [{ header: 'Folio', key: 'folio' }, { header: 'Cliente', key: 'cliente' }, { header: 'Estado', key: 'estado' }, { header: 'Creada', key: 'creado' }, { header: 'Cerrada', key: 'cerrada' }, ...campos.map(({ c }) => ({ header: c.label, key: 'k_' + c.key }))];
      for (const s of mios) { const d = { ...(s.datos || {}), ...(s.datos_comercial || {}), ...(s.datos_operacion || {}) }; const r = { folio: s.folio, cliente: s.cliente, estado: (F.ESTADOS[s.estado] || {}).nombre, creado: fT(s.creado_at), cerrada: fT(s.cerrada_at) };
        campos.forEach(({ c }) => { const v = d[c.key]; r['k_' + c.key] = Array.isArray(v) ? v.join(', ') : (v === undefined ? null : v); }); w.addRow(r); }
      w.getColumn('creado').numFmt = 'dd/mm/yyyy hh:mm'; w.getColumn('cerrada').numFmt = 'dd/mm/yyyy hh:mm'; cabecera(w);
    }
    const buf = await wb.xlsx.writeBuffer();
    if (bit) await bit(req, 'sc_registro_exportar', `filas=${rows.length}`, { resource_type: 'sc_registro' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="registro-solicitudes-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  });

  ruta('post', '/api/sc/solicitudes', ['cliente', 'comercial', 'dir_comercial', 'admin'], async (req, res) => {
    const b = req.body || {}, rol = rolDe(req), y = quien(req); const t = CAT.tipo(b.tipo);
    if (!t) throw E(400, 'Elige el tipo de solicitud.');
    const alc = await alcance(req);
    let idGrupo = Number(b.id_grupo);
    if (!Number.isFinite(idGrupo) && alc && alc.length === 1) idGrupo = alc[0];
    if (!Number.isFinite(idGrupo) || !veGrupo(alc, idGrupo)) throw E(403, 'Elige un cliente tuyo.');
    const cli = (await db.query('select g.id_grupo, coalesce(k.activo, false) as portal, k.ejecutivo_id, u.email as ejecutivo from grupos g left join sc_clientes k on k.id_grupo = g.id_grupo left join usuarios u on u.id = k.ejecutivo_id where g.id_grupo = $1', [idGrupo])).rows[0];
    if (!cli) throw E(404, 'No existe ese grupo de cliente.');
    if (rol === 'cliente' && !cli.portal) throw E(403, 'Tu acceso al portal está desactivado.');
    const datos = normalizarParte(t, 'cliente', b.datos || {}, true);
    const errs = V_errores(t, 'cliente', datos); if (Object.keys(errs).length) throw E(400, 'Revisa los datos marcados.', { campos: errs });
    if (rol === 'cliente') { const fuera = POS.fueraDeAlcance(await POS.restriccionDe(db, y.id, idGrupo), datos); if (Object.keys(fuera).length) throw E(400, 'Hay datos fuera de tus unidades de negocio.', { campos: fuera }); }
    const id = await db.tx(async tx => {
      const n = Number((await tx.query("select nextval('sc_folio_seq') n")).rows[0].n);
      const folio = `SC-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`;
      const afil = txt(datos.afil_principal, 30);
      const r = (await tx.query(`insert into sc_solicitudes(folio, tipo, id_grupo, datos, titulo, afiliacion, solicitante, solicitante_nombre, capturada_por_comercial, ejecutivo) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [folio, t.id, idGrupo, JSON.stringify(datos), titulo(t.id, datos), afil, y.usuario, y.nombre, rol !== 'cliente', cli.ejecutivo ? String(cli.ejecutivo).toLowerCase() : null])).rows[0];
      await evento(tx, req, r, 'crear', { estado_nvo: 'borrador', detalle: `Creó la solicitud «${t.corto}»${rol !== 'cliente' ? ' a nombre del cliente' : ''}`, visible: true });
      return r.id;
    });
    res.status(201).json({ ok: true, id });
  });

  // Normaliza y filtra los datos de una etapa: solo las llaves de ese tipo y etapa.
  function normalizarParte(t, etapa, entrada, soloLlaves) {
    const out = {}; const campos = camposDe(t, etapa);
    for (const c of campos) if (entrada[c.key] !== undefined) out[c.key] = V.normalizarValor(c, entrada[c.key]);
    void soloLlaves; return out;
  }
  const V_errores = (t, etapa, datos) => F.erroresFormato(t, etapa, datos);

  async function docsSubidos(q, id) { return (await q.query('select doc_id from sc_adjuntos where solicitud_id = $1 and not retirado and doc_id is not null', [id])).rows.map(r => r.doc_id); }

  ruta('get', '/api/sc/solicitudes/:id', null, async (req, res) => {
    const id = Number(req.params.id), rol = rolDe(req);
    const s = await cargar(req, id); const t = CAT.tipo(s.tipo);
    const todo = juntos(s);
    const adjuntos = (await db.query('select id, doc_id, nombre, mime, tam, visible_cliente, subido_por, subido_at from sc_adjuntos where solicitud_id = $1 and not retirado order by id', [id])).rows
      .filter(a => rol !== 'cliente' || a.visible_cliente);
    let eventos = (await db.query('select id, ts, actor, actor_nombre, actor_rol, accion, estado_ant, estado_nvo, detalle, visible_cliente, meta, hash from sc_eventos where solicitud_id = $1 order by id', [id])).rows;
    if (rol === 'cliente') eventos = eventosCliente(eventos);
    const subidos = await docsSubidos(db, id);
    const unico = await unicoAdmin();
    const acciones = F.accionesDisponibles({ sol: s, rol, usuario: quien(req).usuario, unicoAdmin: unico });
    const editar = editables(rol, s.estado);
    const out = rol === 'cliente' ? filtrarParaCliente(s, t) : s;
    const neg = rol === 'cliente' ? { errores: {}, alertas: [] } : await POS.validarNegocio(db, s.tipo, todo, { id_grupo: s.id_grupo, id: s.id });
    res.json({
      solicitud: { ...out, ...{ cliente: s.cliente } }, tipo: CAT.publico(t), adjuntos, eventos, acciones, editables: editar,
      faltantes: { cliente: F.faltantes(t, 'cliente', todo), comercial: F.faltantes(t, 'comercial', todo), operacion: F.faltantes(t, 'operacion', todo) },
      docs_faltantes: F.docsFaltantes(t, subidos, 'cliente').map(d => d.id), docs_faltantes_comercial: F.docsFaltantes(t, subidos, 'comercial').map(d => d.id),
      errores_negocio: neg.errores, alertas: neg.alertas, estado_info: { ...F.ESTADOS[s.estado], nombre_cliente: F.ESTADOS[s.estado].cliente },
      requiere_direccion: CAT.requiereDireccion(t, todo), referencia_pos: rol === 'cliente' ? {} : s.referencia_pos,
    });
  });

  /* ---------- editar una etapa ---------- */
  ruta('put', '/api/sc/solicitudes/:id', ['cliente', 'comercial', 'dir_comercial', 'operacion', 'admin'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, rol = rolDe(req);
    await db.tx(async tx => {
      const s = await cargar(req, id, tx, true); const t = CAT.tipo(s.tipo);
      if (b._v != null && Number(b._v) !== s.version) throw E(409, 'Alguien más cambió esta solicitud. Recarga para ver lo último.');
      const permitidas = editables(rol, s.estado); const cambios = [];
      const nuevo = { datos: { ...s.datos }, datos_comercial: { ...s.datos_comercial }, datos_operacion: { ...s.datos_operacion } };
      for (const [parte, etapa] of [['datos', 'cliente'], ['datos_comercial', 'comercial'], ['datos_operacion', 'operacion']]) {
        if (!b[parte] || !Object.keys(b[parte]).length) continue;
        if (!permitidas.includes(etapa)) throw E(409, `No puedes editar esa parte de la solicitud en este momento (${F.ESTADOS[s.estado].nombre}).`);
        const parteNueva = normalizarParte(t, etapa, b[parte]);
        const errs = V_errores(t, etapa, { ...juntos({ datos: nuevo.datos, datos_comercial: nuevo.datos_comercial, datos_operacion: nuevo.datos_operacion }), ...parteNueva });
        const propios = Object.fromEntries(Object.entries(errs).filter(([k]) => parteNueva[k] !== undefined)); if (Object.keys(propios).length) throw E(400, 'Revisa los datos marcados.', { campos: propios });
        for (const [k, v] of Object.entries(parteNueva)) if (JSON.stringify(nuevo[parte][k]) !== JSON.stringify(v)) { cambios.push(k); nuevo[parte][k] = v; }
      }
      if (!cambios.length) return;
      if (rol === 'cliente') { const fuera = POS.fueraDeAlcance(await POS.restriccionDe(tx, Number(req.user.sub), s.id_grupo), nuevo.datos); if (Object.keys(fuera).length) throw E(400, 'Hay datos fuera de tus unidades de negocio.', { campos: fuera }); }
      const todo = juntos(nuevo); const dir = CAT.requiereDireccion(t, todo);
      const neg = await POS.validarNegocio(tx, s.tipo, todo, { id_grupo: s.id_grupo, id: s.id });
      await tx.query(`update sc_solicitudes set datos=$2, datos_comercial=$3, datos_operacion=$4, titulo=$5, afiliacion=$6, requiere_direccion=$7, motivo_direccion=$8, alertas=$9, version=version+1, actualizado_at=now() where id=$1`,
        [id, JSON.stringify(nuevo.datos), JSON.stringify(nuevo.datos_comercial), JSON.stringify(nuevo.datos_operacion), titulo(s.tipo, todo) || s.titulo, txt(todo.afil_principal, 30) || s.afiliacion, dir.si, dir.motivo || null, JSON.stringify(neg.alertas)]);
      const etiquetas = cambios.map(k => { const c = t.secciones.flatMap(x => x.campos).find(x => x.key === k); return c ? c.label : k; });
      await evento(tx, req, s, 'editar', { estado_ant: s.estado, estado_nvo: s.estado, detalle: `Modificó: ${etiquetas.join(', ')}`, visible: false, meta: { campos: cambios } });
    });
    res.json({ ok: true });
  });

  /* ---------- PDF al completarse: se genera solo, se guarda en la solicitud y se manda por correo ---------- */
  // Dos versiones: la completa (solo personal de Polipay) y la del cliente (sin datos internos). Si la solicitud se vuelve a completar, reemplaza las anteriores.
  async function generaPdfFinal(req, id) {
    try {
      const s = (await db.query(`${SEL} where s.id = $2`, [F.ABIERTAS, id])).rows[0]; if (!s) return null; const t = CAT.tipo(s.tipo);
      const eventos = (await db.query('select * from sc_eventos where solicitud_id = $1 order by id', [id])).rows;
      const adj = (await db.query('select doc_id, nombre, subido_at, retirado, visible_cliente from sc_adjuntos where solicitud_id = $1', [id])).rows;
      const completo = await PDF.formatoPDF({ s, cliente: s.cliente, eventos, adjuntos: adj, paraCliente: false });
      const sc = filtrarParaCliente(s, t); sc.cliente = s.cliente;
      const delCliente = await PDF.formatoPDF({ s: sc, cliente: s.cliente, eventos: eventosCliente(eventos), adjuntos: adj.filter(a => a.visible_cliente), paraCliente: true });
      await db.tx(async tx => {
        await tx.query("update sc_adjuntos set retirado = true where solicitud_id = $1 and subido_por = 'sistema:formato' and not retirado", [id]);
        const guarda = (buf, nombre, visible) => tx.query('insert into sc_adjuntos(solicitud_id, doc_id, nombre, mime, tam, archivo_cifrado, visible_cliente, subido_por) values($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, '', nombre, 'application/pdf', buf.length, cifArchivo(buf), visible, 'sistema:formato']);
        await guarda(completo, `${t.formato}-${s.folio}-completo.pdf`, false);
        await guarda(delCliente, `${t.formato}-${s.folio}.pdf`, true);
        await evento(tx, req, s, 'pdf_generado', { estado_ant: s.estado, estado_nvo: s.estado, detalle: `Se generó y guardó el formato ${t.formato} en PDF (completo y para el cliente)`, visible: false });
      });
      return { filename: `${t.formato}-${s.folio}.pdf`, contentType: 'application/pdf', content: delCliente };
    } catch (e) { console.warn('[solicitudes] PDF final:', e.message); return null; }
  }

  /* ---------- acciones del flujo ---------- */
  ruta('post', '/api/sc/solicitudes/:id/accion', null, async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, rol = rolDe(req), y = quien(req);
    const a = F.ACCIONES[b.accion]; if (!a) throw E(400, 'Esa acción no existe.');
    const comentario = txt(b.comentario, 2000);
    let auto = false;   // la pidió Comercial (account manager): pasa directo a Operación, sin otra revisión de Comercial
    await db.tx(async tx => {
      const s = await cargar(req, id, tx, true); const t = CAT.tipo(s.tipo);
      if (b._v != null && Number(b._v) !== s.version) throw E(409, 'Alguien más cambió esta solicitud. Recarga para ver lo último.');
      if (!a.roles.includes(rol)) throw E(403, 'Tu rol no puede hacer eso.');
      if (!a.desde.includes(s.estado)) throw E(409, `No se puede hacer eso: la solicitud está «${F.ESTADOS[s.estado].nombre}».`);
      if (rol === 'cliente' && b.accion === 'cancelar' && !F.CLIENTE_CANCELA_DESDE.includes(s.estado)) throw E(409, 'Ya está en proceso: pide la cancelación a tu Ejecutivo Comercial.');
      if (a.comentario && (!comentario || comentario.length < a.comentario)) throw E(400, `Escribe un comentario de al menos ${a.comentario} caracteres.`);
      const todo = juntos(s); const sets = {}; let marcaAdmin = null;
      const hab = await feriados(tx);
      const unico = await unicoAdmin(tx);

      if (b.accion === 'enviar') {
        const falta = F.faltantes(t, 'cliente', todo); const fmt = F.erroresFormato(t, 'cliente', todo); const docs = F.docsFaltantes(t, await docsSubidos(tx, id), 'cliente');
        if (falta.length || Object.keys(fmt).length || docs.length) throw E(400, 'Falta información para enviar la solicitud.', { faltan: falta, campos: fmt, documentos: docs.map(d => d.nombre) });
        const neg = await POS.validarNegocio(tx, s.tipo, todo, { id_grupo: s.id_grupo, id: s.id });
        if (rol === 'cliente') Object.assign(neg.errores, POS.fueraDeAlcance(await POS.restriccionDe(tx, Number(req.user.sub), s.id_grupo), todo));
        if (Object.keys(neg.errores).length) throw E(400, 'Hay datos que no coinciden con POS.', { campos: neg.errores });
        const ref = await POS.referenciaPos(tx, s.id_grupo, todo.afil_principal);
        sets.referencia_pos = JSON.stringify(ref); sets.alertas = JSON.stringify(neg.alertas);
        // Condiciones heredadas: el sub afiliado toma la tasa y la liquidación de su afiliación principal.
        if (s.tipo === 'alta_subafiliado' && ref.tasas) {
          const dc = { ...s.datos_comercial };
          dc.tasa_debito = ref.tasas.tdd; dc.tasa_credito = ref.tasas.tdc; dc.tasa_internacional = ref.tasas.int; dc.tasa_amex = ref.tasas.amex;
          const aBanca = todo.liq_destino === CAT.DEST_BANCA;
          dc.esquema_liq = aBanca ? 'Cuenta nueva en Suite Banca (se abre para este comercio)' : (ref.cuenta ? `Liquidación por la concentradora de la afiliación (${ref.cuenta.banco} ····${POS.ult4(ref.cuenta.clabe)})` : 'Liquidación por la concentradora de la afiliación');
          sets.datos_comercial = JSON.stringify(dc);
          // La cuenta concentradora sale de las cuentas de liquidación de POS (no de lo que mande el cliente) y queda en el formato.
          const dd = { ...s.datos }; delete dd.liq_banco; delete dd.liq_clabe; delete dd.liq_titular;
          if (!aBanca && ref.cuenta) { dd.liq_banco = ref.cuenta.banco; dd.liq_clabe = '····' + POS.ult4(ref.cuenta.clabe); dd.liq_titular = ref.cuenta.titular; }
          sets.datos = JSON.stringify(dd);
        }
        if (!s.enviada_at) sets.enviada_at = new Date().toISOString();
        sets.vence_at = sumaHabiles(new Date(), SLA_COMERCIAL_DIAS, hab).toISOString();
        const dir = CAT.requiereDireccion(t, todo); sets.requiere_direccion = dir.si; sets.motivo_direccion = dir.motivo || null;
      }
      // Lo que pide Comercial (account manager) no necesita su propia revisión: si su parte está completa, va directo a Operación.
      if (b.accion === 'enviar' && ['comercial', 'dir_comercial'].includes(rol)) {
        const todoC = { ...todo, ...(sets.datos_comercial ? JSON.parse(sets.datos_comercial) : (s.datos_comercial || {})) };
        const fC = F.faltantes(t, 'comercial', todoC), eC = F.erroresFormato(t, 'comercial', todoC), dC = F.docsFaltantes(t, await docsSubidos(tx, id), 'comercial');
        if (!fC.length && !Object.keys(eC).length && !dC.length) {
          auto = true; sets.liberada_por = y.usuario; sets.liberada_at = new Date().toISOString(); sets.vence_at = sumaHabiles(new Date(), t.sla_dias, hab).toISOString();
        }
      }
      if (b.accion === 'devolver') { sets.vence_at = null; sets.devoluciones = s.devoluciones + 1; }
      if (b.accion === 'liberar') {
        let dc = { ...s.datos_comercial };
        const ref = await POS.referenciaPos(tx, s.id_grupo, todo.afil_principal);
        if (s.tipo === 'alta_subafiliado' && ref.tasas) { dc.tasa_debito = ref.tasas.tdd; dc.tasa_credito = ref.tasas.tdc; dc.tasa_internacional = ref.tasas.int; dc.tasa_amex = ref.tasas.amex; sets.datos_comercial = JSON.stringify(dc); }
        const todo2 = { ...todo, ...dc };
        const falta = F.faltantes(t, 'comercial', todo2); const fmt = F.erroresFormato(t, 'comercial', todo2); const docs = F.docsFaltantes(t, await docsSubidos(tx, id), 'comercial');
        if (falta.length || Object.keys(fmt).length || docs.length) throw E(400, 'Falta completar la parte comercial.', { faltan: falta, campos: fmt, documentos: docs.map(d => d.nombre) });
        const neg = await POS.validarNegocio(tx, s.tipo, todo2, { id_grupo: s.id_grupo, id: s.id });
        if (Object.keys(neg.errores).length) throw E(400, 'Hay datos que no coinciden con POS.', { campos: neg.errores });
        sets.referencia_pos = JSON.stringify(ref); sets.alertas = JSON.stringify(neg.alertas);
        sets.liberada_por = y.usuario; sets.liberada_at = new Date().toISOString(); sets.vence_at = sumaHabiles(new Date(), t.sla_dias, hab).toISOString();
        const dir = CAT.requiereDireccion(t, todo2); sets.requiere_direccion = dir.si; sets.motivo_direccion = dir.motivo || null;
      }
      if (b.accion === 'tomar') { sets.ejecutada_por = y.usuario; }
      if (b.accion === 'devolver_comercial') { sets.ejecutada_por = null; sets.liberada_por = null; sets.vence_at = sumaHabiles(new Date(), SLA_COMERCIAL_DIAS, hab).toISOString(); sets.devoluciones = s.devoluciones + 1; }
      if (b.accion === 'ejecutar') {
        if (s.ejecutada_por && s.ejecutada_por !== y.usuario && rol !== 'admin') throw E(409, 'Otra persona de Operación tomó esta solicitud.');
        const falta = F.faltantes(t, 'operacion', todo); const fmt = F.erroresFormato(t, 'operacion', todo);
        if (falta.length || Object.keys(fmt).length) throw E(400, 'Falta completar los datos de Operación.', { faltan: falta, campos: fmt });
        if (t.dato_requerido_ejecutar && todo[t.dato_requerido_ejecutar.campo] !== t.dato_requerido_ejecutar.valor) throw E(409, t.dato_requerido_ejecutar.mensaje);
        sets.ejecutada_por = s.ejecutada_por || y.usuario; sets.ejecutada_at = new Date().toISOString(); sets.vence_at = sumaHabiles(new Date(), SLA_VALIDACION_DIAS, hab).toISOString();
      }
      if (b.accion === 'observar') { sets.validada_por = null; sets.direccion_por = null; sets.ejecutada_at = null; sets.vence_at = null; }
      let hacia = auto ? 'operacion' : a.hacia;
      if (b.accion === 'validar') {
        const dir = !!s.requiere_direccion;
        const ejecutor = s.ejecutada_por;
        const mismo = u => u && u === y.usuario;
        // Qué firma da esta persona: Coordinación (valida) o Dirección. El administrador completa la firma que falte.
        let slot;
        if (rol === 'coordinacion') slot = 'coordinacion';
        else if (rol === 'direccion') slot = dir ? 'direccion' : 'coordinacion';
        else slot = !s.validada_por ? 'coordinacion' : 'direccion';
        if (slot === 'coordinacion' && s.validada_por) throw E(409, 'Coordinación ya validó; falta la firma de la Dirección de Operaciones.');
        if (slot === 'direccion' && s.direccion_por) throw E(409, 'La Dirección ya firmó.');
        if (slot === 'direccion' && !dir) slot = 'coordinacion';
        const conflictos = [];
        if (mismo(ejecutor)) conflictos.push('quien ejecutó la solicitud no puede validarla');
        if (slot === 'direccion' && mismo(s.validada_por)) conflictos.push('la firma de la Dirección debe ser de otra persona que la de Coordinación');
        if (slot === 'coordinacion' && mismo(s.direccion_por)) conflictos.push('la firma de Coordinación debe ser de otra persona que la de la Dirección');
        if (conflictos.length) {
          if (rol === 'admin' && unico && comentario && comentario.length >= 20) marcaAdmin = conflictos.join('; ');
          else throw E(409, `Segregación de funciones: ${conflictos.join('; ')}.${rol === 'admin' ? ' Como único administrador puedes autoaprobar con un comentario de al menos 20 caracteres.' : ''}`);
        }
        if (slot === 'coordinacion') sets.validada_por = y.usuario; else sets.direccion_por = y.usuario;
        const gerOk = slot === 'coordinacion' || s.validada_por || sets.validada_por, dirOk = !dir || slot === 'direccion' || s.direccion_por;
        if (gerOk && dirOk) { sets.cerrada_at = new Date().toISOString(); sets.vence_at = null; }
        else hacia = 'validacion';   // firma parcial: sigue en validación esperando la otra
        sets._slot = slot;
      }
      if (b.accion === 'rechazar' || b.accion === 'cancelar') { sets.motivo = comentario; sets.cerrada_at = new Date().toISOString(); sets.vence_at = null; }
      const slot = sets._slot; delete sets._slot;

      const cols = Object.keys(sets), args = [id, hacia];
      const setSql = ['estado = $2', ...(hacia !== s.estado ? ['estado_desde = now()'] : []), 'version = version + 1', 'actualizado_at = now()'];
      for (const k of cols) { args.push(sets[k]); setSql.push(`${k} = $${args.length}`); }
      await tx.query(`update sc_solicitudes set ${setSql.join(', ')} where id = $1`, args);
      const parcial = b.accion === 'validar' && hacia === 'validacion';
      const detalleBase = { enviar: auto ? 'Envió la solicitud y la liberó a Operación (la pidió Comercial: no requiere otra revisión de Comercial)' : 'Envió la solicitud', devolver: 'Devolvió la solicitud al cliente', liberar: 'Liberó la solicitud a Operación', tomar: 'Tomó la solicitud para ejecutarla', devolver_comercial: 'Regresó la solicitud a Comercial',
        ejecutar: 'Marcó la solicitud como ejecutada', observar: 'Devolvió la solicitud con observaciones', validar: parcial ? `Dio su firma de ${slot === 'direccion' ? 'Dirección' : 'Coordinación'}; falta la otra firma` : 'Validó y completó la solicitud', rechazar: 'Rechazó la solicitud', cancelar: 'Canceló la solicitud' }[b.accion];
      const visibles = ['enviar', 'devolver', 'liberar', 'tomar', 'ejecutar', 'validar', 'rechazar', 'cancelar'];
      await evento(tx, req, s, b.accion, { estado_ant: s.estado, estado_nvo: hacia, detalle: `${detalleBase}${comentario ? ': ' + comentario : ''}${marcaAdmin ? ' · AUTOAPROBADA por el único administrador (' + marcaAdmin + ')' : ''}`,
        visible: visibles.includes(b.accion) && !parcial, meta: { comentario, ...(marcaAdmin ? { autoaprobada: marcaAdmin } : {}), ...(slot ? { firma: slot } : {}) } });
      if (marcaAdmin) await tx.query('update sc_solicitudes set alertas = alertas || $2::jsonb where id = $1', [id, JSON.stringify([`Autoaprobada por el único administrador: ${marcaAdmin}`])]);
    });
    const sFresh = (await db.query(`${SEL} where s.id = $2`, [F.ABIERTAS, id])).rows[0];
    // Al completarse: se genera el PDF, se guarda en la solicitud y se manda adjunto (versión del cliente) con el aviso de «completada».
    let pdfFinal = null; if (b.accion === 'validar' && sFresh.estado === 'completada') pdfFinal = await generaPdfFinal(req, id);
    if (!(b.accion === 'validar' && sFresh.estado === 'validacion')) avisar(auto ? 'liberar' : b.accion, sFresh, txt(b.comentario, 2000), pdfFinal ? [pdfFinal] : null);
    res.json({ ok: true, estado: sFresh.estado });
  });

  /* ---------- comentarios ---------- */
  ruta('post', '/api/sc/solicitudes/:id/comentarios', null, async (req, res) => {
    const id = Number(req.params.id), rol = rolDe(req), texto = txt((req.body || {}).texto, 2000);
    if (!texto) throw E(400, 'Escribe el comentario.');
    if (rol === 'consulta') throw E(403, 'Tu rol es de solo lectura.');
    await db.tx(async tx => {
      const s = await cargar(req, id, tx, true);
      if (F.FINALES.includes(s.estado) && rol === 'cliente') throw E(409, 'La solicitud ya está cerrada.');
      const visible = rol === 'cliente' ? true : !!(req.body || {}).visible_cliente;
      await evento(tx, req, s, 'comentario', { estado_ant: s.estado, estado_nvo: s.estado, detalle: texto, visible });
      await tx.query('update sc_solicitudes set actualizado_at = now() where id = $1', [id]);
    });
    res.status(201).json({ ok: true });
  });

  /* ---------- archivos ---------- */
  ruta('post', '/api/sc/solicitudes/:id/adjuntos', null, async (req, res) => {
    const id = Number(req.params.id), rol = rolDe(req), y = quien(req), docId = txt(req.body.doc_id, 40);
    if (!req.file) throw E(400, 'Elige el archivo.');
    const mime = tipoArchivo(req.file); if (!mime) throw E(400, 'Ese tipo de archivo no se acepta. Sube PDF, imagen (JPG, PNG, WEBP, HEIC), Word, Excel, CSV, XML o TXT.');
    if (rol === 'consulta') throw E(403, 'Tu rol es de solo lectura.');
    await db.tx(async tx => {
      const s = await cargar(req, id, tx, true); const t = CAT.tipo(s.tipo);
      const puede = rol === 'cliente' ? ['borrador', 'devuelta'].includes(s.estado) : (['comercial', 'dir_comercial', 'admin'].includes(rol) ? F.ABIERTAS.includes(s.estado) : ['operacion', 'ejecucion', 'validacion'].includes(s.estado));
      if (!puede) throw E(409, 'No puedes agregar archivos en este momento.');
      if (docId && !(t.docs || []).some(d => d.id === docId)) throw E(400, 'Ese documento no se pide en esta solicitud.');
      if (docId) await tx.query('update sc_adjuntos set retirado = true where solicitud_id = $1 and doc_id = $2 and not retirado', [id, docId]);
      const visible = rol === 'cliente' ? true : (req.body.visible_cliente === '0' || req.body.visible_cliente === 'false' ? false : ['comercial', 'dir_comercial', 'admin'].includes(rol));
      await tx.query('insert into sc_adjuntos(solicitud_id, doc_id, nombre, mime, tam, archivo_cifrado, visible_cliente, subido_por) values($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, docId, String(req.file.originalname || 'archivo').slice(0, 200), mime, req.file.size, cifArchivo(req.file.buffer), visible, y.usuario]);
      const d = (t.docs || []).find(x => x.id === docId);
      await evento(tx, req, s, 'adjunto', { estado_ant: s.estado, estado_nvo: s.estado, detalle: `Subió ${d ? '«' + d.nombre + '»' : 'un archivo'} (${req.file.originalname}, ${Math.round(req.file.size / 1024)} KB)`, visible });
      await tx.query('update sc_solicitudes set actualizado_at = now() where id = $1', [id]);
    });
    res.status(201).json({ ok: true });
  }, upl('archivo'));
  ruta('get', '/api/sc/solicitudes/:id/adjuntos/:aid', null, async (req, res) => {
    const id = Number(req.params.id), rol = rolDe(req); const s = await cargar(req, id);
    const a = (await db.query('select * from sc_adjuntos where id = $1 and solicitud_id = $2 and not retirado', [Number(req.params.aid), id])).rows[0];
    if (!a || (rol === 'cliente' && !a.visible_cliente)) throw E(404, 'No existe ese archivo.');
    const buf = descifArchivo(a.archivo_cifrado); if (!buf) throw E(500, 'No se pudo descifrar el archivo.');
    await db.tx(async tx => evento(tx, req, s, 'descarga', { estado_ant: s.estado, estado_nvo: s.estado, detalle: `Descargó «${a.nombre}»`, visible: false }));
    res.setHeader('Content-Type', a.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.nombre)}"`);
    res.send(buf);
  });

  /* ---------- formato oficial imprimible ---------- */
  ruta('get', '/api/sc/solicitudes/:id/formato.html', ['comercial', 'dir_comercial', 'operacion', 'coordinacion', 'direccion', 'consulta', 'admin'], async (req, res) => {
    const id = Number(req.params.id); const s = await cargar(req, id);
    const eventos = (await db.query('select * from sc_eventos where solicitud_id = $1 order by id', [id])).rows;
    const adjuntos = (await db.query('select doc_id, nombre, subido_at, retirado from sc_adjuntos where solicitud_id = $1', [id])).rows;
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(IMP.formatoHTML({ s, cliente: s.cliente, eventos, adjuntos }));
  });

  /* ---------- formatos oficiales en PDF ---------- */
  const sirve = (res, buf, nombre) => { res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`); res.send(buf); };
  ruta('get', '/api/sc/solicitudes/:id/formato.pdf', null, async (req, res) => {
    const id = Number(req.params.id), rol = rolDe(req); const s = await cargar(req, id); const t = CAT.tipo(s.tipo);
    let eventos = (await db.query('select * from sc_eventos where solicitud_id = $1 order by id', [id])).rows;
    let adj = (await db.query('select doc_id, nombre, subido_at, retirado, visible_cliente from sc_adjuntos where solicitud_id = $1', [id])).rows;
    let sol = s;
    if (rol === 'cliente') { sol = filtrarParaCliente(s, t); sol.cliente = s.cliente; eventos = eventosCliente(eventos); adj = adj.filter(a => a.visible_cliente); }
    const buf = await PDF.formatoPDF({ s: sol, cliente: s.cliente, eventos, adjuntos: adj, paraCliente: rol === 'cliente' });
    await db.tx(async tx => evento(tx, req, s, 'descarga_pdf', { estado_ant: s.estado, estado_nvo: s.estado, detalle: `Descargó el formato ${t.formato} en PDF`, visible: false }));
    sirve(res, buf, `${t.formato}-${s.folio}.pdf`);
  });
  ruta('get', '/api/sc/formatos', null, async (req, res) => {
    res.json(CAT.TIPOS.map(t => ({ id: t.id, formato: t.formato, codigo: t.codigo, nombre: t.nombre, corto: t.corto, descripcion: t.descripcion, critica: !!t.critica })));
  });
  ruta('get', '/api/sc/formatos/:tipo/pdf', null, async (req, res) => {
    const t = CAT.tipo(req.params.tipo); if (!t) throw E(404, 'No existe ese formato.');
    sirve(res, await PDF.formatoEnBlanco(t.id), `${t.formato}-formato-en-blanco.pdf`);
  });

  /* ====================================================================== tablero */
  ruta('get', '/api/sc/tablero', null, async (req, res) => {
    const rol = rolDe(req), y = quien(req); const alc = await alcance(req);
    const where = [], args = [F.ABIERTAS];
    if (alc !== null) { args.push(alc.length ? alc : [-1]); where.push(`s.id_grupo = any($${args.length}::int[])`); }
    if (['operacion', 'coordinacion', 'direccion'].includes(rol)) { args.push(F.PREVIOS_A_OPERACION); where.push(`s.estado <> all($${args.length}::text[])`); }
    if (rol === 'cliente') { args.push(y.usuario); where.push(`(s.estado <> 'borrador' or s.solicitante = $${args.length})`); }
    const w = where.length ? ' where ' + where.join(' and ') : '';
    const todas = (await db.query(`${SEL}${w}`, args)).rows;
    const conteos = {}; for (const s of todas) conteos[s.estado] = (conteos[s.estado] || 0) + 1;
    const paraMi = todas.filter(s => {
      if (rol === 'cliente') return s.estado === 'devuelta';
      if (rol === 'comercial' || rol === 'dir_comercial') return s.estado === 'revision_comercial';
      if (rol === 'operacion') return s.estado === 'operacion' || (s.estado === 'ejecucion' && (!s.ejecutada_por || s.ejecutada_por === y.usuario));
      if (rol === 'coordinacion') return s.estado === 'validacion' && !s.validada_por;
      if (rol === 'direccion') return s.estado === 'validacion' && s.requiere_direccion && !s.direccion_por;
      if (rol === 'admin') return F.ABIERTAS.includes(s.estado) && s.estado !== 'borrador';
      return false;
    }).sort((a, b) => (b.vencida - a.vencida) || (new Date(a.vence_at || 8e15) - new Date(b.vence_at || 8e15))).slice(0, 30).map(s => fila(s, rol));
    const abiertas = todas.filter(s => F.ABIERTAS.includes(s.estado));
    const out = { rol, conteos, abiertas: abiertas.length, vencidas: abiertas.filter(s => s.vencida).length, para_mi: paraMi };
    if (rol !== 'cliente') {
      const cerr = todas.filter(s => s.estado === 'completada' && s.enviada_at && s.cerrada_at && new Date(s.cerrada_at) > new Date(Date.now() - 90 * 864e5));
      const porTipo = {};
      for (const t of CAT.TIPOS) {
        const mios = todas.filter(s => s.tipo === t.id), cc = cerr.filter(s => s.tipo === t.id);
        porTipo[t.id] = { nombre: t.corto, total: mios.length, abiertas: mios.filter(s => F.ABIERTAS.includes(s.estado)).length, completadas: mios.filter(s => s.estado === 'completada').length,
          dias_promedio: cc.length ? Math.round(cc.reduce((a, s) => a + (new Date(s.cerrada_at) - new Date(s.enviada_at)) / 864e5, 0) / cc.length * 10) / 10 : null, sla_dias: t.sla_dias,
          devueltas: mios.filter(s => s.devoluciones > 0).length };
      }
      out.por_tipo = porTipo;
      const enviadas = todas.filter(s => s.enviada_at);
      out.tasa_devolucion = enviadas.length ? Math.round(enviadas.filter(s => s.devoluciones > 0).length / enviadas.length * 1000) / 10 : null;
    }
    res.json(out);
  });
}

module.exports = { montar, sumaHabiles };
