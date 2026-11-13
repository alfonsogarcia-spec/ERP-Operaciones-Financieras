'use strict';
/* ============================================================================
   lib/inventario-layout.js — Carga MASIVA del inventario administrativo (Excel o CSV). Puro: planifica sin tocar la base.

   Hojas del layout:
     «Articulos»    sku · nombre · categoria · unidad · minimo · serializado (SI/NO) · activo (SI/NO)
     «Movimientos»  tipo (ENTRADA/SALIDA) · concepto · fecha · sku · serie · cantidad · costo_unitario · documento · proveedor · empresa · unidad · afiliacion · notas
   Una fila de un artículo SERIALIZADO es una serie; las filas con el mismo tipo, concepto, fecha, sku, costo, documento, proveedor, empresa, unidad, afiliación y
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
const COL_MOV = { tipo: 'tipo', concepto: 'concepto', fecha: 'fecha', sn: 'sku', sku: 'sku', codigo: 'sku', serie: 'serie', numero_de_serie: 'serie', cantidad: 'cantidad', costo_unitario: 'costo_unitario', costo: 'costo_unitario', documento: 'documento', factura: 'documento',
  proveedor: 'proveedor', empresa: 'empresa', unidad: 'unidad_cliente', unidad_cliente: 'unidad_cliente', unidad_de_negocio: 'unidad_cliente', afiliacion: 'afiliacion', notas: 'notas', nota: 'notas' };

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

/* ctx = { articulos: Map(SKU → {id, sku, nombre, serializado, ...}), movs: Map(articuloId → [movimientos vigentes con series]), empresas: [{id, nombre, afiliaciones:[numero]}], hoy } */
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
    let cantidad, serie = '';
    if (a.serializado) {
      serie = S.normSerie(f.serie);
      if (!S.SERIE_OK.test(serie)) { err('Movimientos', f.n, `Falta la serie, o trae caracteres no válidos (el artículo ${sku} es serializado: una fila por serie).`); continue; }
      if (txt(f.cantidad) !== '' && aNumero(f.cantidad) !== 1) { err('Movimientos', f.n, 'En un artículo serializado cada fila es UNA serie: la cantidad es 1 o va vacía.'); continue; }
      cantidad = 1;
    } else {
      if (txt(f.serie) !== '') { err('Movimientos', f.n, `El artículo ${sku} no es serializado: quita la serie.`); continue; }
      cantidad = aNumero(f.cantidad);
    }
    const costo = tipo === 'entrada' ? (txt(f.costo_unitario) === '' ? undefined : aNumero(f.costo_unitario)) : undefined;
    let empresa = null, empresa_id = null, afiliacion = '';
    const unidad = txt(f.unidad_cliente);
    if (tipo === 'salida' && concepto === 'entrega') {
      empresa = (ctx.empresas || []).find(e => nrm(e.nombre) === nrm(f.empresa));
      if (!txt(f.empresa)) { err('Movimientos', f.n, 'Una entrega lleva la Empresa a la que se asigna.'); continue; }
      if (!empresa && ctx.empresas && ctx.empresas.length) { err('Movimientos', f.n, `La Empresa «${txt(f.empresa)}» no existe en el catálogo de Grupos y afiliaciones.`); continue; }
      if (!unidad) { err('Movimientos', f.n, 'Una entrega lleva la Unidad del cliente.'); continue; }
      empresa_id = empresa ? empresa.id : null;
      afiliacion = txt(f.afiliacion);
      if (afiliacion && empresa && !empresa.afiliaciones.includes(afiliacion)) { err('Movimientos', f.n, `La afiliación ${afiliacion} no pertenece a ${empresa.nombre}.`); continue; }
    }
    const base = { tipo, concepto, fecha, sku, cantidad, costo_unitario: costo, documento: txt(f.documento), proveedor: txt(f.proveedor), empresa_id, empresa: empresa ? empresa.nombre : (txt(f.empresa) || null), unidad: unidad || null, afiliacion: afiliacion || null, notas: txt(f.notas) };
    const e = P.validarMovimiento({ ...base, destino: '' });
    if (e.length) { err('Movimientos', f.n, e[0]); continue; }
    const clave = JSON.stringify([tipo, concepto, fecha, sku, costo, base.documento, base.proveedor, base.empresa, base.unidad, base.afiliacion, base.notas, a.serializado ? 's' : 'n' + f.n]);
    if (!grupos.has(clave)) grupos.set(clave, { ...base, cantidad: 0, series: [], filas: [] });
    const g = grupos.get(clave);
    g.cantidad = P.r4(g.cantidad + cantidad); g.filas.push(f.n); if (a.serializado) g.series.push(serie);
  }
  const movs = [...grupos.values()];

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
  return crypto.createHash('sha256').update(JSON.stringify([archivoHash, plan.articulos.map(a => [a.sku, a.accion, a.nombre, a.categoria, a.unidad, a.minimo, a.activo, a.serializado]), plan.movimientos.map(m => [m.tipo, m.concepto, m.fecha, m.sku, m.cantidad, m.costo_unitario, m.documento, m.proveedor, m.empresa, m.unidad, m.afiliacion, m.notas, m.series])])).digest('hex').slice(0, 24);
}

module.exports = { planificar, huella, normH, fechaISO, MAX_FILAS, COL_ART, COL_MOV };
