/* ============================================================================
   public/inventario-admin.js — Pantalla del INVENTARIO ADMINISTRATIVO (método PEPS, captura manual).
   Usa los ayudantes del sistema (el, api, modal, tableWrap, cards, fld, toast, confirmar, pedir, mxn, fmtISO, descargar, errMsg, esc).
   Se registra en window.INV_VISTAS / window.INV_TITULOS; index.html los une a su enrutador.
   ========================================================================= */
(function () {
'use strict';
const BASE = '/api/inventario/admin';
const ST = { clientes: [], serie: { q: '', articulo_id: '', estado: '', empresa: '' }, cat: [], conceptos: { entrada: {}, salida: {} }, arts: [], filtro: { q: '', cat: '', bajo: false, inactivos: false }, mov: { articulo_id: '', tipo: '', desde: '', hasta: '' } };
const puede = () => !!SES && ['admin', 'operador', 'inventario'].includes(SES.rol);
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const n4 = n => Number(n).toLocaleString('es-MX', { maximumFractionDigits: 4 });
const badge = (cls, t) => `<span class="badge ${cls}">${esc(t)}</span>`;
const err = e => toast(e && e.data && e.data.error ? e.data.error : errMsg(e), 'err');

/* ---------- carga ---------- */
async function cargarArticulos() {
  const d = await api('GET', BASE + '/articulos');
  ST.arts = d.articulos; ST.cat = d.categorias; ST.conceptos = d.conceptos;
}

/* ---------- vista principal ---------- */
async function vInvAdmin(v) {
  const acciones = [];
  if (puede()) acciones.push(el('button', { class: 'btn secondary sm', onclick: () => formArticulo(null) }, '+ Artículo'), el('button', { class: 'btn sm', onclick: () => formMovimiento('entrada') }, '↓ Entrada'), el('button', { class: 'btn sm', onclick: () => formMovimiento('salida') }, '↑ Salida'));
  if (puede()) acciones.push(el('button', { class: 'btn secondary sm', onclick: () => cargaMasiva() }, '⬆ Carga masiva'));
  acciones.push(el('button', { class: 'btn ghost sm', onclick: () => descargar(BASE + '/existencias.xlsx', 'existencias_peps.xlsx').catch(err) }, '⬇ Existencias'), el('button', { class: 'btn ghost sm', onclick: () => descargar(BASE + '/kardex.xlsx', 'kardex_peps.xlsx').catch(err) }, '⬇ Kardex'));
  acciones.forEach(a => $('#pageAction').append(a));
  const [res] = await Promise.all([api('GET', BASE + '/resumen'), cargarArticulos()]);
  v.innerHTML = '';
  v.append(cards([
    ['Valor del inventario', mxn(res.valor_total), 'Costeo PEPS'],
    ['Artículos activos', res.articulos, ''],
    ['Bajo el mínimo', res.bajo_minimo.length, res.bajo_minimo.length ? res.bajo_minimo.slice(0, 2).map(a => a.sku).join(', ') + (res.bajo_minimo.length > 2 ? '…' : '') : 'Todo en orden'],
    ['Movimientos del mes', res.entradas_mes + res.salidas_mes, `${res.entradas_mes} entradas · ${res.salidas_mes} salidas`],
    ['Terminales con serie', res.series_almacen + res.series_asignadas, `${res.series_asignadas} asignadas · ${res.series_almacen} en almacén`],
  ]));
  if (res.inconsistentes) v.append(el('div', { class: 'msg err', role: 'alert' }, `${res.inconsistentes} artículo(s) con movimientos incoherentes. Abre su kardex.`));
  const pe = el('div', { class: 'panel' });
  pe.append(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px' }, el('h3', { style: 'margin:0' }, 'Existencias'),
    puede() ? el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, el('button', { class: 'btn', type: 'button', onclick: () => cargaMasiva() }, '⬆ Cargar layout (Excel o CSV)'), el('button', { class: 'btn ghost', type: 'button', onclick: () => descargar(BASE + '/layout.xlsx', 'layout_inventario_administrativo.xlsx').catch(err) }, '⬇ Plantilla del layout')) : ''));
  const fq = el('input', { type: 'search', placeholder: 'SN o nombre', 'aria-label': 'Buscar', value: ST.filtro.q });
  const fc = el('select', { 'aria-label': 'Categoría' }, el('option', { value: '' }, 'Todas las categorías'), ...ST.cat.map(c => el('option', { value: c }, c))); fc.value = ST.filtro.cat;
  const fb = el('input', { type: 'checkbox', id: 'invBajo' }); fb.checked = ST.filtro.bajo;
  const fi = el('input', { type: 'checkbox', id: 'invInact' }); fi.checked = ST.filtro.inactivos;
  const cont = el('div', {});
  const pinta = () => {
    ST.filtro = { q: fq.value, cat: fc.value, bajo: fb.checked, inactivos: fi.checked };
    const q = fq.value.trim().toLowerCase();
    const l = ST.arts.filter(a => (fi.checked || a.activo) && (!fc.value || a.categoria === fc.value) && (!fb.checked || a.bajo_minimo) && (!q || (a.sku + ' ' + a.nombre).toLowerCase().includes(q)));
    cont.innerHTML = '';
    const rows = l.map(a => { const tr = [esc(a.sku), `<b>${esc(a.nombre)}</b>${a.serializado ? ' ' + badge('info', 'con serie') : ''}${a.activo ? '' : ' ' + badge('neutral', 'desactivado')}`, esc(a.categoria || '—'), { num: `${n4(a.existencia)} ${esc(a.unidad)}${a.serializado ? `<div class="muted">${a.asignadas || 0} asignadas</div>` : ''}` }, { num: a.costo_siguiente == null ? '—' : mxn(a.costo_siguiente) }, { num: mxn(a.valor) }, { num: a.minimo ? n4(a.minimo) : '—' }, a.inconsistente ? badge('danger', 'revisar') : a.bajo_minimo ? badge('warn', 'bajo mínimo') : a.existencia > 0 ? badge('ok', 'en stock') : badge('neutral', 'sin existencia')]; tr._onclick = () => abrirKardex(a.id); return tr; });
    cont.append(tableWrap(['SN', 'Artículo', 'Categoría', { t: 'Existencia' }, { t: 'Costo siguiente' }, { t: 'Valor PEPS' }, { t: 'Mínimo' }, 'Estado'], rows, { empty: ST.arts.length ? 'Ningún artículo coincide con el filtro.' : 'Todavía no hay artículos. Crea el primero con «+ Artículo».' }));
  };
  [fq, fc, fb, fi].forEach(x => x.addEventListener('input', pinta)); fc.addEventListener('change', pinta);
  pe.append(el('div', { class: 'filters' }, fld('Buscar', fq), fld('Categoría', fc), el('label', { class: 'chk', for: 'invBajo' }, fb, ' Solo bajo mínimo'), el('label', { class: 'chk', for: 'invInact' }, fi, ' Ver desactivados')), cont);
  v.append(pe); pinta();

  await panelTerminales(v);
  const pm = el('div', { class: 'panel' }); pm.append(el('h3', {}, 'Movimientos'));
  const mA = el('select', { 'aria-label': 'Artículo' }, el('option', { value: '' }, 'Todos los artículos'), ...ST.arts.map(a => el('option', { value: a.id }, a.sku + ' · ' + a.nombre))); mA.value = ST.mov.articulo_id;
  const mT = el('select', { 'aria-label': 'Tipo' }, el('option', { value: '' }, 'Entradas y salidas'), el('option', { value: 'entrada' }, 'Solo entradas'), el('option', { value: 'salida' }, 'Solo salidas')); mT.value = ST.mov.tipo;
  const mD = el('input', { type: 'date', 'aria-label': 'Desde', value: ST.mov.desde }), mH = el('input', { type: 'date', 'aria-label': 'Hasta', value: ST.mov.hasta });
  const lista = el('div', {});
  const cargaMov = async () => {
    ST.mov = { articulo_id: mA.value, tipo: mT.value, desde: mD.value, hasta: mH.value };
    const q = new URLSearchParams(); Object.entries(ST.mov).forEach(([k, x]) => { if (x) q.set(k, x); }); q.set('limite', '100');
    const d = await api('GET', BASE + '/movimientos?' + q);
    lista.innerHTML = '';
    lista.append(tableWrap(['Fecha', 'Folio', 'Artículo', 'Tipo', 'Concepto', { t: 'Cantidad' }, { t: 'Costo unit.' }, { t: 'Costo total' }, 'Documento / destino', 'Capturó'], d.movimientos.map(m => {
      const tr = [fmtISO(m.fecha), String(m.id), `${esc(m.sku)} · ${esc(m.nombre)}`, m.tipo === 'entrada' ? badge('ok', 'Entrada') : badge('info', 'Salida'), esc((ST.conceptos[m.tipo] || {})[m.concepto] || m.concepto), { num: `${n4(m.cantidad)} ${esc(m.unidad)}` }, { num: m.costo_unitario == null ? '—' : mxn(m.costo_unitario) }, { num: m.costo_total == null ? '—' : mxn(m.costo_total) }, esc(m.documento || m.destino || '—') + (m.n_series ? `<div class="muted">${m.n_series} serie(s)</div>` : ''), esc(m.usuario)];
      tr._onclick = () => abrirKardex(m.articulo_id); return tr;
    }), { empty: 'Sin movimientos con ese filtro.' }));
    lista.append(el('div', { class: 'muted', style: 'margin-top:8px' }, 'Se muestran los últimos 100. Clic en un renglón para ver el kardex del artículo.'));
  };
  [mA, mT, mD, mH].forEach(x => x.addEventListener('change', () => cargaMov().catch(err)));
  pm.append(el('div', { class: 'filters' }, fld('Artículo', mA), fld('Tipo', mT), fld('Desde', mD), fld('Hasta', mH)), lista);
  v.append(pm);
  await cargaMov();
}

/* ---------- kardex de un artículo ---------- */
async function abrirKardex(id) {
  let d;
  try { d = await api('GET', `${BASE}/articulos/${id}/kardex`); } catch (e) { return err(e); }
  const a = d.articulo, body = el('div', {});
  body.append(cards([['Existencia', `${n4(a.existencia)} ${a.unidad}`, a.minimo ? `Mínimo ${n4(a.minimo)}` : ''], ['Valor PEPS', mxn(a.valor), `Promedio ${mxn(a.costo_promedio)}`], ['Costo de la siguiente salida', a.costo_siguiente == null ? '—' : mxn(a.costo_siguiente), a.capas ? `${a.capas} capa(s) abierta(s)` : 'Sin capas']]));
  if (d.error) body.append(el('div', { class: 'msg err', role: 'alert' }, `Movimientos incoherentes desde el folio ${d.error.folio} (${fmtISO(d.error.fecha)}): faltan ${n4(d.error.faltante)}.`));
  const quitar = m => puede() ? el('button', { class: 'btn ghost sm', type: 'button', onclick: () => anular(m, id) }, 'Anular') : '';
  body.append(el('h4', {}, 'Kardex (en orden de aplicación)'));
  body.append(tableWrap(['Fecha', 'Folio', 'Tipo', 'Concepto', { t: 'Cantidad' }, { t: 'Costo unit.' }, { t: 'Costo total' }, { t: 'Saldo' }, { t: 'Saldo valor' }, 'Referencia', ''],
    d.filas.map(f => [fmtISO(f.fecha), String(f.id), f.tipo === 'entrada' ? badge('ok', 'Entrada') : badge('info', 'Salida'), esc((ST.conceptos[f.tipo] || {})[f.concepto] || f.concepto), { num: n4(f.cantidad) }, { num: mxn(f.costo_unitario) }, { num: mxn(f.costo_total) }, { num: n4(f.saldo_cantidad) }, { num: mxn(f.saldo_valor) }, esc(f.documento || (f.empresa ? `${f.empresa} / ${f.unidad}` : f.destino) || f.notas || '') + ((f.series || []).length ? `<div class="muted">${esc(f.series.slice(0, 4).join(', '))}${f.series.length > 4 ? '… (' + f.series.length + ')' : ''}</div>` : ''), quitar(f)]),
    { empty: 'Sin movimientos.' }));
  if (d.series && d.series.length) { body.append(el('h4', {}, 'Series')); body.append(tableWrap(['Serie', 'Estado', 'Empresa', 'Unidad', 'Afiliación', 'Desde'], d.series.slice(0, 300).map(s => { const [c, t] = ESTADO_SERIE[s.estado] || ['neutral', s.estado]; return [`<b>${esc(s.serie)}</b>`, badge(c, t), esc(s.empresa || '—'), esc(s.unidad || '—'), esc(s.afiliacion || '—'), fmtISO(s.desde)]; }))); }
  if (d.capas.length) { body.append(el('h4', {}, 'Capas disponibles (se consumen de la más antigua)')); body.append(tableWrap(['Entrada', 'Fecha', { t: 'Original' }, { t: 'Restante' }, { t: 'Costo unit.' }, { t: 'Valor' }], d.capas.map(c => [String(c.id), fmtISO(c.fecha), { num: n4(c.original) }, { num: n4(c.restante) }, { num: mxn(c.costo_unitario) }, { num: mxn(c.restante * c.costo_unitario) }]))); }
  if (d.anulados.length) { const det = el('details', { style: 'margin-top:10px' }, el('summary', {}, `Movimientos anulados (${d.anulados.length})`)); det.append(tableWrap(['Fecha', 'Folio', 'Tipo', { t: 'Cantidad' }, 'Anuló', 'Motivo'], d.anulados.map(m => [fmtISO(m.fecha), String(m.id), m.tipo === 'entrada' ? 'Entrada' : 'Salida', { num: n4(m.cantidad) }, esc(m.anulado_por || ''), esc(m.anulado_motivo || '')]))); body.append(det); }
  const foot = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end' });
  foot.append(el('button', { class: 'btn ghost', onclick: () => descargar(`${BASE}/kardex.xlsx?articulo_id=${id}`, `kardex_${a.sku}.xlsx`).catch(err) }, '⬇ Excel'));
  if (puede()) foot.append(el('button', { class: 'btn secondary', onclick: () => { closeModal(); formArticulo(a); } }, 'Editar artículo'), el('button', { class: 'btn', onclick: () => { closeModal(); formMovimiento('entrada', id); } }, '↓ Entrada'), el('button', { class: 'btn', onclick: () => { closeModal(); formMovimiento('salida', id); } }, '↑ Salida'));
  modal(`${a.sku} · ${a.nombre}`, body, foot, true);
}

async function anular(m, articuloId) {
  const motivo = await pedir(`Anular el folio ${m.id} (${m.tipo === 'entrada' ? 'entrada' : 'salida'} de ${n4(m.cantidad)}). Escribe el motivo (mínimo 10 caracteres): queda en la bitácora y el costo PEPS se recalcula.`, { titulo: 'Anular movimiento', ok: 'Anular' });
  if (!motivo) return;
  try { await api('POST', `${BASE}/movimientos/${m.id}/anular`, { motivo }); toast('Movimiento anulado', 'ok'); closeModal(); await render(); abrirKardex(articuloId); } catch (e) { err(e); }
}

/* ---------- formulario de artículo ---------- */
/* ---------- terminales (series): Empresa y Unidad a la que está asignada cada una ---------- */
const ESTADO_SERIE = { almacen: ['ok', 'En almacén'], asignada: ['info', 'Asignada'], baja: ['neutral', 'Baja'] };
async function panelTerminales(v) {
  if (!ST.arts.some(a => a.serializado)) return;
  const p = el('div', { class: 'panel' }); p.append(el('h3', {}, 'Terminales: Empresa y Unidad asignadas'));
  const fq = el('input', { type: 'search', placeholder: 'Serie, Empresa o Unidad', 'aria-label': 'Buscar', value: ST.serie.q });
  const fa = el('select', { 'aria-label': 'Artículo' }, el('option', { value: '' }, 'Todos'), ...ST.arts.filter(a => a.serializado).map(a => el('option', { value: a.id }, a.sku + ' · ' + a.nombre))); fa.value = ST.serie.articulo_id;
  const fe = el('select', { 'aria-label': 'Estado' }, el('option', { value: '' }, 'Todos los estados'), el('option', { value: 'asignada' }, 'Asignadas'), el('option', { value: 'almacen' }, 'En almacén'), el('option', { value: 'baja' }, 'Bajas')); fe.value = ST.serie.estado;
  const fm = el('input', { type: 'search', placeholder: 'Empresa', 'aria-label': 'Empresa', value: ST.serie.empresa });
  const cont = el('div', {});
  const carga = async () => {
    ST.serie = { q: fq.value, articulo_id: fa.value, estado: fe.value, empresa: fm.value };
    const qs = new URLSearchParams(); Object.entries(ST.serie).forEach(([k, x]) => { if (x) qs.set(k, x); });
    const d = await api('GET', BASE + '/series?' + qs);
    cont.innerHTML = '';
    if (d.resumen.otra_empresa || d.resumen.sin_uso) cont.append(el('div', { class: 'msg', role: 'status' }, `${d.resumen.otra_empresa ? d.resumen.otra_empresa + ' terminal(es) transaccionan para otra Empresa. ' : ''}${d.resumen.sin_uso ? d.resumen.sin_uso + ' asignada(s) todavía sin transacciones.' : ''}`));
    cont.append(tableWrap(['Serie', 'Artículo', 'Estado', 'Empresa', 'Unidad', 'Afiliación', 'Desde', 'Última transacción', ''], d.series.slice(0, 300).map(s => {
      const [c, t] = ESTADO_SERIE[s.estado] || ['neutral', s.estado];
      const tr = [`<b>${esc(s.serie)}</b>`, esc(s.sku), badge(c, t), esc(s.empresa || '—'), esc(s.unidad || '—'), esc(s.afiliacion || '—'), fmtISO(s.desde), s.uso ? `${fmtISO(s.uso.ultima)} · ${esc(s.uso.cliente)}` : '—', s.alerta === 'otra_empresa' ? badge('warn', 'otra Empresa') : s.alerta === 'sin_uso' ? badge('neutral', 'sin uso') : ''];
      tr._onclick = () => abrirKardex(s.articulo_id); return tr;
    }), { empty: 'Sin terminales con ese filtro.' }));
    if (d.series.length > 300) cont.append(el('div', { class: 'muted', style: 'margin-top:8px' }, `Se muestran 300 de ${d.series.length}. Afina el filtro o descarga el Excel.`));
  };
  [fq, fm].forEach(x => x.addEventListener('input', () => { clearTimeout(carga._t); carga._t = setTimeout(() => carga().catch(err), 250); })); [fa, fe].forEach(x => x.addEventListener('change', () => carga().catch(err)));
  const xls = el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { const qs = new URLSearchParams(); Object.entries(ST.serie).forEach(([k, x]) => { if (x) qs.set(k, x); }); descargar(BASE + '/series.xlsx?' + qs, 'terminales_asignadas.xlsx').catch(err); } }, '⬇ Excel');
  p.append(el('div', { class: 'filters' }, fld('Buscar', fq), fld('Artículo', fa), fld('Estado', fe), fld('Empresa', fm), el('span', { class: 'spacer' }), xls), cont);
  v.append(p);
  await carga();
}

function formArticulo(a) {
  const nuevo = !a;
  const sku = el('input', { value: a ? a.sku : '', maxlength: '30', placeholder: 'TERM-001', style: 'text-transform:uppercase' });
  const nombre = el('input', { value: a ? a.nombre : '', maxlength: '140' });
  const cat = el('input', { value: a ? a.categoria : '', list: 'invCats', maxlength: '60', placeholder: 'Terminales, papelería…' });
  const dl = el('datalist', { id: 'invCats' }, ...ST.cat.map(c => el('option', { value: c })));
  const uni = el('input', { value: a ? a.unidad : 'pieza', list: 'invUni', maxlength: '20' });
  const dlu = el('datalist', { id: 'invUni' }, ...['pieza', 'caja', 'paquete', 'rollo', 'juego', 'litro', 'kg'].map(c => el('option', { value: c })));
  const min = el('input', { type: 'number', min: '0', step: 'any', value: a ? a.minimo : '0' });
  const notas = el('textarea', { rows: '2', maxlength: '400' }); notas.value = a ? a.notas : '';
  const act = el('input', { type: 'checkbox', id: 'invAct' }); act.checked = a ? a.activo : true;
  const ser = el('input', { type: 'checkbox', id: 'invSer' }); ser.checked = a ? !!a.serializado : false; if (a && a.movimientos) ser.disabled = true;
  const body = el('div', {}, el('div', { class: 'grid2' }, fld('SN', sku), fld('Unidad', uni)), fld('Nombre', nombre), el('div', { class: 'grid2' }, fld('Categoría', cat), fld('Mínimo (alerta)', min)), fld('Notas', notas), dl, dlu);
  body.append(el('label', { class: 'chk', for: 'invSer', title: 'Cada pieza lleva su número de serie y se asigna a una Empresa y Unidad' }, ser, ' Con número de serie (terminales)' + (a && a.movimientos ? ' · ya tiene movimientos' : '')));
  if (!nuevo) body.append(el('label', { class: 'chk', for: 'invAct' }, act, ' Artículo activo (si lo desactivas ya no recibe movimientos)'));
  const g = el('button', { class: 'btn' }, nuevo ? 'Crear artículo' : 'Guardar');
  g.onclick = async () => { try { await api('POST', BASE + '/articulos', { id: a ? a.id : undefined, sku: sku.value, nombre: nombre.value, categoria: cat.value, unidad: uni.value, minimo: min.value, notas: notas.value, activo: act.checked, serializado: ser.checked }); closeModal(); toast(nuevo ? 'Artículo creado' : 'Guardado', 'ok'); render(); } catch (e) { err(e); } };
  modal(nuevo ? 'Nuevo artículo' : 'Editar artículo', body, el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), ' ', g), false);
}

/* ---------- formulario de movimiento (entrada o salida) ---------- */
async function cargarClientes() { if (!ST.clientes.length) { try { ST.clientes = (await api('GET', BASE + '/clientes')).empresas; } catch (_e) { ST.clientes = []; } } }
async function formMovimiento(tipo, articuloId) {
  if (!ST.arts.length) await cargarArticulos().catch(err);
  await cargarClientes();
  const activos = ST.arts.filter(a => a.activo);
  if (!activos.length) return toast('Primero crea un artículo con «+ Artículo».', 'err');
  const esE = tipo === 'entrada';
  const art = el('select', { 'aria-label': 'Artículo' }, ...activos.map(a => el('option', { value: a.id }, `${a.sku} · ${a.nombre}${a.serializado ? ' (serie)' : ''}`))); if (articuloId) art.value = articuloId;
  const conc = el('select', { 'aria-label': 'Concepto' }, ...Object.entries(ST.conceptos[tipo] || {}).map(([k, t]) => el('option', { value: k }, t)));
  const fecha = el('input', { type: 'date', value: hoyISO(), max: hoyISO() });
  const cant = el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '0' });
  const costo = el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '0.00' });
  const prov = el('input', { maxlength: '120' }), doc = el('input', { maxlength: '80', placeholder: 'Factura, remisión u OC' });
  const notas = el('textarea', { rows: '2', maxlength: '400' });
  const series = el('textarea', { rows: '4', placeholder: 'Una serie por línea (o pega desde Excel)', style: 'font-family:ui-monospace,monospace' });
  const cuentaSeries = el('div', { class: 'muted' });
  const chips = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' });
  const emp = el('select', { 'aria-label': 'Empresa' }, el('option', { value: '' }, 'Elige la Empresa…'), ...ST.clientes.map(c => el('option', { value: c.id }, c.nombre)));
  const uni = el('input', { maxlength: '140', list: 'invUnidades', placeholder: 'Sucursal, plaza o unidad de negocio' }), dlU = el('datalist', { id: 'invUnidades' });
  const afi = el('select', { 'aria-label': 'Afiliación' }, el('option', { value: '' }, '(sin afiliación)'));
  const empNombre = el('input', { maxlength: '140', placeholder: 'Empresa del cliente' });            // solo si el catálogo de Empresas está vacío
  const info = el('div', { class: 'muted', style: 'min-height:20px;margin-top:4px' });
  const cajaCli = el('div', {}, el('div', { class: 'grid2' }, fld('Empresa', ST.clientes.length ? emp : empNombre), fld('Unidad del cliente', uni)), fld('Afiliación (opcional)', afi), dlU);
  const cajaSeries = el('div', {}, fld('Números de serie', series), cuentaSeries, chips);
  const cajaCant = el('div', { class: 'grid2' }, fld('Cantidad', cant), esE ? fld('Costo unitario (sin IVA)', costo) : el('div', {}));
  const cajaDoc = esE ? el('div', { class: 'grid2' }, fld('Documento', doc), fld('Proveedor', prov)) : el('div', {}, fld('Documento o remisión (opcional)', doc));
  let capas = [], libres = [];
  const art0 = () => ST.arts.find(x => String(x.id) === String(art.value));
  const listaSeries = () => series.value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  const cambiaEmpresa = () => {
    const c = ST.clientes.find(x => String(x.id) === String(emp.value));
    dlU.innerHTML = ''; (c ? c.unidades : []).forEach(u => dlU.append(el('option', { value: u })));
    afi.innerHTML = ''; afi.append(el('option', { value: '' }, '(sin afiliación)')); (c ? c.afiliaciones_detalle : []).forEach(a => afi.append(el('option', { value: a.numero }, a.numero + (a.razon_social ? ' · ' + a.razon_social : ''))));
  };
  const visible = () => {
    const a = art0(), entrega = !esE && conc.value === 'entrega', ser = !!(a && a.serializado);
    cajaSeries.style.display = ser ? '' : 'none';
    cajaCli.style.display = entrega ? '' : 'none';
    cajaCant.style.display = ser && !esE ? 'none' : '';                       // salida de serializados: la cantidad sale de las series
    cant.disabled = ser && esE;                                               // entrada de serializados: la cantidad es el número de series
    if (ser && esE) cant.value = listaSeries().length || '';
  };
  const refresca = async () => {
    const a = art0(); visible();
    try { const d = await api('GET', `${BASE}/articulos/${art.value}/kardex`); capas = d.capas; libres = (d.series || []).filter(x => x.estado === 'almacen').map(x => x.serie); } catch (_e) { capas = []; libres = []; }
    chips.innerHTML = '';
    if (!esE && a && a.serializado) { libres.slice(0, 40).forEach(sn => chips.append(el('button', { type: 'button', class: 'btn ghost sm', onclick: () => { const l = listaSeries(); if (!l.includes(sn)) { series.value = (series.value.trim() ? series.value.trim() + '\n' : '') + sn; refresca(); } } }, sn))); if (libres.length > 40) chips.append(el('span', { class: 'muted' }, `…y ${libres.length - 40} más`)); }
    const ls = listaSeries();
    cuentaSeries.textContent = a && a.serializado ? `${ls.length} serie(s)${!esE ? ` · disponibles en almacén: ${libres.length}` : ''}` : '';
    const c = a && a.serializado ? ls.length : Number(cant.value);
    if (a && a.serializado && esE) cant.value = ls.length || '';
    if (esE) info.textContent = c > 0 && costo.value !== '' ? `Total de la entrada: ${mxn(c * Number(costo.value))}` : '';
    else { let falta = c, tot = 0; for (const k of capas) { if (falta <= 0) break; const t = Math.min(falta, k.restante); tot += t * k.costo_unitario; falta -= t; } info.textContent = a ? (c > 0 ? (falta > 1e-9 ? `No alcanza: hay ${n4(a.existencia)} ${a.unidad}.` : `Costo PEPS estimado: ${mxn(tot)} (existencia ${n4(a.existencia)} ${a.unidad})`) : `Existencia: ${n4(a.existencia)} ${a.unidad}`) : ''; }
  };
  [cant, costo, series].forEach(x => x.addEventListener('input', refresca)); art.addEventListener('change', refresca); conc.addEventListener('change', () => { visible(); refresca(); }); emp.addEventListener('change', cambiaEmpresa);
  const body = el('div', {}, fld('Artículo', art), el('div', { class: 'grid2' }, fld('Concepto', conc), fld('Fecha', fecha)), cajaSeries, cajaCant, info, cajaDoc, cajaCli, fld('Notas', notas));
  const g = el('button', { class: 'btn' }, esE ? 'Registrar entrada' : 'Registrar salida');
  g.onclick = async () => {
    g.disabled = true;
    const a = art0(), entrega = !esE && conc.value === 'entrega';
    try {
      const r = await api('POST', BASE + '/movimientos', { articulo_id: Number(art.value), tipo, concepto: conc.value, fecha: fecha.value, cantidad: a && a.serializado ? undefined : cant.value, series: a && a.serializado ? listaSeries() : undefined,
        costo_unitario: esE ? costo.value : undefined, proveedor: prov.value, documento: doc.value, empresa_id: entrega && ST.clientes.length ? emp.value || undefined : undefined, empresa: entrega && !ST.clientes.length ? empNombre.value : undefined, unidad: entrega ? uni.value : undefined, afiliacion: entrega ? afi.value : undefined, notas: notas.value });
      closeModal(); toast(esE ? 'Entrada registrada' : `Salida registrada · costo PEPS ${mxn(r.costo_total)}`, 'ok'); render();
    } catch (e) { err(e); g.disabled = false; }
  };
  modal(esE ? 'Registrar entrada' : 'Registrar salida', body, el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), ' ', g), false);
  cambiaEmpresa(); visible(); refresca();
}

/* ---------- carga masiva (layout Excel o CSV) ---------- */
const aBase64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
function cargaMasiva() {
  const f = el('input', { type: 'file', accept: '.xlsx,.csv,.txt', 'aria-label': 'Archivo' });
  const res = el('div', { style: 'margin-top:12px' });
  const aplicar = el('button', { class: 'btn', disabled: '' }, 'Aplicar carga');
  const revisar = el('button', { class: 'btn secondary' }, 'Revisar archivo');
  let archivo = null, huella = null;
  const pide = async ap => {
    const r = await api('POST', BASE + '/layout', { archivo, nombre: f.files[0].name, aplicar: ap, huella: ap ? huella : undefined });
    return r;
  };
  const pinta = d => {
    res.innerHTML = '';
    const s = d.resumen || {};
    res.append(cards([['Artículos', `${s.articulos_nuevos || 0} nuevos`, `${s.articulos_actualizados || 0} actualizados`], ['Movimientos', s.movimientos || 0, `${s.entradas || 0} entradas · ${s.salidas || 0} salidas`], ['Series', s.unidades || 0, ''], ['Valor de entradas', mxn(s.valor_entradas || 0), `Costo de salidas ${mxn(s.costo_salidas || 0)}`]]));
    if (d.n_errores) res.append(el('div', { class: 'msg err', role: 'alert' }, `${d.n_errores} error(es): no se aplicará nada hasta corregirlos.`), tableWrap(['Hoja', { t: 'Fila' }, 'Qué pasa'], d.errores.map(e => [esc(e.hoja || '—'), { num: String(e.fila || '') }, esc(e.mensaje)])));
    (d.avisos || []).forEach(a => res.append(el('div', { class: 'muted', style: 'margin-top:6px' }, a)));
    if (d.ok) { res.append(el('h4', {}, 'Vista previa de los movimientos')); res.append(tableWrap(['Fecha', 'Tipo', 'Concepto', 'SN', { t: 'Cantidad' }, { t: 'Costo' }, 'Empresa / Unidad'], d.vista.map(m => [fmtISO(m.fecha), m.tipo === 'entrada' ? 'Entrada' : 'Salida', esc((ST.conceptos[m.tipo] || {})[m.concepto] || m.concepto), esc(m.sku), { num: n4(m.cantidad) + (m.series ? ` (${m.series} serie)` : '') }, { num: m.tipo === 'entrada' ? mxn(m.costo_unitario) : (m.costo_total == null ? '—' : mxn(m.costo_total)) }, esc(m.empresa ? `${m.empresa} / ${m.unidad}` : '')]))); }
  };
  revisar.onclick = async () => {
    if (!f.files[0]) return toast('Elige el archivo del layout.', 'err');
    revisar.disabled = true; aplicar.disabled = true;
    try { archivo = aBase64(await f.files[0].arrayBuffer()); const d = await pide(false); huella = d.huella; pinta(d); aplicar.disabled = !d.ok; } catch (e) { err(e); } finally { revisar.disabled = false; }
  };
  aplicar.onclick = async () => {
    aplicar.disabled = true;
    try { const d = await pide(true); closeModal(); toast(`Carga aplicada: ${d.resumen.movimientos} movimientos, ${d.resumen.unidades} series`, 'ok'); ST.arts = []; render(); }
    catch (e) { if (e && e.data && e.data.n_errores) pinta(e.data); err(e); aplicar.disabled = false; }
  };
  f.addEventListener('change', () => { aplicar.disabled = true; res.innerHTML = ''; });
  const body = el('div', {}, el('div', { class: 'muted' }, 'Una hoja «Articulos» y otra «Movimientos». Primero se revisa; si algo falla, no se aplica nada.'),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px' }, el('button', { class: 'btn ghost', type: 'button', onclick: () => descargar(BASE + '/layout.xlsx', 'layout_inventario_administrativo.xlsx').catch(err) }, '⬇ Descargar plantilla'), f, revisar), res);
  modal('Carga masiva de inventario', body, el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cerrar'), ' ', aplicar), true);
}

window.INV_VISTAS = { inv_admin: vInvAdmin };
window.INV_TITULOS = { inv_admin: ['Inventario administrativo', 'Existencias, entradas y salidas con costo PEPS (primeras entradas, primeras salidas)'] };
})();
