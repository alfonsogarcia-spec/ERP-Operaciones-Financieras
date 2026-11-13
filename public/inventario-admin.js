/* ============================================================================
   public/inventario-admin.js — Pantalla del INVENTARIO ADMINISTRATIVO.
   Metodologías: serialización unitaria (S/N · IMEI · TID) · PEPS/FIFO (costo y rotación física) · conteo cíclico con ABC · punto de reorden + stock de seguridad.
   Usa los ayudantes del sistema (el, api, modal, tableWrap, cards, fld, toast, confirmar, pedir, zonaArchivos, mxn, fmtISO, descargar, errMsg, esc).
   Se registra en window.INV_VISTAS / window.INV_TITULOS; index.html los une a su enrutador.
   ========================================================================= */
(function () {
'use strict';
const BASE = '/api/inventario/admin';
const ST = { tab: 'tablero', irA: null, clientes: [], serie: { q: '', articulo_id: '', estado: '', empresa: '', con_fallas: false, sobre_limite: false }, cat: [], conceptos: { entrada: {}, salida: {} }, arts: [],
  filtro: { q: '', cat: '', alerta: false, inactivos: false }, mov: { articulo_id: '', tipo: '', desde: '', hasta: '' }, rep: { estado: '' } };
const puede = () => !!SES && ['admin', 'operador', 'inventario'].includes(SES.rol);
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const n4 = n => Number(n).toLocaleString('es-MX', { maximumFractionDigits: 4 });
const badge = (cls, t) => `<span class="badge ${cls}">${esc(t)}</span>`;
const err = e => toast(e && e.data && e.data.error ? e.data.error : errMsg(e), 'err');
const fila = (txt, ...xs) => el('div', { class: 'muted', style: 'margin-top:8px' }, txt, ...xs);

const CLASE = { A: 'violet', B: 'info', C: 'neutral' };
const claseBadge = c => (c ? badge(CLASE[c] || 'neutral', c) : '');
const REO = { urgente: ['danger', 'Urgente'], reordenar: ['warn', 'Reordenar'], ok: ['ok', 'Suficiente'], sin_consumo: ['neutral', 'Sin consumo'] };
const PCI = { vencida: ['danger', 'Vencida'], por_vencer: ['warn', 'Por vencer'], vigente: ['ok', 'Vigente'] };
const ESTADO_SERIE = { almacen: ['ok', 'En almacén'], asignada: ['info', 'Asignada'], baja: ['neutral', 'Baja'] };
const dd = n => (n == null ? '—' : `${n4(n)} d`);
const reoBadge = r => (r && REO[r.estado] ? badge(REO[r.estado][0], REO[r.estado][1]) : '');
const pciBadge = p => (p && PCI[p.estado] ? badge(PCI[p.estado][0], PCI[p.estado][1]) : '');
const barra = (pct, color) => `<div style="height:8px;border-radius:99px;background:var(--glass-2)"><div style="height:8px;border-radius:99px;width:${Math.max(0, Math.min(100, pct))}%;background:${color}"></div></div>`;
const compacta = w => { const t = w.querySelector('table'); if (t) t.style.minWidth = '0'; return w; };                    // tablas de paneles a media columna: sin el ancho mínimo general
const panel = (titulo, ...hijos) => el('div', { class: 'panel' }, el('h3', {}, titulo), ...hijos);
const panelConLink = (titulo, linkTxt, tab, ...hijos) => el('div', { class: 'panel' }, el('h3', {}, titulo, el('span', { class: 'right' }, el('button', { class: 'btn ghost sm', type: 'button', onclick: () => ST.irA(tab) }, linkTxt))), ...hijos);

/* ---------- carga ---------- */
async function cargarArticulos() {
  const d = await api('GET', BASE + '/articulos');
  ST.arts = d.articulos; ST.cat = d.categorias; ST.conceptos = d.conceptos;
}

/* ---------- vista principal: una pestaña por metodología ---------- */
const TABS = [['tablero', 'Tablero'], ['existencias', 'Existencias'], ['equipos', 'Equipos'], ['reposicion', 'Reposición'], ['conteo', 'Conteo cíclico'], ['movimientos', 'Movimientos']];
const PINTA = { tablero: tTablero, existencias: tExistencias, equipos: tEquipos, reposicion: tReposicion, conteo: tConteo, movimientos: tMovimientos };
async function vInvAdmin(v) {
  if (puede()) ['↓ Entrada', '↑ Salida', '⬆ Subir layout', '+ Artículo'].forEach((t, i) => $('#pageAction').append(el('button', { class: i === 3 ? 'btn secondary sm' : 'btn sm', onclick: () => [() => formMovimiento('entrada'), () => formMovimiento('salida'), cargaMasiva, () => formArticulo(null)][i]() }, t)));
  $('#pageAction').append(el('button', { class: 'btn ghost sm', onclick: () => descargar(BASE + '/layout.xlsx', 'layout_terminales_inventario.xlsx').catch(err) }, '⬇ Plantilla'));
  await cargarArticulos();
  v.innerHTML = '';
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const cont = el('div', {});
  let n = 0;
  const pinta = async () => {
    const mio = ++n;
    [...tabs.children].forEach(b => { const on = b.dataset.t === ST.tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    cont.innerHTML = '';
    const tmp = el('div', {});
    try { await PINTA[ST.tab](tmp); } catch (e) { err(e); }
    if (mio === n) { cont.innerHTML = ''; cont.append(tmp); }                          // si cambió de pestaña mientras cargaba, gana la última
  };
  ST.irA = k => { ST.tab = k; pinta(); };
  TABS.forEach(([k, t]) => tabs.append(el('button', { class: 'tab', type: 'button', role: 'tab', 'data-t': k, onclick: () => ST.irA(k) }, t)));
  v.append(tabs, cont);
  await pinta();
}

/* ============================ TABLERO ============================ */
async function tTablero(c) {
  const [d, res] = await Promise.all([api('GET', BASE + '/tablero'), api('GET', BASE + '/resumen')]);
  const urg = d.reorden.filter(x => x.estado === 'urgente').length, vencidas = d.pci.filter(x => x.estado === 'vencida').length;
  c.append(cards([
    ['Valor del inventario', mxn(res.valor_total), 'Costeo PEPS'],
    ['Por reordenar', d.reorden.length, urg ? `${urg} urgente(s)` : 'Ninguno urgente'],
    ['Certificación PCI PTS', d.pci.length, d.pci.length ? `${vencidas} vencida(s)` : 'Todo vigente'],
    ['Equipos envejeciendo', d.antiguedad.sobre_limite, `de ${d.antiguedad.total} en almacén`],
    ['Por contar', d.conteo_vencido, d.conteo.abierto ? 'Hay un conteo abierto' : 'artículos'],
  ]));
  if (res.inconsistentes) c.append(el('div', { class: 'msg err', role: 'alert' }, `${res.inconsistentes} artículo(s) con movimientos incoherentes. Abre su kardex.`));
  if (d.fifo_excepciones_30d) c.append(el('div', { class: 'msg', role: 'status' }, `${d.fifo_excepciones_30d} entrega(s) de los últimos 30 días salieron fuera del orden PEPS con justificación. Búscalas en Movimientos.`));

  const rep = panelConLink('Reposición: qué pedir', 'Ver todo', 'reposicion', compacta(tableWrap(['Artículo', { t: 'Existencia' }, { t: 'Pedir' }, 'Estado'],
    d.reorden.slice(0, 6).map(a => { const tr = [`<b>${esc(a.nombre)}</b><div class="muted">${esc(a.sku)} · punto de reorden ${n4(a.punto_reorden)}</div>`, { num: `${n4(a.existencia)} ${esc(a.unidad)}` }, { num: `<b>${n4(a.sugerido)}</b>` }, reoBadge(a)]; tr._onclick = () => ST.irA('reposicion'); return tr; }),
    { empty: 'Nada por reordenar: todo supera su punto de reorden.' })));
  const pci = panelConLink('Certificación PCI PTS', 'Ver modelos', 'existencias', compacta(tableWrap(['Modelo', 'Vence', 'Estado'],
    d.pci.slice(0, 6).map(a => [`<b>${esc(a.nombre)}</b><div class="muted">${a.en_almacen} en almacén</div>`, fmtISO(a.vence), `${pciBadge(a)}<div class="muted">${a.dias < 0 ? 'hace ' + (-a.dias) : 'en ' + a.dias} días</div>`]),
    { empty: 'Sin certificaciones por vencer. Captura la vigencia PCI PTS en cada modelo de terminal.' })));
  c.append(el('div', { class: 'grid2' }, rep, pci));

  const maxN = Math.max(1, ...d.antiguedad.tramos.map(t => t.n));
  const ant = panelConLink('Antigüedad en almacén', 'Ver equipos', 'equipos',
    el('div', { html: d.antiguedad.tramos.map(t => `<div style="display:grid;grid-template-columns:110px 1fr 40px;gap:10px;align-items:center;margin-bottom:8px"><span>${esc(t.etiqueta)}</span>${barra(t.n / maxN * 100, 'var(--accent-fill)')}<b style="text-align:right">${t.n}</b></div>`).join('') }),
    d.antiguedad.mas_antiguas.length ? compacta(tableWrap(['Equipo', { t: 'En almacén' }], d.antiguedad.mas_antiguas.slice(0, 5).map(u => { const tr = [`<b>${esc(u.serie)}</b><div class="muted">${esc(u.articulo)}</div>`, { num: `${u.dias} d${u.sobre_limite ? '<div>' + badge('warn', 'pasado') + '</div>' : ''}` }]; tr._onclick = () => fichaEquipo(u.articulo_id, u.serie); return tr; }))) : fila('No hay equipos en almacén.'));
  const cnt = panelConLink('Conteo cíclico', d.conteo.abierto ? 'Continuar conteo' : 'Iniciar conteo', 'conteo', compacta(tableWrap(['ABC', 'Artículo'],
    d.conteo.propuesta.slice(0, 6).map(a => [claseBadge(a.clase), `<b>${esc(a.nombre)}</b><div class="muted">${a.ultimo_conteo ? 'Último conteo ' + fmtISO(a.ultimo_conteo) + ' · hace ' + a.dias_sin_contar + ' d' : 'Nunca se ha contado'}</div>`]),
    { empty: 'Nada toca contar todavía según la clase de cada artículo.' })));
  c.append(el('div', { class: 'grid2' }, ant, cnt));

  const abc = el('div', {}, tableWrap(['Clase', { t: 'Artículos' }, { t: 'Consumo 12 meses' }, { t: 'En existencia' }, 'Se cuenta cada'], ['A', 'B', 'C'].map(k => [claseBadge(k), { num: String(d.abc[k].n) }, { num: mxn(d.abc[k].consumo) }, { num: mxn(d.abc[k].existencia) }, k === 'A' ? '30 días' : k === 'B' ? '90 días' : '180 días'])),
    fila('A = el 80 % del consumo valuado · B = el siguiente 15 % · C = el resto.'));
  c.append(panel('Clasificación ABC', abc));
}

/* ============================ EXISTENCIAS ============================ */
async function tExistencias(c) {
  const pe = el('div', { class: 'panel' });
  pe.append(el('h3', {}, 'Existencias', el('span', { class: 'right' }, el('button', { class: 'btn ghost sm', onclick: () => descargar(BASE + '/existencias.xlsx', 'existencias_peps.xlsx').catch(err) }, '⬇ Existencias'), el('button', { class: 'btn ghost sm', onclick: () => descargar(BASE + '/kardex.xlsx', 'kardex_peps.xlsx').catch(err) }, '⬇ Kardex'))));
  const fq = el('input', { type: 'search', placeholder: 'SN o nombre', 'aria-label': 'Buscar', value: ST.filtro.q });
  const fc = el('select', { 'aria-label': 'Categoría' }, el('option', { value: '' }, 'Todas las categorías'), ...ST.cat.map(x => el('option', { value: x }, x))); fc.value = ST.filtro.cat;
  const fb = el('input', { type: 'checkbox', id: 'invBajo' }); fb.checked = ST.filtro.alerta;
  const fi = el('input', { type: 'checkbox', id: 'invInact' }); fi.checked = ST.filtro.inactivos;
  const cont = el('div', {});
  const pinta = () => {
    ST.filtro = { q: fq.value, cat: fc.value, alerta: fb.checked, inactivos: fi.checked };
    const q = fq.value.trim().toLowerCase();
    const alerta = a => a.bajo_minimo || (a.reorden && ['urgente', 'reordenar'].includes(a.reorden.estado)) || (a.pci && a.pci.estado === 'vencida');
    const l = ST.arts.filter(a => (fi.checked || a.activo) && (!fc.value || a.categoria === fc.value) && (!fb.checked || alerta(a)) && (!q || (a.sku + ' ' + a.nombre).toLowerCase().includes(q)));
    cont.innerHTML = '';
    const rows = l.map(a => {
      const estado = a.inconsistente ? badge('danger', 'revisar') : a.pci && a.pci.estado === 'vencida' ? badge('danger', 'PCI vencida') : a.reorden && a.reorden.estado !== 'ok' && a.reorden.estado !== 'sin_consumo' ? reoBadge(a.reorden) : a.bajo_minimo ? badge('warn', 'bajo mínimo') : a.existencia > 0 ? badge('ok', 'en stock') : badge('neutral', 'sin existencia');
      const extra = a.serializado ? `<div class="muted">${a.en_almacen || 0} en almacén · ${a.asignadas || 0} asignadas${a.sobre_limite ? ' · ' + a.sobre_limite + ' envejeciendo' : ''}</div>` : '';
      const tr = [esc(a.sku), `<b>${esc(a.nombre)}</b>${a.serializado ? ' ' + badge('info', 'con serie') : ''}${a.activo ? '' : ' ' + badge('neutral', 'desactivado')}<div class="muted">${esc(a.categoria || '')}</div>`, claseBadge(a.clase), { num: `${n4(a.existencia)} ${esc(a.unidad)}${extra}` }, { num: a.costo_siguiente == null ? '—' : mxn(a.costo_siguiente) }, { num: mxn(a.valor) }, { num: a.reorden ? n4(a.reorden.punto_reorden) : '—' }, estado];
      tr._onclick = () => abrirKardex(a.id); return tr;
    });
    cont.append(tableWrap(['SN', 'Artículo', 'ABC', { t: 'Existencia' }, { t: 'Costo siguiente' }, { t: 'Valor PEPS' }, { t: 'Punto de reorden' }, 'Estado'], rows, { empty: ST.arts.length ? 'Ningún artículo coincide con el filtro.' : 'Todavía no hay artículos. Crea el primero con «+ Artículo».' }));
  };
  [fq, fc, fb, fi].forEach(x => x.addEventListener('input', pinta)); fc.addEventListener('change', pinta);
  pe.append(el('div', { class: 'filters' }, fld('Buscar', fq), fld('Categoría', fc), el('label', { class: 'chk', for: 'invBajo' }, fb, ' Solo con alerta'), el('label', { class: 'chk', for: 'invInact' }, fi, ' Ver desactivados')), cont);
  c.append(pe); pinta();
}

/* ============================ EQUIPOS (serialización unitaria) ============================ */
async function tEquipos(c) {
  if (!ST.arts.some(a => a.serializado)) { c.append(panel('Equipos', fila('Todavía no hay artículos con número de serie. Crea un modelo con «+ Artículo» y marca «Con número de serie», o sube el layout de terminales.'))); return; }
  const p = el('div', { class: 'panel' }); p.append(el('h3', {}, 'Equipos: S/N · IMEI · TID'));
  const fq = el('input', { type: 'search', placeholder: 'S/N, IMEI, TID, Empresa o Unidad', 'aria-label': 'Buscar', value: ST.serie.q });
  const fa = el('select', { 'aria-label': 'Modelo' }, el('option', { value: '' }, 'Todos los modelos'), ...ST.arts.filter(a => a.serializado).map(a => el('option', { value: a.id }, a.sku + ' · ' + a.nombre))); fa.value = ST.serie.articulo_id;
  const fe = el('select', { 'aria-label': 'Estado' }, el('option', { value: '' }, 'Todos los estados'), el('option', { value: 'asignada' }, 'Asignadas'), el('option', { value: 'almacen' }, 'En almacén'), el('option', { value: 'baja' }, 'Bajas')); fe.value = ST.serie.estado;
  const fm = el('input', { type: 'search', placeholder: 'Empresa', 'aria-label': 'Empresa', value: ST.serie.empresa });
  const ff = el('input', { type: 'checkbox', id: 'invFallas' }); ff.checked = ST.serie.con_fallas;
  const fo = el('input', { type: 'checkbox', id: 'invEnvej' }); fo.checked = ST.serie.sobre_limite;
  const cont = el('div', {});
  const qs = () => { const q = new URLSearchParams(); Object.entries(ST.serie).forEach(([k, x]) => { if (x) q.set(k, x === true ? '1' : x); }); return q; };
  const carga = async () => {
    ST.serie = { q: fq.value, articulo_id: fa.value, estado: fe.value, empresa: fm.value, con_fallas: ff.checked, sobre_limite: fo.checked };
    const d = await api('GET', BASE + '/series?' + qs());
    cont.innerHTML = '';
    const r = d.resumen;
    if (r.otra_empresa || r.sin_uso || r.sobre_limite) cont.append(el('div', { class: 'msg', role: 'status' }, [r.otra_empresa ? `${r.otra_empresa} transaccionan para otra Empresa` : '', r.sin_uso ? `${r.sin_uso} asignadas sin transacciones` : '', r.sobre_limite ? `${r.sobre_limite} pasadas del tiempo máximo en almacén` : ''].filter(Boolean).join(' · ') + '.'));
    cont.append(tableWrap(['S/N', 'IMEI', 'TID', 'Modelo', 'Estado', 'Empresa / Unidad', { t: 'En almacén' }, { t: 'Fallas' }, ''], d.series.slice(0, 300).map(s => {
      const [k, t] = ESTADO_SERIE[s.estado] || ['neutral', s.estado];
      const tr = [`<b>${esc(s.serie)}</b>`, esc(s.imei || '—'), esc(s.tid || '—'), esc(s.articulo), badge(k, t), s.empresa ? `${esc(s.empresa)}<div class="muted">${esc(s.unidad)}</div>` : '—',
        { num: s.dias_almacen == null ? '—' : `${s.dias_almacen} d${s.sobre_limite ? ' ' + badge('warn', 'pasado') : ''}` }, { num: s.fallas ? badge('danger', String(s.fallas)) : '—' }, s.alerta === 'otra_empresa' ? badge('warn', 'otra Empresa') : s.alerta === 'sin_uso' ? badge('neutral', 'sin uso') : ''];
      tr._onclick = () => fichaEquipo(s.articulo_id, s.serie); return tr;
    }), { empty: 'Sin equipos con ese filtro.' }));
    if (d.series.length > 300) cont.append(fila(`Se muestran 300 de ${d.series.length}. Afina el filtro o descarga el Excel.`));
  };
  [fq, fm].forEach(x => x.addEventListener('input', () => { clearTimeout(carga._t); carga._t = setTimeout(() => carga().catch(err), 250); })); [fa, fe, ff, fo].forEach(x => x.addEventListener('change', () => carga().catch(err)));
  const xls = el('button', { class: 'btn ghost sm', type: 'button', onclick: () => descargar(BASE + '/series.xlsx?' + qs(), 'equipos.xlsx').catch(err) }, '⬇ Excel');
  p.append(el('div', { class: 'filters' }, fld('Buscar', fq), fld('Modelo', fa), fld('Estado', fe), fld('Empresa', fm), el('label', { class: 'chk', for: 'invFallas' }, ff, ' Con fallas'), el('label', { class: 'chk', for: 'invEnvej' }, fo, ' Envejeciendo'), el('span', { class: 'spacer' }), xls), cont);
  c.append(p);
  await carga();
}

/* ---------- ficha de un equipo: identificadores, historial de asignación y de fallas ---------- */
async function fichaEquipo(articuloId, serie) {
  let d;
  try { d = await api('GET', `${BASE}/unidades/${articuloId}/${encodeURIComponent(serie)}`); } catch (e) { return err(e); }
  const u = d.unidad, [k, t] = ESTADO_SERIE[u.estado] || ['neutral', u.estado], body = el('div', {});
  const reabrir = () => { closeModal(); fichaEquipo(articuloId, serie); };
  body.append(cards([['Estado', t, u.empresa ? `${u.empresa} / ${u.unidad}` : u.estado === 'almacen' ? 'Disponible' : ''], ['En almacén', u.dias_almacen == null ? '—' : `${u.dias_almacen} días`, d.articulo.max_dias_almacen ? `Máximo del modelo: ${d.articulo.max_dias_almacen} días` : ''], ['PCI PTS del modelo', d.articulo.pci ? PCI[d.articulo.pci.estado][1] : 'Sin fecha', d.articulo.pci_pts_vence ? 'Vence ' + fmtISO(d.articulo.pci_pts_vence) : ''], ['Fallas', d.eventos.filter(e => e.tipo === 'falla').length, `${d.eventos.length} evento(s) en total`]]));
  const imei = el('input', { value: u.imei || '', maxlength: '15', inputmode: 'numeric', placeholder: '15 dígitos', disabled: !puede() ? '' : null });
  const tid = el('input', { value: u.tid || '', maxlength: '20', placeholder: 'TID de la adquirente', style: 'text-transform:uppercase', disabled: !puede() ? '' : null });
  const nota = el('input', { value: u.notas || '', maxlength: '300', placeholder: 'Opcional', disabled: !puede() ? '' : null });
  const guarda = el('button', { class: 'btn sm', type: 'button' }, 'Guardar identificadores');
  guarda.onclick = async () => { try { await api('PUT', BASE + '/unidades', { articulo_id: articuloId, serie: u.serie, imei: imei.value, tid: tid.value, notas: nota.value }); toast('Identificadores guardados', 'ok'); reabrir(); } catch (e) { err(e); } };
  body.append(el('h4', {}, `${u.serie} · ${d.articulo.nombre}`), el('div', { class: 'grid2' }, fld('IMEI', imei), fld('TID', tid)), fld('Notas', nota));
  if (puede()) body.append(guarda);
  if (d.uso) body.append(fila(`Transaccionó por última vez el ${fmtISO(d.uso.ultima)} para ${d.uso.cliente}${d.uso.comercio ? ' · ' + d.uso.comercio : ''} (${d.uso.n} transacciones).`));
  body.append(el('h4', { style: 'margin-top:14px' }, 'Historial de asignación'), tableWrap(['Fecha', 'Folio', 'Evento'], (u.historial || []).slice().reverse().map(h => [fmtISO(h.fecha), String(h.folio), esc(h.evento)]), { empty: 'Sin historial.' }));
  body.append(el('h4', { style: 'margin-top:14px' }, 'Fallas y servicio'), tableWrap(['Fecha', 'Tipo', 'Detalle', 'Registró'], d.eventos.map(e => [fmtISO(e.fecha), e.tipo === 'falla' ? badge('danger', e.tipo_txt) : badge('neutral', e.tipo_txt), esc(e.descripcion), esc(e.usuario)]), { empty: 'Sin fallas ni servicios registrados.' }));
  if (puede()) {
    const tp = el('select', { 'aria-label': 'Tipo de evento' }, ...Object.entries(d.tipos).map(([v, x]) => el('option', { value: v }, x)));
    const fe = el('input', { type: 'date', value: hoyISO(), max: hoyISO(), 'aria-label': 'Fecha' }), ds = el('input', { maxlength: '400', placeholder: 'Qué pasó (mínimo 5 caracteres)', 'aria-label': 'Detalle' });
    const reg = el('button', { class: 'btn sm', type: 'button' }, 'Registrar');
    reg.onclick = async () => { try { await api('POST', BASE + '/unidades/eventos', { articulo_id: articuloId, serie: u.serie, tipo: tp.value, fecha: fe.value, descripcion: ds.value }); toast('Evento registrado', 'ok'); reabrir(); } catch (e) { err(e); } };
    body.append(el('div', { class: 'filters', style: 'margin-top:10px' }, fld('Tipo', tp), fld('Fecha', fe), fld('Detalle', ds), reg));
  }
  modal(`Equipo ${u.serie}`, body, el('div', {}, el('button', { class: 'btn secondary', onclick: () => { closeModal(); abrirKardex(articuloId); } }, 'Ver kardex del modelo'), ' ', el('button', { class: 'btn', onclick: closeModal }, 'Cerrar')), true);
}

/* ============================ REPOSICIÓN (punto de reorden) ============================ */
async function tReposicion(c) {
  const p = el('div', { class: 'panel' });
  const sel = el('select', { 'aria-label': 'Estado' }, el('option', { value: '' }, 'Todos'), ...Object.entries(REO).map(([v, x]) => el('option', { value: v }, x[1]))); sel.value = ST.rep.estado;
  const cont = el('div', {});
  p.append(el('h3', {}, 'Reposición: punto de reorden y stock de seguridad', el('span', { class: 'right' }, el('button', { class: 'btn ghost sm', onclick: () => descargar(BASE + '/reorden.xlsx', 'reposicion.xlsx').catch(err) }, '⬇ Excel'))),
    el('div', { class: 'filters' }, fld('Estado', sel)), cont);
  const carga = async () => {
    ST.rep.estado = sel.value;
    const d = await api('GET', BASE + '/reorden' + (sel.value ? '?estado=' + sel.value : ''));
    cont.innerHTML = '';
    cont.append(tableWrap(['Artículo', { t: 'Existencia' }, { t: 'Demanda / día' }, { t: 'Reposición' }, { t: 'Stock de seguridad' }, { t: 'Punto de reorden' }, 'Estado', { t: 'Pedir' }],
      d.articulos.map(a => { const tr = [`<b>${esc(a.nombre)}</b> ${claseBadge(a.clase)}<div class="muted">${esc(a.sku)}</div>`, { num: `${n4(a.existencia)} ${esc(a.unidad)}<div class="muted">${a.dias_cobertura == null ? 'sin consumo' : 'alcanza ' + n4(Math.floor(a.dias_cobertura)) + ' d'}</div>` }, { num: n4(a.demanda_diaria) }, { num: `${a.lead_dias} d<div class="muted">${a.tiempo_entrega_dias} prov. + ${a.tiempo_config_dias} config.</div>` }, { num: n4(a.stock_seguridad) + (a.ss_manual ? '<div class="muted">manual</div>' : '') }, { num: n4(a.punto_reorden) }, reoBadge(a), { num: a.sugerido ? `<b>${n4(a.sugerido)}</b>` : '—' }]; if (puede()) tr._onclick = () => formArticulo(ST.arts.find(x => x.id === a.id)); return tr; }),
      { empty: 'Ningún artículo con ese estado.' }));
    cont.append(fila('Punto de reorden = demanda diaria × (entrega del proveedor + configuración y encriptación) + stock de seguridad. La demanda sale de las entregas, consumos y mermas de los últimos 90 días. Clic en un renglón para ajustar los tiempos.'));
  };
  sel.addEventListener('change', () => carga().catch(err));
  c.append(p); await carga();
}

/* ============================ CONTEO CÍCLICO ============================ */
async function tConteo(c) {
  const lista = await api('GET', BASE + '/conteos');
  const abierto = lista.conteos.find(x => x.estado === 'abierto');
  if (abierto) await conteoAbierto(c, abierto.id); else await conteoNuevo(c);
  c.append(panel('Conteos anteriores', tableWrap(['#', 'Fecha', 'Estado', { t: 'Artículos' }, { t: 'Contados' }, { t: 'Con diferencia' }, 'Nota'],
    lista.conteos.map(x => { const tr = [String(x.id), fmtISO(x.fecha), x.estado === 'abierto' ? badge('warn', 'Abierto') : badge('ok', 'Cerrado'), { num: String(x.lineas) }, { num: String(x.contadas) }, { num: x.con_diferencia ? badge('danger', String(x.con_diferencia)) : '0' }, esc(x.nota)]; tr._onclick = () => (x.estado === 'abierto' ? ST.irA('conteo') : detalleConteo(x.id)); return tr; }),
    { empty: 'Todavía no se ha hecho ningún conteo.' })));
}
async function conteoNuevo(c) {
  const prop = (await api('GET', BASE + '/conteos/propuesta?limite=50')).propuesta;
  const iniciales = new Set(prop.slice(0, 10).map(x => x.id));
  const orden = [...prop.map(x => x.id), ...ST.arts.filter(a => a.activo && !prop.some(x => x.id === a.id)).map(a => a.id)];
  const checks = new Map();
  const rows = orden.map(id => {
    const a = ST.arts.find(x => x.id === id); if (!a) return null;
    const ch = el('input', { type: 'checkbox', 'aria-label': 'Contar ' + a.nombre }); ch.checked = iniciales.has(id); checks.set(id, ch);
    return [ch, claseBadge(a.clase), `<b>${esc(a.nombre)}</b>${a.serializado ? ' ' + badge('info', 'con serie') : ''}`, a.ultimo_conteo ? `${fmtISO(a.ultimo_conteo)}` : 'Nunca', `${a.frecuencia_conteo || '—'} d`, a.toca_conteo ? badge('warn', 'toca') : badge('neutral', 'al día')];
  }).filter(Boolean);
  const nota = el('input', { maxlength: '200', placeholder: 'Opcional: Ej. conteo semanal de almacén central', 'aria-label': 'Nota' });
  const ini = el('button', { class: 'btn', type: 'button' }, 'Iniciar conteo');
  const marcados = () => [...checks].filter(([, ch]) => ch.checked).map(([id]) => id);
  ini.onclick = async () => { const ids = marcados(); if (!ids.length) return toast('Elige al menos un artículo.', 'err'); ini.disabled = true; try { await api('POST', BASE + '/conteos', { articulo_ids: ids, nota: nota.value }); toast('Conteo abierto', 'ok'); ST.irA('conteo'); } catch (e) { err(e); ini.disabled = false; } };
  c.append(panel('Nuevo conteo', tableWrap(['', 'ABC', 'Artículo', 'Último conteo', 'Cada', ''], rows, { empty: 'No hay artículos activos.' }), fila('Se proponen primero los de clase A y los más atrasados. Los que ya cuentas "al día" se pueden contar igual si lo marcas.'),
    puede() ? el('div', { class: 'filters', style: 'margin-top:12px' }, fld('Nota', nota), ini) : ''));
}
async function conteoAbierto(c, id) {
  const d = await api('GET', `${BASE}/conteos/${id}`);
  const p = el('div', { class: 'panel' });
  const hechas = d.lineas.filter(l => l.contada != null).length;
  const cierra = el('button', { class: 'btn', type: 'button', onclick: () => cerrarConteo(d) }, `Cerrar conteo (${hechas} de ${d.lineas.length})`);
  p.append(el('h3', {}, `Conteo #${d.id} · ${fmtISO(d.fecha)}`, el('span', { class: 'right' }, puede() ? cierra : '')));
  if (d.nota) p.append(fila(d.nota));
  const recarga = () => ST.irA('conteo');
  p.append(tableWrap(['ABC', 'Artículo', 'Contado', { t: 'Esperado' }, { t: 'Diferencia' }, ''], d.lineas.map(l => {
    const cont = l.contada != null, r = l.resultado || {};
    const dif = !cont ? '—' : l.serializado ? ((r.faltantes || []).length || (r.sobrantes_conocidas || []).length || (r.sobrantes_desconocidas || []).length ? badge('warn', `faltan ${(r.faltantes || []).length} · sobran ${(r.sobrantes_conocidas || []).length + (r.sobrantes_desconocidas || []).length}`) : badge('ok', 'cuadra')) : (l.diferencia ? badge('warn', (l.diferencia > 0 ? '+' : '') + n4(l.diferencia)) : badge('ok', 'cuadra'));
    let accion = '';
    if (puede()) {
      if (l.serializado) accion = el('button', { class: 'btn ghost sm', type: 'button', onclick: () => capturaSeries(d.id, l, recarga) }, cont ? 'Recapturar equipos' : 'Capturar equipos');
      else { const inp = el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', style: 'width:110px', 'aria-label': 'Contado de ' + l.nombre, value: cont ? l.contada : '' }); const g = el('button', { class: 'btn ghost sm', type: 'button' }, 'Guardar'); g.onclick = async () => { try { await api('POST', `${BASE}/conteos/${d.id}/contar`, { articulo_id: l.articulo_id, contada: inp.value }); recarga(); } catch (e) { err(e); } }; accion = el('div', { style: 'display:flex;gap:6px' }, inp, g); }
    }
    return [claseBadge(l.clase), `<b>${esc(l.nombre)}</b><div class="muted">${esc(l.sku)}</div>`, l.serializado ? (cont ? `${l.contada} equipos` : '—') : (cont ? `${n4(l.contada)} ${esc(l.unidad)}` : '—'), { num: cont ? n4(l.esperada) : '—' }, { num: dif }, accion];
  }), { empty: 'Sin artículos.' }));
  p.append(fila('Cuenta a ciegas: el esperado aparece cuando guardas lo contado. Si hay movimientos después de contar, hay que volver a capturar ese artículo antes de cerrar.'));
  c.append(p);
}
function capturaSeries(conteoId, l, recarga) {
  const ta = el('textarea', { rows: '10', placeholder: 'Un equipo por línea (S/N). Pega desde Excel.', style: 'font-family:ui-monospace,monospace', 'aria-label': 'Equipos contados' }); ta.value = (l.series_contadas || []).join('\n');
  const cuenta = el('div', { class: 'muted' }); const act = () => { cuenta.textContent = `${ta.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean).length} equipo(s) contados`; }; ta.addEventListener('input', act); act();
  const g = el('button', { class: 'btn' }, 'Guardar conteo');
  g.onclick = async () => { g.disabled = true; try { const r = await api('POST', `${BASE}/conteos/${conteoId}/contar`, { articulo_id: l.articulo_id, series: ta.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean) }); closeModal(); recarga(); const x = r.resultado; toast(x.faltantes.length || x.sobrantes_conocidas.length || x.sobrantes_desconocidas.length ? `Faltan ${x.faltantes.length} · sobran ${x.sobrantes_conocidas.length + x.sobrantes_desconocidas.length}` : 'Cuadra con el sistema', 'ok'); } catch (e) { err(e); g.disabled = false; } };
  modal(`Contar equipos · ${l.nombre}`, el('div', {}, fld('Equipos en el almacén (uno por línea)', ta), cuenta), el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), ' ', g), false);
}
function cerrarConteo(d) {
  const con = d.lineas.filter(l => l.contada != null && (l.serializado ? ((l.resultado.faltantes || []).length || (l.resultado.sobrantes_conocidas || []).length || (l.resultado.sobrantes_desconocidas || []).length) : l.diferencia));
  const sin = d.lineas.filter(l => l.contada == null).length;
  if (!d.lineas.some(l => l.contada != null)) return toast('Captura al menos un artículo contado.', 'err');
  const ctl = new Map();
  const body = el('div', {});
  body.append(el('div', {}, con.length ? 'Estos artículos tienen diferencia. Decide qué hacer con cada uno y escribe el motivo (mínimo 10 caracteres): el ajuste queda como un movimiento con su folio.' : 'Todo lo contado cuadra con el sistema.'));
  if (sin) body.append(fila(`${sin} artículo(s) sin contar se descartan de este conteo.`));
  con.forEach(l => {
    const r = l.resultado, ac = el('select', { 'aria-label': 'Decisión para ' + l.nombre }, el('option', { value: 'ajustar' }, 'Ajustar el inventario'), el('option', { value: 'pendiente' }, 'Dejar pendiente (investigar)'));
    const mo = el('input', { maxlength: '300', placeholder: 'Motivo de la diferencia', 'aria-label': 'Motivo para ' + l.nombre });
    ctl.set(l.articulo_id, { ac, mo });
    const detalle = l.serializado ? [(r.faltantes || []).length ? 'Faltan: ' + r.faltantes.slice(0, 6).join(', ') : '', (r.sobrantes_desconocidas || []).length ? 'Sobran (no registrados): ' + r.sobrantes_desconocidas.slice(0, 6).join(', ') : '', (r.sobrantes_conocidas || []).length ? 'En almacén pero el sistema los tiene con cliente o de baja: ' + r.sobrantes_conocidas.slice(0, 6).map(x => x.serie).join(', ') : ''].filter(Boolean).join(' · ') : `Esperado ${n4(l.esperada)} · contado ${n4(l.contada)} · diferencia ${l.diferencia > 0 ? '+' : ''}${n4(l.diferencia)}`;
    body.append(el('div', { style: 'margin-top:14px' }, el('b', {}, `${l.nombre} (${l.sku})`), fila(detalle), el('div', { class: 'grid2', style: 'margin-top:6px' }, fld('Decisión', ac), fld('Motivo', mo))));
  });
  const g = el('button', { class: 'btn' }, 'Cerrar conteo');
  g.onclick = async () => {
    g.disabled = true;
    try { const r = await api('POST', `${BASE}/conteos/${d.id}/cerrar`, { decisiones: [...ctl].map(([articulo_id, x]) => ({ articulo_id, accion: x.ac.value, motivo: x.mo.value })) }); closeModal(); toast(`Conteo cerrado · ${r.ajustes} ajuste(s)${r.pendientes ? ' · ' + r.pendientes + ' pendiente(s)' : ''}`, 'ok'); await cargarArticulos(); ST.irA('conteo'); }
    catch (e) { err(e); g.disabled = false; }
  };
  modal(`Cerrar conteo #${d.id}`, body, el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), ' ', g), true);
}
async function detalleConteo(id) {
  let d; try { d = await api('GET', `${BASE}/conteos/${id}`); } catch (e) { return err(e); }
  modal(`Conteo #${d.id} · ${fmtISO(d.fecha)}`, el('div', {}, d.nota ? fila(d.nota) : '', tableWrap(['ABC', 'Artículo', { t: 'Esperado' }, { t: 'Contado' }, { t: 'Diferencia' }, 'Resultado'], d.lineas.map(l => [claseBadge(l.clase), `<b>${esc(l.nombre)}</b><div class="muted">${esc(l.sku)}</div>`, { num: n4(l.esperada) }, { num: n4(l.contada) }, { num: l.diferencia ? (l.diferencia > 0 ? '+' : '') + n4(l.diferencia) : '0' }, esc(l.ajuste_motivo || (l.diferencia ? '' : 'Cuadra'))]), { empty: 'Sin líneas.' }), fila(`Abrió ${d.creado_por}${d.cerrado_por ? ' · cerró ' + d.cerrado_por : ''}.`)), el('button', { class: 'btn', onclick: closeModal }, 'Cerrar'), true);
}

/* ============================ MOVIMIENTOS ============================ */
async function tMovimientos(c) {
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
    lista.append(tableWrap(['Fecha', 'Artículo', 'Movimiento', { t: 'Cantidad' }, { t: 'Costo unit.' }, { t: 'Costo total' }, 'Documento / destino'], d.movimientos.map(m => {
      const tr = [`${fmtISO(m.fecha)}<div class="muted">folio ${m.id}</div>`, `<b>${esc(m.nombre)}</b><div class="muted">${esc(m.sku)}</div>`, `${m.tipo === 'entrada' ? badge('ok', 'Entrada') : badge('info', 'Salida')} ${esc((ST.conceptos[m.tipo] || {})[m.concepto] || m.concepto)}${m.fifo_excepcion ? ' ' + badge('warn', 'fuera de PEPS') : ''}`, { num: `${n4(m.cantidad)} ${esc(m.unidad)}` }, { num: m.costo_unitario == null ? '—' : mxn(m.costo_unitario) }, { num: m.costo_total == null ? '—' : mxn(m.costo_total) }, `${esc(m.documento || m.destino || '—')}${m.n_series ? ' · ' + m.n_series + ' equipo(s)' : ''}<div class="muted">${esc(m.usuario)}</div>`];
      tr._onclick = () => abrirKardex(m.articulo_id); return tr;
    }), { empty: 'Sin movimientos con ese filtro.' }));
    lista.append(fila('Se muestran los últimos 100. Clic en un renglón para ver el kardex del artículo.'));
  };
  [mA, mT, mD, mH].forEach(x => x.addEventListener('change', () => cargaMov().catch(err)));
  pm.append(el('div', { class: 'filters' }, fld('Artículo', mA), fld('Tipo', mT), fld('Desde', mD), fld('Hasta', mH)), lista);
  c.append(pm);
  await cargaMov();
}

/* ---------- kardex de un artículo ---------- */
async function abrirKardex(id) {
  let d;
  try { d = await api('GET', `${BASE}/articulos/${id}/kardex`); } catch (e) { return err(e); }
  const a = d.articulo, body = el('div', {});
  const r = a.reorden;
  body.append(cards([['Existencia', `${n4(a.existencia)} ${a.unidad}`, a.clase ? `Clase ${a.clase}` : ''], ['Valor PEPS', mxn(a.valor), `Promedio ${mxn(a.costo_promedio)}`], ['Costo de la siguiente salida', a.costo_siguiente == null ? '—' : mxn(a.costo_siguiente), a.capas ? `${a.capas} capa(s) abierta(s)` : 'Sin capas'],
    ...(r ? [['Punto de reorden', n4(r.punto_reorden), `${REO[r.estado][1]} · seguridad ${n4(r.stock_seguridad)} · reposición ${r.lead_dias} d`]] : [])]));
  if (a.pci) body.append(el('div', { class: 'msg' + (a.pci.estado === 'vencida' ? ' err' : ''), role: 'status' }, `Certificación PCI PTS ${PCI[a.pci.estado][1].toLowerCase()}: ${fmtISO(a.pci_pts_vence)}${a.pci_pts_folio ? ' · folio ' + a.pci_pts_folio : ''}.${a.pci.estado === 'vencida' ? ' No se pueden entregar equipos de este modelo.' : ''}`));
  if (d.error) body.append(el('div', { class: 'msg err', role: 'alert' }, `Movimientos incoherentes desde el folio ${d.error.folio} (${fmtISO(d.error.fecha)}): faltan ${n4(d.error.faltante)}.`));
  const quitar = m => puede() ? el('button', { class: 'btn ghost sm', type: 'button', onclick: () => anular(m, id) }, 'Anular') : '';
  body.append(el('h4', {}, 'Kardex (en orden de aplicación)'));
  body.append(tableWrap(['Fecha', 'Folio', 'Tipo', 'Concepto', { t: 'Cantidad' }, { t: 'Costo unit.' }, { t: 'Costo total' }, { t: 'Saldo' }, { t: 'Saldo valor' }, 'Referencia', ''],
    d.filas.map(f => [fmtISO(f.fecha), String(f.id), f.tipo === 'entrada' ? badge('ok', 'Entrada') : badge('info', 'Salida'), esc((ST.conceptos[f.tipo] || {})[f.concepto] || f.concepto) + (f.fifo_excepcion ? ' ' + badge('warn', 'fuera de PEPS') : ''), { num: n4(f.cantidad) }, { num: mxn(f.costo_unitario) }, { num: mxn(f.costo_total) }, { num: n4(f.saldo_cantidad) }, { num: mxn(f.saldo_valor) }, esc(f.documento || (f.empresa ? `${f.empresa} / ${f.unidad}` : f.destino) || f.notas || '') + ((f.series || []).length ? `<div class="muted">${esc(f.series.slice(0, 4).join(', '))}${f.series.length > 4 ? '… (' + f.series.length + ')' : ''}</div>` : ''), quitar(f)]),
    { empty: 'Sin movimientos.' }));
  if (d.series && d.series.length) {
    body.append(el('h4', {}, 'Equipos (los más antiguos en almacén primero)'));
    body.append(tableWrap(['S/N', 'IMEI', 'TID', 'Estado', 'Empresa / Unidad', { t: 'En almacén' }], d.series.slice(0, 300).map(s => { const [k, t] = ESTADO_SERIE[s.estado] || ['neutral', s.estado]; const tr = [`<b>${esc(s.serie)}</b>`, esc(s.imei || '—'), esc(s.tid || '—'), badge(k, t), s.empresa ? `${esc(s.empresa)} / ${esc(s.unidad)}` : '—', { num: s.dias_almacen == null ? '—' : `${s.dias_almacen} d${s.sobre_limite ? ' ' + badge('warn', 'pasado') : ''}` }]; tr._onclick = () => { closeModal(); fichaEquipo(id, s.serie); }; return tr; })));
  }
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
function formArticulo(a) {
  const nuevo = !a;
  const sku = el('input', { value: a ? a.sku : '', maxlength: '30', placeholder: 'TERM-001', style: 'text-transform:uppercase' });
  const nombre = el('input', { value: a ? a.nombre : '', maxlength: '140' });
  const cat = el('input', { value: a ? a.categoria : '', list: 'invCats', maxlength: '60', placeholder: 'Terminales, papelería…' });
  const dl = el('datalist', { id: 'invCats' }, ...ST.cat.map(x => el('option', { value: x })));
  const uni = el('input', { value: a ? a.unidad : 'pieza', list: 'invUni', maxlength: '20' });
  const dlu = el('datalist', { id: 'invUni' }, ...['pieza', 'caja', 'paquete', 'rollo', 'juego', 'litro', 'kg'].map(x => el('option', { value: x })));
  const min = el('input', { type: 'number', min: '0', step: 'any', value: a ? a.minimo : '0', title: 'Si lo dejas en 0 se calcula con la variación de la demanda' });
  const tEnt = el('input', { type: 'number', min: '0', max: '365', step: '1', inputmode: 'numeric', value: a ? a.tiempo_entrega_dias : '0' });
  const tCfg = el('input', { type: 'number', min: '0', max: '365', step: '1', inputmode: 'numeric', value: a ? a.tiempo_config_dias : '0' });
  const cob = el('input', { type: 'number', min: '1', max: '365', step: '1', inputmode: 'numeric', value: a ? a.cobertura_dias : '30' });
  const maxAlm = el('input', { type: 'number', min: '1', max: '3650', step: '1', inputmode: 'numeric', value: a && a.max_dias_almacen ? a.max_dias_almacen : '', placeholder: 'Sin límite' });
  const pciV = el('input', { type: 'date', value: a && a.pci_pts_vence ? a.pci_pts_vence : '' }), pciF = el('input', { maxlength: '60', value: a ? a.pci_pts_folio : '', placeholder: 'Folio de la certificación' });
  const notas = el('textarea', { rows: '2', maxlength: '400' }); notas.value = a ? a.notas : '';
  const act = el('input', { type: 'checkbox', id: 'invAct' }); act.checked = a ? a.activo : true;
  const ser = el('input', { type: 'checkbox', id: 'invSer' }); ser.checked = a ? !!a.serializado : false; if (a && a.movimientos) ser.disabled = true;
  const cajaSer = el('div', {}, el('div', { class: 'grid2' }, fld('Máximo en almacén (días)', maxAlm), fld('PCI PTS vigente hasta', pciV)), fld('Folio PCI PTS', pciF));
  const vis = () => { cajaSer.style.display = ser.checked ? '' : 'none'; }; ser.addEventListener('change', vis);
  const body = el('div', {}, el('div', { class: 'grid2' }, fld('SN', sku), fld('Unidad', uni)), fld('Nombre', nombre), el('div', { class: 'grid2' }, fld('Categoría', cat), fld('Stock de seguridad (opcional)', min)), fld('Notas', notas), dl, dlu);
  body.append(el('label', { class: 'chk', for: 'invSer', title: 'Cada pieza lleva su S/N, IMEI y TID y se asigna a una Empresa y Unidad' }, ser, ' Con número de serie (terminales)' + (a && a.movimientos ? ' · ya tiene movimientos' : '')));
  body.append(el('h4', { style: 'margin-top:14px' }, 'Reposición'), el('div', { class: 'grid2' }, fld('Entrega del proveedor (días)', tEnt), fld('Configuración y encriptación (días)', tCfg)), fld('Cobertura al pedir (días de demanda)', cob), cajaSer);
  if (!nuevo) body.append(el('label', { class: 'chk', for: 'invAct' }, act, ' Artículo activo (si lo desactivas ya no recibe movimientos)'));
  const g = el('button', { class: 'btn' }, nuevo ? 'Crear artículo' : 'Guardar');
  g.onclick = async () => { try { await api('POST', BASE + '/articulos', { id: a ? a.id : undefined, sku: sku.value, nombre: nombre.value, categoria: cat.value, unidad: uni.value, minimo: min.value, notas: notas.value, activo: act.checked, serializado: ser.checked, tiempo_entrega_dias: tEnt.value, tiempo_config_dias: tCfg.value, cobertura_dias: cob.value, max_dias_almacen: ser.checked ? maxAlm.value : '', pci_pts_vence: ser.checked ? pciV.value : '', pci_pts_folio: ser.checked ? pciF.value : '' }); closeModal(); toast(nuevo ? 'Artículo creado' : 'Guardado', 'ok'); render(); } catch (e) { err(e); } };
  modal(nuevo ? 'Nuevo artículo' : 'Editar artículo', body, el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), ' ', g), false);
  vis();
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
  const series = el('textarea', { rows: '5', placeholder: esE ? 'Un equipo por línea: S/N, IMEI, TID\nEj. SN0001, 350000000000001, TID0001\nIMEI y TID son opcionales. Pega desde Excel.' : 'Un S/N por línea (o elige abajo). TID opcional: SN0001, , TID0001', style: 'font-family:ui-monospace,monospace' });
  const cuentaSeries = el('div', { class: 'muted' });
  const chips = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' });
  const emp = el('select', { 'aria-label': 'Empresa' }, el('option', { value: '' }, 'Elige la Empresa…'), ...ST.clientes.map(x => el('option', { value: x.id }, x.nombre)));
  const uni = el('input', { maxlength: '140', list: 'invUnidades', placeholder: 'Sucursal, plaza o unidad de negocio' }), dlU = el('datalist', { id: 'invUnidades' });
  const empNombre = el('input', { maxlength: '140', placeholder: 'Empresa del cliente' });            // solo si el catálogo de Empresas está vacío
  const info = el('div', { class: 'muted', style: 'min-height:20px;margin-top:4px' });
  const cajaCli = el('div', {}, el('div', { class: 'grid2' }, fld('Empresa', ST.clientes.length ? emp : empNombre), fld('Unidad del cliente', uni)), dlU);
  const cajaSeries = el('div', {}, fld(esE ? 'Equipos (S/N · IMEI · TID)' : 'Números de serie', series), cuentaSeries, chips);
  const cajaCant = el('div', { class: 'grid2' }, fld('Cantidad', cant), esE ? fld('Costo unitario (sin IVA)', costo) : el('div', {}));
  const cajaDoc = esE ? el('div', { class: 'grid2' }, fld('Documento', doc), fld('Proveedor', prov)) : el('div', {}, fld('Documento o remisión (opcional)', doc));
  let capas = [], libres = [];
  const art0 = () => ST.arts.find(x => String(x.id) === String(art.value));
  const lineas = () => series.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const snDe = l => l.split(/[,;\t]/)[0].trim().toUpperCase().replace(/\s+/g, '');
  const cambiaEmpresa = () => {
    const x = ST.clientes.find(y => String(y.id) === String(emp.value));
    dlU.innerHTML = ''; (x ? x.unidades : []).forEach(u => dlU.append(el('option', { value: u })));
  };
  const visible = () => {
    const a = art0(), entrega = !esE && conc.value === 'entrega', ser = !!(a && a.serializado);
    cajaSeries.style.display = ser ? '' : 'none';
    cajaCli.style.display = entrega ? '' : 'none';
    cajaCant.style.display = ser && !esE ? 'none' : '';                       // salida de serializados: la cantidad sale de las series
    cant.disabled = ser && esE;                                               // entrada de serializados: la cantidad es el número de equipos
    if (ser && esE) cant.value = lineas().length || '';
  };
  const refresca = async () => {
    const a = art0(); visible();
    try { const d = await api('GET', `${BASE}/articulos/${art.value}/kardex`); capas = d.capas; libres = (d.series || []).filter(x => x.estado === 'almacen'); } catch (_e) { capas = []; libres = []; }
    chips.innerHTML = '';
    if (!esE && a && a.serializado) {
      const elegidas = new Set(lineas().map(snDe));
      const sig = libres.find(x => !elegidas.has(x.serie));                                                           // PEPS físico: el más antiguo que aún no eliges
      if (sig && conc.value === 'entrega') chips.append(el('button', { type: 'button', class: 'btn secondary sm', onclick: () => { series.value = (series.value.trim() ? series.value.trim() + '\n' : '') + sig.serie; refresca(); } }, `+ El más antiguo (${sig.serie} · ${sig.dias_almacen} d)`));
      libres.slice(0, 30).forEach(x => chips.append(el('button', { type: 'button', class: 'btn ghost sm', title: `${x.dias_almacen} días en almacén`, onclick: () => { if (!elegidas.has(x.serie)) { series.value = (series.value.trim() ? series.value.trim() + '\n' : '') + x.serie; refresca(); } } }, `${x.serie} · ${x.dias_almacen} d`)));
      if (libres.length > 30) chips.append(el('span', { class: 'muted' }, `…y ${libres.length - 30} más`));
    }
    const ls = lineas();
    cuentaSeries.textContent = a && a.serializado ? `${ls.length} equipo(s)${!esE ? ` · disponibles en almacén: ${libres.length} (del más antiguo al más nuevo)` : ''}` : '';
    const n = a && a.serializado ? ls.length : Number(cant.value);
    if (a && a.serializado && esE) cant.value = ls.length || '';
    if (esE) info.textContent = n > 0 && costo.value !== '' ? `Total de la entrada: ${mxn(n * Number(costo.value))}` : '';
    else { let falta = n, tot = 0; for (const k of capas) { if (falta <= 0) break; const t = Math.min(falta, k.restante); tot += t * k.costo_unitario; falta -= t; } info.textContent = a ? (n > 0 ? (falta > 1e-9 ? `No alcanza: hay ${n4(a.existencia)} ${a.unidad}.` : `Costo PEPS estimado: ${mxn(tot)} (existencia ${n4(a.existencia)} ${a.unidad})`) : `Existencia: ${n4(a.existencia)} ${a.unidad}`) : ''; }
  };
  [cant, costo, series].forEach(x => x.addEventListener('input', refresca)); art.addEventListener('change', refresca); conc.addEventListener('change', () => { visible(); refresca(); }); emp.addEventListener('change', cambiaEmpresa);
  const body = el('div', {}, fld('Artículo', art), el('div', { class: 'grid2' }, fld('Concepto', conc), fld('Fecha', fecha)), cajaSeries, cajaCant, info, cajaDoc, cajaCli, fld('Notas', notas));
  const g = el('button', { class: 'btn' }, esE ? 'Registrar entrada' : 'Registrar salida');
  const envia = async fifo => {
    const a = art0(), entrega = !esE && conc.value === 'entrega';
    return api('POST', BASE + '/movimientos', { articulo_id: Number(art.value), tipo, concepto: conc.value, fecha: fecha.value, cantidad: a && a.serializado ? undefined : cant.value, series: a && a.serializado ? lineas() : undefined,
      costo_unitario: esE ? costo.value : undefined, proveedor: prov.value, documento: doc.value, empresa_id: entrega && ST.clientes.length ? emp.value || undefined : undefined, empresa: entrega && !ST.clientes.length ? empNombre.value : undefined, unidad: entrega ? uni.value : undefined, notas: notas.value, fifo_justificacion: fifo });
  };
  g.onclick = async () => {
    g.disabled = true;
    try {
      let r;
      try { r = await envia(); }
      catch (e) {
        if (!(e && e.data && e.data.codigo === 'fifo')) throw e;
        const just = await pedir(`${e.data.error}\n\nSi es necesario, escribe la justificación (mínimo 10 caracteres): queda en el movimiento y en la bitácora. Si no, cancela y usa «+ El más antiguo».`, { titulo: 'Fuera del orden PEPS', ok: 'Entregar de todos modos' });
        if (!just) { g.disabled = false; return; }
        r = await envia(just);
      }
      closeModal(); toast(esE ? 'Entrada registrada' : `Salida registrada · costo PEPS ${mxn(r.costo_total)}`, 'ok'); (r.avisos || []).forEach(x => toast(x, 'err')); render();
    } catch (e) { err(e); g.disabled = false; }
  };
  modal(esE ? 'Registrar entrada' : 'Registrar salida', body, el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), ' ', g), false);
  cambiaEmpresa(); visible(); refresca();
}

/* ---------- carga masiva (layout Excel o CSV) ---------- */
const aBase64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
function cargaMasiva() {
  const res = el('div', { style: 'margin-top:12px' });
  const aplicar = el('button', { class: 'btn', disabled: '' }, 'Aplicar carga');
  let archivo = null, huella = null, nombre = '';
  const pinta = d => {
    res.innerHTML = '';
    const s = d.resumen || {};
    if (d.n_errores) {
      res.append(el('div', { class: 'msg err', role: 'alert' }, `${d.n_errores} error(es): corrige estas filas y vuelve a subir el archivo. No se aplicó nada.`), tableWrap(['Hoja', { t: 'Fila' }, 'Qué pasa'], d.errores.map(e => [esc(e.hoja || '—'), { num: String(e.fila || '') }, esc(e.mensaje)])));
    } else {
      res.append(el('div', { class: 'msg', role: 'status' }, `Todo en orden: ${s.unidades || s.movimientos || 0} ${s.unidades ? 'equipo(s)' : 'movimiento(s)'}${s.articulos_nuevos ? ` · ${s.articulos_nuevos} modelo(s) nuevo(s)` : ''} · valor de entradas ${mxn(s.valor_entradas || 0)}. Pulsa «Aplicar carga».`));
      if (d.vista && d.vista.length) res.append(tableWrap(['Fecha', 'Movimiento', 'Modelo', { t: 'Cant.' }, { t: 'Costo' }, 'Empresa / Unidad'], d.vista.map(m => [fmtISO(m.fecha), m.tipo === 'entrada' ? 'Entrada' : 'Entrega', esc(m.sku), { num: n4(m.cantidad) }, { num: m.tipo === 'entrada' ? mxn(m.costo_unitario) : (m.costo_total == null ? '—' : mxn(m.costo_total)) }, esc(m.empresa ? `${m.empresa} / ${m.unidad}` : '')])));
    }
    (d.avisos || []).forEach(a => res.append(fila(a)));
  };
  const zf = zonaArchivos({ accept: '.xlsx,.csv,.txt', titulo: 'Arrastra aquí tu layout', ayuda: 'Excel (.xlsx) o CSV · o haz clic para elegirlo', onFiles: () => revisa() });
  const f = zf.input;
  async function revisa() {
    const a = f.files[0]; if (!a) return;
    nombre = a.name; aplicar.disabled = true; res.innerHTML = ''; res.append(el('div', { class: 'muted' }, 'Revisando…'));
    try { archivo = aBase64(await a.arrayBuffer()); const d = await api('POST', BASE + '/layout', { archivo, nombre, aplicar: false }); huella = d.huella; pinta(d); aplicar.disabled = !d.ok; } catch (e) { res.innerHTML = ''; err(e); }
  }
  aplicar.onclick = async () => {
    aplicar.disabled = true;
    try { const d = await api('POST', BASE + '/layout', { archivo, nombre, aplicar: true, huella }); closeModal(); toast(`Carga aplicada: ${d.resumen.unidades || d.resumen.movimientos} ${d.resumen.unidades ? 'equipo(s)' : 'movimiento(s)'}`, 'ok'); ST.arts = []; render(); }
    catch (e) { if (e && e.data && e.data.n_errores) pinta(e.data); err(e); aplicar.disabled = false; }
  };
  const body = el('div', {}, el('div', {}, 'Una fila por terminal: ', el('b', {}, 'SN, IMEI, TID, modelo, costo y fecha de compra'), '. IMEI y TID son opcionales. Si ya está con un cliente, agrega Empresa y Unidad.'),
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px' }, el('button', { class: 'btn ghost sm', type: 'button', onclick: () => descargar(BASE + '/layout.xlsx', 'layout_terminales_inventario.xlsx').catch(err) }, '⬇ Plantilla'), el('a', { href: '#', class: 'muted', onclick: e => { e.preventDefault(); descargar(BASE + '/layout-avanzado.xlsx', 'layout_avanzado_inventario.xlsx').catch(err); } }, 'Layout avanzado (artículos sin número de serie)')),
    zf, res);
  modal('Subir layout de inventario', body, el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cerrar'), ' ', aplicar), true);
}

window.INV_VISTAS = { inv_admin: vInvAdmin };
window.INV_TITULOS = { inv_admin: ['Inventario administrativo', 'Equipos por serie, rotación PEPS, conteo cíclico y reposición'] };
})();
