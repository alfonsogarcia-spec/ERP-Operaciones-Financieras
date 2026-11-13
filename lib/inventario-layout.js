'use strict';
/* ============================================================================
   lib/inventario-layout.js — Carga MASIVA del inventario administrativo (Excel o CSV). Puro: planifica sin tocar la base.

   Hojas del layout:
     «Articulos»    sku · nombre · categoria · unidad · minimo · serializado (SI/NO) · activo (SI/NO)
     «Movimientos»  tipo (ENTRADA/SALIDA) · concepto · fecha · sn · serie · cantidad · costo_unitario · documento · proveedor · empresa · unidad · notas
   Una fila de un artículo SERIALIZADO es una serie; las filas con el mismo tipo, concepto, fecha, sn, costo, documento, proveedor, empresa, unidad y
   notas forman UN movimiento. Si algo falla, no se aplica nada: se devuelve cada error con su hoja y su fila.
   ========================================================================= */
const crypto = require('crypto');
const P = require('./inventario-peps.js');
const S = require('./inventario-series.js');

const MAX_FILAS = 5000;
const quita = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const normH = h => quita(h).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const txt = v => (v == null ? '' : String(v).trim());
const nrm = s => quita(s).toLowerCase().replace(/\s+/g, ' ').trim();
const si = v => /^(si|s|1|true|x|yes|y)$/i.test(quita(txt(v)));

const COL_ART = { sn: 'sku', sku: 'sku', codigo: 'sku', nombre: 'nombre', articulo: 'nombre', categoria: 'categoria', unidad: 'unidad', unidad_de_medida: 'unidad', minimo: 'minimo', serializado: 'serializado', activo: 'activo' };
const COL_MOV = { imei: 'imei', tid: 'tid', tipo: 'tipo', concepto: 'concepto', fecha: 'fecha', sn: 'sku', sku: 'sku', codigo: 'sku', serie: 'serie', numero_de_serie: 'serie', cantidad: 'cantidad', costo_unitario: 'costo_unitario', costo: 'costo_unitario', documento: 'documento', factura: 'documento',
  proveedor: 'proveedor', empresa: 'empresa', unidad: 'unidad_cliente', unidad_cliente: 'unidad_cliente', unidad_de_negocio: 'unidad_cliente', notas: 'notas', nota: 'notas' };

function fechaISO(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);   // serie de Excel
  const t = txt(v);
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return t;
}
const aNumero = v => { if (typeof v === 'number') return v; const t = txt(v).replace(/[$,\s]/g, ''); return t === '' ? NaN : Number(t); };

function conceptoDe(tipo, v) {
  const cat = tipo === 'entrada' ? P.CONCEPTOS_ENTRADA : P.CONCEPTOS_SALIDA, t = nrm(v);
  for (const [k, lbl] of Object.entries(cat)) if (nrm(k) === t || nrm(k.replace(/_/g, ' ')) === t || nrm(lbl) === t) return k;
  return null;
}

/* Convierte las filas de una hoja (arreglo de objetos con encabezados originales) a filas con columnas canónicas. Devuelve {filas:[{n, ...}], desconocidas:[]} */
function filasCanonicas(objs, mapa) {
  const desconocidas = new Set();
  const filas = objs.map((o, i) => {
    const f = { n: i + 2 };
    for (const [h, v] of Object.entries(o)) { const c = mapa[normH(h)]; if (c) f[c] = v; else if (normH(h)) desconocidas.add(h); }
    return f;
  }).filter(f => Object.keys(f).some(k => k !== 'n' && txt(f[k]) !== ''));
  return { filas, desconocidas: [...desconocidas] };
}

/* ctx = { articulos: Map(SKU → {id, sku, nombre, serializado, ...}), movs: Map(articuloId → [movimientos vigentes con series]), empresas: [{id, nombre}], hoy } */
function planificar(hojas, ctx) {
  const errores = [], avisos = [];
  const err = (hoja, fila, mensaje) => errores.push({ hoja, fila, mensaje });
  const art = filasCanonicas(hojas.articulos || [], COL_ART), mov = filasCanonicas(hojas.movimientos || [], COL_MOV);
  if (art.filas.length + mov.filas.length === 0) err('', 0, 'El archivo no trae filas en las hojas «Articulos» ni «Movimientos».');
  if (art.filas.length + mov.filas.length > MAX_FILAS) err('', 0, `Demasiadas filas (máximo ${MAX_FILAS} por archivo).`);
  for (const d of art.desconocidas) avisos.push(`Hoja Articulos: la columna «${d}» no se reconoce y se ignora.`);
  for (const d of mov.desconocidas) avisos.push(`Hoja Movimientos: la columna «${d}» no se reconoce y se ignora.`);
  const hoy = ctx.hoy || P.hoyMX();

  /* ---- artículos ---- */
  const arts = new Map();                                                     // SKU → {…, accion}
  for (const [sku, a] of ctx.articulos) arts.set(sku, { ...a, accion: 'sin_cambio', nuevo: false });
  const vistos = new Set();
  const resumenArt = { crear: 0, actualizar: 0 };
  for (const f of art.filas) {
    const sku = txt(f.sku).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._\-]{0,29}$/.test(sku)) { err('Articulos', f.n, 'El SN es obligatorio: letras, números, punto o guion (máximo 30).'); continue; }
    if (vistos.has(sku)) { err('Articulos', f.n, `El SN ${sku} viene repetido en la hoja.`); continue; }
    vistos.add(sku);
    const nombre = txt(f.nombre), unidad = (txt(f.unidad) || 'pieza').toLowerCase(), categoria = txt(f.categoria);
    const minimo = txt(f.minimo) === '' ? 0 : aNumero(f.minimo);
    if (!nombre || nombre.length > 140) { err('Articulos', f.n, 'El nombre es obligatorio (máximo 140 caracteres).'); continue; }
    if (unidad.length > 20) { err('Articulos', f.n, 'La unidad es demasiado larga.'); continue; }
    if (!Number.isFinite(minimo) || minimo < 0) { err('Articulos', f.n, 'El mínimo debe ser un número mayor o igual a cero.'); continue; }
    const serializado = txt(f.serializado) === '' ? undefined : si(f.serializado), activo = txt(f.activo) === '' ? true : si(f.activo);
    const ex = ctx.articulos.get(sku);
    if (ex) {
      if (serializado !== undefined && serializado !== ex.serializado && (ctx.movs.get(ex.id) || []).length) { err('Articulos', f.n, `El artículo ${sku} ya tiene movimientos: no se puede cambiar si es serializado.`); continue; }
      const cambia = ex.nombre !== nombre || (ex.categoria || '') !== categoria || ex.unidad !== unidad || Number(ex.minimo) !== minimo || ex.activo !== activo || (serializado !== undefined && serializado !== ex.serializado);
      arts.set(sku, { ...ex, nombre, categoria, unidad, minimo, activo, serializado: serializado === undefined ? ex.serializado : serializado, accion: cambia ? 'actualizar' : 'sin_cambio', nuevo: false });
      if (cambia) resumenArt.actualizar++;
    } else { arts.set(sku, { id: null, sku, nombre, categoria, unidad, minimo, activo, serializado: !!serializado, accion: 'crear', nuevo: true }); resumenArt.crear++; }
  }

  /* ---- movimientos: filas → movimientos ---- */
  const grupos = new Map();
  for (const f of mov.filas) {
    const tipoT = nrm(f.tipo), tipo = /^(entrada|e)$/.test(tipoT) ? 'entrada' : /^(salida|s)$/.test(tipoT) ? 'salida' : null;
    if (!tipo) { err('Movimientos', f.n, 'El tipo debe ser ENTRADA o SALIDA.'); continue; }
    const concepto = conceptoDe(tipo, f.concepto);
    if (!concepto) { err('Movimientos', f.n, `El concepto «${txt(f.concepto)}» no es válido para ${tipo === 'entrada' ? 'una entrada' : 'una salida'}. Usa: ${Object.values(tipo === 'entrada' ? P.CONCEPTOS_ENTRADA : P.CONCEPTOS_SALIDA).join(', ')}.`); continue; }
    const sku = txt(f.sku).toUpperCase(), a = arts.get(sku);
    if (!a) { err('Movimientos', f.n, `El artículo ${sku || '(vacío)'} no existe: agrégalo en la hoja Articulos o créalo antes.`); continue; }
    if (a.activo === false) { err('Movimientos', f.n, `El artículo ${sku} está desactivado.`); continue; }
    const fecha = fechaISO(f.fecha);
    if (!P.esFecha(fecha)) { err('Movimientos', f.n, 'La fecha no es válida (usa AAAA-MM-DD o DD/MM/AAAA).'); continue; }
    if (fecha > hoy) { err('Movimientos', f.n, 'La fecha no puede ser futura.'); continue; }
    let cantidad, serie = '', imei = '', tid = '';
    if (a.serializado) {
      serie = S.normSerie(f.serie);
      if (!S.SERIE_OK.test(serie)) { err('Movimientos', f.n, `Falta la serie, o trae caracteres no válidos (el artículo ${sku} es serializado: una fila por serie).`); continue; }
      if (txt(f.cantidad) !== '' && aNumero(f.cantidad) !== 1) { err('Movimientos', f.n, 'En un artículo serializado cada fila es UNA serie: la cantidad es 1 o va vacía.'); continue; }
      cantidad = 1;
      imei = S.normId(f.imei); tid = S.normId(f.tid);
      const ei = S.validarIdentificadores({ serie, imei, tid }); if (ei) { err('Movimientos', f.n, ei); continue; }
    } else {
      if (txt(f.imei) !== '' || txt(f.tid) !== '') { err('Movimientos', f.n, `El artículo ${sku} no es serializado: quita el IMEI y el TID.`); continue; }
      if (txt(f.serie) !== '') { err('Movimientos', f.n, `El artículo ${sku} no es serializado: quita la serie.`); continue; }
      cantidad = aNumero(f.cantidad);
    }
    const costo = tipo === 'entrada' ? (txt(f.costo_unitario) === '' ? undefined : aNumero(f.costo_unitario)) : undefined;
    let empresa = null, empresa_id = null;
    const unidad = txt(f.unidad_cliente);
    if (tipo === 'salida' && concepto === 'entrega') {
      empresa = (ctx.empresas || []).find(e => nrm(e.nombre) === nrm(f.empresa));
      if (!txt(f.empresa)) { err('Movimientos', f.n, 'Una entrega lleva la Empresa a la que se asigna.'); continue; }
      if (!empresa && ctx.empresas && ctx.empresas.length) { err('Movimientos', f.n, `La Empresa «${txt(f.empresa)}» no existe en el catálogo de Empresas (Grupos de cliente).`); continue; }
      if (!unidad) { err('Movimientos', f.n, 'Una entrega lleva la Unidad del cliente.'); continue; }
      empresa_id = empresa ? empresa.id : null;
    }
    const base = { tipo, concepto, fecha, sku, cantidad, costo_unitario: costo, documento: txt(f.documento), proveedor: txt(f.proveedor), empresa_id, empresa: empresa ? empresa.nombre : (txt(f.empresa) || null), unidad: unidad || null, notas: txt(f.notas) };
    const e = P.validarMovimiento({ ...base, destino: '' });
    if (e.length) { err('Movimientos', f.n, e[0]); continue; }
    const clave = JSON.stringify([tipo, concepto, fecha, sku, costo, base.documento, base.proveedor, base.empresa, base.unidad, base.notas, a.serializado ? 's' : 'n' + f.n]);
    if (!grupos.has(clave)) grupos.set(clave, { ...base, cantidad: 0, series: [], ids: {}, filas: [] });
    const g = grupos.get(clave);
    g.cantidad = P.r4(g.cantidad + cantidad); g.filas.push(f.n); if (a.serializado) { g.series.push(serie); if (imei || tid) g.ids[serie] = { imei, tid }; }
  }
  const movs = [...grupos.values()];
  for (const [campo, et] of [['imei', 'IMEI'], ['tid', 'TID']]) {
    const visto = new Map();
    for (const m of movs) for (const [sr, v] of Object.entries(m.ids)) if (v[campo]) { const prev = visto.get(v[campo]); if (prev !== undefined && prev !== sr) err('Movimientos', m.filas[0] || 0, `El ${et} ${v[campo]} está en dos equipos distintos (${prev} y ${sr}).`); else visto.set(v[campo], sr); }
  }

  /* ---- simulación: el estado final por artículo debe ser coherente (PEPS y series) ---- */
  let prov = 1e12;
  const finales = new Map();                                                  // sku → movimientos (existentes + nuevos)
  for (const m of movs) {
    const a = arts.get(m.sku);
    if (!finales.has(m.sku)) finales.set(m.sku, (a.id != null ? (ctx.movs.get(a.id) || []) : []).slice());
    m.provId = ++prov; finales.get(m.sku).push({ ...m, id: m.provId, series: m.series });
  }
  for (const [sku, lista] of finales) {
    const a = arts.get(sku), k = P.kardex(lista);
    const filaDe = id => (movs.find(m => m.provId === id) || {}).filas;
    if (k.error) { const fl = filaDe(k.error.folio); err('Movimientos', fl ? fl[0] : 0, `Sin existencia suficiente de ${sku} al ${k.error.fecha}: faltan ${k.error.faltante}${fl ? '' : ` (afecta una salida ya registrada, folio ${k.error.folio})`}.`); continue; }
    if (a.serializado) for (const e of S.estadoSeries(lista).errores) { const fl = filaDe(e.folio); err('Movimientos', fl ? fl[0] : 0, e.mensaje + (fl ? '' : ` (afecta un movimiento ya registrado, folio ${e.folio})`)); }
    for (const m of movs.filter(x => x.sku === sku && x.tipo === 'salida')) { const r = k.filas ? k.filas.find(f => f.id === m.provId) : null; if (r) { m.costo_total = r.costo_total; m.costo_unitario_peps = r.costo_unitario; } }
  }

  const ent = movs.filter(m => m.tipo === 'entrada'), sal = movs.filter(m => m.tipo === 'salida');
  const unidadesNuevas = [...new Set(movs.filter(m => m.unidad && m.empresa).map(m => `${m.empresa} / ${m.unidad}`))].filter(x => !(ctx.unidadesConocidas || new Set()).has(x));
  if (unidadesNuevas.length) avisos.push(`Unidades nuevas para su Empresa (revisa que no sean errores de captura): ${unidadesNuevas.slice(0, 8).join('; ')}${unidadesNuevas.length > 8 ? '…' : ''}.`);
  const plan = {
    ok: errores.length === 0 && (movs.length > 0 || resumenArt.crear + resumenArt.actualizar > 0), errores, avisos,
    resumen: { articulos_nuevos: resumenArt.crear, articulos_actualizados: resumenArt.actualizar, movimientos: movs.length, entradas: ent.length, salidas: sal.length, unidades: movs.reduce((s, m) => s + (m.series.length || 0), 0), valor_entradas: P.r2(ent.reduce((s, m) => s + m.cantidad * (m.costo_unitario || 0), 0)), costo_salidas: P.r2(sal.reduce((s, m) => s + (m.costo_total || 0), 0)) },
    articulos: [...arts.values()].filter(a => a.accion !== 'sin_cambio'), movimientos: movs, desconocidas: { articulos: art.desconocidas, movimientos: mov.desconocidas } };
  return plan;
}

function huella(archivoHash, plan) {
  return crypto.createHash('sha256').update(JSON.stringify([archivoHash, plan.articulos.map(a => [a.sku, a.accion, a.nombre, a.categoria, a.unidad, a.minimo, a.activo, a.serializado]), plan.movimientos.map(m => [m.tipo, m.concepto, m.fecha, m.sku, m.cantidad, m.costo_unitario, m.documento, m.proveedor, m.empresa, m.unidad, m.notas, m.series, m.ids])])).digest('hex').slice(0, 24);
}


/* ============================================================================
   Layout SIMPLE (una sola hoja «Terminales»): una fila por terminal.
     serie (SN) · modelo · costo · fecha_compra · documento · proveedor · empresa · unidad · fecha_entrega · notas
   Cada fila da de alta la terminal (entrada) y, si trae Empresa y Unidad, también su entrega. El modelo que no exista se crea solo (con número de serie).
   Internamente se convierte a las hojas Articulos/Movimientos y se reutiliza el mismo planificador (mismas validaciones, PEPS y series).
   ========================================================================= */
const COL_SIMPLE = { imei: 'imei', tid: 'tid', serie: 'serie', sn: 'serie', numero_de_serie: 'serie', n_serie: 'serie', no_de_serie: 'serie', modelo: 'modelo', equipo: 'modelo', terminal: 'modelo', articulo: 'modelo', codigo: 'codigo',
  costo: 'costo', costo_unitario: 'costo', precio: 'costo', costo_sin_iva: 'costo', fecha_compra: 'fecha_compra', fecha_de_compra: 'fecha_compra', fecha: 'fecha_compra', documento: 'documento', factura: 'documento', proveedor: 'proveedor',
  empresa: 'empresa', cliente: 'empresa', unidad: 'unidad', unidad_cliente: 'unidad', sucursal: 'unidad', unidad_de_negocio: 'unidad', fecha_entrega: 'fecha_entrega', fecha_de_entrega: 'fecha_entrega', notas: 'notas', nota: 'notas' };

function planificarSimple(objs, ctx) {
  const { filas, desconocidas } = filasCanonicas(objs, COL_SIMPLE);
  const arts = [], artOrig = [], movs = [], movOrig = [], previos = [];
  const porNombre = new Map(); for (const a of ctx.articulos.values()) porNombre.set(nrm(a.nombre), a.sku);
  const usados = new Set(ctx.articulos.keys());
  const nuevos = new Map();                                                   // modelo normalizado → código creado en este archivo
  const hoy = ctx.hoy || P.hoyMX();
  const codigoDe = modelo => { let base = quita(modelo).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'TERMINAL', c = base, i = 1; while (usados.has(c)) c = `${base}-${++i}`; usados.add(c); return c; };
  const mal = (n, mensaje) => previos.push({ hoja: 'Terminales', fila: n, mensaje });
  if (!filas.length) mal(0, 'El archivo no trae filas en la hoja «Terminales».');
  for (const f of filas) {
    const modelo = txt(f.modelo), serie = S.normSerie(f.serie);
    if (!S.SERIE_OK.test(serie)) { mal(f.n, 'Falta el SN (número de serie), o trae caracteres no válidos.'); continue; }
    if (!modelo) { mal(f.n, 'Falta el modelo (nombre del equipo).'); continue; }
    let sku = txt(f.codigo).toUpperCase() || porNombre.get(nrm(modelo)) || nuevos.get(nrm(modelo));
    const ex = sku ? ctx.articulos.get(sku) : null;
    if (ex && !ex.serializado) { mal(f.n, `El modelo «${modelo}» ya existe como artículo SIN número de serie: no se puede cargar por SN.`); continue; }
    if (!ex && !(sku && [...nuevos.values()].includes(sku))) {
      if (!sku) sku = codigoDe(modelo); else usados.add(sku);
      nuevos.set(nrm(modelo), sku); arts.push({ sn: sku, nombre: modelo, categoria: 'Terminales', unidad: 'pieza', serializado: 'SI', activo: 'SI' }); artOrig.push(f.n);
    }
    const costo = txt(f.costo) === '' ? NaN : aNumero(f.costo);
    if (!Number.isFinite(costo) || costo < 0) { mal(f.n, 'Falta el costo (sin IVA); si fue donación, pon 0.'); continue; }
    const fc = fechaISO(f.fecha_compra);
    if (!P.esFecha(fc)) { mal(f.n, 'La fecha de compra no es válida (usa AAAA-MM-DD o DD/MM/AAAA).'); continue; }
    const empresa = txt(f.empresa), unidad = txt(f.unidad);
    if (unidad && !empresa) { mal(f.n, 'Trae Unidad pero falta la Empresa.'); continue; }
    if (empresa && !unidad) { mal(f.n, 'Trae Empresa pero falta la Unidad.'); continue; }
    const doc = txt(f.documento);
    movs.push({ tipo: 'ENTRADA', concepto: doc ? 'Compra' : 'Inventario inicial', fecha: fc, sn: sku, serie, imei: txt(f.imei), tid: txt(f.tid), costo_unitario: costo, documento: doc, proveedor: txt(f.proveedor), notas: txt(f.notas) }); movOrig.push(f.n);
    if (empresa) {
      const fe = txt(f.fecha_entrega) === '' ? fc : fechaISO(f.fecha_entrega);
      if (!P.esFecha(fe)) { previos.push({ hoja: 'Terminales', fila: f.n, mensaje: 'La fecha de entrega no es válida.' }); continue; }
      if (fe < fc) { previos.push({ hoja: 'Terminales', fila: f.n, mensaje: 'La fecha de entrega es anterior a la de compra.' }); continue; }
      movs.push({ tipo: 'SALIDA', concepto: 'Entrega a cliente o área', fecha: fe, sn: sku, serie, empresa, unidad, notas: '' }); movOrig.push(f.n);
    }
  }
  const plan = planificar({ articulos: arts, movimientos: movs }, { ...ctx, hoy });
  const traduce = e => ({ hoja: 'Terminales', fila: e.hoja === 'Movimientos' ? (movOrig[e.fila - 2] || 0) : e.hoja === 'Articulos' ? (artOrig[e.fila - 2] || 0) : e.fila, mensaje: e.mensaje });
  plan.errores = [...previos, ...plan.errores.map(traduce)].filter((e, i, a) => a.findIndex(x => x.fila === e.fila && x.mensaje === e.mensaje) === i).sort((x, y) => x.fila - y.fila);
  plan.avisos = plan.avisos.filter(a => !/^Hoja (Articulos|Movimientos)/.test(a));
  for (const d of desconocidas) plan.avisos.push(`La columna «${d}» no se reconoce y se ignora.`);
  plan.ok = plan.errores.length === 0 && plan.movimientos.length > 0;
  return plan;
}

module.exports = { planificar, planificarSimple, huella, normH, fechaISO, MAX_FILAS, COL_ART, COL_MOV };
