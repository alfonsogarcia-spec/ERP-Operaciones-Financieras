'use strict';
/* ============================================================================
   lib/inventario-admin.js — Inventario ADMINISTRATIVO (método PEPS, captura manual y carga masiva) del sistema POS.

   Es distinto del «Inventario de terminales» (que sale de las transacciones): aquí se llevan artículos que la empresa compra y entrega (terminales físicas,
   lectores, SIMs, papelería, etc.) con sus entradas y salidas, el costo por PEPS y la valuación del almacén. Los artículos SERIALIZADOS (terminales) llevan
   además cada número de serie y a qué EMPRESA y UNIDAD del cliente está asignado. Los movimientos no se editan: se ANULAN con motivo y todo se recalcula
   (ver lib/inventario-peps.js, lib/inventario-series.js y lib/inventario-layout.js). Rutas bajo /api/inventario/admin.
   ========================================================================= */
const crypto = require('crypto');
const XLSX = require('xlsx');
const P = require('./inventario-peps.js');
const SE = require('./inventario-series.js');
const LY = require('./inventario-layout.js');
const X = require('./excel.js');
const MET = require('./inventario-metodos.js');

const KEY = 7420112000;                                                  // base del candado por artículo (pg_advisory_xact_lock)
const KEY_ALTAS = 7420111999;                                            // candado para altas de artículos (SKU único) desde la carga masiva
let listo = null;

class ErrorInv extends Error { constructor(status, codigo, msg, extra) { super(msg); this.status = status; this.codigo = codigo; this.extra = extra || null; } }
const fF = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || ''); };
const mxn = n => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = v => (v === null || v === undefined ? null : Number(v));
const nrm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function asegurar(db) {
  if (!listo) listo = (async () => {
    await db.query(`create table if not exists inv_articulos (
      id bigserial primary key, sku text not null, nombre text not null, categoria text, unidad text not null default 'pieza',
      minimo numeric(14,4) not null default 0, activo boolean not null default true, notas text,
      creado_por text, creado_at timestamptz not null default now())`);
    await db.query('alter table inv_articulos add column if not exists serializado boolean not null default false');
    await db.query('create unique index if not exists inv_articulos_sku on inv_articulos (upper(sku))');
    await db.query(`create table if not exists inv_movimientos (
      id bigserial primary key, articulo_id bigint not null references inv_articulos(id),
      tipo text not null check (tipo in ('entrada','salida')), concepto text not null, fecha date not null,
      cantidad numeric(14,4) not null check (cantidad > 0), costo_unitario numeric(14,4),
      proveedor text, documento text, destino text, notas text,
      usuario text not null, creado_at timestamptz not null default now(),
      anulado boolean not null default false, anulado_por text, anulado_motivo text, anulado_at timestamptz)`);
    for (const c of ['empresa_id integer', 'empresa text', 'unidad text', 'afiliacion text']) await db.query(`alter table inv_movimientos add column if not exists ${c}`);
    await db.query('create index if not exists inv_mov_art on inv_movimientos (articulo_id, fecha, id)');
    await db.query(`create table if not exists inv_mov_series (
      id bigserial primary key, movimiento_id bigint not null references inv_movimientos(id), serie text not null)`);
    await db.query('create index if not exists inv_mov_series_mov on inv_mov_series (movimiento_id)');
    await db.query('create index if not exists inv_mov_series_serie on inv_mov_series (upper(serie))');
    // Metodologías: reposición (ROP), PCI PTS, antigüedad, PEPS físico, serialización con IMEI/TID, historial de fallas y conteo cíclico.
    for (const c of ['tiempo_entrega_dias integer not null default 0', 'tiempo_config_dias integer not null default 0', 'cobertura_dias integer not null default 30', 'max_dias_almacen integer', 'pci_pts_vence date', 'pci_pts_folio text']) await db.query(`alter table inv_articulos add column if not exists ${c}`);
    await db.query('alter table inv_movimientos add column if not exists fifo_excepcion boolean not null default false');
    await db.query(`create table if not exists inv_unidades (
      id bigserial primary key, articulo_id bigint not null references inv_articulos(id), serie text not null, imei text, tid text, notas text,
      actualizado_por text, actualizado_at timestamptz not null default now())`);
    await db.query('create unique index if not exists inv_unidades_serie on inv_unidades (articulo_id, upper(serie))');
    await db.query("create unique index if not exists inv_unidades_imei on inv_unidades (upper(imei)) where imei is not null and imei <> ''");
    await db.query("create unique index if not exists inv_unidades_tid on inv_unidades (upper(tid)) where tid is not null and tid <> ''");
    await db.query(`create table if not exists inv_unidad_eventos (
      id bigserial primary key, articulo_id bigint not null references inv_articulos(id), serie text not null, fecha date not null,
      tipo text not null check (tipo in ('falla','reparacion','garantia','reemplazo','configuracion','nota')), descripcion text not null,
      usuario text not null, creado_at timestamptz not null default now())`);
    await db.query('create index if not exists inv_unidad_eventos_serie on inv_unidad_eventos (articulo_id, upper(serie), fecha)');
    await db.query(`create table if not exists inv_conteos (
      id bigserial primary key, fecha date not null, estado text not null default 'abierto' check (estado in ('abierto','cerrado')), nota text,
      creado_por text not null, creado_at timestamptz not null default now(), cerrado_por text, cerrado_at timestamptz)`);
    await db.query(`create table if not exists inv_conteo_lineas (
      id bigserial primary key, conteo_id bigint not null references inv_conteos(id), articulo_id bigint not null references inv_articulos(id),
      clase text, contada numeric(14,4), series_contadas jsonb, esperada numeric(14,4), diferencia numeric(14,4), resultado jsonb,
      ajuste_movimiento_id bigint, ajuste_motivo text, unique (conteo_id, articulo_id))`);
  })().catch(e => { listo = null; throw e; });
  return listo;
}

const ART_SEL = "select a.*, to_char(a.pci_pts_vence, 'YYYY-MM-DD') as pci_vence from inv_articulos a";
const COLS_MOV = `m.id, m.articulo_id, m.tipo, m.concepto, to_char(m.fecha, 'YYYY-MM-DD') fecha, m.cantidad, m.costo_unitario, m.proveedor, m.documento, m.destino, m.notas,
                  m.empresa_id, m.empresa, m.unidad, m.usuario, m.creado_at, m.fifo_excepcion, m.anulado, m.anulado_por, m.anulado_motivo, m.anulado_at`;
const aMov = r => ({ ...r, id: Number(r.id), articulo_id: Number(r.articulo_id), cantidad: Number(r.cantidad), costo_unitario: num(r.costo_unitario), empresa_id: r.empresa_id == null ? null : Number(r.empresa_id) });

/* Movimientos vigentes (sin anulados), cada uno con sus series. */
async function movsVigentes(q, articuloId) {
  const r = articuloId != null
    ? await q(`select ${COLS_MOV} from inv_movimientos m where m.articulo_id = $1 and not m.anulado order by m.fecha, m.id`, [articuloId])
    : await q(`select ${COLS_MOV} from inv_movimientos m where not m.anulado order by m.fecha, m.id`);
  const movs = r.rows.map(aMov);
  const s = articuloId != null
    ? await q('select s.movimiento_id, s.serie from inv_mov_series s join inv_movimientos m on m.id = s.movimiento_id where m.articulo_id = $1 and not m.anulado order by s.id', [articuloId])
    : await q('select s.movimiento_id, s.serie from inv_mov_series s join inv_movimientos m on m.id = s.movimiento_id where not m.anulado order by s.id');
  const por = new Map();
  for (const x of s.rows) { const k = Number(x.movimiento_id); if (!por.has(k)) por.set(k, []); por.get(k).push(x.serie); }
  for (const m of movs) m.series = por.get(m.id) || [];
  return movs;
}
const porArticulo = movs => { const m = new Map(); for (const x of movs) { if (!m.has(x.articulo_id)) m.set(x.articulo_id, []); m.get(x.articulo_id).push(x); } return m; };

function resumenArticulo(a, kd, movsDe, mt) {
  const existencia = kd.existencia, minimo = Number(a.minimo) || 0;
  const r = { id: Number(a.id), sku: a.sku, nombre: a.nombre, categoria: a.categoria || '', unidad: a.unidad, minimo, activo: a.activo, notas: a.notas || '', serializado: !!a.serializado,
    existencia, valor: kd.valor, costo_promedio: existencia > 0 ? P.r4(kd.valor / existencia) : 0, costo_siguiente: kd.capas.length ? kd.capas[0].costo_unitario : null, capas: kd.capas.length,
    bajo_minimo: a.activo && minimo > 0 && existencia < minimo, ultimo_mov: movsDe.length ? movsDe[movsDe.length - 1].fecha : null, inconsistente: !!kd.error, movimientos: movsDe.length,
    tiempo_entrega_dias: Number(a.tiempo_entrega_dias) || 0, tiempo_config_dias: Number(a.tiempo_config_dias) || 0, cobertura_dias: Number(a.cobertura_dias) || 30,
    max_dias_almacen: a.max_dias_almacen == null ? null : Number(a.max_dias_almacen), pci_pts_vence: a.pci_vence || null, pci_pts_folio: a.pci_pts_folio || '' };
  if (a.serializado) {
    const e = SE.estadoSeries(movsDe);
    const v = [...e.series.values()];
    r.en_almacen = v.filter(x => x.estado === 'almacen').length; r.asignadas = v.filter(x => x.estado === 'asignada').length; r.bajas = v.filter(x => x.estado === 'baja').length;
    if (e.errores.length) r.inconsistente = true;
    if (mt) {                                                                                                  // rotación física: cuánto llevan en el almacén
      const ed = MET.antiguedad(v.filter(x => x.estado === 'almacen').map(x => ({ serie: x.serie, desde: x.desde })), mt.hoy);
      r.dias_max_almacen = ed.unidades.length ? Math.max(...ed.unidades.map(u => u.dias_almacen)) : 0;
      r.sobre_limite = r.max_dias_almacen ? ed.unidades.filter(u => u.dias_almacen > r.max_dias_almacen).length : 0;
    }
  }
  if (mt) {
    r.pci = MET.estadoPCI(a.pci_vence, mt.hoy);
    if (a.activo) {
      const c = mt.abc.get(r.id) || { clase: 'C', valor: 0 };
      const dem = mt.dem.get(r.id);
      r.clase = c.clase; r.valor_consumo = c.valor;
      r.reorden = MET.reorden(a, dem, existencia); r.demanda_90d = dem.total;
      r.ultimo_conteo = mt.conteo.get(r.id) || null;
      const frec = MET.FRECUENCIA_CONTEO[c.clase];
      r.frecuencia_conteo = frec; r.toca_conteo = !r.ultimo_conteo || MET.dias(r.ultimo_conteo, mt.hoy) >= frec;
    }
  }
  return r;
}

function montar(app, deps) {
  const { auth, requiereRol, bit, db, enviarXLSX } = deps;
  const base = '/api/inventario/admin';
  const escribe = requiereRol('admin', 'operador', 'inventario');
  const q = (t, p) => db.query(t, p || []);
  const listo503 = (req, res, next) => { if (!db.isReady()) return res.status(503).json({ error: 'db_no_lista' }); asegurar(db).then(() => next(), e => { console.error('[inventario-admin]', e); res.status(500).json({ error: 'No se pudo preparar el inventario administrativo.' }); }); };
  const seguro = fn => async (req, res) => { try { await fn(req, res); } catch (e) {
    if (e instanceof ErrorInv) return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.extra || {}), ...(e.plan ? resumenPlan(e.plan, '') : {}) });
    console.error('[inventario-admin]', e); res.status(500).json({ error: 'No se pudo completar. Intenta de nuevo.' }); } };

  /* ---- catálogo de clientes (Empresas = grupos de cliente; unidades ya usadas) ---- */
  async function catalogoClientes(qq) {
    let empresas = [];
    try {
      const g = (await qq('select id_grupo, nombre_cliente from grupos where activo order by upper(nombre_cliente)')).rows;
      empresas = g.map(x => ({ id: Number(x.id_grupo), nombre: x.nombre_cliente }));
    } catch (_e) { empresas = []; }
    const unidades = new Map();                                                   // «Empresa / Unidad» → origen
    try { for (const r of (await qq('select distinct empresa, unidad from inv_movimientos where empresa is not null and unidad is not null')).rows) unidades.set(`${r.empresa} / ${r.unidad}`, r.empresa); } catch (_e) { /* sin movimientos */ }
    const porEmpresa = {};
    try { for (const r of (await qq("select cliente, comercio from transacciones where comercio is not null and comercio <> '' group by cliente, comercio order by cliente, comercio limit 20000")).rows) { (porEmpresa[nrm(r.cliente)] = porEmpresa[nrm(r.cliente)] || new Set()).add(r.comercio); } } catch (_e) { /* sin transacciones */ }
    for (const e of empresas) { const s = new Set([...(porEmpresa[nrm(e.nombre)] || [])]); for (const k of unidades.keys()) if (k.startsWith(e.nombre + ' / ')) s.add(k.slice(e.nombre.length + 3)); e.unidades = [...s].sort(); }
    return { empresas, unidadesConocidas: new Set(unidades.keys()) };
  }
  async function resolverEmpresa(qq, id, nombre) {
    const cat = (await catalogoClientes(qq)).empresas;
    if (!cat.length) return { id: null, nombre: String(nombre || '').trim() };                  // sin catálogo (solo pruebas): se acepta el texto
    const e = cat.find(x => (id != null && id !== '' && x.id === Number(id))) || cat.find(x => nrm(x.nombre) === nrm(nombre));
    if (!e) throw new ErrorInv(422, 'empresa', 'La Empresa no existe en el catálogo de Empresas (Grupos de cliente).');
    return { id: e.id, nombre: e.nombre };
  }

  /* Artículos con sus indicadores: ABC (consumo valuado de 12 meses), demanda (90 días), punto de reorden, PCI PTS, antigüedad y último conteo. */
  async function analisis() {
    const arts = (await q(ART_SEL + ' order by upper(a.nombre)')).rows;
    const mapa = porArticulo(await movsVigentes(q));
    const hoy = P.hoyMX(), desde12 = MET.sumaDias(hoy, -364);
    const kds = new Map(), dem = new Map(), consumo = new Map();
    for (const a of arts) {
      const id = Number(a.id), kd = P.kardex(mapa.get(id) || []);
      const sal = kd.filas.filter(f => f.tipo === 'salida');
      kds.set(id, kd); dem.set(id, MET.demanda(sal, hoy));
      consumo.set(id, P.r2(sal.filter(f => MET.CONCEPTOS_CONSUMO.includes(f.concepto) && f.fecha >= desde12 && f.fecha <= hoy).reduce((t, f) => t + f.costo_total, 0)));
    }
    const activos = arts.filter(a => a.activo);
    const hayConsumo = activos.some(a => consumo.get(Number(a.id)) > 0);
    const abc = MET.claseABC(activos.map(a => ({ id: Number(a.id), valor: hayConsumo ? consumo.get(Number(a.id)) : kds.get(Number(a.id)).valor })));
    const conteo = new Map();
    try { for (const r of (await q("select l.articulo_id, to_char(max(c.fecha), 'YYYY-MM-DD') f from inv_conteo_lineas l join inv_conteos c on c.id = l.conteo_id where c.estado = 'cerrado' and l.contada is not null group by l.articulo_id")).rows) conteo.set(Number(r.articulo_id), r.f); } catch (_e) { /* sin conteos */ }
    const mt = { hoy, abc, dem, conteo };
    const lista = arts.map(a => { const ms = mapa.get(Number(a.id)) || []; return resumenArticulo(a, kds.get(Number(a.id)), ms, mt); });
    return { lista, arts, mapa, hoy };
  }
  const listaArticulos = async () => (await analisis()).lista;

  app.get(base + '/clientes', auth, listo503, seguro(async (_req, res) => { const c = await catalogoClientes(q); res.json({ empresas: c.empresas }); }));

  app.get(base + '/resumen', auth, listo503, seguro(async (_req, res) => {
    const l = await listaArticulos();
    const mes = P.hoyMX().slice(0, 7);
    const movs = (await q(`select tipo, cantidad, costo_unitario from inv_movimientos where not anulado and to_char(fecha, 'YYYY-MM') = $1`, [mes])).rows;
    const ser = l.filter(a => a.serializado);
    res.json({ articulos: l.filter(a => a.activo).length, valor_total: P.r2(l.reduce((s, a) => s + a.valor, 0)), bajo_minimo: l.filter(a => a.bajo_minimo).map(a => ({ id: a.id, sku: a.sku, nombre: a.nombre, existencia: a.existencia, minimo: a.minimo, unidad: a.unidad })),
      entradas_mes: movs.filter(m => m.tipo === 'entrada').length, salidas_mes: movs.filter(m => m.tipo === 'salida').length, inconsistentes: l.filter(a => a.inconsistente).length,
      series_almacen: ser.reduce((s, a) => s + (a.en_almacen || 0), 0), series_asignadas: ser.reduce((s, a) => s + (a.asignadas || 0), 0) });
  }));

  app.get(base + '/articulos', auth, listo503, seguro(async (_req, res) => {
    const l = await listaArticulos();
    res.json({ articulos: l, categorias: [...new Set(l.map(a => a.categoria).filter(Boolean))].sort(), conceptos: { entrada: P.CONCEPTOS_ENTRADA, salida: P.CONCEPTOS_SALIDA } });
  }));

  app.post(base + '/articulos', auth, escribe, listo503, seguro(async (req, res) => {
    const b = req.body || {};
    const sku = String(b.sku || '').trim().toUpperCase(), nombre = String(b.nombre || '').trim(), unidad = String(b.unidad || 'pieza').trim().toLowerCase();
    const categoria = String(b.categoria || '').trim(), notas = String(b.notas || '').trim(), minimo = Number(b.minimo || 0), serializado = b.serializado === true;
    if (!/^[A-Z0-9][A-Z0-9._\-]{0,29}$/.test(sku)) throw new ErrorInv(400, 'sku', 'El SN lleva letras, números, punto o guion (máximo 30).');
    if (!nombre || nombre.length > 140) throw new ErrorInv(400, 'nombre', 'Escribe el nombre del artículo (máximo 140 caracteres).');
    if (!unidad || unidad.length > 20) throw new ErrorInv(400, 'unidad', 'Escribe la unidad (pieza, caja, paquete…).');
    if (!Number.isFinite(minimo) || minimo < 0 || minimo > 1e9) throw new ErrorInv(400, 'minimo', 'El mínimo debe ser un número mayor o igual a cero.');
    if (categoria.length > 60 || notas.length > 400) throw new ErrorInv(400, 'texto', 'La categoría o las notas son demasiado largas.');
    const usuario = req.user.email || req.user.nombre || '—';
    const entero = (v, def, campo, et, max) => { if (v === undefined) return def; const n = Number(v); if (v === '' || v === null) return def === null ? null : 0; if (!Number.isInteger(n) || n < 0 || n > max) throw new ErrorInv(400, campo, `${et} debe ser un número entero de días (0 a ${max}).`); return n; };
    const pciVence = b.pci_pts_vence === undefined ? undefined : (b.pci_pts_vence ? String(b.pci_pts_vence) : null);
    if (pciVence && !P.esFecha(pciVence)) throw new ErrorInv(400, 'pci_pts_vence', 'La vigencia PCI PTS debe ser una fecha válida.');
    const pciFolio = b.pci_pts_folio === undefined ? undefined : String(b.pci_pts_folio || '').trim();
    if (pciFolio && pciFolio.length > 60) throw new ErrorInv(400, 'pci_pts_folio', 'El folio PCI PTS es demasiado largo (máximo 60).');
    if (b.id) {
      const id = Number(b.id);
      const ex = (await q('select * from inv_articulos where id = $1', [id])).rows[0];
      if (!ex) throw new ErrorInv(404, 'no_existe', 'Ese artículo no existe.');
      const te = entero(b.tiempo_entrega_dias, ex.tiempo_entrega_dias, 'tiempo_entrega_dias', 'El tiempo de entrega del proveedor', 365), tc = entero(b.tiempo_config_dias, ex.tiempo_config_dias, 'tiempo_config_dias', 'El tiempo de configuración', 365);
      const cob = entero(b.cobertura_dias, ex.cobertura_dias, 'cobertura_dias', 'La cobertura', 365), mx = b.max_dias_almacen === undefined ? ex.max_dias_almacen : entero(b.max_dias_almacen, null, 'max_dias_almacen', 'El máximo en almacén', 3650);
      await q('update inv_articulos set tiempo_entrega_dias=$2, tiempo_config_dias=$3, cobertura_dias=$4, max_dias_almacen=$5, pci_pts_vence=$6, pci_pts_folio=$7 where id=$1',
        [id, te, tc, cob || 30, mx || null, pciVence === undefined ? ex.pci_pts_vence : pciVence, pciFolio === undefined ? ex.pci_pts_folio : (pciFolio || null)]);
      if (b.serializado !== undefined && serializado !== ex.serializado && Number((await q('select count(*)::int n from inv_movimientos where articulo_id = $1', [id])).rows[0].n)) throw new ErrorInv(409, 'serializado', 'El artículo ya tiene movimientos: no se puede cambiar si es serializado.');
      const dup = (await q('select id from inv_articulos where upper(sku) = $1 and id <> $2', [sku, id])).rows[0];
      if (dup) throw new ErrorInv(409, 'sku_repetido', 'Ya hay otro artículo con ese código.');
      await q('update inv_articulos set sku=$2, nombre=$3, categoria=$4, unidad=$5, minimo=$6, notas=$7, activo=$8, serializado=$9 where id=$1', [id, sku, nombre, categoria || null, unidad, minimo, notas || null, b.activo === false ? false : true, b.serializado === undefined ? ex.serializado : serializado]);
      await bit(req, 'inv_articulo_editar', `${sku} · ${nombre} · mínimo ${minimo}${b.activo === false ? ' · desactivado' : ''}`, { resource_type: 'inventario_admin', resource_id: id });
      return res.json({ ok: true, id });
    }
    const dup = (await q('select id from inv_articulos where upper(sku) = $1', [sku])).rows[0];
    if (dup) throw new ErrorInv(409, 'sku_repetido', 'Ya hay un artículo con ese código.');
    const r = await q('insert into inv_articulos (sku, nombre, categoria, unidad, minimo, notas, serializado, creado_por, tiempo_entrega_dias, tiempo_config_dias, cobertura_dias, max_dias_almacen, pci_pts_vence, pci_pts_folio) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id',
      [sku, nombre, categoria || null, unidad, minimo, notas || null, serializado, usuario, entero(b.tiempo_entrega_dias, 0, 'tiempo_entrega_dias', 'El tiempo de entrega del proveedor', 365), entero(b.tiempo_config_dias, 0, 'tiempo_config_dias', 'El tiempo de configuración', 365),
        entero(b.cobertura_dias, 30, 'cobertura_dias', 'La cobertura', 365) || 30, b.max_dias_almacen === undefined ? null : (entero(b.max_dias_almacen, null, 'max_dias_almacen', 'El máximo en almacén', 3650) || null), pciVence || null, pciFolio || null]);
    await bit(req, 'inv_articulo_alta', `${sku} · ${nombre} · ${unidad}${serializado ? ' · serializado' : ''}`, { resource_type: 'inventario_admin', resource_id: r.rows[0].id });
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  app.get(base + '/articulos/:id/kardex', auth, listo503, seguro(async (req, res) => {
    const id = Number(req.params.id);
    const a = (await q(ART_SEL + ' where a.id = $1', [id])).rows[0];
    if (!a) throw new ErrorInv(404, 'no_existe', 'Ese artículo no existe.');
    const ms = await movsVigentes(q, id);
    const kd = P.kardex(ms);
    const anul = (await q(`select ${COLS_MOV} from inv_movimientos m where m.articulo_id = $1 and m.anulado order by m.fecha, m.id`, [id])).rows.map(aMov);
    const hoy = P.hoyMX();
    const out = { articulo: (await listaArticulos()).find(x => x.id === id) || resumenArticulo(a, kd, ms), filas: kd.filas, capas: kd.capas, anulados: anul, error: kd.error };
    if (a.serializado) {
      const ids = new Map((await q('select upper(serie) s, imei, tid from inv_unidades where articulo_id = $1', [id])).rows.map(x => [x.s, x]));
      const maxd = a.max_dias_almacen == null ? null : Number(a.max_dias_almacen);
      out.series = [...SE.estadoSeries(ms).series.values()].map(x => { const u = ids.get(x.serie) || {}; const d = x.estado === 'almacen' ? Math.max(0, MET.dias(x.desde, hoy)) : null; return { ...x, imei: u.imei || '', tid: u.tid || '', dias_almacen: d, sobre_limite: d != null && maxd ? d > maxd : false }; })
        .sort((x, y) => (x.estado === y.estado ? (x.estado === 'almacen' ? y.dias_almacen - x.dias_almacen : x.serie.localeCompare(y.serie)) : x.estado.localeCompare(y.estado)));
    }
    res.json(out);
  }));

  app.get(base + '/movimientos', auth, listo503, seguro(async (req, res) => {
    const f = req.query, cond = ['true'], par = [];
    if (f.articulo_id) { par.push(Number(f.articulo_id)); cond.push(`m.articulo_id = $${par.length}`); }
    if (f.tipo === 'entrada' || f.tipo === 'salida') { par.push(f.tipo); cond.push(`m.tipo = $${par.length}`); }
    if (P.esFecha(String(f.desde || ''))) { par.push(f.desde); cond.push(`m.fecha >= $${par.length}::date`); }
    if (P.esFecha(String(f.hasta || ''))) { par.push(f.hasta); cond.push(`m.fecha <= $${par.length}::date`); }
    if (f.anulados !== '1') cond.push('not m.anulado');
    const lim = Math.min(500, Math.max(1, parseInt(f.limite, 10) || 100));
    const filas = (await q(`select ${COLS_MOV}, a.sku, a.nombre, a.unidad as unidad_medida, a.serializado from inv_movimientos m join inv_articulos a on a.id = m.articulo_id where ${cond.join(' and ')} order by m.fecha desc, m.id desc limit ${lim}`, par)).rows.map(r => ({ ...aMov(r), sku: r.sku, nombre: r.nombre, unidad_medida: r.unidad_medida, serializado: r.serializado }));
    const costos = new Map();
    for (const idA of new Set(filas.map(x => x.articulo_id))) for (const k of P.kardex(await movsVigentes(q, idA)).filas) costos.set(k.id, k);
    const ids = filas.map(x => x.id);
    const sr = ids.length ? (await q('select movimiento_id, count(*)::int n from inv_mov_series where movimiento_id = any($1::bigint[]) group by movimiento_id', [ids])).rows : [];
    const nSeries = new Map(sr.map(r => [Number(r.movimiento_id), r.n]));
    res.json({ movimientos: filas.map(x => { const k = costos.get(x.id); return { ...x, unidad: x.unidad_medida, unidad_cliente: x.unidad, costo_total: k ? k.costo_total : null, costo_unitario: k ? k.costo_unitario : x.costo_unitario, n_series: nSeries.get(x.id) || 0 }; }) });
  }));

  /* ---- alta de un movimiento (la usan el formulario y el cierre de conteos) ---- */
  async function registrarMovimiento(tq, b, usuario) {
    const articuloId = Number(b.articulo_id);
    const crudo = b.unidades != null ? b.unidades : b.series;
    const unidades = SE.parseUnidades(Array.isArray(crudo) ? crudo : String(crudo || ''));
    const series = unidades.map(u => u.serie);
    await tq('select pg_advisory_xact_lock($1::bigint)', [KEY + (Number.isFinite(articuloId) ? articuloId : 0)]);
    const a = (await tq(ART_SEL + ' where a.id = $1', [articuloId])).rows[0];
    if (!a) throw new ErrorInv(404, 'no_existe', 'Ese artículo no existe.');
    if (!a.activo) throw new ErrorInv(409, 'inactivo', 'Ese artículo está desactivado: actívalo para registrar movimientos.');
    const esEntrega = b.tipo === 'salida' && b.concepto === 'entrega';
    let empresa = { id: null, nombre: '' };
    if (esEntrega) {
      if (!String(b.empresa || '').trim() && (b.empresa_id == null || b.empresa_id === '')) throw new ErrorInv(422, 'empresa', 'Una entrega lleva la Empresa y la Unidad del cliente a la que se asigna.');
      empresa = await resolverEmpresa(tq, b.empresa_id, b.empresa);
    }
    const mov = { tipo: b.tipo, concepto: b.concepto, fecha: String(b.fecha || ''), cantidad: Number(b.cantidad), costo_unitario: b.tipo === 'entrada' ? b.costo_unitario : undefined,
      proveedor: String(b.proveedor || '').trim(), documento: String(b.documento || '').trim(), destino: String(b.destino || '').trim(), empresa: empresa.nombre, unidad: esEntrega ? String(b.unidad || '').trim() : '', notas: String(b.notas || '').trim() };
    if (a.serializado) {
      if (!series.length) throw new ErrorInv(422, 'series', 'Este artículo es serializado: captura los equipos (uno por línea: SN, IMEI y TID).');
      for (const u of unidades) { const e = SE.validarIdentificadores(u); if (e) throw new ErrorInv(422, 'series', e); }
      for (const [campo, et] of [['imei', 'IMEI'], ['tid', 'TID']]) { const v = unidades.map(u => u[campo]).filter(Boolean); const rep = v.find((x, i) => v.indexOf(x) !== i); if (rep) throw new ErrorInv(422, campo, `El ${et} ${rep} viene repetido en la captura.`); }
      mov.cantidad = series.length;
    } else if (series.length) throw new ErrorInv(422, 'series', 'Este artículo no es serializado: quita los números de serie.');
    const errs = P.validarMovimiento(mov);
    if (errs.length) throw new ErrorInv(422, 'validacion', errs[0]);
    const previos = await movsVigentes(tq, articuloId);
    const nuevo = { ...mov, id: Number.MAX_SAFE_INTEGER, articulo_id: articuloId, empresa_id: empresa.id, series };
    const sim = P.kardex([...previos, nuevo]);
    if (sim.error) {
      const e = sim.error, propio = e.folio === Number.MAX_SAFE_INTEGER;
      throw new ErrorInv(409, 'insuficiente', propio ? `No hay existencia suficiente de «${a.nombre}» al ${fF(mov.fecha)}: faltan ${e.faltante} ${a.unidad} (hay ${e.disponible}).`
        : `Esta captura dejaría sin existencia una salida ya registrada (folio ${e.folio}, ${fF(e.fecha)}): faltarían ${e.faltante} ${a.unidad}.`);
    }
    const avisos = [];
    let fifoExcepcion = false;
    if (a.serializado) {
      const er = SE.estadoSeries([...previos, nuevo]).errores[0]; if (er) throw new ErrorInv(409, 'series', er.mensaje + (er.folio === Number.MAX_SAFE_INTEGER ? '' : ` (afecta al folio ${er.folio})`));
      // Identificadores: el IMEI y el TID no se repiten entre equipos.
      const ex = (await tq('select serie, imei, tid from inv_unidades where articulo_id = $1 and upper(serie) = any($2::text[])', [articuloId, series])).rows;
      const exPor = new Map(ex.map(x => [String(x.serie).toUpperCase(), x]));
      for (const u of unidades) {
        const e = exPor.get(u.serie);
        if (u.imei && e && e.imei && e.imei.toUpperCase() !== u.imei) throw new ErrorInv(409, 'imei', `La serie ${u.serie} ya tiene el IMEI ${e.imei}: el IMEI no cambia.`);
        for (const [campo, et] of [['imei', 'IMEI'], ['tid', 'TID']]) {
          if (!u[campo]) continue;
          const otra = (await tq(`select serie from inv_unidades where upper(${campo}) = $1 and not (articulo_id = $2 and upper(serie) = $3) limit 1`, [u[campo], articuloId, u.serie])).rows[0];
          if (otra) throw new ErrorInv(409, campo, `El ${et} ${u[campo]} ya está en el equipo ${otra.serie}.`);
        }
      }
      if (esEntrega) {
        const pci = MET.estadoPCI(a.pci_vence, mov.fecha);
        if (pci && pci.estado === 'vencida') throw new ErrorInv(409, 'pci_vencida', `La certificación PCI PTS de «${a.nombre}» venció el ${fF(a.pci_vence)}: no se pueden entregar equipos sin certificación vigente. Actualiza la vigencia en el artículo cuando se renueve.`);
        if (pci && pci.estado === 'por_vencer') avisos.push(`La certificación PCI PTS de «${a.nombre}» vence el ${fF(a.pci_vence)} (en ${pci.dias} días).`);
        // PEPS físico: salen primero los equipos que llevan más tiempo en el almacén.
        const alDia = SE.estadoSeries(previos.filter(m => m.fecha <= mov.fecha)).series;
        const disponibles = [...alDia.values()].filter(x => x.estado === 'almacen').map(x => ({ serie: x.serie, desde: x.desde }));
        const fifo = MET.verificarFIFO(disponibles, series);
        if (!fifo.ok) {
          const just = String(b.fifo_justificacion || '').trim();
          if (just.length < 10) throw new ErrorInv(409, 'fifo', `PEPS físico: ${fifo.infracciones.length === 1 ? 'el equipo ' + fifo.infracciones[0].serie + ' es más nuevo' : fifo.infracciones.length + ' equipos son más nuevos'} que otros que siguen en almacén (por ejemplo ${fifo.infracciones[0].mas_viejas[0].serie}, desde ${fF(fifo.infracciones[0].mas_viejas[0].desde)}). Entrega primero los más antiguos o justifica la excepción.`,
            { infracciones: fifo.infracciones.slice(0, 20), sugeridas: MET.sugeridasFIFO(disponibles, series.length) });
          fifoExcepcion = true; mov.notas = `[Excepción PEPS físico] ${just}${mov.notas ? ' · ' + mov.notas : ''}`.slice(0, 400);
        }
      }
    }
    const destino = mov.empresa ? `${mov.empresa} / ${mov.unidad}` : mov.destino;
    const ins = await tq(`insert into inv_movimientos (articulo_id, tipo, concepto, fecha, cantidad, costo_unitario, proveedor, documento, destino, notas, empresa_id, empresa, unidad, usuario, fifo_excepcion)
                          values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [articuloId, mov.tipo, mov.concepto, mov.fecha, mov.cantidad, mov.tipo === 'entrada' ? Number(mov.costo_unitario) : null, mov.proveedor || null, mov.documento || null, destino || null, mov.notas || null, empresa.id, mov.empresa || null, mov.unidad || null, usuario, fifoExcepcion]);
    const id = Number(ins.rows[0].id);
    for (const u of unidades) {
      await tq('insert into inv_mov_series (movimiento_id, serie) values ($1, $2)', [id, u.serie]);
      if (a.serializado && (u.imei || u.tid || mov.tipo === 'entrada')) await tq(`insert into inv_unidades (articulo_id, serie, imei, tid, actualizado_por) values ($1,$2,$3,$4,$5)
        on conflict (articulo_id, upper(serie)) do update set imei = coalesce(nullif(excluded.imei, ''), inv_unidades.imei), tid = coalesce(nullif(excluded.tid, ''), inv_unidades.tid), actualizado_por = $5, actualizado_at = now()`, [articuloId, u.serie, u.imei || null, u.tid || null, usuario]);
    }
    const fila = P.kardex(await movsVigentes(tq, articuloId)).filas.find(f => f.id === id);
    return { id, articulo: a, fila, mov, series, unidades, avisos, fifoExcepcion };
  }

  app.post(base + '/movimientos', auth, escribe, listo503, seguro(async (req, res) => {
    const usuario = req.user.email || req.user.nombre || '—';
    const out = await db.tx(t => registrarMovimiento((s, p) => t.query(s, p || []), req.body || {}, usuario));
    const { mov } = out;
    await bit(req, mov.tipo === 'entrada' ? 'inv_entrada' : 'inv_salida', `${out.articulo.sku} · ${P.CONCEPTOS_ENTRADA[mov.concepto] || P.CONCEPTOS_SALIDA[mov.concepto]} · ${mov.cantidad} ${out.articulo.unidad}${mov.tipo === 'entrada' ? ' a ' + mxn(mov.costo_unitario) : ' (costo PEPS ' + mxn(out.fila && out.fila.costo_total) + ')'}${mov.empresa ? ' · ' + mov.empresa + ' / ' + mov.unidad : ''}${out.series.length ? ' · series ' + out.series.slice(0, 5).join(', ') + (out.series.length > 5 ? '…' : '') : ''}${out.fifoExcepcion ? ' · EXCEPCIÓN PEPS físico' : ''} · ${mov.fecha}`, { resource_type: 'inventario_admin', resource_id: out.id });
    res.json({ ok: true, id: out.id, avisos: out.avisos, fifo_excepcion: out.fifoExcepcion, costo_total: out.fila ? out.fila.costo_total : null, costo_unitario: out.fila ? out.fila.costo_unitario : null, saldo_cantidad: out.fila ? out.fila.saldo_cantidad : null, saldo_valor: out.fila ? out.fila.saldo_valor : null, consumos: out.fila ? out.fila.consumos : [] });
  }));

  app.post(base + '/movimientos/:id/anular', auth, escribe, listo503, seguro(async (req, res) => {
    const id = Number(req.params.id), motivo = String((req.body && req.body.motivo) || '').trim();
    if (motivo.length < 10) throw new ErrorInv(400, 'motivo', 'Escribe el motivo de la anulación (al menos 10 caracteres): queda en la bitácora.');
    const usuario = req.user.email || req.user.nombre || '—';
    const m0 = (await q('select m.articulo_id, a.serializado from inv_movimientos m join inv_articulos a on a.id = m.articulo_id where m.id = $1', [id])).rows[0];
    if (!m0) throw new ErrorInv(404, 'no_existe', 'Ese movimiento no existe.');
    const articuloId = Number(m0.articulo_id);
    await db.tx(async t => {
      const tq = (s, p) => t.query(s, p || []);
      await tq('select pg_advisory_xact_lock($1::bigint)', [KEY + articuloId]);
      const m = (await tq('select anulado from inv_movimientos where id = $1', [id])).rows[0];
      if (m.anulado) throw new ErrorInv(409, 'ya_anulado', 'Ese movimiento ya estaba anulado.');
      const vigentes = await movsVigentes(tq, articuloId);
      const sin = vigentes.filter(x => x.id !== id);
      const sim = P.kardex(sin);
      if (sim.error) throw new ErrorInv(409, 'dejaria_sin_existencia', `No se puede anular: dejaría sin existencia la salida del ${fF(sim.error.fecha)} (folio ${sim.error.folio}): faltarían ${sim.error.faltante}. Anula primero esa salida.`);
      if (m0.serializado) { const er = SE.estadoSeries(sin).errores[0]; if (er) throw new ErrorInv(409, 'series', `No se puede anular: ${er.mensaje} (folio ${er.folio}). Anula primero ese movimiento.`); }
      await tq('update inv_movimientos set anulado = true, anulado_por = $2, anulado_motivo = $3, anulado_at = now() where id = $1', [id, usuario, motivo]);
    });
    await bit(req, 'inv_anular', `movimiento ${id} anulado: ${motivo.slice(0, 160)}`, { resource_type: 'inventario_admin', resource_id: id });
    res.json({ ok: true });
  }));

  /* ---- series (terminales): a qué Empresa y Unidad está asignada cada una, cruzado con lo que realmente transacciona ---- */
  async function listaSeries(f) {
    const arts = (await q(ART_SEL + ' where a.serializado order by upper(a.nombre)')).rows;
    const mapa = porArticulo(await movsVigentes(q));
    let filas = [];
    const hoy = P.hoyMX();
    const ids = new Map((await q('select articulo_id, upper(serie) s, imei, tid from inv_unidades')).rows.map(x => [`${x.articulo_id}|${x.s}`, x]));
    const fallas = new Map((await q("select articulo_id, upper(serie) s, count(*)::int n from inv_unidad_eventos where tipo = 'falla' group by articulo_id, upper(serie)")).rows.map(x => [`${x.articulo_id}|${x.s}`, x.n]));
    for (const a of arts) {
      if (f.articulo_id && Number(f.articulo_id) !== Number(a.id)) continue;
      const maxd = a.max_dias_almacen == null ? null : Number(a.max_dias_almacen);
      for (const s of SE.estadoSeries(mapa.get(Number(a.id)) || []).series.values()) {
        const k = `${a.id}|${s.serie}`, u = ids.get(k) || {}, d = s.estado === 'almacen' ? Math.max(0, MET.dias(s.desde, hoy)) : null;
        filas.push({ ...s, articulo_id: Number(a.id), sku: a.sku, articulo: a.nombre, imei: u.imei || '', tid: u.tid || '', fallas: fallas.get(k) || 0, dias_almacen: d, sobre_limite: d != null && maxd ? d > maxd : false });
      }
    }
    if (f.estado) filas = filas.filter(s => s.estado === f.estado);
    if (f.empresa) filas = filas.filter(s => nrm(s.empresa).includes(nrm(f.empresa)));
    if (f.q) filas = filas.filter(s => (s.serie + ' ' + s.imei + ' ' + s.tid + ' ' + s.unidad + ' ' + s.empresa).toLowerCase().includes(String(f.q).toLowerCase()));
    if (f.con_fallas === '1') filas = filas.filter(s => s.fallas > 0);
    if (f.sobre_limite === '1') filas = filas.filter(s => s.sobre_limite);
    filas = filas.slice(0, 5000);
    // Cruce con las transacciones: ¿esa terminal ha transaccionado y para qué cliente?
    const series = filas.filter(s => s.estado === 'asignada').map(s => s.serie);
    const uso = new Map();
    if (series.length) {
      try {
        const r = (await q(`select upper(trim(terminal)) t, cliente, count(*)::int n, max(fecha) ultima from transacciones where upper(trim(terminal)) = any($1::text[]) group by upper(trim(terminal)), cliente order by max(fecha) desc`, [series])).rows;
        for (const x of r) if (!uso.has(x.t)) uso.set(x.t, { cliente: x.cliente, ultima: x.ultima, n: x.n });
      } catch (_e) { /* sin transacciones */ }
    }
    return filas.map(s => { const u = uso.get(s.serie) || null; return { ...s, uso: u, alerta: s.estado === 'asignada' ? (u ? (nrm(u.cliente) !== nrm(s.empresa) ? 'otra_empresa' : null) : 'sin_uso') : null }; });
  }
  app.get(base + '/series', auth, listo503, seguro(async (req, res) => {
    const filas = await listaSeries(req.query || {});
    res.json({ series: filas, resumen: { almacen: filas.filter(s => s.estado === 'almacen').length, asignada: filas.filter(s => s.estado === 'asignada').length, baja: filas.filter(s => s.estado === 'baja').length, otra_empresa: filas.filter(s => s.alerta === 'otra_empresa').length, sin_uso: filas.filter(s => s.alerta === 'sin_uso').length, con_fallas: filas.filter(s => s.fallas > 0).length, sobre_limite: filas.filter(s => s.sobre_limite).length } });
  }));
  app.get(base + '/series.xlsx', auth, listo503, seguro(async (req, res) => {
    const filas = await listaSeries(req.query || {});
    const head = ['Serie (S/N)', 'IMEI', 'TID', 'Artículo', 'SN', 'Estado', 'Empresa', 'Unidad', 'Desde', 'Días en almacén', 'Folio', 'Fallas', 'Última transacción', 'Cliente en transacciones', 'Transacciones', 'Alerta'];
    const est = { almacen: 'En almacén', asignada: 'Asignada', baja: 'Baja' }, al = { otra_empresa: 'Transacciona para otra Empresa', sin_uso: 'Asignada sin transacciones' };
    const buf = X.buildXLSX([{ name: 'TERMINALES', aoa: [head, ...filas.map(s => [s.serie, s.imei, s.tid, s.articulo, s.sku, est[s.estado], s.empresa, s.unidad, s.desde, s.dias_almacen == null ? '' : s.dias_almacen, s.folio, s.fallas || '', s.uso ? s.uso.ultima : '', s.uso ? s.uso.cliente : '', s.uso ? s.uso.n : '', al[s.alerta] || ''])], cols: [{ wch: 22 }, { wch: 18 }, { wch: 14 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 30 }, { wch: 26 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 30 }, { wch: 12 }, { wch: 30 }] }]);
    enviarXLSX(res, `terminales_asignadas_${P.hoyMX()}.xlsx`, buf);
  }));

  app.get(base + '/existencias.xlsx', auth, listo503, seguro(async (_req, res) => {
    const l = await listaArticulos();
    const head = ['SN', 'Artículo', 'Categoría', 'Unidad', 'Serializado', 'Existencia', 'Costo siguiente (PEPS)', 'Costo promedio', 'Valor PEPS', 'Mínimo', 'Bajo mínimo', 'En almacén (series)', 'Asignadas (series)'];
    const rows = l.map(a => [a.sku, a.nombre, a.categoria, a.unidad, a.serializado ? 'Sí' : '', a.existencia, a.costo_siguiente, a.costo_promedio, a.valor, a.minimo, a.bajo_minimo ? 'Sí' : '', a.serializado ? a.en_almacen : '', a.serializado ? a.asignadas : '']);
    const total = ['', 'TOTAL', '', '', '', '', '', '', P.r2(l.reduce((s, a) => s + a.valor, 0)), '', '', '', ''];
    const buf = X.buildXLSX([{ name: 'EXISTENCIAS', aoa: [head, ...rows, total], cols: [{ wch: 14 }, { wch: 34 }, { wch: 18 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 16 }] }]);
    enviarXLSX(res, `existencias_peps_${P.hoyMX()}.xlsx`, buf);
  }));

  app.get(base + '/kardex.xlsx', auth, listo503, seguro(async (req, res) => {
    const arts = req.query.articulo_id ? (await q(ART_SEL + ' where a.id = $1', [Number(req.query.articulo_id)])).rows : (await q(ART_SEL + ' order by upper(a.nombre)')).rows;
    const mapa = porArticulo(await movsVigentes(q));
    const head = ['SN', 'Artículo', 'Fecha', 'Folio', 'Tipo', 'Concepto', 'Cantidad', 'Costo unitario', 'Costo total', 'Documento', 'Proveedor', 'Empresa', 'Unidad', 'Series', 'Saldo cantidad', 'Saldo valor PEPS', 'Capturó'];
    const rows = [];
    for (const a of arts) for (const f of P.kardex(mapa.get(Number(a.id)) || []).filas) rows.push([a.sku, a.nombre, f.fecha, f.id, f.tipo === 'entrada' ? 'Entrada' : 'Salida', (P.CONCEPTOS_ENTRADA[f.concepto] || P.CONCEPTOS_SALIDA[f.concepto] || f.concepto), f.cantidad, f.costo_unitario, f.costo_total, f.documento || '', f.proveedor || '', f.empresa || '', f.unidad || '', (f.series || []).join(', '), f.saldo_cantidad, f.saldo_valor, f.usuario]);
    const buf = X.buildXLSX([{ name: 'KARDEX PEPS', aoa: [head, ...rows], cols: [{ wch: 14 }, { wch: 30 }, { wch: 12 }, { wch: 8 }, { wch: 9 }, { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 28 }, { wch: 22 }, { wch: 30 }, { wch: 12 }, { wch: 16 }, { wch: 26 }] }]);
    enviarXLSX(res, `kardex_peps${arts.length === 1 ? '_' + arts[0].sku : ''}_${P.hoyMX()}.xlsx`, buf);
  }));


  /* ============ Serialización unitaria: ficha del equipo (S/N · IMEI · TID), historial de fallas ============ */
  const TIPOS_EVENTO = { falla: 'Falla', reparacion: 'Reparación', garantia: 'Garantía', reemplazo: 'Reemplazo', configuracion: 'Configuración', nota: 'Nota' };
  async function estadoDeSerie(qq, articuloId, serie) {
    const a = (await qq(ART_SEL + ' where a.id = $1', [articuloId])).rows[0];
    if (!a || !a.serializado) throw new ErrorInv(404, 'no_existe', 'Ese artículo no existe o no es serializado.');
    const s = SE.estadoSeries(await movsVigentes(qq, articuloId)).series.get(SE.normSerie(serie));
    if (!s) throw new ErrorInv(404, 'no_existe', 'Esa serie no existe en el inventario.');
    return { a, s };
  }
  app.get(base + '/unidades/:articuloId/:serie', auth, listo503, seguro(async (req, res) => {
    const articuloId = Number(req.params.articuloId), serie = SE.normSerie(req.params.serie);
    const { a, s } = await estadoDeSerie(q, articuloId, serie);
    const u = (await q('select imei, tid, notas from inv_unidades where articulo_id = $1 and upper(serie) = $2', [articuloId, serie])).rows[0] || {};
    const eventos = (await q("select id, to_char(fecha, 'YYYY-MM-DD') fecha, tipo, descripcion, usuario, creado_at from inv_unidad_eventos where articulo_id = $1 and upper(serie) = $2 order by fecha desc, id desc", [articuloId, serie])).rows.map(e => ({ ...e, id: Number(e.id), tipo_txt: TIPOS_EVENTO[e.tipo] }));
    let uso = null;
    try { const r = (await q('select cliente, comercio, count(*)::int n, max(fecha) ultima from transacciones where upper(trim(terminal)) = $1 group by cliente, comercio order by max(fecha) desc limit 1', [serie])).rows[0]; if (r) uso = { cliente: r.cliente, comercio: r.comercio, n: r.n, ultima: r.ultima }; } catch (_e) { /* sin transacciones */ }
    const hoy = P.hoyMX();
    res.json({ articulo: { id: Number(a.id), sku: a.sku, nombre: a.nombre, pci_pts_vence: a.pci_vence || null, pci: MET.estadoPCI(a.pci_vence, hoy), max_dias_almacen: a.max_dias_almacen == null ? null : Number(a.max_dias_almacen) },
      unidad: { ...s, imei: u.imei || '', tid: u.tid || '', notas: u.notas || '', dias_almacen: s.estado === 'almacen' ? Math.max(0, MET.dias(s.desde, hoy)) : null }, eventos, uso, tipos: TIPOS_EVENTO });
  }));

  app.put(base + '/unidades', auth, escribe, listo503, seguro(async (req, res) => {
    const b = req.body || {}, articuloId = Number(b.articulo_id), usuario = req.user.email || req.user.nombre || '—';
    const u = SE.parseUnidades([{ serie: b.serie, imei: b.imei, tid: b.tid }])[0];
    if (!u) throw new ErrorInv(400, 'series', 'Falta la serie.');
    const e = SE.validarIdentificadores(u); if (e) throw new ErrorInv(422, 'series', e);
    const notas = String(b.notas == null ? '' : b.notas).trim(); if (notas.length > 300) throw new ErrorInv(400, 'notas', 'Las notas son demasiado largas (máximo 300).');
    await db.tx(async t => {
      const tq = (x, p) => t.query(x, p || []);
      await tq('select pg_advisory_xact_lock($1::bigint)', [KEY + articuloId]);
      await estadoDeSerie(tq, articuloId, u.serie);
      for (const [campo, et] of [['imei', 'IMEI'], ['tid', 'TID']]) {
        if (!u[campo]) continue;
        const otra = (await tq(`select serie from inv_unidades where upper(${campo}) = $1 and not (articulo_id = $2 and upper(serie) = $3) limit 1`, [u[campo], articuloId, u.serie])).rows[0];
        if (otra) throw new ErrorInv(409, campo, `El ${et} ${u[campo]} ya está en el equipo ${otra.serie}.`);
      }
      await tq(`insert into inv_unidades (articulo_id, serie, imei, tid, notas, actualizado_por) values ($1,$2,$3,$4,$5,$6)
        on conflict (articulo_id, upper(serie)) do update set imei = $3, tid = $4, notas = $5, actualizado_por = $6, actualizado_at = now()`, [articuloId, u.serie, u.imei || null, u.tid || null, notas || null, usuario]);
    });
    await bit(req, 'inv_unidad_editar', `${u.serie} · IMEI ${u.imei || '—'} · TID ${u.tid || '—'}`, { resource_type: 'inventario_admin', resource_id: articuloId });
    res.json({ ok: true });
  }));

  app.post(base + '/unidades/eventos', auth, escribe, listo503, seguro(async (req, res) => {
    const b = req.body || {}, articuloId = Number(b.articulo_id), serie = SE.normSerie(b.serie), usuario = req.user.email || req.user.nombre || '—';
    const fecha = String(b.fecha || P.hoyMX()), descripcion = String(b.descripcion || '').trim();
    if (!Object.prototype.hasOwnProperty.call(TIPOS_EVENTO, b.tipo)) throw new ErrorInv(400, 'tipo', 'Elige el tipo de evento.');
    if (!P.esFecha(fecha) || fecha > P.hoyMX()) throw new ErrorInv(400, 'fecha', 'La fecha no es válida (no puede ser futura).');
    if (descripcion.length < 5 || descripcion.length > 400) throw new ErrorInv(400, 'descripcion', 'Describe el evento (de 5 a 400 caracteres).');
    await estadoDeSerie(q, articuloId, serie);
    const r = await q('insert into inv_unidad_eventos (articulo_id, serie, fecha, tipo, descripcion, usuario) values ($1,$2,$3::date,$4,$5,$6) returning id', [articuloId, serie, fecha, b.tipo, descripcion, usuario]);
    await bit(req, 'inv_unidad_evento', `${serie} · ${TIPOS_EVENTO[b.tipo]} · ${descripcion.slice(0, 120)}`, { resource_type: 'inventario_admin', resource_id: Number(r.rows[0].id) });
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  /* ============ Abastecimiento: punto de reorden (ROP) y stock de seguridad ============ */
  const ORDEN_REORDEN = { urgente: 0, reordenar: 1, ok: 2, sin_consumo: 3 };
  const filaReorden = a => ({ id: a.id, sku: a.sku, nombre: a.nombre, unidad: a.unidad, clase: a.clase, existencia: a.existencia, ...a.reorden, tiempo_entrega_dias: a.tiempo_entrega_dias, tiempo_config_dias: a.tiempo_config_dias });
  async function listaReorden(f) {
    let l = (await listaArticulos()).filter(a => a.activo && a.reorden);
    if (f && f.estado) l = l.filter(a => a.reorden.estado === f.estado);
    return l.map(filaReorden).sort((x, y) => ORDEN_REORDEN[x.estado] - ORDEN_REORDEN[y.estado] || String(x.clase).localeCompare(String(y.clase)) || x.nombre.localeCompare(y.nombre));
  }
  app.get(base + '/reorden', auth, listo503, seguro(async (req, res) => {
    const filas = await listaReorden(req.query || {});
    res.json({ articulos: filas, resumen: { urgente: filas.filter(x => x.estado === 'urgente').length, reordenar: filas.filter(x => x.estado === 'reordenar').length, ok: filas.filter(x => x.estado === 'ok').length, sin_consumo: filas.filter(x => x.estado === 'sin_consumo').length } });
  }));
  app.get(base + '/reorden.xlsx', auth, listo503, seguro(async (_req, res) => {
    const filas = await listaReorden({});
    const est = { urgente: 'Urgente', reordenar: 'Reordenar', ok: 'Suficiente', sin_consumo: 'Sin consumo' };
    const head = ['SN', 'Artículo', 'Clase ABC', 'Existencia', 'Demanda diaria', 'Entrega proveedor (días)', 'Configuración (días)', 'Tiempo total (días)', 'Stock de seguridad', 'Punto de reorden', 'Días de cobertura', 'Estado', 'Pedido sugerido'];
    const buf = X.buildXLSX([{ name: 'REPOSICION', aoa: [head, ...filas.map(a => [a.sku, a.nombre, a.clase, a.existencia, a.demanda_diaria, a.tiempo_entrega_dias, a.tiempo_config_dias, a.lead_dias, a.stock_seguridad, a.punto_reorden, a.dias_cobertura == null ? '' : a.dias_cobertura, est[a.estado], a.sugerido])], cols: [{ wch: 14 }, { wch: 32 }, { wch: 9 }, { wch: 11 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }] }]);
    enviarXLSX(res, `reposicion_${P.hoyMX()}.xlsx`, buf);
  }));

  /* ============ Tablero: lo que hay que atender hoy según cada metodología ============ */
  app.get(base + '/tablero', auth, listo503, seguro(async (_req, res) => {
    const { lista, mapa, hoy } = await analisis();
    const act = lista.filter(a => a.activo);
    const abc = { A: { n: 0, consumo: 0, existencia: 0 }, B: { n: 0, consumo: 0, existencia: 0 }, C: { n: 0, consumo: 0, existencia: 0 } };
    for (const a of act) { const c = abc[a.clase]; c.n++; c.consumo = P.r2(c.consumo + a.valor_consumo); c.existencia = P.r2(c.existencia + a.valor); }
    // antigüedad de los equipos en almacén
    const todas = [];
    for (const a of act.filter(x => x.serializado)) for (const x of SE.estadoSeries(mapa.get(a.id) || []).series.values()) if (x.estado === 'almacen') todas.push({ serie: x.serie, desde: x.desde, articulo_id: a.id, articulo: a.nombre, max: a.max_dias_almacen });
    const ed = MET.antiguedad(todas, hoy);
    const vencidos = ed.unidades.filter(u => u.max && u.dias_almacen > u.max);
    const fifo = Number((await q("select count(*)::int n from inv_movimientos where fifo_excepcion and not anulado and fecha >= $1::date", [MET.sumaDias(hoy, -30)])).rows[0].n);
    const propuesta = MET.propuestaConteo(act.map(a => ({ id: a.id, sku: a.sku, nombre: a.nombre, clase: a.clase, ultimo_conteo: a.ultimo_conteo })), hoy, 10);
    const abierto = (await q("select id, to_char(fecha, 'YYYY-MM-DD') fecha from inv_conteos where estado = 'abierto' order by id desc limit 1")).rows[0];
    res.json({ hoy,
      reorden: act.filter(a => a.reorden && ['urgente', 'reordenar'].includes(a.reorden.estado)).map(filaReorden).sort((x, y) => ORDEN_REORDEN[x.estado] - ORDEN_REORDEN[y.estado] || x.nombre.localeCompare(y.nombre)),
      pci: act.filter(a => a.pci && a.pci.estado !== 'vigente').map(a => ({ id: a.id, sku: a.sku, nombre: a.nombre, vence: a.pci_pts_vence, folio: a.pci_pts_folio, ...a.pci, en_almacen: a.en_almacen || 0 })).sort((x, y) => x.dias - y.dias),
      antiguedad: { tramos: ed.tramos, total: ed.unidades.length, sobre_limite: vencidos.length, mas_antiguas: ed.unidades.slice().sort((x, y) => y.dias_almacen - x.dias_almacen).slice(0, 8).map(u => ({ serie: u.serie, articulo_id: u.articulo_id, articulo: u.articulo, dias: u.dias_almacen, sobre_limite: !!(u.max && u.dias_almacen > u.max) })) },
      abc, conteo: { propuesta, abierto: abierto ? { id: Number(abierto.id), fecha: abierto.fecha } : null }, fifo_excepciones_30d: fifo,
      conteo_vencido: act.filter(a => a.toca_conteo).length });
  }));

  /* ============ Conteo cíclico con ABC: se cuenta por lotes, la clase A más seguido ============ */
  const aConteo = c => ({ id: Number(c.id), fecha: c.fecha, estado: c.estado, nota: c.nota || '', creado_por: c.creado_por, cerrado_por: c.cerrado_por || null });
  const SEL_CONTEO = "select id, to_char(fecha, 'YYYY-MM-DD') fecha, estado, nota, creado_por, cerrado_por from inv_conteos";
  app.get(base + '/conteos', auth, listo503, seguro(async (_req, res) => {
    const cs = (await q(SEL_CONTEO + ' order by id desc limit 100')).rows.map(aConteo);
    const ls = cs.length ? (await q('select conteo_id, count(*)::int n, count(contada)::int contadas, count(*) filter (where diferencia is not null and diferencia <> 0)::int con_dif from inv_conteo_lineas where conteo_id = any($1::bigint[]) group by conteo_id', [cs.map(c => c.id)])).rows : [];
    const por = new Map(ls.map(x => [Number(x.conteo_id), x]));
    res.json({ conteos: cs.map(c => ({ ...c, lineas: (por.get(c.id) || {}).n || 0, contadas: (por.get(c.id) || {}).contadas || 0, con_diferencia: (por.get(c.id) || {}).con_dif || 0 })) });
  }));
  app.get(base + '/conteos/propuesta', auth, listo503, seguro(async (req, res) => {
    const act = (await listaArticulos()).filter(a => a.activo);
    const lim = Math.min(50, Math.max(1, parseInt(req.query.limite, 10) || 10));
    res.json({ propuesta: MET.propuestaConteo(act.map(a => ({ id: a.id, sku: a.sku, nombre: a.nombre, serializado: a.serializado, clase: a.clase, ultimo_conteo: a.ultimo_conteo })), P.hoyMX(), lim), frecuencias: MET.FRECUENCIA_CONTEO });
  }));
  async function detalleConteo(qq, id) {
    const c = (await qq(SEL_CONTEO + ' where id = $1', [id])).rows[0];
    if (!c) throw new ErrorInv(404, 'no_existe', 'Ese conteo no existe.');
    const ls = (await qq(`select l.articulo_id, l.clase, l.contada, l.series_contadas, l.esperada, l.diferencia, l.resultado, l.ajuste_movimiento_id, l.ajuste_motivo, a.sku, a.nombre, a.unidad, a.serializado
                          from inv_conteo_lineas l join inv_articulos a on a.id = l.articulo_id where l.conteo_id = $1 order by l.clase, upper(a.nombre)`, [id])).rows
      .map(l => ({ articulo_id: Number(l.articulo_id), sku: l.sku, nombre: l.nombre, unidad: l.unidad, serializado: l.serializado, clase: l.clase, contada: l.contada == null ? null : Number(l.contada), esperada: l.esperada == null ? null : Number(l.esperada), diferencia: l.diferencia == null ? null : Number(l.diferencia), series_contadas: l.series_contadas || null, resultado: l.resultado || null, ajuste_movimiento_id: l.ajuste_movimiento_id == null ? null : Number(l.ajuste_movimiento_id), ajuste_motivo: l.ajuste_motivo || '' }));
    return { ...aConteo(c), lineas: ls };
  }
  app.get(base + '/conteos/:id', auth, listo503, seguro(async (req, res) => res.json(await detalleConteo(q, Number(req.params.id)))));

  app.post(base + '/conteos', auth, escribe, listo503, seguro(async (req, res) => {
    const b = req.body || {}, usuario = req.user.email || req.user.nombre || '—';
    if ((await q("select 1 from inv_conteos where estado = 'abierto' limit 1")).rows.length) throw new ErrorInv(409, 'abierto', 'Ya hay un conteo abierto: ciérralo antes de iniciar otro.');
    const act = (await listaArticulos()).filter(a => a.activo);
    let ids = Array.isArray(b.articulo_ids) ? b.articulo_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) ids = MET.propuestaConteo(act.map(a => ({ id: a.id, clase: a.clase, ultimo_conteo: a.ultimo_conteo })), P.hoyMX(), Math.min(50, Math.max(1, parseInt(b.limite, 10) || 10))).map(x => x.id);
    ids = [...new Set(ids)];
    const sel = ids.map(id => act.find(a => a.id === id)).filter(Boolean);
    if (!sel.length) throw new ErrorInv(422, 'sin_articulos', 'No hay artículos por contar: ninguno toca todavía según su clase. Elige artículos a mano si quieres contar de todos modos.');
    const nota = String(b.nota || '').trim().slice(0, 200);
    const id = await db.tx(async t => {
      const r = await t.query('insert into inv_conteos (fecha, nota, creado_por) values ($1::date, $2, $3) returning id', [P.hoyMX(), nota || null, usuario]);
      for (const a of sel) await t.query('insert into inv_conteo_lineas (conteo_id, articulo_id, clase) values ($1,$2,$3)', [Number(r.rows[0].id), a.id, a.clase]);
      return Number(r.rows[0].id);
    });
    await bit(req, 'inv_conteo_abrir', `conteo ${id} con ${sel.length} artículos (${['A', 'B', 'C'].map(c => c + ':' + sel.filter(a => a.clase === c).length).join(' ')})`, { resource_type: 'inventario_admin', resource_id: id });
    res.json({ ok: true, id });
  }));

  /* Esperado vs. contado de un artículo hoy. */
  async function compararHoy(qq, a, contada, seriesTxt) {
    const ms = await movsVigentes(qq, Number(a.id));
    if (!a.serializado) {
      const n = Number(contada);
      if (contada === '' || contada == null || !Number.isFinite(n) || n < 0 || n > 1e9 || Math.abs(n * 1e4 - Math.round(n * 1e4)) > 1e-6) throw new ErrorInv(422, 'contada', 'Escribe la cantidad contada (cero o más, hasta 4 decimales).');
      const esperado = P.kardex(ms).existencia;
      return { contada: n, series: null, resultado: MET.compararConteo({ serializado: false, esperado, contado: n }) };
    }
    const us = SE.parseUnidades(Array.isArray(seriesTxt) ? seriesTxt : String(seriesTxt || ''));
    const series = us.map(u => u.serie);
    for (const x of series) if (!SE.SERIE_OK.test(x)) throw new ErrorInv(422, 'series', `La serie «${x}» no es válida.`);
    if (new Set(series).size !== series.length) throw new ErrorInv(422, 'series', 'Hay series repetidas en la captura.');
    const est = SE.estadoSeries(ms).series;
    const esperadas = [...est.values()].filter(x => x.estado === 'almacen').map(x => x.serie);
    const conocidas = new Map([...est.values()].map(x => [x.serie, x.estado]));
    return { contada: series.length, series, resultado: MET.compararConteo({ serializado: true, esperadas, contadas: series, conocidas }) };
  }
  app.post(base + '/conteos/:id/contar', auth, escribe, listo503, seguro(async (req, res) => {
    const b = req.body || {}, id = Number(req.params.id), articuloId = Number(b.articulo_id);
    const out = await db.tx(async t => {
      const tq = (x, p) => t.query(x, p || []);
      await tq('select pg_advisory_xact_lock($1::bigint)', [KEY + articuloId]);
      const c = (await tq("select estado from inv_conteos where id = $1", [id])).rows[0];
      if (!c) throw new ErrorInv(404, 'no_existe', 'Ese conteo no existe.');
      if (c.estado !== 'abierto') throw new ErrorInv(409, 'cerrado', 'Ese conteo ya está cerrado.');
      const l = (await tq('select 1 from inv_conteo_lineas where conteo_id = $1 and articulo_id = $2', [id, articuloId])).rows[0];
      if (!l) throw new ErrorInv(404, 'no_existe', 'Ese artículo no está en este conteo.');
      const a = (await tq(ART_SEL + ' where a.id = $1', [articuloId])).rows[0];
      const cmp = await compararHoy(tq, a, b.contada, b.series);
      const r = cmp.resultado;
      await tq('update inv_conteo_lineas set contada = $3, series_contadas = $4::jsonb, esperada = $5, diferencia = $6, resultado = $7::jsonb where conteo_id = $1 and articulo_id = $2',
        [id, articuloId, cmp.contada, cmp.series ? JSON.stringify(cmp.series) : null, r.esperado, r.diferencia, JSON.stringify(r)]);
      return { resultado: r, sku: a.sku };
    });
    await bit(req, 'inv_conteo_captura', `conteo ${id} · ${out.sku} · esperado ${out.resultado.esperado} · contado ${out.resultado.contado} · diferencia ${out.resultado.diferencia}`, { resource_type: 'inventario_admin', resource_id: id });
    res.json({ ok: true, resultado: out.resultado });
  }));

  app.post(base + '/conteos/:id/cerrar', auth, escribe, listo503, seguro(async (req, res) => {
    const b = req.body || {}, id = Number(req.params.id), usuario = req.user.email || req.user.nombre || '—';
    const decisiones = new Map((Array.isArray(b.decisiones) ? b.decisiones : []).map(d => [Number(d.articulo_id), d]));
    const cierre = await db.tx(async t => {
      const tq = (x, p) => t.query(x, p || []);
      const c = (await tq('select estado from inv_conteos where id = $1 for update', [id])).rows[0];
      if (!c) throw new ErrorInv(404, 'no_existe', 'Ese conteo no existe.');
      if (c.estado !== 'abierto') throw new ErrorInv(409, 'cerrado', 'Ese conteo ya estaba cerrado.');
      const lineas = (await tq('select articulo_id from inv_conteo_lineas where conteo_id = $1 order by articulo_id', [id])).rows.map(x => Number(x.articulo_id));
      for (const aid of lineas) await tq('select pg_advisory_xact_lock($1::bigint)', [KEY + aid]);            // orden fijo: sin interbloqueos
      const det = (await tq('select articulo_id, contada, series_contadas, esperada from inv_conteo_lineas where conteo_id = $1', [id])).rows;
      const contadas = det.filter(l => l.contada != null);
      if (!contadas.length) throw new ErrorInv(422, 'sin_contar', 'Captura al menos un artículo contado para cerrar el conteo.');
      let ajustes = 0, sinAjuste = 0;
      const cambiaron = [];
      for (const l of contadas) {
        const aid = Number(l.articulo_id);
        const a = (await tq(ART_SEL + ' where a.id = $1', [aid])).rows[0];
        const cmp = await compararHoy(tq, a, Number(l.contada), l.series_contadas || []);                       // lo contado se revalida contra la existencia de AHORA
        if (Number(cmp.resultado.esperado) !== Number(l.esperada)) { cambiaron.push(a.sku); continue; }
        const r = cmp.resultado;
        await tq('update inv_conteo_lineas set resultado = $3::jsonb, diferencia = $4 where conteo_id = $1 and articulo_id = $2', [id, aid, JSON.stringify(r), r.diferencia]);
        const hayDif = a.serializado ? (r.faltantes.length || r.sobrantes_conocidas.length || r.sobrantes_desconocidas.length) : r.diferencia !== 0;
        if (!hayDif) continue;
        const d = decisiones.get(aid), motivo = String((d && d.motivo) || '').trim();
        if (!d || !['ajustar', 'pendiente'].includes(d.accion)) throw new ErrorInv(422, 'decision', `«${a.nombre}» tiene diferencia: decide si se ajusta o queda pendiente.`, { articulo_id: aid });
        if (motivo.length < 10) throw new ErrorInv(422, 'motivo', `Escribe el motivo de la diferencia de «${a.nombre}» (al menos 10 caracteres).`, { articulo_id: aid });
        if (d.accion === 'pendiente') { sinAjuste++; await tq('update inv_conteo_lineas set ajuste_motivo = $3 where conteo_id = $1 and articulo_id = $2', [id, aid, 'Pendiente: ' + motivo]); continue; }
        if (a.serializado && r.sobrantes_conocidas.length) throw new ErrorInv(422, 'conocidas', `En «${a.nombre}» hay series que el sistema tiene asignadas o dadas de baja (${r.sobrantes_conocidas.slice(0, 3).map(x => x.serie).join(', ')}): regístralas como devolución de cliente y vuelve a contar, o deja la diferencia como pendiente.`, { articulo_id: aid });
        const nota = `Conteo cíclico #${id}: ${motivo}`.slice(0, 400), hoy = P.hoyMX();
        const kd = P.kardex(await movsVigentes(tq, aid));
        const costo = kd.existencia > 0 ? P.r4(kd.valor / kd.existencia) : (kd.capas.length ? kd.capas[kd.capas.length - 1].costo_unitario : 0);
        let primero = null;
        const poner = async (mv) => { const o = await registrarMovimiento(tq, { articulo_id: aid, fecha: hoy, notas: nota, ...mv }, usuario); if (primero == null) primero = o.id; ajustes++; };
        if (a.serializado) {
          if (r.faltantes.length) await poner({ tipo: 'salida', concepto: 'ajuste_negativo', series: r.faltantes });
          if (r.sobrantes_desconocidas.length) await poner({ tipo: 'entrada', concepto: 'ajuste_positivo', costo_unitario: costo, series: r.sobrantes_desconocidas });
        } else if (r.diferencia > 0) await poner({ tipo: 'entrada', concepto: 'ajuste_positivo', cantidad: r.diferencia, costo_unitario: costo });
        else await poner({ tipo: 'salida', concepto: 'ajuste_negativo', cantidad: -r.diferencia });
        await tq('update inv_conteo_lineas set ajuste_movimiento_id = $3, ajuste_motivo = $4 where conteo_id = $1 and articulo_id = $2', [id, aid, primero, 'Ajustado: ' + motivo]);
      }
      if (cambiaron.length) throw new ErrorInv(409, 'cambio', `Hubo movimientos desde que se contó (${cambiaron.slice(0, 5).join(', ')}): vuelve a capturar el conteo de esos artículos.`);
      await tq('delete from inv_conteo_lineas where conteo_id = $1 and contada is null', [id]);                 // lo que no se contó se descarta
      await tq("update inv_conteos set estado = 'cerrado', cerrado_por = $2, cerrado_at = now() where id = $1", [id, usuario]);
      return { contados: contadas.length, ajustes, pendientes: sinAjuste };
    });
    await bit(req, 'inv_conteo_cerrar', `conteo ${id} cerrado: ${cierre.contados} artículos, ${cierre.ajustes} ajustes, ${cierre.pendientes} diferencias pendientes`, { resource_type: 'inventario_admin', resource_id: id });
    res.json({ ok: true, ...cierre });
  }));

  /* ---- carga MASIVA (layout) ---- */
  const tablaEmpresas = cl => [['Empresas (usa el nombre exacto)'], ...cl.empresas.map(e => [e.nombre])];
  app.get(base + '/layout.xlsx', auth, listo503, seguro(async (_req, res) => {
    const cl = await catalogoClientes(q);
    const ej = cl.empresas[0] ? cl.empresas[0].nombre : 'Nombre de la Empresa';
    const buf = X.buildXLSX([
      { name: 'Instrucciones', aoa: [['Layout de terminales · una fila por terminal'], [''], ['1. Llena la hoja «Terminales»: SN (número de serie), modelo, costo y fecha de compra. Es lo único obligatorio.'], ['2. Si la terminal ya está con un cliente, pon también Empresa y Unidad (y la fecha de entrega, si no es la de compra).'], ['3. IMEI (15 dígitos) y TID son opcionales: si los traes, quedan ligados al equipo. No se pueden repetir entre equipos.'], ['4. Sube el archivo: se revisa solo y te dice qué fila corregir. Si hay un error no se aplica nada.'], ['5. El modelo que no exista se crea solo. El costo va sin IVA.']], cols: [{ wch: 110 }] },
      { name: 'Terminales', aoa: [['sn', 'imei', 'tid', 'modelo', 'costo', 'fecha_compra', 'documento', 'proveedor', 'empresa', 'unidad', 'fecha_entrega'],
        ['SN0001', '350000000000001', 'TID0001', 'Terminal POS Verifone', 1850, '2026-11-01', 'F-1001', 'Proveedor A', ej, 'Sucursal Norte', '2026-11-10'], ['SN0002', '350000000000002', '', 'Terminal POS Verifone', 1850, '2026-11-01', 'F-1001', 'Proveedor A', '', '', ''], ['SN0003', '', '', 'Terminal POS Verifone', 1850, '2026-11-01', 'F-1001', 'Proveedor A', '', '', '']],
        cols: [{ wch: 16 }, { wch: 18 }, { wch: 12 }, { wch: 28 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 30 }, { wch: 22 }, { wch: 14 }] },
      { name: 'Empresas', aoa: tablaEmpresas(cl), cols: [{ wch: 60 }] }]);
    enviarXLSX(res, 'layout_terminales_inventario.xlsx', buf);
  }));
  app.get(base + '/layout-avanzado.xlsx', auth, listo503, seguro(async (_req, res) => {
    const cl = await catalogoClientes(q);
    const ej = cl.empresas[0] ? cl.empresas[0].nombre : 'Nombre de la Empresa';
    const buf = X.buildXLSX([
      { name: 'Instrucciones', aoa: [['Layout avanzado · artículos sin número de serie y movimientos sueltos'], [''], ['1. Llena «Articulos» (catálogo) y/o «Movimientos» (entradas y salidas). Puedes subir solo una de las dos.'], ['2. Terminales (serializado = SI): una fila por número de serie.'], ['3. Las filas con mismo tipo, concepto, fecha, SN, costo, documento, empresa y unidad forman un solo movimiento.'], ['4. Entrega: Empresa (del catálogo) y Unidad obligatorias.'], ['5. Fechas: AAAA-MM-DD o DD/MM/AAAA. Costos sin IVA.'], [''], ['Conceptos de entrada: ' + Object.values(P.CONCEPTOS_ENTRADA).join(' · ')], ['Conceptos de salida: ' + Object.values(P.CONCEPTOS_SALIDA).join(' · ')]], cols: [{ wch: 120 }] },
      { name: 'Articulos', aoa: [['sn', 'nombre', 'categoria', 'unidad', 'minimo', 'serializado', 'activo'], ['TERM-001', 'Terminal POS Verifone', 'Terminales', 'pieza', 5, 'SI', 'SI'], ['PAP-001', 'Papel térmico 57 mm', 'Papelería', 'caja', 10, 'NO', 'SI']], cols: [{ wch: 14 }, { wch: 34 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 8 }] },
      { name: 'Movimientos', aoa: [['tipo', 'concepto', 'fecha', 'sn', 'serie', 'imei', 'tid', 'cantidad', 'costo_unitario', 'documento', 'proveedor', 'empresa', 'unidad', 'notas'],
        ['ENTRADA', 'Compra', '2026-11-02', 'PAP-001', '', '', '', 20, 95, 'F-1002', 'Proveedor B', '', '', ''], ['SALIDA', 'Consumo interno', '2026-11-12', 'PAP-001', '', '', '', 3, '', '', '', '', '', 'Uso en oficina'],
        ['SALIDA', 'Entrega a cliente o área', '2026-11-10', 'TERM-001', 'SN0001', '', '', '', '', 'REM-55', '', ej, 'Sucursal Norte', '']], cols: [{ wch: 9 }, { wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 30 }, { wch: 22 }, { wch: 24 }] },
      { name: 'Empresas', aoa: tablaEmpresas(cl), cols: [{ wch: 60 }] }]);
    enviarXLSX(res, 'layout_avanzado_inventario.xlsx', buf);
  }));

  function leerHojas(b) {
    if (!b || typeof b.archivo !== 'string' || !b.archivo) throw new ErrorInv(400, 'archivo', 'Falta el archivo.');
    const buf = Buffer.from(b.archivo, 'base64');
    if (buf.length > 6 * 1024 * 1024) throw new ErrorInv(413, 'tamano', 'El archivo pesa más de 6 MB.');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const nombre = String(b.nombre || '').toLowerCase();
    let wb;
    try { wb = /\.(csv|txt|tsv)$/.test(nombre) ? XLSX.read(buf.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true }) : XLSX.read(buf, { type: 'buffer', raw: true }); }
    catch (_e) { throw new ErrorInv(400, 'archivo', 'No se pudo leer el archivo. Usa el layout .xlsx o un .csv.'); }
    const hoja = nombres => { const n = wb.SheetNames.find(x => nombres.includes(LY.normH(x))); return n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '', raw: true }) : null; };
    let articulos = hoja(['articulos', 'articulo', 'catalogo']), movimientos = hoja(['movimientos', 'movimiento']);
    const terminales = hoja(['terminales', 'terminal']);
    if (!articulos && !movimientos && !terminales) {                                                    // CSV o libro de una sola hoja: se decide por sus encabezados
      const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
      const hs = filas.length ? Object.keys(filas[0]).map(LY.normH) : [];
      if (hs.includes('modelo')) return { hojas: { terminales: filas }, hash };
      if (hs.includes('tipo')) movimientos = filas; else if (hs.includes('serie') || hs.includes('sn')) return { hojas: { terminales: filas }, hash }; else articulos = filas;
    }
    return { hojas: terminales && terminales.length ? { terminales } : { articulos: articulos || [], movimientos: movimientos || [] }, hash };
  }

  const planDe = (hojas, ctx) => hojas.terminales ? LY.planificarSimple(hojas.terminales, ctx) : LY.planificar(hojas, ctx);
  async function contextoLayout(qq) {
    const arts = (await qq(ART_SEL)).rows;
    const todos = await movsVigentes(qq);
    const mapa = porArticulo(todos);
    const articulos = new Map(arts.map(a => [String(a.sku).toUpperCase(), { id: Number(a.id), sku: a.sku, nombre: a.nombre, categoria: a.categoria || '', unidad: a.unidad, minimo: Number(a.minimo), activo: a.activo, serializado: !!a.serializado }]));
    const cl = await catalogoClientes(qq);
    return { articulos, movs: mapa, empresas: cl.empresas, unidadesConocidas: cl.unidadesConocidas, hoy: P.hoyMX() };
  }
  const resumenPlan = (plan, h) => ({ ok: plan.ok, errores: plan.errores.slice(0, 200), n_errores: plan.errores.length, avisos: plan.avisos, resumen: plan.resumen, huella: plan.ok ? LY.huella(h, plan) : null,
    vista: plan.movimientos.slice(0, 60).map(m => ({ tipo: m.tipo, concepto: m.concepto, fecha: m.fecha, sku: m.sku, cantidad: m.cantidad, costo_unitario: m.costo_unitario, costo_total: m.costo_total == null ? null : m.costo_total, empresa: m.empresa, unidad: m.unidad, series: m.series.length, filas: m.filas.slice(0, 3) })),
    articulos: plan.articulos.map(a => ({ sku: a.sku, nombre: a.nombre, accion: a.accion, serializado: a.serializado })) });

  app.post(base + '/layout', auth, escribe, listo503, seguro(async (req, res) => {
    const b = req.body || {};
    const { hojas, hash } = leerHojas(b);
    if (!b.aplicar) { const plan = planDe(hojas, await contextoLayout(q)); return res.json({ aplicado: false, ...resumenPlan(plan, hash) }); }
    const usuario = req.user.email || req.user.nombre || '—';
    let aplicado = null;
    const resp = await db.tx(async t => {
      const tq = (s, p) => t.query(s, p || []);
      await tq('select pg_advisory_xact_lock($1::bigint)', [KEY_ALTAS]);
      const pre = await contextoLayout(tq);
      const tocados = [...pre.articulos.values()].map(a => a.id).sort((x, y) => x - y);
      for (const id of tocados) await tq('select pg_advisory_xact_lock($1::bigint)', [KEY + id]);       // candado por artículo (orden fijo: sin interbloqueos)
      const ctx = await contextoLayout(tq);
      const plan = planDe(hojas, ctx);
      if (!plan.ok) throw Object.assign(new ErrorInv(422, 'layout_con_errores', 'El archivo tiene errores: corrígelos y vuelve a subirlo.'), { plan });
      if (!b.huella || b.huella !== LY.huella(hash, plan)) throw new ErrorInv(409, 'plan_cambio', 'Lo que se iba a aplicar cambió desde que se revisó (otra persona capturó movimientos). Vuelve a revisar el archivo.');
      const ids = new Map([...ctx.articulos].map(([sku, a]) => [sku, a.id]));
      for (const a of plan.articulos) {
        if (a.accion === 'crear') { const r = await tq('insert into inv_articulos (sku, nombre, categoria, unidad, minimo, serializado, activo, creado_por) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id', [a.sku, a.nombre, a.categoria || null, a.unidad, a.minimo, a.serializado, a.activo, usuario]); ids.set(a.sku, Number(r.rows[0].id)); }
        else await tq('update inv_articulos set nombre=$2, categoria=$3, unidad=$4, minimo=$5, activo=$6, serializado=$7 where id=$1', [a.id, a.nombre, a.categoria || null, a.unidad, a.minimo, a.activo, a.serializado]);
      }
      const orden = plan.movimientos.slice().sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : (x.tipo === 'entrada' ? 0 : 1) - (y.tipo === 'entrada' ? 0 : 1)));
      for (const m of orden) {
        const destino = m.empresa && m.tipo === 'salida' && m.concepto === 'entrega' ? `${m.empresa} / ${m.unidad}` : null;
        const ins = await tq(`insert into inv_movimientos (articulo_id, tipo, concepto, fecha, cantidad, costo_unitario, proveedor, documento, destino, notas, empresa_id, empresa, unidad, usuario)
                              values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
          [ids.get(m.sku), m.tipo, m.concepto, m.fecha, m.cantidad, m.tipo === 'entrada' ? m.costo_unitario : null, m.proveedor || null, m.documento || null, destino, m.notas || null, m.empresa_id, m.tipo === 'salida' && m.concepto === 'entrega' ? m.empresa : null, m.tipo === 'salida' && m.concepto === 'entrega' ? m.unidad : null, usuario]);
        for (const sr of m.series) {
          await tq('insert into inv_mov_series (movimiento_id, serie) values ($1,$2)', [Number(ins.rows[0].id), sr]);
          const idn = (m.ids || {})[sr] || {};
          if (m.tipo === 'entrada' || idn.imei || idn.tid) {
            try { await tq(`insert into inv_unidades (articulo_id, serie, imei, tid, actualizado_por) values ($1,$2,$3,$4,$5)
              on conflict (articulo_id, upper(serie)) do update set imei = coalesce(nullif(excluded.imei, ''), inv_unidades.imei), tid = coalesce(nullif(excluded.tid, ''), inv_unidades.tid), actualizado_por = $5, actualizado_at = now()`, [ids.get(m.sku), sr, idn.imei || null, idn.tid || null, usuario]); }
            catch (e) { if (e && e.code === '23505') throw new ErrorInv(409, 'imei_tid', `El IMEI o el TID del equipo ${sr} ya está en otro equipo del inventario: no se aplicó nada.`); throw e; }
          }
        }
      }
      // verificación final dentro de la transacción: nada incoherente
      const final = await contextoLayout(tq);
      for (const [sku, a] of final.articulos) { const ms = final.movs.get(a.id) || []; const k = P.kardex(ms); if (k.error || (a.serializado && SE.estadoSeries(ms).errores.length)) throw new ErrorInv(409, 'incoherente', `El resultado dejaría incoherente el artículo ${sku}: no se aplicó nada.`); }
      aplicado = plan; return resumenPlan(plan, hash);
    });
    await bit(req, 'inv_layout', `carga masiva: ${aplicado.resumen.articulos_nuevos} artículos nuevos, ${aplicado.resumen.movimientos} movimientos (${aplicado.resumen.entradas} entradas, ${aplicado.resumen.salidas} salidas), ${aplicado.resumen.unidades} series · archivo ${String(b.nombre || '').slice(0, 80)}`, { resource_type: 'inventario_admin', resource_id: null });
    res.json({ aplicado: true, ...resp });
  }));

}

module.exports = { montar, asegurar };
