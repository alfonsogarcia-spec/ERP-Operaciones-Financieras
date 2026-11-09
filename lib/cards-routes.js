/* ============================================================================
   lib/cards-routes.js — Cards (BSO): solicitud de fondeos, CEP y asignación de saldo.
   Se monta desde server.js con mountCardsRoutes(app, deps).
   deps: { auth, requiereRol, bit, db, C, X, enviarXLSX, sesEnabled, sendSES }

   Estructura EMPRESA → UN → TARJETA (cada una con su CLABE). Un comercial solicita un fondeo a una empresa suya (el sistema cotiza
   comisión + IVA), sube el CEP del depósito (solo se aceptan CEP) y tesorería confirma que el saldo se asignó. Reglas en cards-flujo.js.
   ========================================================================= */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const F = require('./cards-fondeo.js');
const CEPX = require('./cards-cep-extract.js');
const DEST = require('./cards-destinatarios.js');
const FL = require('./cards-flujo.js');
const BNK = require('./cards-bancos.js');
const CONTA = require('./cards-contabilidad.js');
const CORREO = require('./cards-correo.js');
const CMP = require('./cards-comprobante.js');

// Roles dentro de Polipay Cards Settlement (independientes del rol en POS Settlement; `req.user.rol_cards` es el efectivo):
//   admin (administrador de POS: todo) · cards_admin · cards_tesoreria (ve lo por asignar, asigna/rechaza y sube el comprobante) · comercial · cards_consulta.
// Sus usuarios se administran en el panel de Administración (server.js · /api/usuarios).
const VER = ['admin', 'comercial', 'cards_admin', 'cards_tesoreria', 'cards_consulta'];
const SOLICITA = ['admin', 'comercial', 'cards_admin'];                 // pedir un fondeo y subir su CEP (el comercial, solo lo suyo)
const MANUAL = ['admin', 'cards_admin'];                                // registrar un fondeo que ya llegó, sin solicitud previa
const ASIGNA = ['admin', 'cards_admin', 'cards_tesoreria'];             // asignar / rechazar y subir el comprobante del saldo
const SIN_CEP = ['cards_tesoreria'];                                      // asignar un fondeo SIN CEP: solo tesorería
const ESTRUCTURA = ['admin', 'cards_admin'];                            // empresas, bancos y destinatarios (y, con ellos, todo lo de la estructura)
const ESTRUCTURA_UN = ['admin', 'cards_admin', 'cards_operaciones'];   // unidades de negocio y tarjetas: también Operaciones (sin tocar cuenta ni tasas, que heredan de la empresa)
const CONTA_VER = ['admin', 'cards_admin', 'cards_consulta'];            // contabilidad: ver los cortes de comisiones
const CONTA_ADM = ['admin', 'cards_admin'];                             // contabilidad: generar y reenviar un corte
const NIVELES = ['EMPRESA', 'UN', 'TARJETA'];
const CEP_MAX = 10 * 1024 * 1024;
const COMPROBANTES_MAX = 5;                      // por fondeo
const REMITENTE = 'Polipay · Operaciones · BSO';   // nombre con el que salen los correos de Cards (la dirección sigue siendo la de SES)
// Los correos de Cards. Cada uno tiene su lista de destinatarios (automáticos y fijos).
const EVENTOS = [
  { id: 'solicitado', nombre: 'Nueva solicitud', cuando: 'Cuando alguien registra una solicitud de fondeo.', auto: true },
  { id: 'por_asignar', nombre: 'Por asignar', cuando: 'Cuando se sube el CEP y el fondeo queda con tesorería (lleva el CEP y su validación).', auto: true },
  { id: 'asignado', nombre: 'Saldo asignado', cuando: 'Cuando tesorería confirma la asignación del saldo (lleva el CEP y el comprobante).', auto: true },
  { id: 'rechazado', nombre: 'Rechazado', cuando: 'Cuando tesorería rechaza el fondeo y lo devuelve.', auto: true },
  { id: 'cancelado', nombre: 'Solicitud cancelada', cuando: 'Cuando se cancela una solicitud.', auto: true },
  { id: 'corte', nombre: 'Corte de comisiones (contabilidad)', cuando: 'Cuando se hace el corte: comisiones cobradas con IVA, y la razón social y el RFC a facturar, con el detalle en Excel.', auto: false },
];
const TOL = FL.TOL;

const hoyMX = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const fechaReal = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const dinero = v => { const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/[,\s$]/g, '')); return Number.isFinite(n) ? n : NaN; };
const txt = (v, max) => { const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
const pct = v => (v === undefined || v === null || String(v).trim() === '') ? null : Number(String(v).replace(',', '.'));
const numN = v => v == null ? null : Number(v);

// Comprobante del saldo asignado: PDF, imagen (captura de pantalla) o Excel. Se valida el contenido, no solo la extensión.
function tipoComprobante(buf, nombre) {
  const ext = (String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  const ini = buf.slice(0, 8);
  if (ext === 'pdf' && ini.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (ext === 'png' && ini.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if ((ext === 'jpg' || ext === 'jpeg') && ini.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (ext === 'xlsx' && ini.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return null;
}

// Firmas de archivo: el CEP llega como PDF o XML (también se reconocen imágenes, que luego se rechazan con un mensaje claro).
function tipoCep(buf, nombre) {
  const ext = (String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  const ini = buf.slice(0, 8);
  if (ext === 'pdf' && ini.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (ext === 'png' && ini.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if ((ext === 'jpg' || ext === 'jpeg') && ini.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (ext === 'xml') { const t = buf.slice(0, 200).toString('utf8').replace(/^﻿/, '').trimStart(); if (t.startsWith('<')) return 'application/xml'; }
  return null;
}

function mountCardsRoutes(app, deps) {
  const { auth, requiereRol, bit, db, C, X, enviarXLSX, sesEnabled, sendSES } = deps;
  const hooks = deps.hooks || {};
  // El acceso a Cards se decide por el rol de Cards de la persona (no por su rol en POS).
  const rol = (...r) => [auth, (req, res, next) => r.includes(req.user.rol_cards) ? next() : res.status(403).json({ error: 'rol_no_autorizado', mensaje: 'Tu usuario no tiene acceso a esta parte de Cards.', necesita: r })];
  const actor = req => (req.user && (req.user.nombre || req.user.email)) || '—';
  const uid = req => parseInt(req.user && req.user.sub, 10) || null;
  const esComercial = req => req.user && req.user.rol_cards === 'comercial';
  const appUrl = () => process.env.APP_URL || 'https://polipay-conciliacion-liquidacion.onrender.com';

  // Subidas de CEP: tope por archivo y máximo 3 simultáneas (Render tiene poco heap; cada subida llega a ocupar ~3× su tamaño).
  const uploadCep = multer({ storage: multer.memoryStorage(), limits: { fileSize: CEP_MAX, files: 1 } });
  let activas = 0; const cola = [];
  const limitaSubidas = (req, res, next) => {
    const entrar = () => { activas++; let libre = false; const salir = () => { if (libre) return; libre = true; activas--; const s = cola.shift(); if (s) s(); }; res.on('close', salir); res.on('finish', salir); next(); };
    if (activas < 3) return entrar();
    if (cola.length >= 10) return res.status(429).json({ error: 'subidas_ocupadas', mensaje: 'Hay muchas subidas en curso; intenta de nuevo en unos segundos.' });
    cola.push(entrar);
  };

  /* ---------- estructura: lectura y alcance ---------- */
  async function todas() {
    const rows = (await db.query(
      `select e.*, bk.nombre as banco_nombre,
              (select count(*)::int from cards.fondeos f where f.entidad_id=e.id and f.estatus<>'CANCELADO') as n_fondeos,
              (select count(*)::int from cards.entidades h where h.parent_id=e.id) as n_hijos
         from cards.entidades e left join cards.bancos bk on bk.codigo_spei=e.banco_codigo order by e.nombre`)).rows;
    const porId = new Map(rows.map(r => [r.id, r]));
    // Cuenta de fondeo efectiva: una UN o tarjeta sin CLABE propia usa la de su padre (y así hacia arriba hasta la empresa).
    for (const r of rows) {
      let n = r, k = 0;
      while (n && !n.clabe && n.parent_id != null && k++ < 10) n = porId.get(n.parent_id);
      r.clabe_ef = (n && n.clabe) || null; r.beneficiario_ef = (n && n.beneficiario) || null; r.banco_codigo_ef = (n && n.banco_codigo) || null; r.banco_nombre_ef = (n && n.banco_nombre) || null;
      r.cuenta_de = n && n.id !== r.id ? n.id : null; r.cuenta_de_nombre = n && n.id !== r.id ? n.nombre : null;
    }
    return { rows, porId };
  }
  const ruta = (e, porId) => { const p = []; let n = e, k = 0; while (n && k++ < 10) { p.unshift(n.nombre); n = n.parent_id != null ? porId.get(n.parent_id) : null; } return p.join(' › '); };
  const activaConPadres = (e, porId) => { let n = e, k = 0; while (n && k++ < 10) { if (!n.activo) return false; n = n.parent_id != null ? porId.get(n.parent_id) : null; } return true; };
  function ordenarArbol(rows) {
    const hijos = new Map(); rows.forEach(r => { const k = r.parent_id == null ? 0 : r.parent_id; if (!hijos.has(k)) hijos.set(k, []); hijos.get(k).push(r); });
    const peso = { UN: 0, TARJETA: 1 }; const out = [];
    const rec = (k, prof) => { (hijos.get(k) || []).sort((a, b) => (peso[a.nivel] - peso[b.nivel]) || a.nombre.localeCompare(b.nombre, 'es')).forEach(r => { out.push({ ...r, profundidad: prof }); rec(r.id, prof + 1); }); };
    rec(0, 0); return out;
  }
  const errUnica = (e, res, campo, mensaje) => {
    if (e && e.code === '23505') {
      if (/correo/.test(String(e.constraint || e.message || ''))) res.status(409).json({ error: 'correo_duplicado', mensaje: MSG_CORREO_DUP });
      else res.status(409).json({ error: campo, mensaje });
      return true;
    }
    return false;
  };
  const MSG_CORREO_DUP = 'Ya hay una tarjeta activa con ese correo de usuario en esta empresa.';
  // Un correo de usuario identifica una sola tarjeta activa dentro de su empresa.
  async function correoTomado(correo, empresaId, exceptoId) {
    if (!correo) return false;
    return (await db.query("select 1 from cards.entidades where nivel='TARJETA' and activo and empresa_id=$1 and lower(correo_usuario)=$2 and id<>$3 limit 1", [empresaId, correo, exceptoId || 0])).rows.length > 0;
  }
  // El solicitante es quien tiene la sesión abierta. Un comercial pide fondeos a cualquier empresa, pero solo ve y toca los que él solicitó.
  // null = sin restricción.
  const alcance = req => esComercial(req) ? { sol: uid(req) || 0 } : null;
  const propio = (req, f) => !esComercial(req) || (f.solicitante_id != null && f.solicitante_id === uid(req));

  /* ====================== ESTRUCTURA: empresas · UN · tarjetas ====================== */
  app.get('/api/cards/entidades', ...rol(...VER, 'cards_operaciones'), async (req, res) => {
    const { rows, porId } = await todas();
    const arbol = ordenarArbol(rows).map(r => {
      const ef = F.tasasEfectivas(r.id, porId);
      return { ...r, ruta: ruta(r, porId), comision_efectiva: ef.comision_pct, iva_efectivo: ef.iva_pct, hereda_comision: r.comision_pct == null, usable: activaConPadres(r, porId) };
    });
    res.json(arbol);
  });

  /* ---------- catálogo de bancos (copia de "Bancos SPEI" de MCEB) ---------- */
  const catalogoBancos = async () => (await db.query('select codigo_spei, nombre, prefijo, activo from cards.bancos order by nombre')).rows;

  app.get('/api/cards/bancos', ...rol(...VER), async (_req, res) => {
    const rows = (await db.query(
      `select b.codigo_spei, b.nombre, b.prefijo, b.activo, (select count(*)::int from cards.entidades e where e.banco_codigo=b.codigo_spei) as en_uso
         from cards.bancos b order by b.nombre`)).rows;
    res.json(rows);
  });

  function validarBanco(b, existente) {
    const nombre = txt(b.nombre, 60);
    if (!nombre || nombre.length < 2) return { error: 'nombre_requerido', mensaje: 'Escribe el nombre del banco.' };
    let codigo = existente ? existente.codigo_spei : parseInt(String(b.codigo_spei || '').replace(/\D/g, ''), 10);
    if (!existente && !(codigo >= 1000 && codigo <= 99999)) return { error: 'codigo_invalido', mensaje: 'El código SPEI debe ser numérico de 4 o 5 dígitos (ej. 40012).' };
    return { ok: { codigo, nombre, prefijo: existente ? existente.prefijo : BNK.prefijoDe(codigo) } };
  }
  app.post('/api/cards/bancos', ...rol(...ESTRUCTURA), async (req, res) => {
    const v = validarBanco(req.body || {}, null);
    if (v.error) return res.status(400).json(v);
    const d = v.ok;
    try { await db.query('insert into cards.bancos(codigo_spei, nombre, prefijo) values($1,$2,$3)', [d.codigo, d.nombre, d.prefijo]); }
    catch (e) { if (errUnica(e, res, 'banco_duplicado', 'Ya existe un banco con ese código o con ese nombre.')) return; throw e; }
    await bit(req, 'cards_banco_alta', `${d.nombre} · ${d.codigo}`, { resource_type: 'cards_banco', resource_id: d.codigo });
    res.status(201).json({ ok: true });
  });
  app.put('/api/cards/bancos/:codigo', ...rol(...ESTRUCTURA), async (req, res) => {
    const ex = (await db.query('select * from cards.bancos where codigo_spei=$1', [parseInt(req.params.codigo, 10) || 0])).rows[0];
    if (!ex) return res.status(404).json({ error: 'no_existe' });
    const v = validarBanco(req.body || {}, ex);
    if (v.error) return res.status(400).json(v);
    const activo = (req.body || {}).activo === undefined ? ex.activo : !!req.body.activo;
    if (!activo && ex.activo && (await db.query('select 1 from cards.entidades where banco_codigo=$1 and activo limit 1', [ex.codigo_spei])).rows.length)
      return res.status(409).json({ error: 'banco_en_uso', mensaje: 'Hay cuentas activas en este banco; no se puede desactivar.' });
    try { await db.query('update cards.bancos set nombre=$1, activo=$2 where codigo_spei=$3', [v.ok.nombre, activo, ex.codigo_spei]); }
    catch (e) { if (errUnica(e, res, 'banco_duplicado', 'Ya existe un banco con ese nombre.')) return; throw e; }
    await bit(req, 'cards_banco_edicion', `${v.ok.nombre} · ${ex.codigo_spei}${ex.activo !== activo ? (activo ? ' · reactivado' : ' · desactivado') : ''}`, { resource_type: 'cards_banco', resource_id: ex.codigo_spei });
    res.json({ ok: true });
  });

  function validarEntidad(b, porId, existente, bancos) {
    const nivel = existente ? existente.nivel : String(b.nivel || '').toUpperCase();
    if (!NIVELES.includes(nivel)) return { error: 'nivel_invalido', mensaje: 'El nivel debe ser EMPRESA, UN o TARJETA.' };
    // La tarjeta se identifica por el correo de su usuario (no por el número de tarjeta); su nombre es opcional.
    let correo_usuario = null;
    if (nivel === 'TARJETA') {
      correo_usuario = String(b.correo_usuario == null ? '' : b.correo_usuario).trim().toLowerCase();
      if (!correo_usuario) return { error: 'correo_requerido', mensaje: 'Escribe el correo del usuario de la tarjeta: es lo que la identifica.' };
      if (correo_usuario.length > 120 || !/^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/.test(correo_usuario)) return { error: 'correo_invalido', mensaje: 'El correo del usuario no es válido (ej. nombre@empresa.com).' };
    }
    const nombre = txt(b.nombre, 120) || (nivel === 'TARJETA' ? correo_usuario : null);
    if (!nombre || nombre.length < 2) return { error: 'nombre_requerido', mensaje: nivel === 'UN' ? 'Escribe el nombre de la unidad de negocio (mínimo 2 caracteres).' : 'Escribe el nombre (mínimo 2 caracteres).' };
    // Cuenta de fondeo: la empresa siempre la define; una UN o tarjeta puede dejarla vacía y usar la de su padre.
    const clabeTxt = F.normalizarClabe(b.clabe);
    const propia = nivel === 'EMPRESA' || clabeTxt !== '';
    let clabe = null, beneficiario = null, banco = null;
    if (propia) {
      clabe = clabeTxt;
      if (!F.clabeValida(clabe)) return { error: 'clabe_invalida', mensaje: 'La CLABE debe tener 18 dígitos y un dígito verificador correcto.' };
      beneficiario = txt(b.beneficiario, 120);
      if (!beneficiario || beneficiario.length < 3) return { error: 'beneficiario_requerido', mensaje: 'Escribe el beneficiario: el nombre del titular de la cuenta, como aparece en el banco.' };
      // El banco sale de la CLABE (sus 3 primeros dígitos); solo si no se reconoce se pide elegirlo del catálogo.
      banco = BNK.bancoDeClabe(clabe, bancos);
      const pedido = b.banco_codigo === undefined || b.banco_codigo === null || b.banco_codigo === '' ? null : parseInt(b.banco_codigo, 10);
      if (banco && pedido != null && pedido !== banco.codigo_spei) return { error: 'banco_no_coincide', mensaje: `La CLABE pertenece a ${banco.nombre}; no coincide con el banco elegido.` };
      if (!banco) {
        banco = pedido != null ? bancos.find(x => x.codigo_spei === pedido && x.activo && x.prefijo) : null;
        if (!banco) return { error: 'banco_requerido', mensaje: `No se reconoce el banco de esta CLABE (clave ${clabe.slice(0, 3)}). Elígelo del catálogo.` };
      }
    }
    let parent_id = null;
    if (existente) parent_id = existente.parent_id;
    else if (nivel !== 'EMPRESA') {
      parent_id = parseInt(b.parent_id, 10);
      const p = porId.get(parent_id);
      if (!p) return { error: 'padre_no_existe', mensaje: 'Elige a qué empresa o unidad de negocio pertenece.' };
      if (nivel === 'UN' && p.nivel !== 'EMPRESA') return { error: 'padre_invalido', mensaje: 'Una unidad de negocio cuelga de una empresa.' };
      if (nivel === 'TARJETA' && p.nivel === 'TARJETA') return { error: 'padre_invalido', mensaje: 'Una tarjeta cuelga de una empresa o de una unidad de negocio.' };
    }
    let comision_pct = pct(b.comision_pct), iva_pct = pct(b.iva_pct);
    if (nivel === 'EMPRESA') { if (comision_pct === null) comision_pct = 0.5; if (iva_pct === null) iva_pct = 16; }
    for (const [k, v] of [['comisión', comision_pct], ['IVA', iva_pct]]) if (v !== null && (!Number.isFinite(v) || v < 0 || v > 25)) return { error: 'tasa_invalida', mensaje: `El porcentaje de ${k} debe estar entre 0 y 25.` };
    // Datos fiscales de la empresa (para facturarle la comisión): razón social y RFC (en `referencia`).
    let referencia = nivel === 'TARJETA' ? (existente ? existente.referencia : null) : txt(b.referencia, 60);   // la tarjeta ya no lleva número/alias: se identifica por correo
    if (nivel === 'EMPRESA' && referencia) { referencia = referencia.toUpperCase().replace(/\s/g, ''); if (!CONTA.rfcValido(referencia)) return { error: 'rfc_invalido', mensaje: 'El RFC no es válido (12 caracteres para persona moral, 13 para persona física).' }; }
    const nombre_comercial = nivel === 'EMPRESA' ? txt(b.nombre_comercial, 120) : null;   // solo la empresa lo lleva; opcional
    return { ok: { nivel, parent_id, nombre, nombre_comercial, clabe, beneficiario, banco_codigo: banco ? banco.codigo_spei : null, referencia, comision_pct, iva_pct, notas: txt(b.notas, 500), correo_usuario } };
  }

  const soloOperaciones = req => req.user.rol_cards === 'cards_operaciones';
  const noEmpresa = res => res.status(403).json({ error: 'rol_no_autorizado', mensaje: 'Tu usuario puede dar de alta unidades de negocio y tarjetas, no empresas.' });
  app.post('/api/cards/entidades', ...rol(...ESTRUCTURA_UN), async (req, res) => {
    const { porId } = await todas();
    let cuerpo = req.body || {};
    if (String(cuerpo.nivel || '').toUpperCase() === 'EMPRESA' && !ESTRUCTURA.includes(req.user.rol_cards)) return noEmpresa(res);
    // Operaciones solo agrega la unidad/tarjeta: la cuenta de fondeo y las tasas las hereda de la empresa.
    if (soloOperaciones(req)) cuerpo = { ...cuerpo, clabe: '', beneficiario: '', banco_codigo: null, comision_pct: null, iva_pct: null };
    const v = validarEntidad(cuerpo, porId, null, await catalogoBancos());
    if (v.error) return res.status(400).json(v);
    const d = v.ok;
    const empresa_id = d.nivel === 'EMPRESA' ? null : porId.get(d.parent_id).empresa_id;
    if (d.nivel !== 'EMPRESA' && !activaConPadres(porId.get(d.parent_id), porId)) return res.status(409).json({ error: 'padre_inactivo', mensaje: 'La empresa (o unidad de negocio) a la que la quieres agregar está desactivada.' });
    if (await correoTomado(d.correo_usuario, empresa_id)) return res.status(409).json({ error: 'correo_duplicado', mensaje: MSG_CORREO_DUP });
    let id;
    try {
      id = (await db.query(
        `insert into cards.entidades(nivel,parent_id,empresa_id,nombre,referencia,clabe,comision_pct,iva_pct,notas,creado_por,beneficiario,banco_codigo,nombre_comercial,correo_usuario) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [d.nivel, d.parent_id, empresa_id, d.nombre, d.referencia, d.clabe, d.comision_pct, d.iva_pct, d.notas, actor(req), d.beneficiario, d.banco_codigo, d.nombre_comercial, d.correo_usuario])).rows[0].id;
    } catch (e) { if (errUnica(e, res, 'clabe_duplicada', 'Esa CLABE ya está asignada a otra empresa, unidad de negocio o tarjeta.')) return; throw e; }
    if (d.nivel === 'EMPRESA') await db.query('update cards.entidades set empresa_id=id where id=$1', [id]);
    await bit(req, 'cards_entidad_alta', `${d.nivel} ${d.nombre}${d.correo_usuario ? ' · ' + d.correo_usuario : ''} · ${d.clabe ? 'CLABE ' + d.clabe + ' · ' + d.beneficiario : 'hereda la cuenta de ' + (porId.get(d.parent_id).nombre)}`, { resource_type: 'cards_entidad', resource_id: id });
    res.status(201).json({ ok: true, id });
  });

  app.put('/api/cards/entidades/:id', ...rol(...ESTRUCTURA_UN), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { porId } = await todas();
    const ex = porId.get(id);
    if (!ex) return res.status(404).json({ error: 'no_existe' });
    if (ex.nivel === 'EMPRESA' && !ESTRUCTURA.includes(req.user.rol_cards)) return noEmpresa(res);
    let b = req.body || {};
    // Operaciones no cambia cuenta ni tasas: se conserva lo que ya tiene la unidad o tarjeta.
    if (soloOperaciones(req)) b = { ...b, clabe: ex.clabe || '', beneficiario: ex.beneficiario || '', banco_codigo: ex.banco_codigo, comision_pct: ex.comision_pct, iva_pct: ex.iva_pct };
    const v = validarEntidad(b, porId, ex, await catalogoBancos());
    if (v.error) return res.status(400).json(v);
    const d = v.ok; const activo = b.activo === undefined ? ex.activo : !!b.activo;
    if (activo && await correoTomado(d.correo_usuario, ex.empresa_id, id)) return res.status(409).json({ error: 'correo_duplicado', mensaje: MSG_CORREO_DUP });
    try {
      await db.query(
        `update cards.entidades set nombre=$1, referencia=$2, clabe=$3, comision_pct=$4, iva_pct=$5, notas=$6, activo=$7, beneficiario=$8, banco_codigo=$9, nombre_comercial=$10, correo_usuario=$12, actualizado_at=now() where id=$11`,
        [d.nombre, d.referencia, d.clabe, d.comision_pct, d.iva_pct, d.notas, activo, d.beneficiario, d.banco_codigo, d.nombre_comercial, id, d.correo_usuario]);
    } catch (e) { if (errUnica(e, res, 'clabe_duplicada', 'Esa CLABE ya está asignada a otra empresa, unidad de negocio o tarjeta.')) return; throw e; }
    const cambios = [];
    if ((ex.nombre_comercial || '') !== (d.nombre_comercial || '')) cambios.push(`nombre comercial ${ex.nombre_comercial || '—'}→${d.nombre_comercial || '—'}`);
    if ((ex.correo_usuario || '') !== (d.correo_usuario || '')) cambios.push(`correo ${ex.correo_usuario || '—'}→${d.correo_usuario || '—'}`);
    if ((ex.clabe || null) !== (d.clabe || null)) cambios.push(`CLABE ${ex.clabe || 'hereda'}→${d.clabe || 'hereda'}`);
    if ((ex.beneficiario || '') !== (d.beneficiario || '')) cambios.push(`beneficiario ${ex.beneficiario || '—'}→${d.beneficiario || '—'}`);
    if (ex.banco_codigo !== d.banco_codigo) cambios.push(`banco ${ex.banco_nombre || '—'}→${d.banco_codigo}`);
    if (Number(ex.comision_pct) !== Number(d.comision_pct) || (ex.comision_pct == null) !== (d.comision_pct == null)) cambios.push(`comisión ${ex.comision_pct ?? 'hereda'}→${d.comision_pct ?? 'hereda'}`);
    if (ex.activo !== activo) cambios.push(activo ? 'reactivada' : 'desactivada');
    await bit(req, 'cards_entidad_edicion', `${ex.nivel} ${d.nombre}${cambios.length ? ' · ' + cambios.join(' · ') : ''}`, { resource_type: 'cards_entidad', resource_id: id });
    res.json({ ok: true });
  });

  app.delete('/api/cards/entidades/:id', ...rol(...ESTRUCTURA_UN), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { porId } = await todas();
    const ex = porId.get(id);
    if (!ex) return res.status(404).json({ error: 'no_existe' });
    if (ex.nivel === 'EMPRESA' && !ESTRUCTURA.includes(req.user.rol_cards)) return noEmpresa(res);
    if (ex.n_hijos > 0) return res.status(409).json({ error: 'tiene_hijos', mensaje: 'Tiene unidades de negocio o tarjetas debajo. Elimínalas primero o desactívala.' });
    const f = (await db.query('select count(*)::int n from cards.fondeos where entidad_id=$1', [id])).rows[0].n;
    if (f > 0) return res.status(409).json({ error: 'tiene_fondeos', mensaje: 'Ya tiene fondeos registrados; no se puede eliminar. Desactívala para que no reciba más.' });
    await db.query('delete from cards.entidades where id=$1', [id]);
    await bit(req, 'cards_entidad_baja', `${ex.nivel} ${ex.nombre}`, { resource_type: 'cards_entidad', resource_id: id });
    res.json({ ok: true });
  });

  /* ---------- importar empresas desde Excel/CSV (alta masiva con todos sus datos) ---------- */
  const IMPORT_COLS = [
    { k: 'nombre', t: 'Razón social', alias: ['razon social', 'razon social (con la que se factura)', 'nombre', 'empresa', 'nombre de la empresa'], ej: 'ACME DEMO SA DE CV' },
    { k: 'nombre_comercial', t: 'Nombre comercial', alias: ['nombre comercial', 'comercial'], ej: 'Acme' },
    { k: 'referencia', t: 'RFC', alias: ['rfc', 'rfc para facturar'], ej: 'ADE010101AB1' },
    { k: 'clabe', t: 'CLABE', alias: ['clabe', 'clabe de fondeo', 'cuenta clabe'], ej: '012180001111222231' },
    { k: 'beneficiario', t: 'Beneficiario', alias: ['beneficiario', 'titular', 'titular de la cuenta'], ej: 'Vacío = la razón social' },
    { k: 'comision_pct', t: 'Comisión %', alias: ['comision', 'comision %', '% comision', 'comision pct', 'comision porcentaje'], ej: 0.5 },
    { k: 'iva_pct', t: 'IVA %', alias: ['iva', 'iva %', '% iva', 'iva pct'], ej: 16 },
    { k: 'notas', t: 'Notas', alias: ['notas', 'observaciones'], ej: '' },
  ];
  const IMPORT_REQ = ['nombre', 'referencia', 'clabe'];
  const IMPORT_MAX = 500;
  const normCab = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[*:]/g, '').replace(/\s+/g, ' ').trim();
  function leerImportacion(buf, esCsv) {
    const XLSX = require('xlsx');
    let wb;
    if (esCsv) {
      // Un CSV puede venir en UTF-8 (con o sin BOM) o en Windows-1252 (Excel en español): se decodifica antes para no romper los acentos.
      let texto;
      try { texto = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_e) { texto = buf.toString('latin1'); }
      wb = XLSX.read(texto.replace(/^\uFEFF/, ''), { type: 'string', raw: true });
    } else wb = XLSX.read(buf, { type: 'buffer', raw: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return { error: 'archivo_vacio', mensaje: 'El archivo no tiene hojas con datos.' };
    const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    let hi = -1, mapa = null;
    for (let i = 0; i < Math.min(filas.length, 10) && hi < 0; i++) {
      const m = {};
      (filas[i] || []).forEach((c, j) => { const n = normCab(c); const col = IMPORT_COLS.find(x => x.alias.includes(n) && m[x.k] === undefined); if (col) m[col.k] = j; });
      if (IMPORT_REQ.every(k => m[k] !== undefined)) { hi = i; mapa = m; }
    }
    if (hi < 0) return { error: 'encabezados', mensaje: 'No encontré los encabezados. La primera fila debe traer al menos: Razón social, RFC y CLABE. Descarga la plantilla para usar los nombres correctos.' };
    const datos = [];
    for (let i = hi + 1; i < filas.length; i++) {
      const f = filas[i] || [];
      if (f.every(c => c == null || String(c).trim() === '')) continue;
      const o = { _fila: i + 1 };
      IMPORT_COLS.forEach(c => { o[c.k] = mapa[c.k] !== undefined ? f[mapa[c.k]] : null; });
      datos.push(o);
    }
    if (!datos.length) return { error: 'sin_filas', mensaje: 'El archivo no trae empresas debajo de los encabezados.' };
    if (datos.length > IMPORT_MAX) return { error: 'demasiadas', mensaje: `El archivo trae ${datos.length} filas; el máximo por importación es ${IMPORT_MAX}.` };
    return { datos };
  }
  const tipoImportacion = (buf, nombre) => {
    const ext = (String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
    if (ext === 'xlsx' && buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'xlsx';
    if (ext === 'csv' && !buf.slice(0, 2000).includes(0)) return 'csv';
    return null;
  };

  app.get('/api/cards/entidades/plantilla.xlsx', ...rol(...ESTRUCTURA), async (_req, res) => {
    const XLSX = require('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([IMPORT_COLS.map(c => c.t), IMPORT_COLS.map(c => c.ej)]);
    ws['!cols'] = IMPORT_COLS.map(c => ({ wch: Math.max(16, c.t.length + 4) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Empresas');
    const ayuda = XLSX.utils.aoa_to_sheet([
      ['Cómo llenarla'],
      ['Una fila por empresa. Razón social, RFC y CLABE son obligatorios.'],
      ['La CLABE debe ir como TEXTO (18 dígitos): si Excel la convierte en número la recorta. Formatea la columna como Texto antes de pegarla.'],
      ['El banco se identifica solo con la CLABE. Beneficiario vacío = la razón social.'],
      ['Comisión % e IVA % van en porcentaje (0.5 = 0.5 %; 16 = 16 %). Vacíos = 0.5 y 16.'],
      ['Las unidades de negocio y las tarjetas no se importan: las da de alta Operaciones, heredando estos datos.'],
    ]);
    ayuda['!cols'] = [{ wch: 120 }];
    XLSX.utils.book_append_sheet(wb, ayuda, 'Instrucciones');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-empresas-cards.xlsx"');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  });

  // ?simular=1 solo revisa y dice qué haría; sin eso, crea las empresas válidas y omite (y reporta) las que traen error.
  app.post('/api/cards/entidades/importar', ...rol(...ESTRUCTURA), limitaSubidas, uploadCep.single('archivo'), async (req, res) => {
    if (!req.file || !req.file.size) return res.status(400).json({ error: 'archivo_requerido', mensaje: 'Elige el archivo de Excel (.xlsx) o CSV con las empresas.' });
    const nombre = String(req.file.originalname || 'empresas').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120);
    const tipoArch = tipoImportacion(req.file.buffer, nombre);
    if (!tipoArch) return res.status(400).json({ error: 'tipo_no_permitido', mensaje: 'El archivo debe ser Excel (.xlsx) o CSV.' });
    let lec;
    try { lec = leerImportacion(req.file.buffer, tipoArch === 'csv'); } catch (_e) { return res.status(400).json({ error: 'archivo_ilegible', mensaje: 'No se pudo leer el archivo. Usa la plantilla en .xlsx o un CSV.' }); }
    if (lec.error) return res.status(400).json(lec);
    const simular = String((req.query || {}).simular || '') === '1';
    const { porId } = await todas();
    const bancos = await catalogoBancos();
    const clabesDb = new Map([...porId.values()].filter(x => x.clabe).map(x => [x.clabe, x.nombre]));
    const rfcsDb = new Map([...porId.values()].filter(x => x.nivel === 'EMPRESA' && x.referencia).map(x => [String(x.referencia).toUpperCase(), x.nombre]));
    const clabesArch = new Set(), rfcsArch = new Set();
    const salida = [];
    for (const d of lec.datos) {
      const fila = { fila: d._fila, nombre: txt(d.nombre, 120), rfc: d.referencia == null ? null : String(d.referencia).toUpperCase().replace(/\s/g, ''), clabe: d.clabe == null ? null : (typeof d.clabe === 'number' ? String(d.clabe) : String(d.clabe).replace(/\s/g, '')), estado: 'nueva', error: null };
      const falla = m => { fila.estado = 'error'; fila.error = m; };
      if (typeof d.clabe === 'number') falla('La CLABE viene como número y Excel la recortó. Formatea la columna como Texto y vuelve a pegarla.');
      else {
        const cuerpo = { nivel: 'EMPRESA', nombre: d.nombre, nombre_comercial: d.nombre_comercial, referencia: d.referencia, clabe: d.clabe, beneficiario: txt(d.beneficiario, 120) || txt(d.nombre, 120),
          comision_pct: d.comision_pct, iva_pct: d.iva_pct, notas: d.notas };
        if (!fila.rfc) falla('Falta el RFC.');
        else {
          const v = validarEntidad(cuerpo, porId, null, bancos);
          if (v.error) falla(v.mensaje);
          else {
            fila.datos = v.ok;
            if (clabesDb.has(v.ok.clabe)) falla(`La CLABE ya está registrada en ${clabesDb.get(v.ok.clabe)}.`);
            else if (clabesArch.has(v.ok.clabe)) falla('La CLABE está repetida en el archivo.');
            else if (rfcsDb.has(v.ok.referencia)) falla(`Ya existe una empresa con ese RFC (${rfcsDb.get(v.ok.referencia)}).`);
            else if (rfcsArch.has(v.ok.referencia)) falla('El RFC está repetido en el archivo.');
            else { clabesArch.add(v.ok.clabe); rfcsArch.add(v.ok.referencia); }
          }
        }
      }
      salida.push(fila);
    }
    let creadas = 0;
    if (!simular) {
      for (const f of salida.filter(x => x.estado === 'nueva')) {
        const d = f.datos;
        try {
          const id = (await db.query(
            `insert into cards.entidades(nivel,parent_id,empresa_id,nombre,referencia,clabe,comision_pct,iva_pct,notas,creado_por,beneficiario,banco_codigo,nombre_comercial) values('EMPRESA',null,null,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
            [d.nombre, d.referencia, d.clabe, d.comision_pct, d.iva_pct, d.notas, actor(req), d.beneficiario, d.banco_codigo, d.nombre_comercial])).rows[0].id;
          await db.query('update cards.entidades set empresa_id=id where id=$1', [id]);
          f.estado = 'creada'; creadas++;
        } catch (e) { f.estado = 'error'; f.error = e && e.code === '23505' ? 'La CLABE o el RFC ya están registrados.' : 'No se pudo guardar.'; }
      }
      await bit(req, 'cards_empresas_importar', `${nombre} · ${creadas} creadas de ${salida.length}`, { resource_type: 'cards_entidad' });
    }
    salida.forEach(f => delete f.datos);
    res.json({ ok: true, simulado: simular, archivo: nombre, total: salida.length, nuevas: salida.filter(x => x.estado === 'nueva').length, creadas, con_error: salida.filter(x => x.estado === 'error').length, filas: salida });
  });

  /* ====================== CÁLCULO (cotización / desglose) ====================== */
  app.post('/api/cards/calcular', ...rol(...VER), async (req, res) => {
    const b = req.body || {};
    const { porId } = await todas();
    const e = porId.get(parseInt(b.entidad_id, 10));
    if (!e) return res.status(404).json({ error: 'entidad_no_existe' });
    const t = F.tasasEfectivas(e.id, porId);
    const base = { entidad: { id: e.id, nivel: e.nivel, nombre: e.nombre, ruta: ruta(e, porId), clabe: e.clabe_ef, beneficiario: e.beneficiario_ef || null, banco: e.banco_nombre_ef || null, usable: activaConPadres(e, porId) }, comision_pct: t.comision_pct, iva_pct: t.iva_pct };
    if (t.comision_pct == null || t.iva_pct == null) return res.status(409).json({ error: 'sin_tasas', mensaje: 'La empresa no tiene comisión/IVA definidos.', ...base });
    const rec = dinero(b.monto_recibido), fon = dinero(b.fondeo);
    if (Number.isFinite(rec) && rec > 0) return res.json({ ...base, desglose: F.desglosarRecibido(rec, t.comision_pct, t.iva_pct) });
    if (Number.isFinite(fon) && fon > 0) return res.json({ ...base, cotizacion: F.desglosarFondeo(fon, t.comision_pct, t.iva_pct) });
    res.json(base);
  });

  /* ====================== FONDEOS: lectura ====================== */
  const FECHA = 'coalesce(f.fecha, f.creado_at::date)';
  function filtros(q, al, req) {
    const conds = [], vals = [];
    const add = (sql, v) => { vals.push(v); conds.push(sql.replace('$#', '$' + vals.length)); };
    if (al !== null) add('f.solicitante_id=$#', al.sol);
    if (q.empresa_id) add('f.empresa_id=$#', parseInt(q.empresa_id, 10) || 0);
    if (q.entidad_id) add('f.entidad_id=$#', parseInt(q.entidad_id, 10) || 0);
    if (q.estatus && FL.ESTATUS.includes(String(q.estatus))) add('f.estatus=$#', String(q.estatus));
    if (q.origen === 'SOLICITUD' || q.origen === 'MANUAL') add('f.origen=$#', q.origen);
    if (q.mias === '1' && req) add('f.solicitante_id=$#', uid(req) || 0);
    if (fechaReal(q.desde)) add(FECHA + '>=$#', q.desde);
    if (fechaReal(q.hasta)) add(FECHA + '<=$#', q.hasta);
    if (q.cep === 'no') conds.push('not exists (select 1 from cards.fondeo_ceps c where c.fondeo_id=f.id)');
    if (q.cep === 'si') conds.push('exists (select 1 from cards.fondeo_ceps c where c.fondeo_id=f.id)');
    if (q.q) { const s = '%' + String(q.q).trim().slice(0, 60) + '%'; vals.push(s); const n = vals.length; conds.push(`(f.folio ilike $${n} or f.clave_rastreo ilike $${n} or f.banco_ordenante ilike $${n} or f.solicitante_nombre ilike $${n} or e.nombre ilike $${n} or emp.nombre ilike $${n} or emp.nombre_comercial ilike $${n})`); }
    return { where: conds.length ? ' where ' + conds.join(' and ') : '', vals };
  }
  const SELECT_FONDEOS = `select f.*, f.fecha::text as fecha_iso, e.nombre as entidad_nombre, e.nivel as entidad_nivel, emp.nombre as empresa_nombre, emp.referencia as empresa_rfc,
         (select count(*)::int from cards.fondeo_ceps c where c.fondeo_id=f.id) as n_ceps,
         (f.fondeo_solicitado is not null and f.monto_recibido is not null and abs(f.fondeo - f.fondeo_solicitado) > ${TOL}) as difiere
    from cards.fondeos f join cards.entidades e on e.id=f.entidad_id join cards.entidades emp on emp.id=f.empresa_id`;
  const num = r => ({ ...r, fecha: r.fecha_iso || null, monto_recibido: numN(r.monto_recibido), monto_esperado: numN(r.monto_esperado), fondeo: Number(r.fondeo), comision: Number(r.comision), iva: Number(r.iva), redondeo: Number(r.redondeo), comision_pct: Number(r.comision_pct), iva_pct: Number(r.iva_pct), fondeo_solicitado: numN(r.fondeo_solicitado) });

  async function listar(q, limite, al, req) {
    const { where, vals } = filtros(q, al, req);
    const rows = (await db.query(SELECT_FONDEOS + where + ` order by ${FECHA} desc, f.id desc limit ` + (limite || 2000), vals)).rows.map(num);
    const { porId } = await todas();
    rows.forEach(r => { r.ruta = ruta(porId.get(r.entidad_id), porId); });
    const asig = rows.filter(r => r.estatus === 'ASIGNADO'), proc = rows.filter(r => r.estatus === 'SOLICITADO' || r.estatus === 'POR_ASIGNAR');
    const suma = (lst, k) => F.round2(lst.reduce((s, r) => s + (r[k] || 0), 0));
    return { rows, totales: { n: asig.length, monto_recibido: suma(asig, 'monto_recibido'), fondeo: suma(asig, 'fondeo'), comision: suma(asig, 'comision'), iva: suma(asig, 'iva'),
      en_proceso: proc.length, en_proceso_monto: F.round2(proc.reduce((s, r) => s + (r.monto_recibido != null ? r.monto_recibido : (r.monto_esperado || 0)), 0)) } };
  }

  app.get('/api/cards/fondeos', ...rol(...VER), async (req, res) => {
    res.json(await listar(req.query || {}, 2000, alcance(req), req));
  });

  app.get('/api/cards/fondeos.xlsx', ...rol(...VER), async (req, res) => {
    const { rows, totales } = await listar(req.query || {}, 2000, alcance(req), req);
    const ESTATUS = { SOLICITADO: 'Esperando CEP', POR_ASIGNAR: 'Por asignar', ASIGNADO: 'Asignado', RECHAZADO: 'Rechazado', CANCELADO: 'Cancelado' };
    const aoa = [['Folio', 'Fecha', 'Empresa', 'Destino', 'CLABE destino', 'Total a depositar', 'Recibido', 'Fondeo', 'Comisión', 'IVA', '% comisión', '% IVA', 'Clave de rastreo', 'Banco ordenante', 'CEP', 'Estatus', 'Solicitó', 'Asignó']];
    rows.forEach(r => aoa.push([r.folio, r.fecha_iso || '', r.empresa_nombre, r.ruta, String(r.clabe_destino), r.monto_esperado == null ? '' : r.monto_esperado, r.monto_recibido == null ? '' : r.monto_recibido, r.fondeo, r.comision, r.iva, r.comision_pct, r.iva_pct, r.clave_rastreo || '', r.banco_ordenante || '', r.n_ceps, ESTATUS[r.estatus], r.solicitante_nombre || r.creado_por || '', r.validado_por || '']));
    aoa.push([]); aoa.push(['TOTAL ASIGNADO', '', '', '', '', '', totales.monto_recibido, totales.fondeo, totales.comision, totales.iva]);
    const buf = X.buildXLSX([{ name: 'Fondeos', aoa, cols: [14, 11, 24, 40, 20, 16, 15, 15, 13, 12, 10, 8, 22, 20, 6, 14, 18, 18].map(w => ({ wch: w })), freeze: { xSplit: 0, ySplit: 1, topLeftCell: 'A2' } }]);
    await bit(req, 'cards_fondeos_exportar', `exportó ${rows.length} fondeos`);
    enviarXLSX(res, `fondeos_cards_${hoyMX()}.xlsx`, buf);
  });

  // ¿Este archivo (mismo contenido) ya está en el sistema, como CEP o como comprobante, en este u otro fondeo? Se compara por huella SHA-256.
  async function archivoRepetido(sha, fondeoId) {
    const r = (await db.query(
      `select 'CEP' as que, f.id as fondeo_id, f.folio from cards.fondeo_ceps c join cards.fondeos f on f.id=c.fondeo_id where c.sha256_hash=$1
       union all
       select 'comprobante' as que, f.id, f.folio from cards.fondeo_comprobantes c join cards.fondeos f on f.id=c.fondeo_id where c.sha256_hash=$1 limit 1`, [sha])).rows[0];
    return r ? { ...r, mismo: r.fondeo_id === fondeoId } : null;
  }
  const evento = (fondeo_id, actorNombre, tipo, detalle) => db.query('insert into cards.fondeo_eventos(fondeo_id, actor, tipo, detalle) values($1,$2,$3,$4)', [fondeo_id, actorNombre, tipo, detalle || null]);
  async function cargar(id) {
    const f = (await db.query(SELECT_FONDEOS + ' where f.id=$1', [id])).rows.map(num)[0];
    if (!f) return null;
    const { porId } = await todas();
    f.ruta = ruta(porId.get(f.entidad_id), porId);
    f.comprobantes = (await db.query('select id, filename, mime, bytes_size, subido_por, subido_at, validado, monto_leido, monto_esperado, origen_monto, datos from cards.fondeo_comprobantes where fondeo_id=$1 order by id', [id])).rows
      .map(c => ({ ...c, monto_leido: numN(c.monto_leido), monto_esperado: numN(c.monto_esperado), coincide_actual: c.validado && c.monto_leido != null ? Math.round(Math.abs(Number(c.monto_leido) - Number(f.fondeo)) * 100) <= 1 : null }));
    f.ceps = (await db.query('select id, filename, mime, bytes_size, subido_por, subido_at, datos, formato, confianza, es_cep, validado from cards.fondeo_ceps where fondeo_id=$1 order by id', [id])).rows;
    const bancos = await catalogoBancos();
    f.ceps.forEach(c => { if (c.datos) c.verificacion = CEPX.verificar(c.datos, { monto_recibido: f.monto_recibido, clave_rastreo: f.clave_rastreo, clabe_destino: f.clabe_destino, fecha: f.fecha, beneficiario_destino: f.beneficiario_destino, banco_destino: f.banco_destino, banco_codigo_destino: f.banco_codigo_destino, bancos }); });
    return { f, porId };
  }
  // Todo lo que tesorería debe mirar antes de asignar. `nota` = exige explicar el motivo al asignar.
  function alertasDe(f) {
    const a = [];
    if (f.difiere) a.push({ codigo: 'difiere', nota: true, texto: `El fondeo resultante (${F.round2(f.fondeo)}) es distinto del solicitado (${F.round2(f.fondeo_solicitado)}).` });
    if (Math.abs(f.redondeo) > 0.02) a.push({ codigo: 'redondeo', nota: true, texto: `Diferencia de redondeo de ${f.redondeo}.` });
    const vistos = new Set();
    (f.comprobantes || []).filter(c => c.validado && c.coincide_actual === false).forEach(c => a.push({ codigo: 'comprobante_difiere', nota: true, texto: `El comprobante ${c.filename} se validó con ${F.round2(c.monto_leido)}, pero el fondeo calculado ahora es ${F.round2(f.fondeo)}.` }));
    if (f.ceps.length && !f.beneficiario_destino) a.push({ codigo: 'sin_beneficiario', nota: false, texto: 'La cuenta de fondeo no tiene beneficiario definido: no se pudo comparar con el CEP. Complétalo en Empresas, UN y tarjetas.' });
    if (f.ceps.length && !f.banco_codigo_destino) a.push({ codigo: 'sin_banco', nota: false, texto: 'La cuenta de fondeo no tiene banco definido: no se pudo comparar con el CEP.' });
    f.ceps.forEach(c => {
      if (c.verificacion) c.verificacion.checks.filter(k => k.duro && k.estado === 'difiere').forEach(k => { if (!vistos.has(k.campo)) { vistos.add(k.campo); a.push({ codigo: 'cep_' + k.campo, nota: true, texto: `${k.etiqueta}: el CEP dice ${k.cep} y lo registrado es ${k.capturado}.`.replace(/\.\.$/, '.') }); } });
      const ord = c.datos && c.datos.ordenante && c.datos.ordenante.rfc, rfcE = f.empresa_rfc ? String(f.empresa_rfc).toUpperCase().replace(/\s/g, '') : null;
      if (rfcE && ord && String(ord).toUpperCase() !== rfcE && !vistos.has('rfc')) { vistos.add('rfc'); a.push({ codigo: 'rfc', nota: true, texto: `El ordenante del CEP (RFC ${ord}) no es el de la empresa (${rfcE}): posible depósito de un tercero.` }); }
      if (c.formato === 'dispersion_polipay' && !vistos.has('polipay')) { vistos.add('polipay'); a.push({ codigo: 'polipay', nota: false, texto: 'La evidencia es un comprobante de dispersión de Polipay, no un CEP de Banxico.' }); }
    });
    return a;
  }

  app.get('/api/cards/fondeos/:id', ...rol(...VER), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const x = Number.isFinite(id) ? await cargar(id) : null;
    if (!x || !propio(req, x.f)) return res.status(404).json({ error: 'no_existe' });
    const { f } = x;
    f.alertas = alertasDe(f);
    f.requiere_nota = f.alertas.some(a => a.nota);
    f.cep_conflicto = f.ceps.some(c => c.verificacion && c.verificacion.conflicto);
    f.puede = FL.permisos(f.estatus, req.user.rol_cards, true);
    f.candado = FL.candadoAsignacion(f);
    f.puede.asignar = f.puede.asignar && f.candado.abierto;
    f.puede.asignar_sin_cep = f.puede.asignar_sin_cep && !f.ceps.some(c => c.validado);   // con un CEP validado se asigna normal
    if (f.origen !== 'MANUAL') f.puede.editar = false;
    const eventos = (await db.query('select id, ts, actor, tipo, detalle from cards.fondeo_eventos where fondeo_id=$1 order by ts, id', [id])).rows;
    res.json({ ...f, eventos });
  });

  /* ====================== AVISOS POR CORREO ====================== */
  // Logo de MCEB/Polipay incrustado (cid) como en los demás correos del sistema.
  const logoCorreo = () => { try { return [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: fs.readFileSync(path.join(__dirname, '..', 'public', 'logo.png')) }]; } catch (_e) { return []; } };
  // Nunca bloquea ni rompe la operación: deja constancia en el historial del fondeo.
  // CEP del fondeo para el correo: el archivo (descifrado, si cabe) y el resultado de su validación.
  const ADJUNTOS_MAX = 6 * 1024 * 1024;
  async function cepsParaCorreo(f) {
    const salida = { ceps: [], attachments: [] };
    if (!f.ceps || !f.ceps.length) return salida;
    const filas = (await db.query('select id, filename, mime, bytes_cifrado, bytes_size, sha256_hash from cards.fondeo_ceps where fondeo_id=$1', [f.id])).rows;
    let usado = 0;
    for (const c of f.ceps) {
      const item = { filename: c.filename, por: c.subido_por, formato: c.formato, confianza: c.confianza, validado: !!c.validado, checks: c.verificacion ? c.verificacion.checks : [], adjunto: false };
      const r = filas.find(x => x.id === c.id);
      try {
        if (r && usado + Number(r.bytes_size || 0) <= ADJUNTOS_MAX) {
          const buf = C.decrypt((Buffer.isBuffer(r.bytes_cifrado) ? r.bytes_cifrado : Buffer.from(r.bytes_cifrado)).toString('utf8'));
          if (crypto.createHash('sha256').update(buf).digest('hex') === r.sha256_hash) {
            salida.attachments.push({ filename: String(r.filename).replace(/["\r\n\\/]/g, '_'), contentType: r.mime || 'application/octet-stream', content: buf });
            usado += buf.length; item.adjunto = true;
          }
        }
      } catch (_e) { /* se avisa que no se adjuntó */ }
      salida.ceps.push(item);
    }
    return salida;
  }
  async function notificar(tipo, id, extra) {
    try {
      const x = await cargar(id); if (!x) return;
      const f = x.f;
      const d = await destinatariosDe(tipo, f, extra);
      if (d.apagado) return evento(id, 'sistema', 'notificado', `${tipo}: este correo está desactivado en Destinatarios`);
      const total = d.to.length + d.cc.length + d.bcc.length;
      if (!d.to.length) return evento(id, 'sistema', 'notificado', `${tipo}: sin destinatarios “Para” configurados`);
      if (!sesEnabled || !sesEnabled()) return evento(id, 'sistema', 'notificado', `${tipo}: no se envió (correo no configurado en este servidor)`);
      // Quién subió el CEP (el solicitante) y, más abajo, el comprobante (tesorería): el correo lo nombra.
      f.cep_subido_por = f.ceps.length ? f.ceps[f.ceps.length - 1].subido_por : null;
      if (tipo === 'solicitado') { const u = f.solicitante_id ? (await db.query('select email from usuarios where id=$1', [f.solicitante_id])).rows[0] : null; f.solicitante_email = u && u.email; }
      const cp = await cepsParaCorreo(f);
      let comprobantes = [];
      if (tipo === 'asignado') {
        const rows = (await db.query('select id, filename, mime, bytes_cifrado, bytes_size, sha256_hash, subido_por, validado, monto_leido, origen_monto from cards.fondeo_comprobantes where fondeo_id=$1 order by id', [f.id])).rows;
        let usado = cp.attachments.reduce((n, a) => n + a.content.length, 0);
        for (const r of rows) {
          const item = { filename: r.filename, adjunto: false, por: r.subido_por, validado: !!r.validado, monto: numN(r.monto_leido), origen: r.origen_monto };
          try {
            if (usado + Number(r.bytes_size || 0) <= ADJUNTOS_MAX) {
              const buf = C.decrypt((Buffer.isBuffer(r.bytes_cifrado) ? r.bytes_cifrado : Buffer.from(r.bytes_cifrado)).toString('utf8'));
              if (crypto.createHash('sha256').update(buf).digest('hex') === r.sha256_hash) { cp.attachments.push({ filename: String(r.filename).replace(/["\r\n\\/]/g, '_'), contentType: r.mime || 'application/octet-stream', content: buf }); usado += buf.length; item.adjunto = true; }
            }
          } catch (_e) { /* se avisa que no se adjuntó */ }
          comprobantes.push(item);
        }
      }
      const c = CORREO.armarCorreoFondeo({ tipo, ceps: cp.ceps, comprobantes, fondeo: f, avisos: (extra && extra.avisos) || (tipo === 'por_asignar' ? alertasDe(f).map(a => a.texto) : []), motivo: extra && extra.motivo, nota: extra && extra.nota, appUrl: appUrl() });
      // Hilo: si ya salió un correo de este fondeo, éste va como respuesta suyo (mismo asunto con "Re:" + In-Reply-To/References).
      // SES entrega cada mensaje con Message-ID <MessageId@email.amazonses.com> (o <MessageId@región.amazonses.com> fuera de us-east-1).
      const region = process.env.AWS_REGION || 'us-east-1', dominio = region === 'us-east-1' ? 'email.amazonses.com' : `${region}.amazonses.com`;
      const raiz = f.correo_msgid ? `<${f.correo_msgid}@${dominio}>` : null;
      const asunto = raiz ? 'Re: ' + (f.correo_asunto || c.subject) : c.subject;
      const msgId = await Promise.race([sendSES({ to: d.to, cc: d.cc, bcc: d.bcc, subject: asunto, html: c.html, textFallback: c.text, inlineImages: logoCorreo(), attachments: cp.attachments, headers: raiz ? { 'In-Reply-To': raiz, References: raiz } : undefined, fromName: REMITENTE }), new Promise((_r, rej) => setTimeout(() => rej(new Error('tiempo de espera agotado')), 10000))]);
      if (!f.correo_msgid && msgId) await db.query('update cards.fondeos set correo_msgid=$1, correo_asunto=$2 where id=$3 and correo_msgid is null', [String(msgId), c.subject, id]);
      await evento(id, 'sistema', 'notificado', `${tipo} → ${total} destinatario(s)${raiz ? ' · en el mismo hilo' : ''}`);
    } catch (e) { try { await evento(id, 'sistema', 'notificado', `${tipo}: falló el envío (${String(e.message).slice(0, 120)})`); } catch (_e) { /* nada */ } }
  }

  /* ---------- destinatarios de cada correo ---------- */
  const emailOk = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  const descifra = (c, otro) => { try { return c ? C.decryptString(c) : otro; } catch (_e) { return otro; } };
  const dir = d => d.nombre ? `${d.nombre.replace(/[<>",]/g, '')} <${d.email}>` : d.email;
  const eventoValido = e => EVENTOS.some(x => x.id === e);
  async function configAviso(evento) {
    return (await db.query('select evento, activo, a_solicitante, a_tesoreria, con_corte_pos from cards.avisos where evento=$1', [evento])).rows[0] || { evento, activo: true, a_solicitante: false, a_tesoreria: false, con_corte_pos: true };
  }
  async function fijosDe(evento) {
    return (await db.query('select id, email_cifrado, nombre_cifrado, tipo, activo, creado_por, creado_at from cards.destinatarios where evento=$1 order by activo desc, id', [evento])).rows
      .map(r => ({ id: r.id, email: descifra(r.email_cifrado, ''), nombre: descifra(r.nombre_cifrado, '') || '', tipo: r.tipo, activo: r.activo, creado_por: r.creado_por, creado_at: r.creado_at }));
  }
  // A quién va cada correo: los automáticos (quien solicitó, usuarios Tesorería Cards) y los fijos de la lista; todo "Para" salvo los fijos CC/CCO.
  async function destinatariosDe(evento, f, extra) {
    const cfg = await configAviso(evento);
    if (!cfg.activo) return { apagado: true, to: [], cc: [], bcc: [] };
    const to = [], cc = [], bcc = [], vistos = new Set();
    const poner = (lista, correo) => { const k = String(correo || '').toLowerCase(); if (k && !vistos.has(k)) { vistos.add(k); lista.push(correo); } };
    const excluir = extra && extra.excluirUsuario ? Number(extra.excluirUsuario) : null;
    if (cfg.a_solicitante && f.solicitante_id && f.solicitante_id !== excluir)
      (await db.query('select email from usuarios where id=$1 and activo', [f.solicitante_id])).rows.forEach(r => poner(to, r.email));
    if (cfg.a_tesoreria)
      (await db.query("select id, email from usuarios where activo and (rol = 'cards_tesoreria' or rol_cards = 'cards_tesoreria')")).rows.filter(r => r.id !== excluir).forEach(r => poner(to, r.email));
    for (const r of (await fijosDe(evento)).filter(x => x.activo && x.email)) poner(r.tipo === 'cc' ? cc : r.tipo === 'bcc' ? bcc : to, dir(r));
    // El aviso de "por asignar" nunca se queda sin nadie: si no hay Tesorería Cards ni fijos, va a los administradores.
    if (evento === 'por_asignar' && !to.length)
      (await db.query("select email from usuarios where activo and (rol in ('admin','cards_admin') or rol_cards = 'cards_admin')")).rows.forEach(r => poner(to, r.email));
    return { to, cc, bcc };
  }
  app.get('/api/cards/destinatarios', ...rol(...ESTRUCTURA), async (_req, res) => {
    const eventos = [];
    for (const e of EVENTOS) eventos.push({ ...e, ...(await configAviso(e.id)), destinatarios: await fijosDe(e.id) });
    res.json({ eventos });
  });
  app.put('/api/cards/avisos/:evento', ...rol(...ESTRUCTURA), async (req, res) => {
    const evento = req.params.evento;
    if (!eventoValido(evento)) return res.status(404).json({ error: 'no_existe' });
    const b = req.body || {}, cfg = await configAviso(evento);
    const v = { activo: b.activo === undefined ? cfg.activo : !!b.activo, a_solicitante: b.a_solicitante === undefined ? cfg.a_solicitante : !!b.a_solicitante, a_tesoreria: b.a_tesoreria === undefined ? cfg.a_tesoreria : !!b.a_tesoreria, con_corte_pos: b.con_corte_pos === undefined ? cfg.con_corte_pos !== false : !!b.con_corte_pos };
    await db.query('insert into cards.avisos(evento, activo, a_solicitante, a_tesoreria, con_corte_pos) values($1,$2,$3,$4,$5) on conflict (evento) do update set activo=excluded.activo, a_solicitante=excluded.a_solicitante, a_tesoreria=excluded.a_tesoreria, con_corte_pos=excluded.con_corte_pos', [evento, v.activo, v.a_solicitante, v.a_tesoreria, v.con_corte_pos]);
    await bit(req, 'cards_aviso_config', `${evento} · activo=${v.activo} solicitante=${v.a_solicitante} tesorería=${v.a_tesoreria}`, { resource_type: 'cards_aviso', resource_id: null });
    res.json({ ok: true });
  });
  app.post('/api/cards/destinatarios', ...rol(...ESTRUCTURA), async (req, res) => {
    const b = req.body || {};
    const ev = String(b.evento || 'solicitado');
    if (!eventoValido(ev)) return res.status(400).json({ error: 'evento_invalido', mensaje: 'Elige a qué correo se agrega.' });
    const email = String(b.email || '').trim().toLowerCase();
    if (!email || email.length > 160 || !emailOk(email)) return res.status(400).json({ error: 'email_invalido', mensaje: 'Escribe un correo válido.' });
    const tipo = ['to', 'cc', 'bcc'].includes(String(b.tipo || 'to').toLowerCase()) ? String(b.tipo || 'to').toLowerCase() : 'to';
    const nombre = txt(b.nombre, 80) || '';
    const hash = C.hmacEmail(email), eCif = C.encrypt(email), nCif = C.encrypt(nombre), activo = b.activo !== false;
    try {
      if (b.id) {
        const r = await db.query('update cards.destinatarios set email_cifrado=$1, email_hash=$2, nombre_cifrado=$3, tipo=$4, activo=$5 where id=$6 and evento=$7', [eCif, hash, nCif, tipo, activo, parseInt(b.id, 10) || 0, ev]);
        if (!r.rowCount && r.rowCount !== undefined) return res.status(404).json({ error: 'no_existe' });
      } else await db.query('insert into cards.destinatarios(email_cifrado, email_hash, nombre_cifrado, tipo, activo, creado_por, evento) values($1,$2,$3,$4,$5,$6,$7)', [eCif, hash, nCif, tipo, activo, actor(req), ev]);
    } catch (e) { if (errUnica(e, res, 'destinatario_duplicado', 'Ese correo ya está en este aviso.')) return; throw e; }
    await bit(req, b.id ? 'cards_destinatario_edicion' : 'cards_destinatario_alta', `${ev} · ${email} (${tipo})${activo ? '' : ' · inactivo'}`, { resource_type: 'cards_destinatario', resource_id: b.id || null });
    res.status(b.id ? 200 : 201).json({ ok: true });
  });
  // Alta masiva: el texto pegado (correos separados por coma, punto y coma, espacios o renglones) se agrega a uno o varios avisos.
  // Con `simular` no guarda nada: solo cuenta cuántos son nuevos, cuántos ya estaban y cuáles no son válidos.
  app.post('/api/cards/destinatarios/masivo', ...rol(...ESTRUCTURA), async (req, res) => {
    const b = req.body || {};
    const eventos = [...new Set((Array.isArray(b.eventos) ? b.eventos : [b.evento]).map(e => String(e || '')))].filter(Boolean);
    if (!eventos.length || !eventos.every(eventoValido)) return res.status(400).json({ error: 'evento_invalido', mensaje: 'Elige a qué correos se agregan.' });
    const tipo = ['to', 'cc', 'bcc'].includes(String(b.tipo || 'to').toLowerCase()) ? String(b.tipo || 'to').toLowerCase() : 'to';
    const lectura = DEST.separarCorreos(b.texto);
    if (lectura.excede) return res.status(400).json({ error: 'demasiados_correos', mensaje: `Pegaste ${lectura.validos.length} correos: agrega máximo ${DEST.MAX_CORREOS} a la vez.` });
    const resultado = [];
    for (const ev of eventos) {
      const ya = new Set((await db.query('select email_hash from cards.destinatarios where evento=$1', [ev])).rows.map(r => r.email_hash));
      const nuevos = [], repetidos = [];
      lectura.validos.forEach(d => (ya.has(C.hmacEmail(d.email)) ? repetidos : nuevos).push(d));
      if (!b.simular) for (const d of nuevos) {
        try { await db.query('insert into cards.destinatarios(email_cifrado, email_hash, nombre_cifrado, tipo, activo, creado_por, evento) values($1,$2,$3,$4,true,$5,$6)', [C.encrypt(d.email), C.hmacEmail(d.email), C.encrypt(d.nombre), tipo, actor(req), ev]); }
        catch (e) { if (e && e.code === '23505') repetidos.push(d); else throw e; }
      }
      resultado.push({ evento: ev, nuevos: nuevos.length, repetidos: repetidos.length });
    }
    if (!b.simular) await bit(req, 'cards_destinatario_alta_masiva', `${resultado.map(r => `${r.evento}: +${r.nuevos}`).join(' · ')} (${tipo}) · ${lectura.validos.length} correos pegados`, { resource_type: 'cards_destinatario', resource_id: null });
    res.status(b.simular ? 200 : 201).json({ ok: true, simulado: !!b.simular, detectados: lectura.validos.length, repetidos_en_texto: lectura.repetidosEnTexto, invalidos: lectura.invalidos.slice(0, 20), n_invalidos: lectura.invalidos.length, eventos: resultado });
  });
  app.delete('/api/cards/destinatarios/:id', ...rol(...ESTRUCTURA), async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    await db.query('delete from cards.destinatarios where id=$1', [id]);
    await bit(req, 'cards_destinatario_baja', String(id), { resource_type: 'cards_destinatario', resource_id: id });
    res.json({ ok: true });
  });

  /* ====================== CONTABILIDAD: corte de comisiones (acumulado, como el de MCEB) ====================== */
  const COLS_CORTE = "id, fecha_corte::text as fecha_corte, depositos_hasta::text as depositos_hasta, origen, pos_corte_id, estado, resumen, detalle, totales, generado_por, generado_at, enviado_at, enviado_por, enviado_a, message_id";
  const cargarCorte = async id => (await db.query(`select ${COLS_CORTE} from cards.cortes_comision where id=$1`, [id])).rows[0] || null;
  const nombreCorte = c => `${CONTA.tituloCorte(c)} · ${CONTA.textoDepositos(c.totales)}`;

  app.get('/api/cards/contabilidad', ...rol(...CONTA_VER), async (_req, res) => {
    const hoy = hoyMX();
    const pend = await CONTA.pendientes(db, hoy);
    const cortes = (await db.query("select id, fecha_corte::text as fecha_corte, depositos_hasta::text as depositos_hasta, origen, pos_corte_id, estado, totales, generado_at, enviado_at, enviado_a from cards.cortes_comision order by id desc limit 60")).rows;
    const cfg = await configAviso('corte'), fijos = (await fijosDe('corte')).filter(x => x.activo);
    res.json({ hoy, pendiente: { resumen: pend.resumen, totales: pend.totales },
      cortes: cortes.map(c => ({ ...c, nombre: nombreCorte(c) })),
      envio: { activo: cfg.activo, con_corte_pos: cfg.con_corte_pos !== false, destinatarios: fijos.filter(x => x.tipo === 'to').length, total: fijos.length } });
  });
  // Envía (o reenvía) el corte a los destinatarios del correo "Corte de comisiones". Devuelve { ok } o { error, mensaje }.
  async function enviarCorte(id, quien) {
    const c = await cargarCorte(id);
    if (!c) return { error: 'no_existe', mensaje: 'No existe ese corte.' };
    const d = await destinatariosDe('corte', {});
    if (d.apagado) return { error: 'apagado', mensaje: 'El correo del corte está desactivado en Destinatarios.' };
    if (!d.to.length) return { error: 'sin_destinatarios', mensaje: 'Falta al menos un destinatario “Para” del corte en Destinatarios.' };
    if (!sesEnabled || !sesEnabled()) return { error: 'ses_no_configurado', mensaje: 'El correo no está configurado en este servidor.' };
    const correo = CORREO.armarCorteContable({ corte: c, appUrl: appUrl(), adjunto: true });
    const adj = [{ filename: `corte_comisiones_${c.fecha_corte}_${c.id}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: X.buildXLSX(CONTA.hojasXlsx(c)) }];
    const msgId = await Promise.race([sendSES({ to: d.to, cc: d.cc, bcc: d.bcc, subject: correo.subject, html: correo.html, textFallback: correo.text, inlineImages: logoCorreo(), attachments: adj, fromName: REMITENTE }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('tiempo de espera agotado')), 15000))]);
    await db.query("update cards.cortes_comision set estado='ENVIADO', enviado_at=now(), enviado_por=$1, enviado_a=$2, message_id=$3 where id=$4", [quien, [...d.to, ...d.cc].join(', '), String(msgId || ''), id]);
    return { ok: true, destinatarios: d.to.length + d.cc.length + d.bcc.length };
  }
  // Hacer el corte ahora: entra todo lo asignado y guardado hasta este momento (depósitos hasta `hasta`) que no esté en otro corte.
  app.post('/api/cards/contabilidad/cortes', ...rol(...CONTA_ADM), async (req, res) => {
    const b = req.body || {}, hoy = hoyMX(), hasta = b.hasta ? String(b.hasta) : hoy;
    if (!fechaReal(hasta) || hasta > hoy) return res.status(400).json({ error: 'fecha_invalida', mensaje: 'Elige la fecha hasta la que entran los depósitos (hoy o antes).' });
    const id = await CONTA.hacerCorte(db, { hasta, hoy, quien: actor(req), origen: 'MANUAL' });
    await bit(req, 'cards_corte_hacer', `corte ${id} · depósitos hasta ${hasta}`, { resource_type: 'cards_corte', resource_id: id });
    let envio = null;
    if (b.enviar) { try { envio = await enviarCorte(id, actor(req)); } catch (e) { envio = { error: 'envio_fallido', mensaje: 'No se pudo enviar el correo: ' + String(e.message).slice(0, 120) }; } if (envio.ok) await bit(req, 'cards_corte_enviar', `corte ${id} → ${envio.destinatarios} destinatario(s)`, { resource_type: 'cards_corte', resource_id: id }); }
    res.status(201).json({ ok: true, id, envio });
  });
  app.get('/api/cards/contabilidad/cortes/:id', ...rol(...CONTA_VER), async (req, res) => {
    const c = await cargarCorte(parseInt(req.params.id, 10) || 0);
    if (!c) return res.status(404).json({ error: 'no_existe' });
    res.json({ ...c, nombre: nombreCorte(c) });
  });
  app.get('/api/cards/contabilidad/cortes/:id/excel', ...rol(...CONTA_VER), async (req, res) => {
    const c = await cargarCorte(parseInt(req.params.id, 10) || 0);
    if (!c) return res.status(404).json({ error: 'no_existe' });
    enviarXLSX(res, `corte_comisiones_${c.fecha_corte}_${c.id}.xlsx`, X.buildXLSX(CONTA.hojasXlsx(c)));
  });
  app.post('/api/cards/contabilidad/cortes/:id/enviar', ...rol(...CONTA_ADM), async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    let r;
    try { r = await enviarCorte(id, actor(req)); } catch (e) { return res.status(502).json({ error: 'envio_fallido', mensaje: 'No se pudo enviar el correo: ' + String(e.message).slice(0, 120) }); }
    if (r.error) return res.status(r.error === 'no_existe' ? 404 : 409).json(r);
    await bit(req, 'cards_corte_enviar', `corte ${id} → ${r.destinatarios} destinatario(s)`, { resource_type: 'cards_corte', resource_id: id });
    res.json(r);
  });
  // Deshacer un corte que no se ha enviado: sus fondeos vuelven a quedar por cortar.
  app.delete('/api/cards/contabilidad/cortes/:id', ...rol(...CONTA_ADM), async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const r = await CONTA.deshacerCorte(db, id);
    if (r.error === 'no_existe') return res.status(404).json({ error: 'no_existe' });
    if (r.error === 'enviado') return res.status(409).json({ error: 'enviado', mensaje: 'Ese corte ya se envió: no se puede deshacer.' });
    await bit(req, 'cards_corte_deshacer', `corte ${id}`, { resource_type: 'cards_corte', resource_id: id });
    res.json({ ok: true });
  });
  // Gancho con el corte de POS Settlement (MCEB): al hacerse ese corte, se hace también el de BSO Cards y se manda lo guardado hasta ese momento.
  // Nunca interfiere con el corte de POS: es de mejor esfuerzo. Si hace menos de 30 min ya se hizo uno, no repite (p. ej. si regeneran el corte de POS).
  async function alCortePOS(info) {
    try {
      const cfg = await configAviso('corte');
      if (!cfg.activo || cfg.con_corte_pos === false) return;
      const reciente = (await db.query("select 1 from cards.cortes_comision where generado_at > now() - interval '30 minutes' limit 1")).rows.length;
      if (reciente) return;
      const hoy = hoyMX();
      const id = await CONTA.hacerCorte(db, { hasta: hoy, hoy, quien: (info && info.quien) || 'sistema', origen: 'POS', posCorteId: info && info.idCorte });
      const r = await enviarCorte(id, 'sistema');
      console.log(`[cards] corte de comisiones ${id} (con el corte de POS #${info && info.idCorte}): ${r.ok ? 'enviado a ' + r.destinatarios + ' destinatario(s)' : (r.mensaje || r.error)}`);
    } catch (e) { console.warn('[cards] corte con el de POS:', e.message); }
  }
  hooks.alCortePOS = alCortePOS;

  /* ====================== SOLICITUD (comercial) ====================== */
  const folioNuevo = async () => 'FND-' + hoyMX().slice(0, 4) + '-' + String((await db.query("select nextval('cards.fondeos_folio_seq') n")).rows[0].n).padStart(6, '0');

  app.post('/api/cards/solicitudes', ...rol(...SOLICITA), async (req, res) => {
    const b = req.body || {};
    const { porId } = await todas();
    const e = porId.get(parseInt(b.entidad_id, 10));
    if (!e) return res.status(400).json({ error: 'entidad_requerida', mensaje: 'Elige la empresa (o unidad de negocio / tarjeta) a la que le solicitas el fondeo.' });
    if (!activaConPadres(e, porId)) return res.status(409).json({ error: 'entidad_inactiva', mensaje: 'Esa entidad (o su empresa) está desactivada.' });
    const t = F.tasasEfectivas(e.id, porId);
    if (t.comision_pct == null || t.iva_pct == null) return res.status(409).json({ error: 'sin_tasas', mensaje: 'La empresa no tiene comisión/IVA definidos.' });
    if (!e.clabe_ef) return res.status(409).json({ error: 'sin_cuenta', mensaje: 'Ni esta entidad ni su empresa tienen CLABE de fondeo definida.' });
    const fon = dinero(b.fondeo);
    if (!Number.isFinite(fon) || fon <= 0 || fon > 1e10) return res.status(400).json({ error: 'monto_invalido', mensaje: 'Escribe el monto a fondear (mayor a 0).' });
    const c = F.desglosarFondeo(fon, t.comision_pct, t.iva_pct);
    const folio = await folioNuevo();
    const id = (await db.query(
      `insert into cards.fondeos(folio, entidad_id, empresa_id, estatus, origen, fondeo, comision, iva, redondeo, comision_pct, iva_pct, fondeo_solicitado, monto_esperado, clabe_destino, notas, creado_por, solicitante_id, solicitante_nombre, solicitado_at, beneficiario_destino, banco_destino, banco_codigo_destino)
       values($1,$2,$3,'SOLICITADO','SOLICITUD',$4,$5,$6,0,$7,$8,$4,$9,$10,$11,$12,$13,$14,now(),$15,$16,$17) returning id`,
      [folio, e.id, e.empresa_id, c.fondeo, c.comision, c.iva, t.comision_pct, t.iva_pct, c.total, e.clabe_ef, txt(b.notas, 500), actor(req), uid(req), actor(req), e.beneficiario_ef || null, e.banco_nombre_ef || null, e.banco_codigo_ef || null])).rows[0].id;
    await evento(id, actor(req), 'solicitado', `Fondeo ${c.fondeo} + comisión ${c.comision} + IVA ${c.iva} = depositar ${c.total}`);
    await bit(req, 'cards_solicitud_alta', `${folio} · ${e.nombre} · fondeo ${c.fondeo} · depositar ${c.total}`, { resource_type: 'cards_fondeo', resource_id: id });
    await notificar('solicitado', id);
    res.status(201).json({ ok: true, id, folio, cotizacion: c, entidad: { nombre: e.nombre, ruta: ruta(e, porId), clabe: e.clabe_ef, beneficiario: e.beneficiario_ef || null, banco: e.banco_nombre_ef || null }, comision_pct: t.comision_pct, iva_pct: t.iva_pct });
  });

  /* ====================== FONDEO MANUAL (tesorería registra algo que ya llegó) ====================== */
  function datosFondeo(b) {
    const fecha = b.fecha;
    if (!fechaReal(fecha)) return { error: 'fecha_invalida', mensaje: 'Elige la fecha en que se recibió el depósito.' };
    if (fecha > hoyMX()) return { error: 'fecha_futura', mensaje: 'La fecha de recepción no puede ser futura.' };
    const monto = dinero(b.monto_recibido);
    if (!Number.isFinite(monto) || monto <= 0 || monto > 1e10) return { error: 'monto_invalido', mensaje: 'Escribe el monto recibido (mayor a 0).' };
    let sol = null;
    if (b.fondeo_solicitado !== undefined && b.fondeo_solicitado !== null && String(b.fondeo_solicitado).trim() !== '') {
      sol = dinero(b.fondeo_solicitado);
      if (!Number.isFinite(sol) || sol <= 0 || sol > 1e10) return { error: 'solicitado_invalido', mensaje: 'El fondeo solicitado debe ser mayor a 0.' };
    }
    const rastreo = txt(b.clave_rastreo, 40);
    if (rastreo && !/^[A-Za-z0-9\-_.\/]+$/.test(rastreo)) return { error: 'rastreo_invalido', mensaje: 'La clave de rastreo solo lleva letras, números y guiones.' };
    return { ok: { fecha, monto: F.round2(monto), sol: sol == null ? null : F.round2(sol), rastreo, banco: txt(b.banco_ordenante, 80), notas: txt(b.notas, 500), ordNombre: txt(b.ordenante_nombre, 120), ordRfc: (txt(b.ordenante_rfc, 13) || '').toUpperCase() || null } };
  }

  app.post('/api/cards/fondeos', ...rol(...MANUAL), async (req, res) => {
    const b = req.body || {};
    const { porId } = await todas();
    const e = porId.get(parseInt(b.entidad_id, 10));
    if (!e) return res.status(400).json({ error: 'entidad_requerida', mensaje: 'Elige la empresa, unidad de negocio o tarjeta que fondea.' });
    if (!activaConPadres(e, porId)) return res.status(409).json({ error: 'entidad_inactiva', mensaje: 'Esa entidad (o su empresa) está desactivada.' });
    const t = F.tasasEfectivas(e.id, porId);
    if (t.comision_pct == null || t.iva_pct == null) return res.status(409).json({ error: 'sin_tasas', mensaje: 'La empresa no tiene comisión/IVA definidos.' });
    if (!e.clabe_ef) return res.status(409).json({ error: 'sin_cuenta', mensaje: 'Ni esta entidad ni su empresa tienen CLABE de fondeo definida.' });
    const v = datosFondeo(b);
    if (v.error) return res.status(400).json(v);
    const d = v.ok, g = F.desglosarRecibido(d.monto, t.comision_pct, t.iva_pct);
    // Se revisa el duplicado ANTES de tomar el folio, para no dejar huecos en la numeración por un rechazo normal.
    if (d.rastreo && (await db.query("select 1 from cards.fondeos where upper(clave_rastreo)=upper($1) and fecha=$2 and estatus<>'CANCELADO' limit 1", [d.rastreo, d.fecha])).rows.length)
      return res.status(409).json({ error: 'rastreo_duplicado', mensaje: 'Ya hay un fondeo con esa clave de rastreo en esa fecha.' });
    const folio = await folioNuevo();
    let id;
    try {
      id = (await db.query(
        `insert into cards.fondeos(folio, entidad_id, empresa_id, estatus, origen, fecha, monto_recibido, fondeo, comision, iva, redondeo, comision_pct, iva_pct, fondeo_solicitado, clabe_destino, clave_rastreo, banco_ordenante, notas, creado_por, ordenante_nombre, ordenante_rfc, beneficiario_destino, banco_destino, banco_codigo_destino)
         values($1,$2,$3,'SOLICITADO','MANUAL',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning id`,
        [folio, e.id, e.empresa_id, d.fecha, g.recibido, g.fondeo, g.comision, g.iva, g.redondeo, t.comision_pct, t.iva_pct, d.sol, e.clabe_ef, d.rastreo, d.banco, d.notas, actor(req), d.ordNombre, d.ordRfc, e.beneficiario_ef || null, e.banco_nombre_ef || null, e.banco_codigo_ef || null])).rows[0].id;
    } catch (er) { if (errUnica(er, res, 'rastreo_duplicado', 'Ya hay un fondeo con esa clave de rastreo en esa fecha.')) return; throw er; }
    await evento(id, actor(req), 'registrado', `Registro manual: recibido ${g.recibido} → fondeo ${g.fondeo} + comisión ${g.comision} + IVA ${g.iva}`);
    await bit(req, 'cards_fondeo_alta', `${folio} · ${e.nombre} · recibido ${g.recibido}`, { resource_type: 'cards_fondeo', resource_id: id });
    res.status(201).json({ ok: true, id, folio });
  });

  app.put('/api/cards/fondeos/:id', ...rol(...ASIGNA), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const f = (await db.query('select * from cards.fondeos where id=$1', [id])).rows[0];
    if (!f) return res.status(404).json({ error: 'no_existe' });
    if (f.origen !== 'MANUAL') return res.status(409).json({ error: 'no_editable', mensaje: 'Una solicitud no se edita: cancélala y crea otra.' });
    if (!['SOLICITADO', 'POR_ASIGNAR'].includes(f.estatus)) return res.status(409).json({ error: 'no_editable', mensaje: 'Solo se puede editar un fondeo que aún no se asigna.' });
    const v = datosFondeo(req.body || {});
    if (v.error) return res.status(400).json(v);
    const d = v.ok, g = F.desglosarRecibido(d.monto, Number(f.comision_pct), Number(f.iva_pct));
    try {
      await db.query(
        `update cards.fondeos set fecha=$1, monto_recibido=$2, fondeo=$3, comision=$4, iva=$5, redondeo=$6, fondeo_solicitado=$7, clave_rastreo=$8, banco_ordenante=$9, notas=$10, ordenante_nombre=$11, ordenante_rfc=$12 where id=$13 and estatus=$14`,
        [d.fecha, g.recibido, g.fondeo, g.comision, g.iva, g.redondeo, d.sol, d.rastreo, d.banco, d.notas, d.ordNombre, d.ordRfc, id, f.estatus]);
    } catch (er) { if (errUnica(er, res, 'rastreo_duplicado', 'Ya hay un fondeo con esa clave de rastreo en esa fecha.')) return; throw er; }
    await evento(id, actor(req), 'edicion', `Recibido ${numN(f.monto_recibido)} → ${g.recibido}`);
    await bit(req, 'cards_fondeo_edicion', `${f.folio} · recibido ${g.recibido}`, { resource_type: 'cards_fondeo', resource_id: id });
    res.json({ ok: true });
  });

  /* ====================== CEP ====================== */
  const archivoCep = req => {
    if (!req.file) return { err: { s: 400, j: { error: 'archivo_requerido', mensaje: 'Elige el archivo del CEP.' } } };
    if (!req.file.size) return { err: { s: 400, j: { error: 'archivo_vacio', mensaje: 'El archivo está vacío.' } } };
    const nombre = String(req.file.originalname || 'cep').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120);
    const mime = tipoCep(req.file.buffer, nombre);
    if (!mime) return { err: { s: 400, j: { error: 'tipo_no_permitido', mensaje: 'Solo se aceptan CEP en PDF o XML válidos.' } } };
    return { buf: req.file.buffer, nombre, mime, sha: crypto.createHash('sha256').update(req.file.buffer).digest('hex') };
  };

  // Lee un CEP y propone los datos de un fondeo manual (no guarda nada). La CLABE beneficiaria identifica quién fondea.
  app.post('/api/cards/ceps/extraer', ...rol(...MANUAL), limitaSubidas, uploadCep.single('archivo'), async (req, res) => {
    const a = archivoCep(req); if (a.err) return res.status(a.err.s).json(a.err.j);
    const x = await CEPX.extraerCep(a.buf, a.mime);
    const d = x.datos, avisos = [...x.avisos], sug = {};
    const { porId } = await todas();
    let entidad = null, desglose = null;
    const cuenta = d.beneficiario && d.beneficiario.cuenta;
    if (cuenta) {
      entidad = [...porId.values()].find(e => e.clabe === cuenta) || null;
      if (!entidad) avisos.push(`La CLABE beneficiaria del CEP (…${cuenta.slice(-4)}) no está registrada en ninguna empresa, unidad de negocio o tarjeta. Elige a quién corresponde o da de alta la CLABE.`);
      else if (!activaConPadres(entidad, porId)) avisos.push(`La CLABE pertenece a «${entidad.nombre}», que está desactivada.`);
    }
    if (entidad) {
      sug.entidad_id = entidad.id; sug.entidad_ruta = ruta(entidad, porId); sug.entidad_usable = activaConPadres(entidad, porId);
      const t = F.tasasEfectivas(entidad.id, porId);
      if (d.monto > 0 && t.comision_pct != null && t.iva_pct != null) desglose = { ...F.desglosarRecibido(d.monto, t.comision_pct, t.iva_pct), comision_pct: t.comision_pct, iva_pct: t.iva_pct };
      const ben = d.beneficiario || {};
      if (entidad.beneficiario && BNK.nombresCoinciden(ben.nombre, entidad.beneficiario) === false) avisos.push(`El beneficiario del CEP («${ben.nombre}») no coincide con el de la cuenta («${entidad.beneficiario}»).`);
      if (entidad.banco_codigo && BNK.bancoCoincide(ben.institucion, { codigo_spei: entidad.banco_codigo, nombre: entidad.banco_nombre }, await catalogoBancos()) === false) avisos.push(`El banco del CEP («${ben.institucion}») no coincide con el de la cuenta (${entidad.banco_nombre}).`);
      const emp = porId.get(entidad.empresa_id), rfcEmp = emp && emp.referencia ? String(emp.referencia).toUpperCase().replace(/\s/g, '') : null;
      const rfcOrd = d.ordenante && d.ordenante.rfc ? String(d.ordenante.rfc).toUpperCase() : null;
      if (rfcEmp && rfcOrd && rfcEmp !== rfcOrd) avisos.push(`El ordenante del CEP (RFC ${rfcOrd}) no coincide con el RFC de ${emp.nombre} (${rfcEmp}): puede ser un depósito de un tercero.`);
    }
    if (d.monto > 0) sug.monto_recibido = d.monto;
    if (d.fecha_abono) sug.fecha = d.fecha_abono;
    if (d.clave_rastreo) sug.clave_rastreo = d.clave_rastreo;
    if (d.ordenante && d.ordenante.institucion) sug.banco_ordenante = d.ordenante.institucion;
    if (d.ordenante && d.ordenante.nombre) sug.ordenante_nombre = d.ordenante.nombre;
    if (d.ordenante && d.ordenante.rfc) sug.ordenante_rfc = d.ordenante.rfc;
    if (sug.fecha && sug.fecha > hoyMX()) avisos.push('La fecha de abono del CEP es futura: revísala.');
    if (d.clave_rastreo && d.fecha_abono) {
      const dup = (await db.query("select id, folio, estatus from cards.fondeos where upper(clave_rastreo)=upper($1) and fecha=$2 and estatus<>'CANCELADO' limit 1", [d.clave_rastreo, d.fecha_abono])).rows[0];
      if (dup) avisos.push(`Ya existe el fondeo ${dup.folio} con esa clave de rastreo y fecha: este CEP parece repetido.`);
    }
    const rep = await archivoRepetido(a.sha, 0);
    if (rep) avisos.push(`Este mismo archivo ya está cargado en el fondeo ${rep.folio}.`);
    await bit(req, 'cards_cep_leer', `${a.nombre} · ${x.formato} · ${x.confianza}`);
    res.json({ ok: true, archivo: { nombre: a.nombre, mime: a.mime, sha256: a.sha }, formato: x.formato, confianza: x.confianza, es_cep: x.es_cep, legible: x.legible, avisos, datos: d, sugerencia: sug, desglose });
  });

  // Alcance de un fondeo para quien llama (404 si es de otra empresa y el usuario es comercial).
  async function fondeoEnAlcance(req, res, id) {
    const f = Number.isFinite(id) ? (await db.query('select * from cards.fondeos where id=$1', [id])).rows[0] : null;
    if (!f) { res.status(404).json({ error: 'no_existe' }); return null; }
    if (!propio(req, f)) { res.status(404).json({ error: 'no_existe' }); return null; }
    return f;
  }

  // Sube el CEP de un fondeo. Solo entra un CEP legible que cuadre con la solicitud (ver cards-flujo.evaluarCep).
  app.post('/api/cards/fondeos/:id/ceps', ...rol(...SOLICITA), limitaSubidas, uploadCep.single('archivo'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const f = await fondeoEnAlcance(req, res, id); if (!f) return;
    if (!FL.permisos(f.estatus, req.user.rol_cards, true).subir_cep) return res.status(409).json({ error: 'no_editable', mensaje: 'Este fondeo ya no admite cambios en su CEP.' });
    const a = archivoCep(req); if (a.err) return res.status(a.err.s).json(a.err.j);
    const dupSha = await archivoRepetido(a.sha, id);
    if (dupSha) {
      await evento(id, actor(req), 'cep_rechazado', `${a.nombre}: ese archivo ya estaba cargado`);
      return res.status(409).json({ error: 'cep_repetido', mensaje: dupSha.que === 'CEP'
        ? (dupSha.mismo ? 'Ese archivo ya está cargado en esta solicitud: no se acepta repetido.' : 'Ese mismo archivo ya está cargado en otro fondeo: no se acepta un CEP repetido.')
        : 'Ese archivo ya está cargado como comprobante del sistema: no se acepta como CEP.' });
    }
    const { porId } = await todas();
    const ent = porId.get(f.entidad_id), emp = porId.get(f.empresa_id);
    const previos = (await db.query('select datos from cards.fondeo_ceps where fondeo_id=$1', [id])).rows;
    const x = await CEPX.extraerCep(a.buf, a.mime);
    const ev = FL.evaluarCep(x, { clabe_destino: f.clabe_destino, empresa_nombre: emp ? emp.nombre : ent.nombre, empresa_rfc: emp && emp.referencia, monto_esperado: numN(f.monto_esperado), rastreos_previos: previos.map(p => p.datos && p.datos.clave_rastreo), hoy: hoyMX(),
      beneficiario_nombre: f.beneficiario_destino, banco: f.banco_codigo_destino ? { codigo_spei: f.banco_codigo_destino, nombre: f.banco_destino } : null, bancos: await catalogoBancos() });
    if (!ev.ok) {
      const msg = ev.errores.map(e => e.mensaje).join(' ');
      await evento(id, actor(req), 'cep_rechazado', `${a.nombre}: ${msg}`.slice(0, 300));
      await bit(req, 'cards_cep_rechazado', `${f.folio} · ${a.nombre} · ${ev.errores[0].codigo}`);
      return res.status(422).json({ error: 'cep_rechazado', codigo: ev.errores[0].codigo, mensaje: msg, errores: ev.errores, formato: x.formato });
    }
    const ap = ev.aplicar;
    const dupRastreo = (await db.query("select folio from cards.fondeos where upper(clave_rastreo)=upper($1) and fecha=$2 and estatus<>'CANCELADO' and id<>$3 limit 1", [ap.clave_rastreo, ap.fecha, id])).rows[0];
    if (dupRastreo) {
      await evento(id, actor(req), 'cep_rechazado', `${a.nombre}: la clave de rastreo ya está en ${dupRastreo.folio}`);
      return res.status(409).json({ error: 'rastreo_duplicado', mensaje: `Esa clave de rastreo ya está registrada en el fondeo ${dupRastreo.folio}: este CEP ya se usó.` });
    }
    const avisos = [...ev.avisos];
    const r = await db.query(
      'insert into cards.fondeo_ceps(fondeo_id, filename, mime, bytes_cifrado, bytes_size, sha256_hash, subido_por, datos, formato, confianza, es_cep, validado) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) returning id',   // solo llega aquí un CEP que pasó evaluarCep
      [id, a.nombre, a.mime, Buffer.from(C.encrypt(a.buf), 'utf8'), a.buf.length, a.sha, actor(req), JSON.stringify(x.datos), x.formato, x.confianza, x.es_cep]);
    const primero = previos.length === 0;
    const pasa = ['SOLICITADO', 'RECHAZADO'].includes(f.estatus);
    const nuevo = pasa ? 'POR_ASIGNAR' : f.estatus;
    try {
      if (f.origen === 'SOLICITUD' && primero) {
        // La solicitud nació sin monto ni fecha: lo que dice el CEP es lo que se recibió. El desglose se recalcula sobre eso.
        const g = F.desglosarRecibido(ap.monto, Number(f.comision_pct), Number(f.iva_pct));
        await db.query(`update cards.fondeos set monto_recibido=$1, fecha=$2, fondeo=$3, comision=$4, iva=$5, redondeo=$6, clave_rastreo=$7, banco_ordenante=$8, ordenante_nombre=$9, ordenante_rfc=$10, estatus=$11, rechazado_por=null, rechazado_at=null, motivo_rechazo=null where id=$12`,
          [g.recibido, ap.fecha, g.fondeo, g.comision, g.iva, g.redondeo, ap.clave_rastreo, ap.banco_ordenante, ap.ordenante_nombre, ap.ordenante_rfc, nuevo, id]);
      } else {
        // Fondeo manual (o 2.º archivo del mismo pago): se respeta lo capturado y solo se completa lo que falte.
        await db.query(`update cards.fondeos set clave_rastreo=coalesce(clave_rastreo,$1), banco_ordenante=coalesce(banco_ordenante,$2), ordenante_nombre=coalesce(ordenante_nombre,$3), ordenante_rfc=coalesce(ordenante_rfc,$4), estatus=$5, rechazado_por=null, rechazado_at=null, motivo_rechazo=null where id=$6`,
          [ap.clave_rastreo, ap.banco_ordenante, ap.ordenante_nombre, ap.ordenante_rfc, nuevo, id]);
        if (f.monto_recibido != null && Math.abs(Number(f.monto_recibido) - ap.monto) > TOL) avisos.push(`El CEP trae ${ap.monto} y lo registrado es ${numN(f.monto_recibido)}.`);
      }
    } catch (er) {
      await db.query('delete from cards.fondeo_ceps where id=$1', [r.rows[0].id]);
      if (errUnica(er, res, 'rastreo_duplicado', 'Esa clave de rastreo ya está registrada en otro fondeo.')) return;
      throw er;
    }
    await evento(id, actor(req), 'cep_alta', `${a.nombre} (${a.buf.length} B) · ${x.formato}`);
    if (pasa) await evento(id, actor(req), 'por_asignar', 'CEP aceptado: pasa a tesorería para asignar el saldo');
    await bit(req, 'cards_cep_alta', `${f.folio} · ${a.nombre}`, { resource_type: 'cards_cep', resource_id: r.rows[0].id });
    if (pasa) await notificar('por_asignar', id, { avisos });
    res.status(201).json({ ok: true, id: r.rows[0].id, sha256: a.sha, formato: x.formato, estatus: nuevo, avisos });
  });

  app.get('/api/cards/ceps/:id/download', ...rol(...VER), async (req, res) => {
    const a = (await db.query('select c.filename, c.mime, c.bytes_cifrado, c.sha256_hash, f.solicitante_id from cards.fondeo_ceps c join cards.fondeos f on f.id=c.fondeo_id where c.id=$1', [parseInt(req.params.id, 10)])).rows[0];
    if (!a) return res.status(404).json({ error: 'no_existe' });
    if (!propio(req, a)) return res.status(404).json({ error: 'no_existe' });
    let buf;
    try { buf = C.decrypt((Buffer.isBuffer(a.bytes_cifrado) ? a.bytes_cifrado : Buffer.from(a.bytes_cifrado)).toString('utf8')); }
    catch (_e) { return res.status(500).json({ error: 'descifrado_fallido' }); }
    if (crypto.createHash('sha256').update(buf).digest('hex') !== a.sha256_hash) return res.status(500).json({ error: 'hash_no_coincide' });
    res.setHeader('Content-Type', a.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + String(a.filename || 'cep').replace(/[^\w.\- ]+/g, '_') + '"');
    res.send(buf);
  });

  app.delete('/api/cards/ceps/:id', ...rol(...SOLICITA), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const a = (await db.query('select c.id, c.filename, c.sha256_hash, c.fondeo_id from cards.fondeo_ceps c where c.id=$1', [id])).rows[0];
    if (!a) return res.status(404).json({ error: 'no_existe' });
    const f = await fondeoEnAlcance(req, res, a.fondeo_id); if (!f) return;
    if (!FL.permisos(f.estatus, req.user.rol_cards, true).quitar_cep) return res.status(409).json({ error: 'no_editable', mensaje: 'Este fondeo ya no admite cambios en su CEP.' });
    await db.query('delete from cards.fondeo_ceps where id=$1', [id]);
    await evento(a.fondeo_id, actor(req), 'cep_baja', `${a.filename} · ${String(a.sha256_hash).slice(0, 12)}`);
    await bit(req, 'cards_cep_baja', `${f.folio} · ${a.filename}`, { resource_type: 'cards_cep', resource_id: id });
    const quedan = (await db.query('select count(*)::int n from cards.fondeo_ceps where fondeo_id=$1', [a.fondeo_id])).rows[0].n;
    if (!quedan && f.estatus !== 'SOLICITADO') {
      if (f.origen === 'SOLICITUD') {   // vuelve a la cotización original, sin los datos del CEP quitado
        const c = F.desglosarFondeo(Number(f.fondeo_solicitado), Number(f.comision_pct), Number(f.iva_pct));
        await db.query(`update cards.fondeos set estatus='SOLICITADO', monto_recibido=null, fecha=null, clave_rastreo=null, banco_ordenante=null, ordenante_nombre=null, ordenante_rfc=null, fondeo=$1, comision=$2, iva=$3, redondeo=0 where id=$4`, [c.fondeo, c.comision, c.iva, a.fondeo_id]);
      } else await db.query("update cards.fondeos set estatus='SOLICITADO' where id=$1", [a.fondeo_id]);
      await evento(a.fondeo_id, actor(req), 'esperando_cep', 'Se quitó el último CEP: vuelve a esperar el comprobante');
    }
    res.json({ ok: true });
  });

  /* ====================== TESORERÍA: asignar · rechazar · cancelar ====================== */
  /* ---------- comprobante del saldo asignado (tesorería) ---------- */
  app.post('/api/cards/fondeos/:id/comprobantes', ...rol(...ASIGNA), limitaSubidas, uploadCep.single('archivo'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const f = Number.isFinite(id) ? (await db.query('select id, folio, estatus, fondeo, monto_recibido, monto_esperado, entidad_id, empresa_id, clabe_destino from cards.fondeos where id=$1', [id])).rows[0] : null;
    if (!f) return res.status(404).json({ error: 'no_existe' });
    if (!FL.permisos(f.estatus, req.user.rol_cards, true).comprobante) return res.status(409).json({ error: 'no_editable', mensaje: 'El comprobante se sube cuando el fondeo está por asignar o ya asignado.' });
    if (!req.file) return res.status(400).json({ error: 'archivo_requerido', mensaje: 'Elige el comprobante.' });
    if (!req.file.size) return res.status(400).json({ error: 'archivo_vacio', mensaje: 'El archivo está vacío.' });
    const nombre = String(req.file.originalname || 'comprobante').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120);
    const mime = tipoComprobante(req.file.buffer, nombre);
    if (!mime) return res.status(400).json({ error: 'tipo_no_permitido', mensaje: 'El comprobante debe ser PDF, imagen (PNG o JPG) o Excel (.xlsx).' });
    const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const previos = (await db.query('select sha256_hash from cards.fondeo_comprobantes where fondeo_id=$1', [id])).rows;
    if (previos.length >= COMPROBANTES_MAX) return res.status(409).json({ error: 'demasiados', mensaje: `Un fondeo admite hasta ${COMPROBANTES_MAX} comprobantes.` });
    const dup = await archivoRepetido(sha, id);
    if (dup) {
      await evento(id, actor(req), 'comprobante_rechazado', `${nombre}: ese archivo ya estaba cargado`);
      return res.status(409).json({ error: 'repetido', mensaje: dup.mismo
        ? `Ese archivo ya está cargado en este fondeo como ${dup.que === 'CEP' ? 'CEP' : 'comprobante'}: no se acepta repetido.`
        : `Ese mismo archivo ya está cargado como ${dup.que === 'CEP' ? 'CEP' : 'comprobante'} del fondeo ${dup.folio}: no se acepta repetido.` });
    }
    // VALIDACIÓN: el monto del comprobante debe ser el fondeo neto calculado. Se lee del archivo (PDF/Excel) o, si es una captura, lo escribe tesorería.
    const { porId } = await todas();
    const ent = porId.get(f.entidad_id), emp = porId.get(f.empresa_id);
    const lectura = await CMP.extraerMontos(req.file.buffer, mime);
    const ev = CMP.evaluarComprobante(lectura, { esperado: Number(f.fondeo), recibido: numN(f.monto_recibido) != null ? numN(f.monto_recibido) : numN(f.monto_esperado), capturado: (req.body || {}).monto,
      entidad_nombre: ent && ent.nombre, correo_usuario: ent && ent.correo_usuario, empresa_nombre: emp && emp.nombre, empresa_comercial: emp && emp.nombre_comercial, clabe: f.clabe_destino });
    if (!ev.ok) {
      if (ev.codigo !== 'monto_requerido') {
        await evento(id, actor(req), 'comprobante_rechazado', `${nombre}: ${ev.mensaje}`.slice(0, 300));
        await bit(req, 'cards_comprobante_rechazado', `${f.folio} · ${nombre} · ${ev.codigo}`, { resource_type: 'cards_fondeo', resource_id: id });
      }
      return res.status(422).json({ error: 'comprobante_rechazado', codigo: ev.codigo, mensaje: ev.mensaje, formato: lectura.formato, esperado: F.round2(Number(f.fondeo)), checks: ev.checks });
    }
    const r = await db.query('insert into cards.fondeo_comprobantes(fondeo_id, filename, mime, bytes_cifrado, bytes_size, sha256_hash, subido_por, validado, monto_leido, monto_esperado, origen_monto, datos) values($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$11) returning id',
      [id, nombre, mime, Buffer.from(C.encrypt(req.file.buffer), 'utf8'), req.file.buffer.length, sha, actor(req), ev.monto, F.round2(Number(f.fondeo)), ev.origen, JSON.stringify(ev.datos)]);
    await evento(id, actor(req), 'comprobante_alta', `${nombre} (${f.estatus === 'ASIGNADO' ? 'saldo ya asignado' : 'antes de confirmar'}) · monto validado ${ev.monto} = calculado${ev.origen === 'captura' ? ' (capturado por tesorería)' : ''}`);
    await bit(req, 'cards_comprobante_alta', `${f.folio} · ${nombre} · ${ev.monto}`, { resource_type: 'cards_fondeo', resource_id: id });
    res.status(201).json({ ok: true, id: r.rows[0].id, validado: true, monto: ev.monto, origen: ev.origen, checks: ev.checks });
  });

  app.get('/api/cards/comprobantes/:id/download', ...rol(...VER), async (req, res) => {
    const a = (await db.query('select c.filename, c.mime, c.bytes_cifrado, c.sha256_hash, f.solicitante_id from cards.fondeo_comprobantes c join cards.fondeos f on f.id=c.fondeo_id where c.id=$1', [parseInt(req.params.id, 10) || 0])).rows[0];
    if (!a || !propio(req, a)) return res.status(404).json({ error: 'no_existe' });
    let buf;
    try { buf = C.decrypt((Buffer.isBuffer(a.bytes_cifrado) ? a.bytes_cifrado : Buffer.from(a.bytes_cifrado)).toString('utf8')); }
    catch (_e) { return res.status(500).json({ error: 'descifrado_fallido' }); }
    if (crypto.createHash('sha256').update(buf).digest('hex') !== a.sha256_hash) return res.status(500).json({ error: 'hash_no_coincide' });
    res.setHeader('Content-Type', a.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + String(a.filename || 'comprobante').replace(/[^\w.\- ]+/g, '_') + '"');
    res.send(buf);
  });

  app.delete('/api/cards/comprobantes/:id', ...rol(...ASIGNA), async (req, res) => {
    const a = (await db.query('select c.id, c.filename, c.fondeo_id, f.folio, f.estatus from cards.fondeo_comprobantes c join cards.fondeos f on f.id=c.fondeo_id where c.id=$1', [parseInt(req.params.id, 10) || 0])).rows[0];
    if (!a) return res.status(404).json({ error: 'no_existe' });
    if (!FL.permisos(a.estatus, req.user.rol_cards, true).quitar_comprobante) return res.status(409).json({ error: 'no_editable', mensaje: a.estatus === 'ASIGNADO' ? 'Con el saldo ya asignado, solo un administrador puede quitar el comprobante.' : 'Este fondeo ya no admite cambios en el comprobante.' });
    await db.query('delete from cards.fondeo_comprobantes where id=$1', [a.id]);
    await evento(a.fondeo_id, actor(req), 'comprobante_baja', a.filename);
    await bit(req, 'cards_comprobante_baja', `${a.folio} · ${a.filename}`, { resource_type: 'cards_fondeo', resource_id: a.fondeo_id });
    res.json({ ok: true });
  });

  app.post('/api/cards/fondeos/:id/asignar', ...rol(...ASIGNA), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const x = Number.isFinite(id) ? await cargar(id) : null;
    if (!x) return res.status(404).json({ error: 'no_existe' });
    const f = x.f;
    // CANDADO: sin un CEP validado por el sistema no hay "saldo asignado" (la base de datos lo vuelve a exigir con un trigger).
    const cand = FL.candadoAsignacion(f);
    if (!cand.abierto) { await evento(id, actor(req), 'asignacion_bloqueada', cand.motivo); return res.status(409).json({ error: 'candado', mensaje: 'No se puede asignar el saldo: ' + cand.motivo }); }
    const alertas = alertasDe(f), nota = txt((req.body || {}).nota, 300);
    if (alertas.some(a => a.nota) && !nota) return res.status(400).json({ error: 'nota_requerida', mensaje: 'Antes de asignar revisa: ' + alertas.filter(a => a.nota).map(a => a.texto).join(' ') + ' Escribe el motivo para continuar.' });
    const r = await db.query("update cards.fondeos set estatus='ASIGNADO', validado_por=$1, validado_at=now(), nota_validacion=$2, validado_por_email=$4 where id=$3 and estatus='POR_ASIGNAR' returning id", [actor(req), nota, id, (req.user && req.user.email) || null]);
    if (!r.rows.length) return res.status(409).json({ error: 'conflicto', mensaje: 'El fondeo cambió mientras lo asignabas. Recarga.' });
    await evento(id, actor(req), 'asignado', nota ? 'Saldo asignado · ' + nota : 'Saldo asignado');
    await bit(req, 'cards_fondeo_asignar', `${f.folio} · ${f.fondeo}`, { resource_type: 'cards_fondeo', resource_id: id });
    await notificar('asignado', id, { nota });
    res.json({ ok: true });
  });

  // ASIGNAR SIN CEP: única excepción al candado y solo para tesorería. Ella captura fecha y monto del depósito (no vienen de un CEP),
  // escribe el motivo (obligatorio) y queda marcado como "sin CEP" en el fondeo, el historial, la bitácora y el correo.
  app.post('/api/cards/fondeos/:id/asignar-sin-cep', ...rol(...SIN_CEP), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const x = Number.isFinite(id) ? await cargar(id) : null;
    if (!x) return res.status(404).json({ error: 'no_existe' });
    const f = x.f, b = req.body || {};
    if (!['SOLICITADO', 'POR_ASIGNAR'].includes(f.estatus)) return res.status(409).json({ error: 'estatus_invalido', mensaje: 'Solo se asigna sin CEP un fondeo que está esperando CEP o por asignar.' });
    if (f.ceps.some(c => c.validado)) return res.status(409).json({ error: 'tiene_cep', mensaje: 'Este fondeo ya tiene un CEP validado: asígnalo de forma normal.' });
    const motivo = txt(b.motivo, 300);
    if (!motivo || motivo.length < 10) return res.status(400).json({ error: 'motivo_requerido', mensaje: 'Escribe por qué se asigna sin CEP (mínimo 10 caracteres).' });
    const fecha = b.fecha;
    if (!fechaReal(fecha)) return res.status(400).json({ error: 'fecha_invalida', mensaje: 'Elige la fecha en que se recibió el depósito.' });
    if (fecha > hoyMX()) return res.status(400).json({ error: 'fecha_futura', mensaje: 'La fecha de recepción no puede ser futura.' });
    const monto = (b.monto_recibido === undefined || b.monto_recibido === null || String(b.monto_recibido).trim() === '') ? numN(f.monto_esperado) : dinero(b.monto_recibido);
    if (!Number.isFinite(monto) || monto <= 0 || monto > 1e10) return res.status(400).json({ error: 'monto_invalido', mensaje: 'Escribe el monto recibido (mayor a 0).' });
    const rastreo = txt(b.clave_rastreo, 40);
    if (rastreo && !/^[A-Za-z0-9\-_.\/]+$/.test(rastreo)) return res.status(400).json({ error: 'rastreo_invalido', mensaje: 'La clave de rastreo solo lleva letras, números y guiones.' });
    const g = F.desglosarRecibido(F.round2(monto), Number(f.comision_pct), Number(f.iva_pct));
    // También sin CEP se exige el comprobante del saldo con su monto validado (contra el neto que resulta de lo capturado).
    const falta = FL.comprobanteFalta(f, g.fondeo);
    if (falta) { await evento(id, actor(req), 'asignacion_bloqueada', falta); return res.status(409).json({ error: 'candado', mensaje: 'No se puede asignar el saldo: ' + falta }); }
    let r;
    try {
      r = await db.query(
        `update cards.fondeos set estatus='ASIGNADO', asignado_sin_cep=true, sin_cep_motivo=$1, fecha=$2, monto_recibido=$3, fondeo=$4, comision=$5, iva=$6, redondeo=$7, clave_rastreo=$8,
                validado_por=$9, validado_at=now(), nota_validacion=$1, validado_por_email=$10
          where id=$11 and estatus in ('SOLICITADO','POR_ASIGNAR') returning id`,
        [motivo, fecha, g.recibido, g.fondeo, g.comision, g.iva, g.redondeo, rastreo, actor(req), (req.user && req.user.email) || null, id]);
    } catch (er) { if (errUnica(er, res, 'rastreo_duplicado', 'Ya hay un fondeo con esa clave de rastreo en esa fecha.')) return; throw er; }
    if (!r.rows.length) return res.status(409).json({ error: 'conflicto', mensaje: 'El fondeo cambió mientras lo asignabas. Recarga.' });
    await evento(id, actor(req), 'asignado_sin_cep', `Saldo asignado SIN CEP · recibido ${g.recibido} el ${fecha}${rastreo ? ' · rastreo ' + rastreo : ''} · ${motivo}`);
    await bit(req, 'cards_fondeo_asignar_sin_cep', `${f.folio} · ${g.recibido} · ${motivo}`, { resource_type: 'cards_fondeo', resource_id: id });
    await notificar('asignado', id, { nota: motivo });
    res.json({ ok: true });
  });

  app.post('/api/cards/fondeos/:id/rechazar', ...rol(...ASIGNA), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const f = (await db.query('select id, folio, estatus from cards.fondeos where id=$1', [id])).rows[0];
    if (!f) return res.status(404).json({ error: 'no_existe' });
    if (f.estatus !== 'POR_ASIGNAR') return res.status(409).json({ error: 'estatus_invalido', mensaje: 'Solo se rechaza un fondeo que está Por asignar.' });
    const motivo = txt((req.body || {}).motivo, 300);
    if (!motivo || motivo.length < 5) return res.status(400).json({ error: 'motivo_requerido', mensaje: 'Escribe el motivo del rechazo (mínimo 5 caracteres).' });
    const r = await db.query("update cards.fondeos set estatus='RECHAZADO', rechazado_por=$1, rechazado_at=now(), motivo_rechazo=$2 where id=$3 and estatus='POR_ASIGNAR' returning id", [actor(req), motivo, id]);
    if (!r.rows.length) return res.status(409).json({ error: 'conflicto', mensaje: 'El fondeo cambió mientras lo rechazabas. Recarga.' });
    await evento(id, actor(req), 'rechazado', motivo);
    await bit(req, 'cards_fondeo_rechazar', `${f.folio} · ${motivo}`, { resource_type: 'cards_fondeo', resource_id: id });
    await notificar('rechazado', id, { motivo });
    res.json({ ok: true });
  });

  app.post('/api/cards/fondeos/:id/cancelar', ...rol(...SOLICITA), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const f = await fondeoEnAlcance(req, res, id); if (!f) return;
    if (f.estatus === 'CANCELADO') return res.status(409).json({ error: 'estatus_invalido', mensaje: 'Ya está cancelado.' });
    if (!FL.permisos(f.estatus, req.user.rol_cards, true).cancelar)
      return res.status(403).json({ error: 'sin_permiso', mensaje: f.estatus === 'ASIGNADO' ? 'Un fondeo asignado solo lo cancela un administrador.' : 'Este fondeo ya está con tesorería: pídele que lo rechace.' });
    const motivo = txt((req.body || {}).motivo, 300);
    if (!motivo || motivo.length < 5) return res.status(400).json({ error: 'motivo_requerido', mensaje: 'Escribe el motivo de la cancelación (mínimo 5 caracteres).' });
    const r = await db.query("update cards.fondeos set estatus='CANCELADO', cancelado_por=$1, cancelado_at=now(), motivo_cancelacion=$2 where id=$3 and estatus=$4 returning id", [actor(req), motivo, id, f.estatus]);
    if (!r.rows.length) return res.status(409).json({ error: 'conflicto', mensaje: 'El fondeo cambió mientras lo cancelabas. Recarga.' });
    await evento(id, actor(req), 'cancelado', motivo);
    await bit(req, 'cards_fondeo_cancelar', `${f.folio} · ${motivo}`, { resource_type: 'cards_fondeo', resource_id: id });
    await notificar('cancelado', id, { motivo, excluirUsuario: uid(req) });   // quien cancela no se avisa a sí mismo
    res.json({ ok: true });
  });

  /* ====================== PANEL y contadores ====================== */
  app.get('/api/cards/resumen', ...rol(...VER), async (req, res) => {
    const al = alcance(req);
    const hoy = hoyMX();
    const desde = fechaReal(req.query.desde) ? req.query.desde : hoy.slice(0, 8) + '01';
    const hasta = fechaReal(req.query.hasta) ? req.query.hasta : hoy;
    const sc = al === null ? { sql: '', vals: [] } : { sql: ' and f.solicitante_id = $3', vals: [al.sol] };
    const tot = (await db.query(
      `select count(*)::int n, coalesce(sum(monto_recibido),0) recibido, coalesce(sum(fondeo),0) fondeo, coalesce(sum(comision),0) comision, coalesce(sum(iva),0) iva
         from cards.fondeos f where f.estatus='ASIGNADO' and f.fecha between $1 and $2${sc.sql}`, [desde, hasta, ...sc.vals])).rows[0];
    const porEmpresa = (await db.query(
      `select emp.id, emp.nombre, count(*)::int n, sum(f.monto_recibido) recibido, sum(f.fondeo) fondeo, sum(f.comision) comision, sum(f.iva) iva
         from cards.fondeos f join cards.entidades emp on emp.id=f.empresa_id
        where f.estatus='ASIGNADO' and f.fecha between $1 and $2${sc.sql} group by emp.id, emp.nombre order by sum(f.fondeo) desc`, [desde, hasta, ...sc.vals])).rows;
    const pend = (await db.query(
      `select count(*) filter (where f.estatus='SOLICITADO')::int esperando_cep,
              count(*) filter (where f.estatus='POR_ASIGNAR')::int por_asignar,
              count(*) filter (where f.estatus='RECHAZADO')::int rechazadas,
              count(*) filter (where f.estatus in ('POR_ASIGNAR','ASIGNADO') and f.fondeo_solicitado is not null and f.monto_recibido is not null and abs(f.fondeo-f.fondeo_solicitado) > ${TOL})::int difieren
         from cards.fondeos f where true${al === null ? '' : ' and f.solicitante_id = $1'}`, al === null ? [] : [al.sol])).rows[0];
    const recientes = (await listar({}, 8, al, req)).rows;
    const n = x => Number(x) || 0;
    res.json({
      desde, hasta,
      totales: { n: tot.n, recibido: n(tot.recibido), fondeo: n(tot.fondeo), comision: n(tot.comision), iva: n(tot.iva) },
      por_empresa: porEmpresa.map(r => ({ id: r.id, nombre: r.nombre, n: r.n, recibido: n(r.recibido), fondeo: n(r.fondeo), comision: n(r.comision), iva: n(r.iva) })),
      pendientes: pend, recientes,
    });
  });

  // Números para el menú: tesorería ve cuántos hay por asignar; el comercial, cuántos le devolvieron o esperan CEP.
  app.get('/api/cards/contadores', ...rol(...VER), async (req, res) => {
    const al = alcance(req);
    const r = (await db.query(
      `select count(*) filter (where estatus='POR_ASIGNAR')::int por_asignar, count(*) filter (where estatus='SOLICITADO')::int esperando_cep, count(*) filter (where estatus='RECHAZADO')::int rechazadas
         from cards.fondeos f where true${al === null ? '' : ' and f.solicitante_id = $1'}`, al === null ? [] : [al.sol])).rows[0];
    res.json(r);
  });
}

module.exports = { mountCardsRoutes, tipoCep };
