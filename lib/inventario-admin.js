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

const KEY = 7420112000;                                                  // base del candado por artículo (pg_advisory_xact_lock)
const KEY_ALTAS = 7420111999;                                            // candado para altas de artículos (SKU único) desde la carga masiva
let listo = null;

class ErrorInv extends Error { constructor(status, codigo, msg) { super(msg); this.status = status; this.codigo = codigo; } }
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
  })().catch(e => { listo = null; throw e; });
  return listo;
}

const COLS_MOV = `m.id, m.articulo_id, m.tipo, m.concepto, to_char(m.fecha, 'YYYY-MM-DD') fecha, m.cantidad, m.costo_unitario, m.proveedor, m.documento, m.destino, m.notas,
                  m.empresa_id, m.empresa, m.unidad, m.afiliacion, m.usuario, m.creado_at, m.anulado, m.anulado_por, m.anulado_motivo, m.anulado_at`;
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

function resumenArticulo(a, kd, movsDe) {
  const existencia = kd.existencia, minimo = Number(a.minimo) || 0;
  const r = { id: Number(a.id), sku: a.sku, nombre: a.nombre, categoria: a.categoria || '', unidad: a.unidad, minimo, activo: a.activo, notas: a.notas || '', serializado: !!a.serializado,
    existencia, valor: kd.valor, costo_promedio: existencia > 0 ? P.r4(kd.valor / existencia) : 0, costo_siguiente: kd.capas.length ? kd.capas[0].costo_unitario : null, capas: kd.capas.length,
    bajo_minimo: a.activo && minimo > 0 && existencia < minimo, ultimo_mov: movsDe.length ? movsDe[movsDe.length - 1].fecha : null, inconsistente: !!kd.error, movimientos: movsDe.length };
  if (a.serializado) {
    const e = SE.estadoSeries(movsDe);
    const v = [...e.series.values()];
    r.en_almacen = v.filter(x => x.estado === 'almacen').length; r.asignadas = v.filter(x => x.estado === 'asignada').length; r.bajas = v.filter(x => x.estado === 'baja').length;
    if (e.errores.length) r.inconsistente = true;
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
    if (e instanceof ErrorInv) return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.plan ? resumenPlan(e.plan, '') : {}) });
    console.error('[inventario-admin]', e); res.status(500).json({ error: 'No se pudo completar. Intenta de nuevo.' }); } };

  /* ---- catálogo de clientes (Empresas = grupos de cliente; afiliaciones; unidades ya usadas) ---- */
  async function catalogoClientes(qq) {
    let empresas = [];
    try {
      const g = (await qq('select id_grupo, nombre_cliente from grupos where activo order by upper(nombre_cliente)')).rows;
      const af = (await qq('select ag.id_grupo, ag.numero_afiliacion, a.razon_social from afil_grupo ag left join afiliaciones a on a.numero_afiliacion = ag.numero_afiliacion order by ag.numero_afiliacion')).rows;
      empresas = g.map(x => ({ id: Number(x.id_grupo), nombre: x.nombre_cliente, afiliaciones: af.filter(y => Number(y.id_grupo) === Number(x.id_grupo)).map(y => y.numero_afiliacion), afiliaciones_detalle: af.filter(y => Number(y.id_grupo) === Number(x.id_grupo)).map(y => ({ numero: y.numero_afiliacion, razon_social: y.razon_social || '' })) }));
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
    if (!cat.length) return { id: null, nombre: String(nombre || '').trim(), afiliaciones: null };                  // sin catálogo (solo pruebas): se acepta el texto
    const e = cat.find(x => (id != null && id !== '' && x.id === Number(id))) || cat.find(x => nrm(x.nombre) === nrm(nombre));
    if (!e) throw new ErrorInv(422, 'empresa', 'La Empresa no existe en el catálogo de Grupos y afiliaciones.');
    return { id: e.id, nombre: e.nombre, afiliaciones: e.afiliaciones };
  }

  async function listaArticulos() {
    const arts = (await q('select * from inv_articulos order by upper(nombre)')).rows;
    const mapa = porArticulo(await movsVigentes(q));
    return arts.map(a => { const ms = mapa.get(Number(a.id)) || []; return resumenArticulo(a, P.kardex(ms), ms); });
  }

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
    if (b.id) {
      const id = Number(b.id);
      const ex = (await q('select id, serializado from inv_articulos where id = $1', [id])).rows[0];
      if (!ex) throw new ErrorInv(404, 'no_existe', 'Ese artículo no existe.');
      if (b.serializado !== undefined && serializado !== ex.serializado && Number((await q('select count(*)::int n from inv_movimientos where articulo_id = $1', [id])).rows[0].n)) throw new ErrorInv(409, 'serializado', 'El artículo ya tiene movimientos: no se puede cambiar si es serializado.');
      const dup = (await q('select id from inv_articulos where upper(sku) = $1 and id <> $2', [sku, id])).rows[0];
      if (dup) throw new ErrorInv(409, 'sku_repetido', 'Ya hay otro artículo con ese código.');
      await q('update inv_articulos set sku=$2, nombre=$3, categoria=$4, unidad=$5, minimo=$6, notas=$7, activo=$8, serializado=$9 where id=$1', [id, sku, nombre, categoria || null, unidad, minimo, notas || null, b.activo === false ? false : true, b.serializado === undefined ? ex.serializado : serializado]);
      await bit(req, 'inv_articulo_editar', `${sku} · ${nombre} · mínimo ${minimo}${b.activo === false ? ' · desactivado' : ''}`, { resource_type: 'inventario_admin', resource_id: id });
      return res.json({ ok: true, id });
    }
    const dup = (await q('select id from inv_articulos where upper(sku) = $1', [sku])).rows[0];
    if (dup) throw new ErrorInv(409, 'sku_repetido', 'Ya hay un artículo con ese código.');
    const r = await q('insert into inv_articulos (sku, nombre, categoria, unidad, minimo, notas, serializado, creado_por) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id', [sku, nombre, categoria || null, unidad, minimo, notas || null, serializado, usuario]);
    await bit(req, 'inv_articulo_alta', `${sku} · ${nombre} · ${unidad}${serializado ? ' · serializado' : ''}`, { resource_type: 'inventario_admin', resource_id: r.rows[0].id });
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  app.get(base + '/articulos/:id/kardex', auth, listo503, seguro(async (req, res) => {
    const id = Number(req.params.id);
    const a = (await q('select * from inv_articulos where id = $1', [id])).rows[0];
    if (!a) throw new ErrorInv(404, 'no_existe', 'Ese artículo no existe.');
    const ms = await movsVigentes(q, id);
    const kd = P.kardex(ms);
    const anul = (await q(`select ${COLS_MOV} from inv_movimientos m where m.articulo_id = $1 and m.anulado order by m.fecha, m.id`, [id])).rows.map(aMov);
    const out = { articulo: resumenArticulo(a, kd, ms), filas: kd.filas, capas: kd.capas, anulados: anul, error: kd.error };
    if (a.serializado) out.series = [...SE.estadoSeries(ms).series.values()].sort((x, y) => (x.estado === y.estado ? x.serie.localeCompare(y.serie) : x.estado.localeCompare(y.estado)));
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

  /* ---- alta de un movimiento ---- */
  app.post(base + '/movimientos', auth, escribe, listo503, seguro(async (req, res) => {
    const b = req.body || {};
    const articuloId = Number(b.articulo_id);
    const usuario = req.user.email || req.user.nombre || '—';
    const crudo = Array.isArray(b.series) ? b.series : String(b.series || '').split(/[\n,;]+/);
    const series = crudo.map(SE.normSerie).filter(Boolean);
    const out = await db.tx(async t => {
      const tq = (s, p) => t.query(s, p || []);
      await tq('select pg_advisory_xact_lock($1::bigint)', [KEY + (Number.isFinite(articuloId) ? articuloId : 0)]);
      const a = (await tq('select * from inv_articulos where id = $1', [articuloId])).rows[0];
      if (!a) throw new ErrorInv(404, 'no_existe', 'Ese artículo no existe.');
      if (!a.activo) throw new ErrorInv(409, 'inactivo', 'Ese artículo está desactivado: actívalo para registrar movimientos.');
      let empresa = { id: null, nombre: '', afiliaciones: null }, afiliacion = String(b.afiliacion || '').trim();
      if (b.tipo === 'salida' && b.concepto === 'entrega') {
        if (!String(b.empresa || '').trim() && (b.empresa_id == null || b.empresa_id === '')) throw new ErrorInv(422, 'empresa', 'Una entrega lleva la Empresa y la Unidad del cliente a la que se asigna.');
        empresa = await resolverEmpresa(tq, b.empresa_id, b.empresa);
        if (afiliacion && empresa.afiliaciones && !empresa.afiliaciones.includes(afiliacion)) throw new ErrorInv(422, 'afiliacion', `La afiliación ${afiliacion} no pertenece a ${empresa.nombre}.`);
      } else afiliacion = '';
      const mov = { tipo: b.tipo, concepto: b.concepto, fecha: String(b.fecha || ''), cantidad: Number(b.cantidad), costo_unitario: b.tipo === 'entrada' ? b.costo_unitario : undefined,
        proveedor: String(b.proveedor || '').trim(), documento: String(b.documento || '').trim(), destino: String(b.destino || '').trim(), empresa: empresa.nombre, unidad: b.tipo === 'salida' && b.concepto === 'entrega' ? String(b.unidad || '').trim() : '', afiliacion, notas: String(b.notas || '').trim() };
      if (a.serializado) {
        if (!series.length) throw new ErrorInv(422, 'series', 'Este artículo es serializado: captura los números de serie (uno por línea).');
        for (const s of series) if (!SE.SERIE_OK.test(s)) throw new ErrorInv(422, 'series', `La serie «${s}» no es válida (letras, números, punto, guion o diagonal).`);
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
      if (a.serializado) { const er = SE.estadoSeries([...previos, nuevo]).errores[0]; if (er) throw new ErrorInv(409, 'series', er.mensaje + (er.folio === Number.MAX_SAFE_INTEGER ? '' : ` (afecta al folio ${er.folio})`)); }
      const destino = mov.empresa ? `${mov.empresa} / ${mov.unidad}` : mov.destino;
      const ins = await tq(`insert into inv_movimientos (articulo_id, tipo, concepto, fecha, cantidad, costo_unitario, proveedor, documento, destino, notas, empresa_id, empresa, unidad, afiliacion, usuario)
                            values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [articuloId, mov.tipo, mov.concepto, mov.fecha, mov.cantidad, mov.tipo === 'entrada' ? Number(mov.costo_unitario) : null, mov.proveedor || null, mov.documento || null, destino || null, mov.notas || null, empresa.id, mov.empresa || null, mov.unidad || null, mov.afiliacion || null, usuario]);
      const id = Number(ins.rows[0].id);
      for (const s of series) await tq('insert into inv_mov_series (movimiento_id, serie) values ($1, $2)', [id, s]);
      const fila = P.kardex(await movsVigentes(tq, articuloId)).filas.find(f => f.id === id);
      return { id, articulo: a, fila, mov, series };
    });
    const { mov } = out;
    await bit(req, mov.tipo === 'entrada' ? 'inv_entrada' : 'inv_salida', `${out.articulo.sku} · ${P.CONCEPTOS_ENTRADA[mov.concepto] || P.CONCEPTOS_SALIDA[mov.concepto]} · ${mov.cantidad} ${out.articulo.unidad}${mov.tipo === 'entrada' ? ' a ' + mxn(mov.costo_unitario) : ' (costo PEPS ' + mxn(out.fila && out.fila.costo_total) + ')'}${mov.empresa ? ' · ' + mov.empresa + ' / ' + mov.unidad : ''}${out.series.length ? ' · series ' + out.series.slice(0, 5).join(', ') + (out.series.length > 5 ? '…' : '') : ''} · ${mov.fecha}`, { resource_type: 'inventario_admin', resource_id: out.id });
    res.json({ ok: true, id: out.id, costo_total: out.fila ? out.fila.costo_total : null, costo_unitario: out.fila ? out.fila.costo_unitario : null, saldo_cantidad: out.fila ? out.fila.saldo_cantidad : null, saldo_valor: out.fila ? out.fila.saldo_valor : null, consumos: out.fila ? out.fila.consumos : [] });
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
    const arts = (await q('select * from inv_articulos where serializado order by upper(nombre)')).rows;
    const mapa = porArticulo(await movsVigentes(q));
    let filas = [];
    for (const a of arts) {
      if (f.articulo_id && Number(f.articulo_id) !== Number(a.id)) continue;
      for (const s of SE.estadoSeries(mapa.get(Number(a.id)) || []).series.values()) filas.push({ ...s, articulo_id: Number(a.id), sku: a.sku, articulo: a.nombre });
    }
    if (f.estado) filas = filas.filter(s => s.estado === f.estado);
    if (f.empresa) filas = filas.filter(s => nrm(s.empresa).includes(nrm(f.empresa)));
    if (f.q) filas = filas.filter(s => (s.serie + ' ' + s.unidad + ' ' + s.empresa).toLowerCase().includes(String(f.q).toLowerCase()));
    filas = filas.slice(0, 5000);
    // Cruce con las transacciones: ¿esa terminal ha transaccionado y para qué cliente?
    const series = filas.filter(s => s.estado === 'asignada').map(s => s.serie);
    const uso = new Map();
    if (series.length) {
      try {
        const r = (await q(`select upper(trim(terminal)) t, cliente, numero_afiliacion, count(*)::int n, max(fecha) ultima from transacciones where upper(trim(terminal)) = any($1::text[]) group by upper(trim(terminal)), cliente, numero_afiliacion order by max(fecha) desc`, [series])).rows;
        for (const x of r) if (!uso.has(x.t)) uso.set(x.t, { cliente: x.cliente, afiliacion: x.numero_afiliacion, ultima: x.ultima, n: x.n });
      } catch (_e) { /* sin transacciones */ }
    }
    return filas.map(s => { const u = uso.get(s.serie) || null; return { ...s, uso: u, alerta: s.estado === 'asignada' ? (u ? (nrm(u.cliente) !== nrm(s.empresa) ? 'otra_empresa' : null) : 'sin_uso') : null }; });
  }
  app.get(base + '/series', auth, listo503, seguro(async (req, res) => {
    const filas = await listaSeries(req.query || {});
    res.json({ series: filas, resumen: { almacen: filas.filter(s => s.estado === 'almacen').length, asignada: filas.filter(s => s.estado === 'asignada').length, baja: filas.filter(s => s.estado === 'baja').length, otra_empresa: filas.filter(s => s.alerta === 'otra_empresa').length, sin_uso: filas.filter(s => s.alerta === 'sin_uso').length } });
  }));
  app.get(base + '/series.xlsx', auth, listo503, seguro(async (req, res) => {
    const filas = await listaSeries(req.query || {});
    const head = ['Serie', 'Artículo', 'SN', 'Estado', 'Empresa', 'Unidad', 'Afiliación asignada', 'Desde', 'Folio', 'Última transacción', 'Cliente en transacciones', 'Afiliación en transacciones', 'Transacciones', 'Alerta'];
    const est = { almacen: 'En almacén', asignada: 'Asignada', baja: 'Baja' }, al = { otra_empresa: 'Transacciona para otra Empresa', sin_uso: 'Asignada sin transacciones' };
    const buf = X.buildXLSX([{ name: 'TERMINALES', aoa: [head, ...filas.map(s => [s.serie, s.articulo, s.sku, est[s.estado], s.empresa, s.unidad, s.afiliacion, s.desde, s.folio, s.uso ? s.uso.ultima : '', s.uso ? s.uso.cliente : '', s.uso ? s.uso.afiliacion : '', s.uso ? s.uso.n : '', al[s.alerta] || ''])], cols: [{ wch: 22 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 30 }, { wch: 26 }, { wch: 16 }, { wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 30 }, { wch: 18 }, { wch: 12 }, { wch: 30 }] }]);
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
    const arts = req.query.articulo_id ? (await q('select * from inv_articulos where id = $1', [Number(req.query.articulo_id)])).rows : (await q('select * from inv_articulos order by upper(nombre)')).rows;
    const mapa = porArticulo(await movsVigentes(q));
    const head = ['SN', 'Artículo', 'Fecha', 'Folio', 'Tipo', 'Concepto', 'Cantidad', 'Costo unitario', 'Costo total', 'Documento', 'Proveedor', 'Empresa', 'Unidad', 'Afiliación', 'Series', 'Saldo cantidad', 'Saldo valor PEPS', 'Capturó'];
    const rows = [];
    for (const a of arts) for (const f of P.kardex(mapa.get(Number(a.id)) || []).filas) rows.push([a.sku, a.nombre, f.fecha, f.id, f.tipo === 'entrada' ? 'Entrada' : 'Salida', (P.CONCEPTOS_ENTRADA[f.concepto] || P.CONCEPTOS_SALIDA[f.concepto] || f.concepto), f.cantidad, f.costo_unitario, f.costo_total, f.documento || '', f.proveedor || '', f.empresa || '', f.unidad || '', f.afiliacion || '', (f.series || []).join(', '), f.saldo_cantidad, f.saldo_valor, f.usuario]);
    const buf = X.buildXLSX([{ name: 'KARDEX PEPS', aoa: [head, ...rows], cols: [{ wch: 14 }, { wch: 30 }, { wch: 12 }, { wch: 8 }, { wch: 9 }, { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 28 }, { wch: 22 }, { wch: 14 }, { wch: 30 }, { wch: 12 }, { wch: 16 }, { wch: 26 }] }]);
    enviarXLSX(res, `kardex_peps${arts.length === 1 ? '_' + arts[0].sku : ''}_${P.hoyMX()}.xlsx`, buf);
  }));

  /* ---- carga MASIVA (layout) ---- */
  app.get(base + '/layout.xlsx', auth, listo503, seguro(async (_req, res) => {
    const cl = await catalogoClientes(q);
    const ej = cl.empresas[0] ? cl.empresas[0].nombre : 'Nombre de la Empresa (como en Grupos y afiliaciones)';
    const buf = X.buildXLSX([
      { name: 'Instrucciones', aoa: [['Layout de carga masiva · Inventario administrativo'], [''], ['1. Llena «Articulos» (catálogo) y/o «Movimientos» (entradas y salidas). Puedes subir solo una de las dos.'], ['2. Terminales (serializado = SI): una fila por número de serie.'], ['3. Las filas con mismo tipo, concepto, fecha, SN, costo, documento, empresa y unidad forman un solo movimiento.'], ['4. Entrega: Empresa (del catálogo de Grupos) y Unidad del cliente obligatorias; afiliación opcional.'], ['5. Fechas: AAAA-MM-DD o DD/MM/AAAA. Costos sin IVA. Primero se simula y se muestran los errores; si hay uno, no se aplica nada.'], [''], ['Conceptos de entrada: ' + Object.values(P.CONCEPTOS_ENTRADA).join(' · ')], ['Conceptos de salida: ' + Object.values(P.CONCEPTOS_SALIDA).join(' · ')]], cols: [{ wch: 120 }] },
      { name: 'Articulos', aoa: [['sn', 'nombre', 'categoria', 'unidad', 'minimo', 'serializado', 'activo'], ['TERM-001', 'Terminal POS Verifone', 'Terminales', 'pieza', 5, 'SI', 'SI'], ['PAP-001', 'Papel térmico 57 mm', 'Papelería', 'caja', 10, 'NO', 'SI']], cols: [{ wch: 14 }, { wch: 34 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 8 }] },
      { name: 'Movimientos', aoa: [['tipo', 'concepto', 'fecha', 'sn', 'serie', 'cantidad', 'costo_unitario', 'documento', 'proveedor', 'empresa', 'unidad', 'afiliacion', 'notas'],
        ['ENTRADA', 'Compra', '2026-11-01', 'TERM-001', 'SN0001', '', 1850, 'F-1001', 'Proveedor A', '', '', '', ''], ['ENTRADA', 'Compra', '2026-11-01', 'TERM-001', 'SN0002', '', 1850, 'F-1001', 'Proveedor A', '', '', '', ''],
        ['ENTRADA', 'Compra', '2026-11-02', 'PAP-001', '', 20, 95, 'F-1002', 'Proveedor B', '', '', '', ''],
        ['SALIDA', 'Entrega a cliente o área', '2026-11-10', 'TERM-001', 'SN0001', '', '', 'REM-55', '', ej, 'Sucursal Norte', '', ''],
        ['SALIDA', 'Consumo interno', '2026-11-12', 'PAP-001', '', 3, '', '', '', '', '', '', 'Uso en oficina']], cols: [{ wch: 9 }, { wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 30 }, { wch: 22 }, { wch: 14 }, { wch: 24 }] },
      { name: 'Empresas', aoa: [['Empresas del catálogo (usa el nombre exacto)', 'Afiliaciones'], ...cl.empresas.map(e => [e.nombre, e.afiliaciones.join(', ')])], cols: [{ wch: 50 }, { wch: 60 }] }]);
    enviarXLSX(res, 'layout_inventario_administrativo.xlsx', buf);
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
    if (!articulos && !movimientos) {                                                    // CSV o libro de una sola hoja: se decide por sus encabezados
      const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
      const hs = filas.length ? Object.keys(filas[0]).map(LY.normH) : [];
      if (hs.includes('tipo') || hs.includes('serie')) movimientos = filas; else articulos = filas;
    }
    return { hojas: { articulos: articulos || [], movimientos: movimientos || [] }, hash };
  }

  async function contextoLayout(qq) {
    const arts = (await qq('select * from inv_articulos')).rows;
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
    if (!b.aplicar) { const plan = LY.planificar(hojas, await contextoLayout(q)); return res.json({ aplicado: false, ...resumenPlan(plan, hash) }); }
    const usuario = req.user.email || req.user.nombre || '—';
    let aplicado = null;
    const resp = await db.tx(async t => {
      const tq = (s, p) => t.query(s, p || []);
      await tq('select pg_advisory_xact_lock($1::bigint)', [KEY_ALTAS]);
      const pre = await contextoLayout(tq);
      const tocados = [...pre.articulos.values()].map(a => a.id).sort((x, y) => x - y);
      for (const id of tocados) await tq('select pg_advisory_xact_lock($1::bigint)', [KEY + id]);       // candado por artículo (orden fijo: sin interbloqueos)
      const ctx = await contextoLayout(tq);
      const plan = LY.planificar(hojas, ctx);
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
        const ins = await tq(`insert into inv_movimientos (articulo_id, tipo, concepto, fecha, cantidad, costo_unitario, proveedor, documento, destino, notas, empresa_id, empresa, unidad, afiliacion, usuario)
                              values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
          [ids.get(m.sku), m.tipo, m.concepto, m.fecha, m.cantidad, m.tipo === 'entrada' ? m.costo_unitario : null, m.proveedor || null, m.documento || null, destino, m.notas || null, m.empresa_id, m.tipo === 'salida' && m.concepto === 'entrega' ? m.empresa : null, m.tipo === 'salida' && m.concepto === 'entrega' ? m.unidad : null, m.afiliacion || null, usuario]);
        for (const s of m.series) await tq('insert into inv_mov_series (movimiento_id, serie) values ($1,$2)', [Number(ins.rows[0].id), s]);
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
