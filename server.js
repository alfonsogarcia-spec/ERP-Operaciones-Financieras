/* ============================================================================
   server.js — Conciliación y Liquidación T+1 (BRD-OP-AGR-001)
   Backend: TODA la lógica y el estado viven aquí. El front es solo espejo.
   - Motor: engine.js (única fuente de verdad).
   - Datos: Postgres (Supabase en prod · pglite en dev).
   - Excel: lib/excel.js (parseo y generación server-side).
   - Auth JWT + bcrypt, roles forzados por endpoint, inmutabilidad de cortes.
   ========================================================================= */
'use strict';
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const E = require('./engine.js');
const db = require('./db/index.js');
const X = require('./lib/excel.js');

const app = express();
const PORT = process.env.PORT || 4174;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-cambia-en-produccion';
if (!process.env.JWT_SECRET) console.warn('⚠  JWT_SECRET no definido: usando secreto de desarrollo.');

app.use(express.json({ limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

/* ---------- helpers ---------- */
const N = v => (v == null || v === '') ? null : Number(v);
const nrm = s => String(s == null ? '' : s).trim().toLowerCase();
const safeUser = u => ({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol });
const ROLES = { admin: 'Administrador', operador: 'Operador (Operaciones)', tesoreria: 'Tesorería' };

function firmar(u) { return jwt.sign({ sub: u.id, rol: u.rol, nombre: u.nombre, email: u.email }, JWT_SECRET, { expiresIn: '12h' }); }
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  if (!tok) return res.status(401).json({ error: 'sin_token' });
  try { req.user = jwt.verify(tok, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'token_invalido' }); }
}
const requiereRol = (...roles) => (req, res, next) =>
  roles.includes(req.user.rol) ? next() : res.status(403).json({ error: 'rol_no_autorizado', necesita: roles });
const dbReady = res => { if (!db.isReady()) { res.status(503).json({ error: 'db_no_lista' }); return false; } return true; };

async function bit(req, accion, detalle) {
  try { await db.query('insert into bitacora(usuario,rol,accion,detalle) values($1,$2,$3,$4)',
    [req.user ? req.user.nombre : '—', req.user ? req.user.rol : '—', accion, detalle || '']); } catch (e) {}
}

/* ---------- loaders de catálogo (coaccionan numeric→number) ---------- */
async function getParams() {
  const r = (await db.query('select * from params where id=1')).rows[0];
  return { IVA: Number(r.iva), tasa_int_amex: Number(r.tasa_int_amex), tasa_int_int: Number(r.tasa_int_int), fee_broxel: Number(r.fee_broxel), prodParams: r.prodparams };
}
async function getFeriados() { return (await db.query('select fecha::text as fecha from feriados order by fecha')).rows.map(r => r.fecha); }
async function getGrupos() { return (await db.query('select * from grupos')).rows; }
async function getAfiliaciones() { return (await db.query('select * from afiliaciones')).rows; }
async function getAfilGrupo() { return (await db.query('select * from afil_grupo')).rows; }
async function getCostos() { return (await db.query('select * from costos')).rows; }
async function getCuentas() { return (await db.query('select * from cuentas')).rows; }
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
function estadoServicio() { return { ok: true, service: 'conciliacion-liquidacion', db: db.isReady(), backend: db.kind(), ts: Date.now() }; }
app.get('/healthz', (_req, res) => res.json(estadoServicio()));
app.get('/api/estado', (_req, res) => res.json(estadoServicio()));

/* ---------- login ---------- */
app.post('/api/login', async (req, res) => {
  if (!dbReady(res)) return;
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'faltan_datos' });
  const u = (await db.query('select * from usuarios where lower(email)=lower($1) and activo=true', [email])).rows[0];
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'credenciales' });
  res.json({ token: firmar(u), user: safeUser(u) });
});
app.get('/api/yo', auth, (req, res) => res.json({ id: req.user.sub, nombre: req.user.nombre, email: req.user.email, rol: req.user.rol }));

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
  if (b.id) {
    await db.query('update cuentas set id_grupo=$1,numero_afiliacion=$2,nombre_comercial=$3,razon_social_beneficiario=$4,banco=$5,clabe=$6,codigo_banco=$7 where id=$8',
      [parseInt(b.id_grupo, 10), afil, b.nombre_comercial || '', b.razon_social_beneficiario || '', b.banco || '', cl, codigo, b.id]);
  } else {
    // dedupe por grupo+afiliación
    const dup = (await db.query('select id from cuentas where id_grupo=$1 and coalesce(numero_afiliacion,\'\')=$2', [parseInt(b.id_grupo, 10), afil])).rows[0];
    if (dup) await db.query('update cuentas set nombre_comercial=$1,razon_social_beneficiario=$2,banco=$3,clabe=$4,codigo_banco=$5 where id=$6', [b.nombre_comercial || '', b.razon_social_beneficiario || '', b.banco || '', cl, codigo, dup.id]);
    else await db.query('insert into cuentas(id_grupo,numero_afiliacion,nombre_comercial,razon_social_beneficiario,banco,clabe,codigo_banco) values($1,$2,$3,$4,$5,$6,$7)',
      [parseInt(b.id_grupo, 10), afil, b.nombre_comercial || '', b.razon_social_beneficiario || '', b.banco || '', cl, codigo]);
  }
  await bit(req, 'catalogo', `cuenta grupo ${b.id_grupo} afil ${afil || 'nivel-grupo'}`);
  res.json({ ok: true });
});
app.delete('/api/catalogo/cuenta/:id', auth, requiereRol('admin'), async (req, res) => {
  if (!dbReady(res)) return; await db.query('delete from cuentas where id=$1', [parseInt(req.params.id, 10)]);
  await bit(req, 'catalogo', `eliminó cuenta ${req.params.id}`); res.json({ ok: true });
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
app.post('/api/catalogo/:tipo/import', auth, requiereRol('admin'), upload.single('archivo'), async (req, res) => {
  if (!dbReady(res)) return;
  const parsed = req.file ? X.parseBuffer(req.file.buffer) : X.parseCSVText((req.body && req.body.csv) || '');
  const objs = parsed.objs; let n = 0;
  try {
    if (req.params.tipo === 'grupos') {
      for (const o of objs) {
        if (!o.id_grupo || !o.numero_afiliacion) continue; const idg = parseInt(o.id_grupo, 10); const afil = String(o.numero_afiliacion).replace(/\D/g, '');
        await db.query('insert into grupos(id_grupo,nombre_cliente,activo) values($1,$2,true) on conflict(id_grupo) do update set nombre_cliente=excluded.nombre_cliente', [idg, String(o.nombre_cliente || ('Grupo ' + idg))]);
        await db.query('insert into afiliaciones(numero_afiliacion,razon_social,ult3,id_afiliacion) values($1,$2,$3,$4) on conflict(numero_afiliacion) do update set razon_social=excluded.razon_social', [afil, String(o.razon_social || ''), E.ult3(afil), E.ult3(afil) + 'CPPX00']);
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
        const vals = [idg, afil, String(o.nombre_comercial || ''), String(o.razon_social_beneficiario || ''), String(o.banco || ''), String(o.clabe || '').replace(/\D/g, ''), cod ? cod.codigo_spei : null];
        if (dup) await db.query('update cuentas set id_grupo=$1,numero_afiliacion=$2,nombre_comercial=$3,razon_social_beneficiario=$4,banco=$5,clabe=$6,codigo_banco=$7 where id=$8', [...vals, dup.id]);
        else await db.query('insert into cuentas(id_grupo,numero_afiliacion,nombre_comercial,razon_social_beneficiario,banco,clabe,codigo_banco) values($1,$2,$3,$4,$5,$6,$7)', vals);
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

app.post('/api/transacciones/ingesta', auth, requiereRol('admin', 'operador'), upload.single('archivo'), async (req, res) => {
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
  await insertMany('transacciones', ['fecha', 'hora', 'cliente', 'comercio', 'numero_afiliacion', 'estatus', 'metodo', 'producto', 'monto', 'folio', 'referencia', 'autorizacion', 'terminal', 'fecha_liq', 'cancelacion', 'invalida'], filas);
  await bit(req, 'ingesta', `${validas} válidas, ${invalidas} inválidas (${modo})`);
  res.json({ validas, invalidas, monto: E.round2(monto) });
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
    const r = E.calcularCompensacion(arr, cat, params, {});
    const faltantes = []; if (!g) faltantes.push('grupo'); if (!tasas) faltantes.push('tasas'); if (!co) faltantes.push('costos'); if (!cuenta && Math.abs(r.disp_total) > 0.005) faltantes.push('cuenta');
    calculos.push({
      cliente, afil, id_grupo: idGrupo, razon: g ? g.nombre_cliente : cliente, concepto: idGrupo ? E.concepto(afil, idGrupo) : '',
      clabe: cuenta ? cuenta.clabe : '', codigo_banco: cuenta ? (cuenta.codigo_banco || bancoCod(cuenta.banco)) : null, banco: cuenta ? cuenta.banco : '', beneficiario: cuenta ? (cuenta.razon_social_beneficiario || cuenta.nombre_comercial) : '',
      calc: r, faltantes, ajustes: { financiamientos: 0, contracargos_dom: 0, contracargos_amex: 0 },
    });
    total_comp += r.comp_total; total_disp += r.disp_total; total_monto += r.m_tdd + r.m_tdc + r.m_amex + r.m_int;
  }
  let cuadra = true; calculos.forEach(c => { if (Math.abs(c.calc.diferencia) > 0.01) cuadra = false; });
  const bloqueos = calculos.filter(c => Math.abs(c.calc.disp_total) > 0.005 && (!c.clabe || !c.codigo_banco)).length;
  return { calculos, total_comp: E.round2(total_comp), total_disp: E.round2(total_disp), total_monto: E.round2(total_monto), n_trx: txs.length, cuadra, bloqueos };
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
  const c = await computeCorte(iso);
  const ins = (await db.query('insert into cortes(fecha_liq,fecha_liq_iso,estado,creado_por,total_monto,total_comp,total_disp,n_trx,cuadra,bloqueos) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id_corte',
    [E.fmtFecha(E.parseFecha(iso)), iso, 'Borrador', req.user.nombre, c.total_monto, c.total_comp, c.total_disp, c.n_trx, c.cuadra, c.bloqueos])).rows[0];
  const idCorte = ins.id_corte;
  await insertMany('calculos', ['corte_id', 'cliente', 'afil', 'id_grupo', 'razon', 'concepto', 'clabe', 'codigo_banco', 'banco', 'beneficiario', 'calc', 'faltantes', 'ajustes'],
    c.calculos.map(cc => ({ corte_id: idCorte, cliente: cc.cliente, afil: cc.afil, id_grupo: cc.id_grupo, razon: cc.razon, concepto: cc.concepto, clabe: cc.clabe, codigo_banco: cc.codigo_banco, banco: cc.banco, beneficiario: cc.beneficiario, calc: JSON.stringify(cc.calc), faltantes: JSON.stringify(cc.faltantes), ajustes: JSON.stringify(cc.ajustes) })));
  await bit(req, 'corte', `generó corte #${idCorte} (${E.fmtFecha(E.parseFecha(iso))}), ${c.calculos.length} grupos`);
  res.json({ id_corte: idCorte });
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
app.post('/api/cortes/:id/:accion', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const accion = req.params.accion; if (!['validar', 'dispersar', 'cerrar'].includes(accion)) return res.status(404).json({ error: 'accion' });
  const rolOk = accion === 'validar' ? ['admin', 'tesoreria'] : accion === 'dispersar' ? ['admin', 'tesoreria'] : ['admin', 'tesoreria'];
  if (!rolOk.includes(req.user.rol)) return res.status(403).json({ error: 'rol_no_autorizado', necesita: rolOk });
  const c = (await db.query('select * from cortes where id_corte=$1', [parseInt(req.params.id, 10)])).rows[0];
  if (!c) return res.status(404).json({ error: 'no_existe' });
  if (['Dispersado', 'Cerrado'].includes(c.estado) && accion !== 'cerrar') return res.status(409).json({ error: 'corte_inmutable', estado: c.estado });
  if (!transicionValida(c.estado, accion)) return res.status(409).json({ error: 'transicion_invalida', estado: c.estado });
  if (accion === 'validar') { if (!c.cuadra || c.bloqueos) return res.status(409).json({ error: 'no_cuadra_o_bloqueado' }); await db.query('update cortes set estado=$1,validado_por=$2 where id_corte=$3', ['Validado', req.user.nombre, c.id_corte]); }
  if (accion === 'dispersar') await db.query('update cortes set estado=$1,dispersado_por=$2 where id_corte=$3', ['Dispersado', req.user.nombre, c.id_corte]);
  if (accion === 'cerrar') await db.query('update cortes set estado=$1 where id_corte=$2', ['Cerrado', c.id_corte]);
  await bit(req, accion, `corte #${c.id_corte}`);
  res.json({ ok: true });
});
app.delete('/api/cortes', auth, requiereRol('admin', 'operador'), async (req, res) => {
  if (!dbReady(res)) return; await db.query('delete from cortes'); await bit(req, 'corte', 'vació cortes'); res.json({ ok: true });
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
    .map(x => ({ ...x, calc: typeof x.calc === 'string' ? JSON.parse(x.calc) : x.calc }))
    .filter(x => Math.abs(x.calc.disp_total) > 0.005);
  const bloq = cal.filter(x => !x.clabe || !x.codigo_banco);
  if (bloq.length) return res.status(409).json({ error: 'bloqueado', detalle: bloq.map(x => ({ razon: x.razon, afil: x.afil, importe: E.round2(x.calc.disp_total), falta: !x.clabe ? 'CLABE' : 'codigo_banco' })) });
  const head = ['concepto', 'clabe', 'codigo_banco', 'beneficiario', 'importe'];
  const rows = cal.map(x => [x.concepto, String(x.clabe), Number(x.codigo_banco) || x.codigo_banco, x.beneficiario, E.round2(x.calc.disp_total)]);
  await bit(req, 'layout', `exportó layout corte #${c.id_corte} (${rows.length} órdenes)`);
  enviarXLSX(res, `layout_spei_corte_${c.id_corte}_${c.fli}.xlsx`, X.buildXLSX([{ name: 'Layout SPEI', aoa: [head, ...rows], cols: [{ wch: 22 }, { wch: 20 }, { wch: 12 }, { wch: 28 }, { wch: 14 }] }]));
});
app.get('/api/cortes/:id/reporte.xlsx', auth, async (req, res) => {
  if (!dbReady(res)) return;
  const c = (await db.query('select *, fecha_liq_iso::text as fli from cortes where id_corte=$1', [parseInt(req.params.id, 10)])).rows[0];
  if (!c) return res.status(404).json({ error: 'no_existe' });
  const cal = (await db.query('select * from calculos where corte_id=$1', [c.id_corte])).rows.map(x => ({ ...x, calc: typeof x.calc === 'string' ? JSON.parse(x.calc) : x.calc }));
  const head = ['grupo', 'afiliacion', 'concepto', 'monto', 'comp_tdd', 'comp_tdc', 'comp_amex', 'comp_int', 'a_compensar', 'banca_mas_iva', 'a_dispersar', 'diferencia', 'utilidad'];
  const rows = cal.map(x => { const r = x.calc; return [x.razon, String(x.afil), x.concepto, E.round2(r.m_tdd + r.m_tdc + r.m_amex + r.m_int), E.round2(r.comp_tdd), E.round2(r.comp_tdc), E.round2(r.comp_amex), E.round2(r.comp_int), E.round2(r.comp_total), E.round2(r.banca + r.iva_banca), E.round2(r.disp_total), E.round2(r.diferencia), E.round2(r.utilidad)]; });
  rows.push(['TOTAL', '', '', Number(c.total_monto), '', '', '', '', Number(c.total_comp), '', Number(c.total_disp), '', '']);
  await bit(req, 'reporte', `exportó reporte corte #${c.id_corte}`);
  enviarXLSX(res, `reporte_cliente_corte_${c.id_corte}_${c.fli}.xlsx`, X.buildXLSX([{ name: 'Reporte por cliente', aoa: [head, ...rows] }]));
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

app.get('/api/bitacora', auth, async (req, res) => {
  if (!dbReady(res)) return;
  res.json((await db.query('select * from bitacora order by id desc limit 300')).rows);
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
  app.listen(PORT, () => console.log(`Conciliación y Liquidación T+1 en http://localhost:${PORT}`));
})();
