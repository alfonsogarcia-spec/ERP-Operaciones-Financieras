/* ============================================================================
   public/solicitudes/ui.js — Portal de solicitudes de clientes (POS): pantallas del cliente y del personal de Polipay.
   Usa los ayudantes de la app (el, api, tableWrap, modal, toast, confirmar, descargar…). Las vistas se registran en window.SC_VISTAS y sus títulos en window.SC_TITULOS.
   Toda regla (permisos, segregación, versiones, qué falta) la hace cumplir el servidor; aquí solo se muestran y se capturan.
   ============================================================================ */
(function () {
'use strict';
const SC = { yo: null, sel: null, nuevo: null, cat: {}, lista: { q: '', estado: 'abiertas', tipo: '', id_grupo: '', vencidas: false, pagina: 1 }, cliente: null };
const call = (m, p, b) => api(m, '/api/sc' + p, b);
const fF = iso => iso ? new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const fFecha = iso => iso ? new Date(iso).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const badge = (cls, txt, title) => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(txt)}</span>`;
const falla = e => toast(errMsg(e), 'err');
const esCliente = () => SC.yo && SC.yo.rol === 'cliente';
const panel = (titulo, ...hijos) => { const p = el('div', { class: 'panel' }); if (titulo) p.append(el('h3', {}, titulo)); hijos.forEach(h => h && p.append(h)); return p; };
const nota = (cls, html) => el('div', { class: 'banner' + (cls ? ' ' + cls : ''), html });
const vacio = v => v == null || v === '' || (Array.isArray(v) && !v.length) || v === false;
const visibleCampo = (c, d) => { const s = c.show_if; if (!s) return true; if (s.all) return s.all.every(x => visibleCampo({ show_if: x }, d)); const v = d[s.key]; const l = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); if (s.any_of) return s.any_of.some(x => l.includes(x)); if (s.equals !== undefined) return l.includes(s.equals); return true; };
const chipEstado = (s, nombre) => badge(({ borrador: 'neutral', revision_comercial: 'info', devuelta: 'warn', operacion: 'info', ejecucion: 'info', validacion: 'violet', completada: 'ok', rechazada: 'danger', cancelada: 'neutral' })[s] || 'neutral', nombre);

async function base() {
  if (!SC.yo) { SC.yo = await call('GET', '/yo'); }
  // Tocar «Mis solicitudes» o «Inicio» en el menú cierra la solicitud que se tenía abierta (abrir() e iniciarNueva() sí la conservan).
  if (!SC.parchado && typeof window.go === 'function') {
    const go0 = window.go; SC.parchado = true;
    window.go = function (id) { if (!SC.conserva && String(id).startsWith('sc_')) { SC.sel = null; SC.nuevo = null; } SC.conserva = false; return go0.apply(this, arguments); };
  }
  return SC.yo;
}
async function catalogoDe(idGrupo) {
  if (!idGrupo) return { afiliaciones: [], bancos: [], comercios: [], empresas: [] };
  if (!SC.cat[idGrupo]) SC.cat[idGrupo] = await call('GET', '/catalogo?id_grupo=' + idGrupo);
  return SC.cat[idGrupo];
}
const tipoDe = id => (SC.yo.tipos || []).find(t => t.id === id);
function abrir(id) { SC.sel = id; SC.nuevo = null; SC.conserva = true; if (typeof VIEW !== 'undefined' && VIEW === 'sc_lista') render(); else go('sc_lista'); }
function volver() { SC.sel = null; SC.nuevo = null; render(); }

/* ============================ INICIO ============================ */
async function vTablero(v) {
  const yo = await base(); const t = await call('GET', '/tablero');
  v.innerHTML = '';
  const cli = yo.rol === 'cliente';
  const c = t.conteos || {};
  const proceso = (c.revision_comercial || 0) + (c.operacion || 0) + (c.ejecucion || 0) + (c.validacion || 0);
  const tarjetas = el('div', { class: 'cards-row', style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px' });
  const kpi = (titulo, valor, cls, sub, onclick) => el('div', { class: 'panel', style: 'padding:14px;margin:0;' + (onclick ? 'cursor:pointer' : ''), onclick }, el('div', { class: 'muted', style: 'font-size:12px' }, titulo), el('div', { style: 'font-size:26px;font-weight:700;margin:4px 0', class: cls || '' }, String(valor)), sub ? el('div', { class: 'muted', style: 'font-size:12px' }, sub) : '');
  const irLista = f => () => { Object.assign(SC.lista, { q: '', estado: '', tipo: '', vencidas: false, pagina: 1 }, f); go('sc_lista'); };
  if (cli) {
    tarjetas.append(kpi('Necesitan tu información', c.devuelta || 0, (c.devuelta ? 'flagwarn' : ''), 'Devueltas por tu Ejecutivo Comercial', irLista({ estado: 'devuelta' })), kpi('En proceso', proceso, '', 'En revisión, ejecución o validación', irLista({ estado: 'abiertas' })),
      kpi('Completadas', c.completada || 0, '', 'Listas para usarse', irLista({ estado: 'completada' })), kpi('Borradores', c.borrador || 0, '', 'Aún sin enviar', irLista({ estado: 'borrador' })));
  } else {
    tarjetas.append(kpi('Abiertas', t.abiertas, '', 'En cualquier etapa', irLista({ estado: 'abiertas' })), kpi('Vencidas', t.vencidas, t.vencidas ? 'flagwarn' : '', 'Pasaron su tiempo de atención', irLista({ estado: 'abiertas', vencidas: true })),
      kpi('Para ti', (t.para_mi || []).length, '', 'Esperan tu acción'), kpi('Devueltas', t.tasa_devolucion == null ? '—' : t.tasa_devolucion + '%', '', 'Solicitudes devueltas al menos una vez'));
  }
  v.append(tarjetas);
  // Para hoy
  const pm = t.para_mi || [];
  v.append(panel(cli ? 'Necesitan tu atención' : 'Para hoy',
    pm.length ? tableWrap(['Folio', 'Solicitud', cli ? '' : 'Cliente', 'Estado', 'Vence'], pm.map(s => { const r = [esc(s.folio), `<b>${esc(s.tipo_nombre)}</b><small class="muted" style="display:block">${esc(s.titulo || '')}</small>`, cli ? '' : esc(s.cliente || ''), chipEstado(s.estado, s.estado_nombre), s.vence_at ? `${fFecha(s.vence_at)}${s.vencida ? ' ' + badge('danger', 'Vencida') : ''}` : '—']; r._onclick = () => abrir(s.id); return r; }), { empty: '' })
      : el('div', { class: 'empty' }, cli ? 'No tienes nada pendiente. Cuando una solicitud necesite tu información, aparecerá aquí.' : 'No tienes solicitudes por atender.')));
  if (cli) {
    for (const g of (yo.grupos || [])) {
      let cat; try { cat = await catalogoDe(g.id_grupo); } catch (_e) { continue; }
      if (!cat.afiliaciones.length) continue;
      v.append(panel(`Mis afiliaciones y condiciones${(yo.grupos || []).length > 1 ? ' · ' + g.nombre : ''}`, tableWrap(['Afiliación', 'Giro / MCC', 'Débito', 'Crédito', 'Internacional', 'AMEX', 'Liquida a'], cat.afiliaciones.map(a => { const tt = a.tasas || {};
        return [`<b>${esc(a.numero)}</b><small class="muted" style="display:block">${esc(a.razon_social || '')}</small>`, esc(`${a.mcc || '—'}${a.giro ? ' · ' + a.giro : ''}`), { num: pctTxt(tt.tdd) }, { num: pctTxt(tt.tdc) }, { num: pctTxt(tt.int) }, { num: pctTxt(tt.amex) }, a.cuenta ? esc(`${a.cuenta.banco} ····${String(a.cuenta.clabe).slice(-4)}`) : '—']; }), { empty: '' })));
    }
  }
  if (yo.puede_crear) {
    const g = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px' });
    (yo.tipos || []).forEach(tp => g.append(tarjetaTipo(tp, () => iniciarNueva(tp.id))));
    v.append(panel('Pedir algo nuevo', g));
  }
  if (!cli && t.por_tipo) {
    v.append(panel('Por tipo de solicitud', tableWrap(['Tipo', 'Abiertas', 'Completadas', 'Días promedio (90 d)', 'Meta', 'Devueltas'], Object.values(t.por_tipo).map(x => [esc(x.nombre), { num: x.abiertas }, { num: x.completadas },
      { num: x.dias_promedio == null ? '—' : x.dias_promedio }, { num: x.sla_dias + ' d' }, { num: x.devueltas }]), { empty: '' })));
  }
}
function tarjetaTipo(tp, onclick) {
  return el('div', { class: 'panel', style: 'margin:0;cursor:pointer;display:flex;flex-direction:column;gap:6px', onclick, role: 'button', tabindex: '0' },
    el('div', { style: 'font-weight:700' }, tp.corto), el('div', { class: 'muted', style: 'font-size:12.5px;flex:1' }, tp.descripcion),
    el('div', { class: 'muted', style: 'font-size:12px' }, `${tp.formato} · atención en ${tp.sla_dias} día(s) hábil(es)` + (tp.critica ? ' · crítica' : '')));
}

/* ============================ LISTA ============================ */
async function vLista(v) {
  const yo = await base();
  if (SC.sel || SC.nuevo) return vDetalle(v);
  const L = SC.lista; v.innerHTML = '';
  const cli = yo.rol === 'cliente';
  if (yo.puede_crear) cardsAcciones(el('button', { class: 'btn', onclick: () => go('sc_nueva') }, '+ Nueva solicitud'));
  const q = el('input', { type: 'search', placeholder: 'Buscar por folio, nombre o afiliación…', value: L.q, style: 'min-width:240px', 'aria-label': 'Buscar' });
  const grupos = new Map(); (yo.orden || []).forEach(e => { const n = cli ? yo.estados[e].cliente : yo.estados[e].nombre; grupos.set(n, (grupos.get(n) || []).concat(e)); });
  const est = el('select', { 'aria-label': 'Estado' }, el('option', { value: '' }, 'Todos los estados'), el('option', { value: 'abiertas' }, 'Abiertas'), ...[...grupos].map(([n, es]) => el('option', { value: es.join(',') }, n)));
  const tp = el('select', { 'aria-label': 'Tipo' }, el('option', { value: '' }, 'Todos los tipos'), ...(yo.tipos || []).map(t => el('option', { value: t.id }, t.corto)));
  const gr = el('select', { 'aria-label': 'Cliente' }, el('option', { value: '' }, 'Todos los clientes'), ...(yo.grupos || []).map(g => el('option', { value: String(g.id_grupo) }, g.nombre)));
  const vc = el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'scVenc' }), ' Solo vencidas');
  est.value = L.estado; tp.value = L.tipo; gr.value = L.id_grupo; vc.querySelector('input').checked = L.vencidas;
  const barra = el('div', { class: 'filters', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center' }, q, est, tp, ...(cli && yo.grupos.length < 2 ? [] : [gr]), ...(cli ? [] : [vc]));
  const cont = el('div', {}); v.append(barra, cont);
  let t0 = null;
  const pintar = async () => {
    const p = new URLSearchParams({ pagina: L.pagina }); if (L.q) p.set('q', L.q); if (L.estado) p.set('estado', L.estado); if (L.tipo) p.set('tipo', L.tipo); if (L.id_grupo) p.set('id_grupo', L.id_grupo); if (L.vencidas) p.set('vencidas', '1');
    let r; try { r = await call('GET', '/solicitudes?' + p); } catch (e) { cont.innerHTML = ''; cont.append(nota('err', esc(errMsg(e)))); return; }
    cont.innerHTML = '';
    cont.append(tableWrap(['Folio', 'Solicitud', cli ? '' : 'Cliente', 'Estado', 'Enviada', 'Vence', ''], r.filas.map(s => { const row = [esc(s.folio), `<b>${esc(s.tipo_nombre)}</b><small class="muted" style="display:block">${esc(s.titulo || '—')}</small>`, cli ? '' : esc(s.cliente || ''), chipEstado(s.estado, s.estado_nombre) + (s.critica && !cli ? ' ' + badge('violet', 'Crítica') : ''), fFecha(s.enviada_at), s.vence_at ? `${fFecha(s.vence_at)}${s.vencida ? ' ' + badge('danger', 'Vencida') : ''}` : '—', '']; row._onclick = () => abrir(s.id); return row; }),
      { empty: 'No hay solicitudes con esos filtros.' }));
    const paginas = Math.max(1, Math.ceil(r.total / r.por));
    if (r.total > r.por) cont.append(el('div', { style: 'display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px' }, el('span', { class: 'muted', style: 'font-size:12px' }, `${r.total} solicitudes`),
      el('button', { class: 'btn ghost sm', disabled: L.pagina <= 1 ? 'true' : null, onclick: () => { L.pagina--; pintar(); } }, '← Anterior'), el('span', { class: 'muted', style: 'font-size:12px' }, `Página ${L.pagina} de ${paginas}`),
      el('button', { class: 'btn ghost sm', disabled: L.pagina >= paginas ? 'true' : null, onclick: () => { L.pagina++; pintar(); } }, 'Siguiente →')));
  };
  const cambio = () => { L.q = q.value; L.estado = est.value; L.tipo = tp.value; L.id_grupo = gr.value; L.vencidas = vc.querySelector('input').checked; L.pagina = 1; pintar(); };
  q.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(cambio, 300); });
  [est, tp, gr, vc.querySelector('input')].forEach(x => x.addEventListener('change', cambio));
  pintar();
}

/* ============================ NUEVA ============================ */
async function vNueva(v) {
  const yo = await base();
  if (SC.nuevo) return vDetalle(v);
  v.innerHTML = '';
  const grupos = (yo.grupos || []).filter(g => g.portal || yo.rol === 'cliente');
  let idGrupo = SC.cliente || (grupos[0] && grupos[0].id_grupo) || '';
  if (yo.rol !== 'cliente' || grupos.length > 1) {
    const sel = el('select', { id: 'scNuevoGrupo', 'aria-label': 'Cliente' }, ...grupos.map(g => el('option', { value: String(g.id_grupo) }, g.nombre)));
    sel.value = String(idGrupo); sel.addEventListener('change', () => { SC.cliente = Number(sel.value); });
    v.append(panel('¿Para qué cliente?', sel));
    SC.cliente = Number(sel.value || 0) || null;
  } else SC.cliente = idGrupo;
  if (!grupos.length) { v.append(nota('warn', yo.rol === 'cliente' ? 'Tu acceso al portal está desactivado. Habla con tu Ejecutivo Comercial.' : 'No tienes clientes con el portal activo. Actívalos en «Clientes y contactos».')); return; }
  const g = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px' });
  (yo.tipos || []).forEach(tp => g.append(tarjetaTipo(tp, () => iniciarNueva(tp.id))));
  v.append(panel('¿Qué necesitas pedir?', g));
}
function iniciarNueva(tipoId) {
  if (!SC.cliente && SC.yo.grupos.length) SC.cliente = SC.yo.grupos[0].id_grupo;
  SC.nuevo = { tipo: tipoId, id_grupo: SC.cliente }; SC.sel = null; SC.conserva = true;
  if (typeof VIEW !== 'undefined' && VIEW === 'sc_lista') render(); else go('sc_lista');
}

/* ============================ VISTA PREVIA DE UNA AFILIACIÓN ============================ */
const pctTxt = v => (v == null ? '—' : Number(v).toLocaleString('es-MX', { maximumFractionDigits: 4 }) + ' %');
// Las condiciones que POS tiene de la afiliación: datos generales, tasas pactadas, cuenta donde liquida y comercios que ya operan bajo ella.
function previewAfil(a, cat) {
  if (!a) return el('div', {});
  const t = a.tasas || {}; const c = a.cuenta;
  const comercios = [...new Set((cat.unidades || []).filter(u => (u.afiliaciones || []).includes(a.numero)).flatMap(u => u.comercios || []))];
  const celda = (k, v) => `<div style="min-width:130px"><div class="muted" style="font-size:11.5px">${esc(k)}</div><div style="font-weight:600;font-variant-numeric:tabular-nums">${v}</div></div>`;
  return el('div', { class: 'panel', style: 'margin:8px 0 0;padding:12px 14px;background:rgba(127,127,127,.10)' },
    el('div', { style: 'font-weight:700;margin-bottom:8px', html: `Condiciones de la afiliación ${esc(a.numero)}` }),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:12px 22px;margin-bottom:8px', html: celda('Razón social', esc(a.razon_social || '—')) + celda('Giro / MCC', esc(`${a.mcc || '—'}${a.giro ? ' · ' + a.giro : ''}`)) + (c ? celda('Liquida a', esc(`${c.banco || ''} ····${String(c.clabe || '').slice(-4)}`)) + celda('Titular de la cuenta', esc(c.titular || '—')) : '') }),
    el('div', { class: 'muted', style: 'font-size:11.5px' }, 'Tasas pactadas (se heredan al comercio que registres)'),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:12px 22px;margin:4px 0 8px', html: celda('Débito (TDD)', pctTxt(t.tdd)) + celda('Crédito (TDC)', pctTxt(t.tdc)) + celda('Internacional', pctTxt(t.int)) + celda('AMEX', pctTxt(t.amex)) + (t.costo_x_trx ? celda('Costo por transacción', '$' + Number(t.costo_x_trx).toLocaleString('es-MX', { minimumFractionDigits: 2 })) : '') }),
    comercios.length ? el('div', { class: 'muted', style: 'font-size:12.5px', html: `<b>Comercios que ya operan bajo ella (${comercios.length}):</b> ${esc(comercios.slice(0, 8).join(', '))}${comercios.length > 8 ? '…' : ''}` }) : '');
}

/* ---- Aspecto del formulario (secciones con icono y avance, campos con aire, tarjetas de afiliación) ---- */
const IC = {
  store: '<path d="M3 9l1.2-5h15.6L21 9"/><path d="M4 9v11h16V9"/><path d="M9.5 20v-6h5v6"/><path d="M3 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18"/><path d="M7 15h4"/>',
  bank: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8"/><path d="M3 21h18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  percent: '<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M5.8 16.2c.6-2 5.8-2 6.4 0M15 10h3.5M15 14h3.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.6 8-8 9-4.4-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
};
const IC_SECCION = { afiliacion: 'link', comercio: 'store', contacto: 'user', solicitante: 'user', usuario: 'user', modalidad: 'card', condiciones: 'percent', operacion: 'gear', rep: 'id', liquidacion: 'bank', nueva: 'bank', niveles: 'shield', perfil: 'shield', cambio: 'edit', tipo: 'list' };
const icSvg = id => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[IC_SECCION[id]] || IC.list}</svg>`;
function estiloFormulario() {
  if (document.getElementById('sc-form-css')) return;
  const st = document.createElement('style'); st.id = 'sc-form-css';
  st.textContent = `
.sc-form .panel.sc-sec{scroll-margin-top:130px;--sc-i:var(--accent-ink);--sc-t:var(--accent-tint);--sc-e:var(--accent-edge);padding:22px 24px 24px}
.sc-form .sc-sec[data-etapa="comercial"]{--sc-i:var(--violet-ink);--sc-t:var(--violet-tint);--sc-e:color-mix(in srgb,var(--violet) 30%,transparent)}
.sc-form .sc-sec[data-etapa="operacion"]{--sc-i:var(--ok-ink);--sc-t:var(--ok-tint);--sc-e:var(--ok-edge)}
.sc-form h3.sc-h{display:flex;align-items:center;gap:14px;margin:0}
.sc-ic{flex:none;width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:var(--sc-t);color:var(--sc-i);box-shadow:inset 0 0 0 1px var(--sc-e)}
.sc-ht{display:flex;flex-direction:column;gap:2px;min-width:0}
.sc-ht b{font-size:var(--fs-lg,16px);font-weight:600;line-height:1.25}
.sc-ht small{font-size:var(--fs-sm,12px);font-weight:500;color:var(--muted)}
.sc-cnt{margin-left:auto;flex:none;font-size:var(--fs-sm,12px);font-weight:600;padding:4px 11px;border-radius:999px;background:var(--strip);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.sc-cnt.ok{background:var(--ok-tint);color:var(--ok-ink);box-shadow:inset 0 0 0 1px var(--ok-edge)}
.sc-bar{height:4px;border-radius:4px;background:var(--strip);margin:14px 0 18px;overflow:hidden}
.sc-bar i{display:block;height:100%;width:0;border-radius:4px;background:var(--sc-i);transition:width .25s var(--ease,ease)}
.sc-form .form-grid{gap:18px 22px}
.sc-form .field{display:flex;flex-direction:column;gap:7px;margin:0;min-width:0}
.sc-form .field>label{font-size:var(--fs-sm,12px);font-weight:600;color:var(--muted);letter-spacing:.01em}
.sc-form .field.sc-ok>label::after{content:"✓";margin-left:6px;color:var(--ok);font-weight:700}
.sc-form .field input:not([type=checkbox]):not([type=radio]),.sc-form .field select,.sc-form .field textarea{min-height:44px;border-radius:14px;padding:10px 14px;font-size:var(--fs-base,14px);font-family:inherit;background:var(--glass-3);border:1px solid var(--line-strong);transition:border-color .15s,box-shadow .15s,background .15s}
.sc-form .field textarea{min-height:92px;line-height:1.45;resize:vertical}
.sc-form .field input:hover,.sc-form .field select:hover,.sc-form .field textarea:hover{border-color:var(--accent-edge)}
.sc-form .field input:focus,.sc-form .field select:focus,.sc-form .field textarea:focus{outline:none;border-color:var(--accent);background:var(--glass-4);box-shadow:0 0 0 4px var(--accent-tint)}
.sc-form .field .req-note{margin:0;font-size:var(--fs-xs,11px);line-height:1.4}
.sc-form .field.invalid input,.sc-form .field.invalid select,.sc-form .field.invalid textarea{box-shadow:0 0 0 4px var(--danger-tint)}
.sc-afil-g{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;max-height:360px;overflow:auto;padding:3px}
.sc-afil{position:relative;display:flex;flex-direction:column;gap:6px;cursor:pointer;border-radius:16px;padding:14px 16px 14px 44px;border:1px solid var(--line-strong);background:var(--glass-3);transition:border-color .15s,background .15s,box-shadow .15s}
.sc-afil:hover{border-color:var(--accent-edge);background:var(--glass-4)}
.sc-afil::before{content:"";position:absolute;left:15px;top:17px;width:16px;height:16px;border-radius:50%;border:2px solid var(--line-strong);background:var(--glass-4);box-sizing:border-box}
.sc-afil.on{border-color:var(--accent);background:var(--accent-tint);box-shadow:0 0 0 3px var(--accent-tint)}
.sc-afil.on::before{border-color:var(--accent);background:radial-gradient(circle,var(--accent) 0 40%,transparent 45%)}
.sc-afil:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sc-afil .n{font-family:var(--font-mono);font-size:var(--fs-sm,12px);font-weight:600;color:var(--accent-ink)}
.sc-afil .rs{font-weight:600;font-size:var(--fs-md,13px);line-height:1.3}
.sc-afil .gi{font-size:var(--fs-sm,12px);color:var(--muted);line-height:1.35}
.sc-afil .tx{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.sc-afil .tx span{font-size:var(--fs-xs,11px);font-weight:600;padding:3px 9px;border-radius:999px;background:var(--strip);font-variant-numeric:tabular-nums}
.sc-prog{position:sticky;top:8px;z-index:4;display:flex;flex-direction:column;gap:10px;margin:0 0 var(--sp-5,20px);padding:14px 18px;border-radius:18px;background:var(--bar);border:1px solid var(--glass-border);box-shadow:var(--shadow);backdrop-filter:blur(var(--blur,20px)) saturate(160%);-webkit-backdrop-filter:blur(var(--blur,20px)) saturate(160%)}
.sc-prog-t{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sc-prog-t b{font-size:var(--fs-base,14px);font-weight:600}
.sc-prog-t span{font-size:var(--fs-sm,12px);color:var(--muted);font-variant-numeric:tabular-nums}
.sc-prog .sc-bar{margin:0;height:6px}
.sc-prog .sc-bar i{background:linear-gradient(90deg,var(--accent2),var(--accent))}
.sc-prog-c{display:flex;gap:6px;flex-wrap:wrap}
.sc-prog-c button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-strong);background:var(--glass-2);color:var(--ink);border-radius:999px;padding:5px 12px;font:inherit;font-size:var(--fs-sm,12px);cursor:pointer;max-width:100%}
.sc-prog-c button:hover{background:var(--glass-3)}
.sc-prog-c button.ok{background:var(--ok-tint);border-color:var(--ok-edge);color:var(--ok-ink)}
.sc-prog-c button em{font-style:normal;font-weight:600;font-variant-numeric:tabular-nums;opacity:.8}
@media(max-width:620px){.sc-form .panel.sc-sec{padding:18px 16px 20px}.sc-ic{width:36px;height:36px;border-radius:12px}.sc-prog-c button span{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}`;
  document.head.append(st);
}

/* ============================ FORMULARIO (secciones y campos) ============================ */
// Pinta las secciones de un tipo. `ctx` = { d (valores de todas las etapas), editables:Set(etapas), cat, errores, dirty:{etapa:{key:valor}} , onChange }
function formulario(tp, ctx) {
  estiloFormulario();
  const cont = el('div', { class: 'sc-form' }); const refs = []; const avance = [];
  const etiquetaEtapa = { cliente: 'Cliente', comercial: 'Ejecutivo Comercial', operacion: 'Operación POS' };
  const repintar = () => refs.forEach(r => r.actualizar());
  tp.secciones.forEach(sec => {
    if (ctx.cliente && sec.llena !== 'cliente') return;                 // el cliente solo ve su parte (y lo comercial que le corresponde, abajo)
    const editable = ctx.editables.has(sec.llena);
    const oculta = sec.omitir_si && visibleCampo({ show_if: sec.omitir_si }, ctx.d);
    if (oculta) return;                                                  // p. ej. «Cuenta en Suite Banca» solo existe si se pidió esa cuenta
    const cuerpo = el('div', { class: 'form-grid' });
    const cnt = el('span', { class: 'sc-cnt' }); const barra = el('i');
    const pan = el('div', { class: 'panel sc-sec', 'data-etapa': sec.llena, id: 'sc-sec-' + sec.id },
      el('h3', { class: 'sc-h' }, el('span', { class: 'sc-ic', html: icSvg(sec.id) }), el('span', { class: 'sc-ht' }, el('b', {}, sec.titulo), el('small', {}, (editable ? 'Por llenar: ' : 'Parte de: ') + etiquetaEtapa[sec.llena])), cnt),
      editable ? el('div', { class: 'sc-bar' }, barra) : el('div', { style: 'height:14px' }), cuerpo);
    // cuántos obligatorios visibles de esta sección ya tienen respuesta
    const estado = () => { let t = 0, h = 0; sec.campos.forEach(c => { if (!c.required || oculta || !visibleCampo(c, ctx.d)) return; t++; if (!vacio(ctx.d[c.key])) h++; }); return { t, h }; };
    refs.push({ actualizar() { const { t, h } = estado(); cnt.style.display = editable && t ? '' : 'none'; cnt.textContent = h >= t ? '✓ Completa' : `${h} de ${t}`; cnt.classList.toggle('ok', t > 0 && h >= t); barra.style.width = (t ? Math.round(100 * h / t) : 100) + '%'; } });
    if (editable) avance.push({ pan, titulo: sec.titulo, estado });
    sec.campos.forEach(c => {
      const wrap = el('div', { class: 'field' + (c.tipo === 'textarea' || c.tipo === 'lista' || c.tipo === 'checkbox_group' || c.tipo === 'radio' ? ' span2' : ''), 'data-key': c.key });
      const lab = el('label', {}, c.label, c.required ? el('span', { style: 'color:var(--danger,#dc2626)' }, ' *') : '');
      const cap = el('span', { class: 'req-note', style: 'margin:0', 'aria-live': 'polite' });
      const ro = !editable || (c.desde && tp.id === 'alta_subafiliado' && sec.llena === 'comercial');
      const entrada = crearEntrada(c, ctx, ro, () => { ctx.dirty[sec.llena] = ctx.dirty[sec.llena] || {}; ctx.dirty[sec.llena][c.key] = ctx.d[c.key]; repintar(); if (ctx.onChange) ctx.onChange(); });
      wrap.append(lab, entrada.nodo, cap);
      const ayuda = () => { const e = ctx.errores && ctx.errores[c.key]; cap.textContent = e || ''; cap.style.color = e ? 'var(--danger,#dc2626)' : ''; if (!e) cap.textContent = c.hint || ''; if (e) wrap.classList.add('invalid'); else wrap.classList.remove('invalid'); };
      refs.push({ actualizar() { wrap.style.display = visibleCampo(c, ctx.d) && !oculta && !(sec.matriz && c.enMatriz) && !c.oculto_ui && !(c.tipo === 'unidad' && !(ctx.cat.unidades || []).length) ? '' : 'none'; entrada.actualizar && entrada.actualizar(); ayuda(); wrap.classList.toggle('sc-ok', editable && !ro && !vacio(ctx.d[c.key]) && !wrap.classList.contains('invalid')); } });
      cuerpo.append(wrap);
    });
    if (sec.matriz) { const mx = matrizCobro(sec, ctx, editable, repintar); refs.push({ actualizar: mx.dibujar }); cuerpo.append(mx.nodo); }
    cont.append(pan);
  });
  if (avance.length) {
    const tit = el('b', {}), sub = el('span', {}), barra = el('i'), chips = el('div', { class: 'sc-prog-c' });
    const botones = avance.map(a => { const em = el('em'); const b = el('button', { type: 'button', onclick: () => a.pan.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, el('span', {}, a.titulo.replace(/\s*\(.*\)\s*$/, '')), em); chips.append(b); return { b, em, a }; });
    cont.prepend(el('div', { class: 'sc-prog', role: 'status', 'aria-live': 'polite' }, el('div', { class: 'sc-prog-t' }, tit, sub), el('div', { class: 'sc-bar' }, barra), chips));
    refs.push({ actualizar() {
      let T = 0, H = 0;
      botones.forEach(x => { const { t, h } = x.a.estado(); T += t; H += h; x.em.textContent = t ? (h >= t ? '✓' : `${h}/${t}`) : '✓'; x.b.classList.toggle('ok', h >= t); });
      tit.textContent = H >= T ? 'Todo lo obligatorio está completo' : 'Avance de la solicitud'; sub.textContent = H >= T ? 'Ya puedes guardar y enviar.' : `${H} de ${T} datos obligatorios`; barra.style.width = (T ? Math.round(100 * H / T) : 100) + '%';
    } });
  }
  repintar();
  return { nodo: cont, repintar };
}
// Matriz «modalidad × opción de cobro»: una fila por modalidad de activación, un interruptor por opción (propina, MSI, check-in/out) y los plazos de MSI debajo.
// Los datos son los mismos campos del formato (modalidad, pos_propina, pos_msi, pos_msi_plazos…): aquí solo cambia cómo se capturan.
function matrizCobro(sec, ctx, editable, repintar) {
  const mx = sec.matriz, d = ctx.d;
  if (!document.getElementById('sc-mx-css')) {
    const st = document.createElement('style'); st.id = 'sc-mx-css';
    st.textContent = `
.sc-mx-w{grid-column:1/-1;overflow-x:auto}
.sc-mx{width:100%;border-collapse:collapse;font-size:var(--fs-md,13px)}
.sc-mx th{font-weight:500;font-size:var(--fs-sm,12px);color:var(--muted);text-align:center;padding:6px 8px;letter-spacing:.02em}
.sc-mx th:first-child,.sc-mx td:first-child{text-align:left}
.sc-mx td{padding:9px 8px;border-top:1px solid var(--line);text-align:center;vertical-align:middle}
.sc-mx tr.off td:not(:first-child){opacity:.4}
.sc-mx tr.sc-pl td{border-top:0;padding:0 8px 10px;text-align:left}
.sc-pill{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:var(--radius-pill,999px);border:1px solid var(--line-strong);background:var(--glass-2);color:var(--ink);font:inherit;font-size:var(--fs-md,13px);cursor:pointer}
.sc-pill:hover{background:var(--glass-3)}
.sc-pill.on{background:var(--accent-tint);border-color:var(--accent-edge);color:var(--accent-ink);font-weight:600}
.sc-pill[disabled]{cursor:default}
.sc-sw{width:38px;height:22px;border-radius:999px;border:1px solid var(--line-strong);background:var(--strip);position:relative;padding:0;cursor:pointer;transition:background .15s}
.sc-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--muted);transition:left .15s,background .15s}
.sc-sw.on{background:var(--accent);border-color:var(--accent)}
.sc-sw.on::after{left:18px;background:#fff}
.sc-sw[disabled]{cursor:default}
.sc-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.sc-chips small{color:var(--muted);font-size:var(--fs-sm,12px);margin-right:4px}
.sc-chip{padding:4px 12px;border-radius:999px;border:1px solid var(--line-strong);background:var(--glass-2);color:var(--ink);font:inherit;font-size:var(--fs-sm,12px);cursor:pointer}
.sc-chip.on{background:var(--accent-tint);border-color:var(--accent-edge);color:var(--accent-ink);font-weight:600}
.sc-chip[disabled]{cursor:default}
.sc-mx-n{font-size:var(--fs-sm,12px);color:var(--muted);margin:8px 0 0}
@media(max-width:620px){.sc-mx th,.sc-mx td{padding:8px 3px}.sc-mx th{font-size:10px;letter-spacing:0}.sc-pill{padding:6px 10px;font-size:12px;text-align:left;white-space:normal;line-height:1.2;border-radius:14px}.sc-mx td:first-child,.sc-mx th:first-child{width:40%}.sc-sw{width:32px;height:19px}.sc-sw::after{width:13px;height:13px}.sc-sw.on::after{left:15px}}`;
    document.head.append(st);
  }
  const marcar = (k, v) => { d[k] = v; ctx.dirty[sec.llena] = ctx.dirty[sec.llena] || {}; ctx.dirty[sec.llena][k] = v; };
  const elegidas = () => Array.isArray(d[mx.campo]) ? d[mx.campo] : [];
  const cambia = () => { repintar(); if (ctx.onChange) ctx.onChange(); };
  const nodo = el('div', { class: 'sc-mx-w' });
  const dis = editable ? {} : { disabled: 'disabled' };
  function dibujar() {
    nodo.innerHTML = '';
    const sel = elegidas(), vistos = {};
    // lo que se elige sin contestar cuenta como «No»: así el interruptor apagado también es una respuesta
    if (editable) mx.filas.forEach(f => { if (sel.includes(f.valor)) f.opciones.forEach(o => { if (d[f.prefijo + '_' + o] == null || d[f.prefijo + '_' + o] === '') marcar(f.prefijo + '_' + o, 'No'); }); });
    const tabla = el('table', { class: 'sc-mx' });
    tabla.append(el('thead', {}, el('tr', {}, el('th', {}, 'Modalidad de activación', sec.campos.find(c => c.key === mx.campo && c.required) ? el('span', { style: 'color:var(--danger)' }, ' *') : ''), ...mx.columnas.map(c => el('th', {}, c[1])))));
    const cuerpo = el('tbody');
    mx.filas.forEach(f => {
      const on = sel.includes(f.valor);
      const dup = !!f.prefijo && !!vistos[f.prefijo]; if (on && f.prefijo) vistos[f.prefijo] = true;
      const pill = el('button', Object.assign({ type: 'button', class: 'sc-pill' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: () => {
        const n = on ? sel.filter(x => x !== f.valor) : sel.concat(f.valor); marcar(mx.campo, mx.filas.map(x => x.valor).filter(x => n.includes(x))); cambia();
      } }, dis), (on ? '✓ ' : '') + f.valor);
      const tr = el('tr', { class: on ? '' : 'off' }, el('td', {}, pill));
      mx.columnas.forEach(([o]) => {
        if (!f.opciones.includes(o)) { tr.append(el('td', { class: 'muted' }, '—')); return; }
        if (!on) { tr.append(el('td', { class: 'muted' }, '·')); return; }
        if (dup) { tr.append(el('td', { class: 'muted', title: 'Es la misma opción que la modalidad de arriba' }, '↑')); return; }
        const k = f.prefijo + '_' + o, si = d[k] === 'Sí';
        tr.append(el('td', {}, el('button', Object.assign({ type: 'button', class: 'sc-sw' + (si ? ' on' : ''), role: 'switch', 'aria-checked': si ? 'true' : 'false', 'aria-label': f.valor + ': ' + (mx.columnas.find(c => c[0] === o) || [])[1], onclick: () => { marcar(k, si ? 'No' : 'Sí'); cambia(); } }, dis))));
      });
      cuerpo.append(tr);
      if (on && !dup && f.opciones.includes('msi') && d[f.prefijo + '_msi'] === 'Sí') {
        const kp = f.prefijo + '_msi_plazos', act = Array.isArray(d[kp]) ? d[kp] : [];
        const chips = el('div', { class: 'sc-chips' }, el('small', {}, 'Plazos de MSI' + (f.prefijo === 'pos' ? ' en terminal' : f.prefijo === 'link' ? ' en link de pago' : ' en API') + ':'));
        mx.plazos.forEach(p => chips.append(el('button', Object.assign({ type: 'button', class: 'sc-chip' + (act.includes(p) ? ' on' : ''), 'aria-pressed': act.includes(p) ? 'true' : 'false', onclick: () => { marcar(kp, mx.plazos.filter(x => act.includes(x) !== (x === p))); cambia(); } }, dis), p)));
        cuerpo.append(el('tr', { class: 'sc-pl' }, el('td', { colspan: String(mx.columnas.length + 1) }, chips)));
      }
    });
    tabla.append(cuerpo); nodo.append(tabla);
    if (!sel.length) nodo.append(el('p', { class: 'sc-mx-n' }, editable ? 'Marca al menos una modalidad para ver sus opciones de cobro.' : 'Sin modalidades.'));
    else if (editable) nodo.append(el('p', { class: 'sc-mx-n' }, 'Interruptor encendido = sí lo necesita.'));
  }
  return { nodo, dibujar };
}
// «¿Dónde se liquida?»: la concentradora de la afiliación (datos de las cuentas de liquidación de POS) o una cuenta nueva en Suite Banca.
function liquidacionCards(c, ctx, ro, set, val) {
  const cont = el('div', { class: 'sc-afil-g', style: 'max-height:none;overflow:visible' });
  const infoConc = () => {
    const d = ctx.d; if (d.liq_banco) return `${d.liq_banco} · CLABE ${d.liq_clabe || '—'} · ${d.liq_titular || ''}`;
    const a = (ctx.cat.afiliaciones || []).find(x => x.numero === String(d.afil_principal)); if (!d.afil_principal) return 'Elige primero la afiliación principal para ver su cuenta.';
    const q = a && a.cuenta; return q ? `${q.banco} · CLABE ····${String(q.clabe || '').slice(-4)} · ${q.titular || ''}` : 'POS no tiene una cuenta de liquidación registrada para esa afiliación. Avisa a tu Ejecutivo Comercial.';
  };
  const OPC = [
    { v: c.options[0], t: 'Liquidar a la concentradora de la afiliación', sub: () => infoConc(), tag: 'Sin cuenta nueva' },
    { v: c.options[1], t: 'Crear una cuenta nueva en Suite Banca', sub: () => 'Se abre una cuenta para este comercio y su liquidación irá ahí. La abre Operación.', tag: 'Cuenta propia' },
  ];
  function dibuja() {
    cont.innerHTML = '';
    OPC.filter(o => !ro || val() === o.v).forEach(o => {
      const on = val() === o.v;
      const nodo = el('div', Object.assign({ role: 'radio', 'aria-checked': on ? 'true' : 'false', class: 'sc-afil' + (on ? ' on' : ''), style: ro ? 'cursor:default' : '' }, ro ? {} : { tabindex: '0',
        onclick: () => { set(o.v); }, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click(); } } }),
        el('span', { class: 'rs' }, o.t), el('span', { class: 'gi' }, o.sub()), el('span', { class: 'tx' }, el('span', {}, o.tag)));
      cont.append(nodo);
    });
    if (ro && !val()) cont.append(el('span', { class: 'muted' }, '—'));
  }
  dibuja();
  return { nodo: cont, actualizar: dibuja };
}
function crearEntrada(c, ctx, ro, cambio) {
  const d = ctx.d; const val = () => d[c.key];
  const set = v => { d[c.key] = v; cambio(); };
  const t = c.tipo;
  if (c.variante === 'liquidacion') return liquidacionCards(c, ctx, ro, set, val);
  if (ro && t === 'afiliacion') { const m = el('div', {}); return { nodo: m, actualizar() { m.innerHTML = ''; const a = (ctx.cat.afiliaciones || []).find(x => x.numero === String(val())); m.append(a ? previewAfil(a, ctx.cat) : el('span', { class: 'muted' }, '—')); } }; }
  if (ro) { const m = el('div', { class: 'valor-ro', style: 'padding:6px 0;min-height:22px' }); return { nodo: m, actualizar() { const v = val(); m.innerHTML = vacio(v) ? '<span class="muted">—</span>' : esc(Array.isArray(v) ? v.join(', ') : t === 'porcentaje' ? v + ' %' : String(v)).replace(/\n/g, '<br>'); } }; }
  if (t === 'textarea') { const i = el('textarea', { rows: 3, style: 'width:100%', maxlength: '2000' }); i.value = val() || ''; i.addEventListener('input', () => set(i.value)); return { nodo: i }; }
  if (t === 'lista') { const i = el('textarea', { rows: 3, style: 'width:100%', placeholder: 'Uno por renglón' }); i.value = Array.isArray(val()) ? val().join('\n') : (val() || ''); i.addEventListener('input', () => set(i.value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))); return { nodo: i }; }
  if (t === 'catalogo_multi') {
    const fuente = c.fuente; const lista = fuente === 'empresas' ? ctx.cat.empresas : fuente === 'unidades' ? (ctx.cat.unidades || []).map(u => u.nombre) : ctx.cat.comercios;
    if (!lista || !lista.length) { const i = el('textarea', { rows: 3, style: 'width:100%', placeholder: 'Uno por renglón' }); i.value = Array.isArray(val()) ? val().join('\n') : ''; i.addEventListener('input', () => set(i.value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))); return { nodo: i }; }
    const box = el('div', { style: 'display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto;padding:6px 8px;border:1px solid var(--border,#d1d5db);border-radius:8px' });
    lista.forEach(o => { const ch = el('input', { type: 'checkbox' }); ch.checked = (val() || []).includes(o); ch.addEventListener('change', () => { const cur = new Set(val() || []); ch.checked ? cur.add(o) : cur.delete(o); set(lista.filter(x => cur.has(x))); }); box.append(el('label', { class: 'chk' }, ch, ' ' + o)); });
    return { nodo: box };
  }
  if (t === 'unidad') {
    const s = el('select', {}); s.append(el('option', { value: '' }, 'Elige…')); (ctx.cat.unidades || []).forEach(u => s.append(el('option', { value: u.nombre }, u.nombre))); s.value = val() || '';
    s.addEventListener('change', () => {
      set(s.value); const u = (ctx.cat.unidades || []).find(x => x.nombre === s.value);
      if (u && (u.afiliaciones || []).length === 1 && d.afil_principal !== u.afiliaciones[0]) { d.afil_principal = u.afiliaciones[0]; ctx.dirty.cliente = ctx.dirty.cliente || {}; ctx.dirty.cliente.afil_principal = d.afil_principal; cambio(); }
    });
    return { nodo: s };
  }
  if (t === 'checkbox_group') {
    const box = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
    (c.options || []).forEach(o => { const ch = el('input', { type: 'checkbox' }); ch.checked = (val() || []).includes(o); ch.addEventListener('change', () => { const cur = new Set(val() || []); ch.checked ? cur.add(o) : cur.delete(o); set((c.options || []).filter(x => cur.has(x))); }); box.append(el('label', { class: 'chk' }, ch, ' ' + o)); });
    return { nodo: box };
  }
  if (t === 'radio') {
    const box = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px 18px' }); const nombre = 'r_' + c.key + Math.random().toString(36).slice(2, 6);
    (c.options || []).forEach(o => { const r = el('input', { type: 'radio', name: nombre }); r.checked = val() === o; r.addEventListener('change', () => set(o)); box.append(el('label', { class: 'chk' }, r, ' ' + o)); });
    return { nodo: box };
  }
  if (t === 'afiliacion') {
    const lista = ctx.cat.afiliaciones || []; const cont = el('div', {});
    const buscar = lista.length > 6 ? el('input', { type: 'search', placeholder: 'Buscar afiliación…', style: 'margin-bottom:8px;width:100%', 'aria-label': 'Buscar afiliación' }) : null;
    const grid = el('div', { class: 'sc-afil-g' }); const prev = el('div', {});
    const pinta = () => {
      const q = buscar ? buscar.value.toLowerCase() : ''; grid.innerHTML = '';
      lista.filter(a => !q || (a.numero + ' ' + a.razon_social).toLowerCase().includes(q)).forEach(a => {
        const sel = String(val()) === a.numero; const tt = a.tasas || {};
        grid.append(el('div', { role: 'radio', 'aria-checked': sel ? 'true' : 'false', tabindex: '0', class: 'sc-afil' + (sel ? ' on' : ''),
          onclick: () => { set(a.numero); pinta(); prev.innerHTML = ''; prev.append(previewAfil(a, ctx.cat)); }, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click(); } } },
          el('span', { class: 'n' }, a.numero), el('span', { class: 'rs' }, a.razon_social || '—'), el('span', { class: 'gi' }, `MCC ${a.mcc || '—'}${a.giro ? ' · ' + a.giro : ''}`),
          el('span', { class: 'tx' }, el('span', {}, `TDD ${pctTxt(tt.tdd)}`), el('span', {}, `TDC ${pctTxt(tt.tdc)}`))));
      });
      if (!grid.children.length) grid.append(el('div', { class: 'muted' }, 'No hay afiliaciones con ese filtro.'));
    };
    if (buscar) buscar.addEventListener('input', pinta);
    cont.append(...(buscar ? [buscar] : []), grid, prev); pinta();
    const a0 = lista.find(x => x.numero === String(val())); if (a0) prev.append(previewAfil(a0, ctx.cat));
    return { nodo: cont, actualizar() { pinta(); prev.innerHTML = ''; const a = lista.find(x => x.numero === String(val())); if (a) prev.append(previewAfil(a, ctx.cat)); } };
  }
  if (t === 'select' || t === 'banco') {
    const s = el('select', {}); s.append(el('option', { value: '' }, 'Elige…'));
    const opts = t === 'afiliacion' ? (ctx.cat.afiliaciones || []).map(a => [a.numero, `${a.numero} · ${a.razon_social}`]) : t === 'banco' ? (ctx.cat.bancos || []).map(b => [b.nombre, b.nombre]) : (c.options || []).map(o => [o, o]);
    opts.forEach(([v, l]) => s.append(el('option', { value: String(v) }, l))); s.value = val() == null ? '' : String(val());
    const info = el('div', { class: 'req-note', style: 'margin-top:4px' });
    const pinta = () => { if (t !== 'afiliacion') return; const a = (ctx.cat.afiliaciones || []).find(x => x.numero === String(val())); info.innerHTML = a ? `MCC ${esc(a.mcc || '—')} · ${esc(a.giro || '')} · tasas pactadas: TDD ${a.tasas.tdd ?? '—'}% · TDC ${a.tasas.tdc ?? '—'}% · INT ${a.tasas.int ?? '—'}% · AMEX ${a.tasas.amex ?? '—'}%` + (a.cuenta ? `<br>Liquida a: ${esc(a.cuenta.banco)} ····${esc(String(a.cuenta.clabe).slice(-4))} · ${esc(a.cuenta.titular || '')}` : '') : ''; };
    s.addEventListener('change', () => { set(s.value); pinta(); });
    const nodo = el('div', {}, s, info); pinta();
    return { nodo, actualizar() { s.value = val() == null ? '' : String(val()); pinta(); } };
  }
  const tipoInput = { email: 'email', tel: 'tel', number: 'number', date: 'date', cp: 'text' }[t] || 'text';
  const i = el('input', { type: tipoInput, maxlength: t === 'clabe' ? '22' : t === 'rfc' ? '13' : t === 'curp' ? '18' : t === 'cp' ? '5' : '200', autocomplete: 'off', inputmode: ['clabe', 'cp', 'tel', 'number', 'porcentaje'].includes(t) ? 'decimal' : null,
    placeholder: t === 'porcentaje' ? 'Ej. 1.85' : t === 'clabe' ? '18 dígitos' : '' });
  if (t === 'number') i.step = 'any'; if (t === 'number' || t === 'porcentaje') i.min = '0';
  i.value = val() == null ? '' : String(val());
  i.addEventListener('input', () => { if (t === 'rfc' || t === 'curp') i.value = i.value.toUpperCase().replace(/[^A-Z0-9Ñ&]/g, ''); if (t === 'clabe' || t === 'cp') i.value = i.value.replace(/\D/g, ''); set(t === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value); });
  return { nodo: i };
}

/* ============================ DETALLE / ALTA ============================ */
const ETAPAS_FLUJO = [['Cliente', ['borrador', 'devuelta']], ['Comercial', ['revision_comercial']], ['Operación', ['operacion', 'ejecucion']], ['Validación', ['validacion']], ['Completada', ['completada']]];
function stepper(estado) {
  const idx = ETAPAS_FLUJO.findIndex(([, e]) => e.includes(estado));
  return el('div', { class: 'stepper', style: 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px' }, ...ETAPAS_FLUJO.map(([n], i) => el('span', { class: 'badge ' + (idx < 0 ? 'neutral' : i < idx ? 'ok' : i === idx ? 'info' : 'neutral'), style: 'opacity:' + (idx >= 0 && i > idx ? '.55' : '1') }, (i < idx ? '✓ ' : '') + n)));
}
async function vDetalle(v) {
  const yo = SC.yo; v.innerHTML = '';
  if (SC.nuevo) return vAlta(v);
  let r; try { r = await call('GET', '/solicitudes/' + SC.sel); } catch (e) { SC.sel = null; v.append(nota('err', esc(errMsg(e)))); return; }
  const s = r.solicitud, tp = r.tipo, cli = esCliente();
  const cat = await catalogoDe(s.id_grupo);
  const d = { ...(s.datos || {}), ...(s.datos_comercial || {}), ...(s.datos_operacion || {}) };
  const ctx = { d, editables: new Set(r.editables), cat, errores: {}, dirty: {}, cliente: cli };
  cardsAcciones(el('button', { class: 'btn secondary', onclick: volver }, '← Solicitudes'),
    el('button', { class: 'btn secondary', onclick: () => descargar(`/api/sc/solicitudes/${s.id}/formato.pdf`, `${tp.formato}-${s.folio}.pdf`).catch(falla) }, 'Descargar formato (PDF)'),
    ...(!cli ? [el('button', { class: 'btn ghost', onclick: () => abrirFormato(s.id) }, 'Vista para imprimir')] : []));
  // encabezado
  const vence = s.vence_at && ['borrador', 'revision_comercial', 'devuelta', 'operacion', 'ejecucion', 'validacion'].includes(s.estado) ? `<span class="muted">Vence ${fFecha(s.vence_at)}</span> ${s.vencida ? badge('danger', 'Vencida') : ''}` : '';
  v.append(el('div', { class: 'panel' },
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, el('h2', { style: 'margin:0;font-size:18px' }, tp.nombre), el('span', { html: chipEstado(s.estado, cli ? r.estado_info.nombre_cliente : r.estado_info.nombre) + (r.requiere_direccion.si && !cli ? ' ' + badge('violet', 'Requiere Dirección', r.requiere_direccion.motivo) : '') }), el('span', { html: vence })),
    el('div', { class: 'muted', style: 'margin:4px 0' }, `${s.folio} · ${s.cliente || ''} · ${tp.formato} · creada ${fF(s.creado_at)}` + (s.solicitante_nombre ? ' por ' + s.solicitante_nombre : '')),
    stepper(s.estado)));
  // qué sigue / qué falta
  v.append(...avisos(r, s, tp, cli));
  // acciones
  const acc = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px' });
  const hayCambios = () => Object.values(ctx.dirty).some(o => Object.keys(o).length);
  const guardar = async (silencioso) => {
    if (!hayCambios()) return true;
    const b = { _v: s.version }; const mapa = { cliente: 'datos', comercial: 'datos_comercial', operacion: 'datos_operacion' };
    for (const [et, o] of Object.entries(ctx.dirty)) if (Object.keys(o).length) b[mapa[et]] = o;
    try { await withBusy('Guardando…', () => call('PUT', '/solicitudes/' + s.id, b)); ctx.dirty = {}; if (!silencioso) toast('Guardado', 'ok'); return true; }
    catch (e) { if (e.data && e.data.campos) { ctx.errores = e.data.campos; form.repintar(); } falla(e); return false; }
  };
  const orden = ['enviar', 'liberar', 'tomar', 'ejecutar', 'validar', 'devolver', 'devolver_comercial', 'observar', 'rechazar', 'cancelar'];
  if (r.editables.length) acc.append(el('button', { class: 'btn secondary', id: 'scGuardar', onclick: async () => { if (await guardar()) render(); } }, 'Guardar cambios'));
  orden.filter(a => r.acciones[a]).forEach(a => {
    const info = r.acciones[a]; const peligro = ['rechazar', 'cancelar', 'devolver', 'devolver_comercial', 'observar'].includes(a);
    acc.append(el('button', { class: 'btn ' + (peligro ? (a === 'rechazar' || a === 'cancelar' ? 'danger' : 'secondary') : ''), onclick: () => ejecutarAccion(s, a, info, guardar, cli) }, info.nombre));
  });
  v.append(acc);
  // datos
  const form = formulario(tp, ctx); v.append(form.nodo);
  // documentos
  if ((tp.docs || []).length) v.append(panelDocs(s, tp, r, cli));
  else if (r.adjuntos.length || !['completada', 'rechazada', 'cancelada'].includes(s.estado)) v.append(panelAdjuntos(s, r, cli));
  // referencia POS (personal)
  if (!cli) v.append(panelReferencia(r));
  // conversación e historial
  v.append(panelHistorial(s, r, cli));
}
function avisos(r, s, tp, cli) {
  const out = []; const f = r.faltantes, ac = r.acciones;
  const lista = (arr, docs) => '<ul style="margin:6px 0 0 18px">' + arr.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>';
  if (s.estado === 'devuelta') out.push(nota('warn', `<b>Tu Ejecutivo Comercial devolvió la solicitud.</b> Completa o corrige lo que pidió y vuelve a enviarla.` + ultimoComentario(r, 'devolver')));
  if (s.estado === 'borrador' && ac.enviar !== undefined || (s.estado === 'devuelta' && ac.enviar !== undefined)) {
    const faltan = f.cliente.map(x => x.label).concat(r.docs_faltantes.map(id => 'Documento: ' + ((tp.docs || []).find(d => d.id === id) || {}).nombre));
    if (faltan.length) out.push(nota('', `<b>Para enviarla falta:</b>${lista(faltan)}`)); else out.push(nota('ok', '<b>Todo listo.</b> Revisa los datos y pulsa «Enviar».'));
  }
  if (s.estado === 'revision_comercial' && ac.liberar !== undefined) {
    const faltan = f.comercial.map(x => x.label).concat(r.docs_faltantes_comercial.map(id => 'Documento: ' + ((tp.docs || []).find(d => d.id === id) || {}).nombre));
    out.push(nota(faltan.length ? '' : 'ok', faltan.length ? `<b>Para liberar a Operación falta:</b>${lista(faltan)}` : '<b>Lista para liberar a Operación.</b>'));
  }
  if (s.estado === 'revision_comercial' && cli) out.push(nota('', '<b>Tu Ejecutivo Comercial la está revisando.</b> Te avisaremos por correo si necesita algo.'));
  if (['operacion', 'ejecucion', 'validacion'].includes(s.estado) && cli) out.push(nota('', '<b>Tu solicitud está en proceso.</b> Te avisaremos por correo cuando quede completada.'));
  if (s.estado === 'ejecucion' && ac.ejecutar !== undefined) { const faltan = f.operacion.map(x => x.label); out.push(nota(faltan.length ? '' : 'ok', faltan.length ? `<b>Para marcarla como ejecutada falta:</b>${lista(faltan)}` : '<b>Datos de Operación completos.</b>')); }
  if (s.estado === 'validacion' && !cli) out.push(nota('', `<b>Validación:</b> ${s.validada_por ? 'Coordinación ya validó. ' : ''}${s.requiere_direccion ? (s.direccion_por ? 'La Dirección ya firmó.' : 'Falta la firma de la Dirección de Operaciones.') : ''}`));
  if (s.estado === 'completada') out.push(nota('ok', cli ? '<b>Tu solicitud se completó.</b> ' + resumenCompletada(s, tp) : '<b>Solicitud completada.</b> Puedes imprimir el formato oficial para el expediente.'));
  if (s.estado === 'rechazada' || s.estado === 'cancelada') out.push(nota('err', `<b>${s.estado === 'rechazada' ? 'Rechazada' : 'Cancelada'}.</b> ${esc(s.motivo || '')}`));
  if (!cli && (r.alertas || []).length) out.push(nota('warn', `<b>Revisa antes de continuar:</b>${lista(r.alertas)}`));
  if (!cli && Object.keys(r.errores_negocio || {}).length) out.push(nota('err', `<b>Datos que no coinciden con POS:</b>${lista(Object.values(r.errores_negocio))}`));
  if (tp.ventana && !cli) out.push(nota('', esc(tp.ventana)));
  return out;
}
const ultimoComentario = (r, accion) => { const e = [...r.eventos].reverse().find(x => x.accion === accion); const t = e && ((e.meta && e.meta.comentario) || (e.detalle || '').split(': ').slice(1).join(': ')); return t ? `<div style="margin-top:6px">«${esc(t)}»</div>` : ''; };
function resumenCompletada(s, tp) { const o = s.datos_operacion || {}; const partes = []; if (o.numero_afiliacion) partes.push('Número de afiliación: <b>' + esc(o.numero_afiliacion) + '</b>'); if (o.id_sub_comercio) partes.push('ID de sub comercio: <b>' + esc(o.id_sub_comercio) + '</b>'); if (o.usuario_creado) partes.push('Usuario: <b>' + esc(o.usuario_creado) + '</b>'); return partes.join(' · '); }

function ejecutarAccion(s, accion, info, guardar, cli) {
  const necesita = info.comentario > 0; const pideOpcional = ['liberar', 'validar', 'ejecutar', 'tomar', 'enviar'].includes(accion);
  const confirmaSolo = ['enviar', 'tomar'].includes(accion);
  const go_ = async comentario => {
    if (!(await guardar(true))) return;
    try { const r = await withBusy('Procesando…', () => call('POST', `/solicitudes/${s.id}/accion`, { accion, comentario, _v: undefined })); closeModal(); toast(info.nombre + ': listo', 'ok'); render(); void r; }
    catch (e) { closeModal(); if (e.data && (e.data.faltan || e.data.documentos || e.data.campos)) detalleFalta(e); else falla(e); render(); }
  };
  if (!necesita && confirmaSolo) { go_(''); return; }
  const ta = el('textarea', { rows: 4, style: 'width:100%', placeholder: necesita ? `Mínimo ${info.comentario} caracteres` : 'Comentario (opcional)' });
  const ok = el('button', { class: 'btn' + (['rechazar', 'cancelar'].includes(accion) ? ' danger' : ''), onclick: async () => { if (necesita && ta.value.trim().length < info.comentario) return toast(`Escribe al menos ${info.comentario} caracteres`, 'err'); ok.disabled = true; await go_(ta.value.trim()); } }, info.nombre);
  const texto = { devolver: 'Explica al cliente qué debe completar o corregir.', devolver_comercial: 'Explica qué necesita aclarar Comercial.', observar: 'Indica las observaciones que Operación debe atender.', rechazar: 'Explica por qué no procede la solicitud.', cancelar: 'Indica por qué se cancela.', validar: 'Con tu validación queda constancia de quién y cuándo.', liberar: 'Se liberará a Operación POS.', ejecutar: 'Confirma que la solicitud ya quedó ejecutada.' }[accion] || '';
  modal(info.nombre, el('div', {}, texto ? el('div', { class: 'banner' }, texto) : '', pideOpcional || necesita ? el('label', { class: 'field' }, 'Comentario', ta) : ''), el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), ok));
  void cli;
}
function detalleFalta(e) {
  const d = e.data || {}; const li = [];
  (d.faltan || []).forEach(x => li.push(`<li>${esc(x.label)} <span class="muted">(${esc(x.seccion || '')})</span></li>`));
  (d.documentos || []).forEach(x => li.push(`<li>Documento: ${esc(x)}</li>`));
  Object.values(d.campos || {}).forEach(x => li.push(`<li>${esc(x)}</li>`));
  modal(d.error || 'Falta información', el('div', {}, el('div', { class: 'banner err', html: `<b>${esc(d.error || 'Falta información')}</b><ul style="margin:6px 0 0 18px">${li.join('')}</ul>` })), el('div', {}, el('button', { class: 'btn', onclick: closeModal }, 'Entendido')));
}
async function abrirFormato(id) {
  try { const r = await fetch(`/api/sc/solicitudes/${id}/formato.html`, { headers: { authorization: 'Bearer ' + localStorage.getItem('cl_token') } }); if (!r.ok) throw new Error('No se pudo generar el formato'); const w = window.open(URL.createObjectURL(await r.blob()), '_blank'); if (!w) toast('Permite las ventanas emergentes para ver el formato', 'err'); } catch (e) { falla(e); }
}

/* ---------- documentos y adjuntos ---------- */
function panelDocs(s, tp, r, cli) {
  const subir = (docId) => { const f = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx,.csv,.xml,.txt', style: 'display:none' }); f.addEventListener('change', async () => { if (!f.files[0]) return; const fd = new FormData(); if (docId) fd.append('doc_id', docId); fd.append('archivo', f.files[0]); try { await withBusy('Subiendo archivo…', () => call('POST', `/solicitudes/${s.id}/adjuntos`, fd)); toast('Archivo cargado', 'ok'); render(); } catch (e) { falla(e); } }); f.click(); };
  const puede = (cli ? ['borrador', 'devuelta'].includes(s.estado) : !['completada', 'rechazada', 'cancelada'].includes(s.estado));
  const filas = (tp.docs || []).filter(d => !cli || (d.etapa || 'cliente') === 'cliente').map(d => {
    const a = r.adjuntos.find(x => x.doc_id === d.id);
    const acc = el('div', { class: 'acciones' });
    if (a) acc.append(el('button', { class: 'btn ghost sm', onclick: () => descargar(`/api/sc/solicitudes/${s.id}/adjuntos/${a.id}`, a.nombre).catch(falla) }, 'Ver'));
    if (puede) acc.append(el('button', { class: 'btn secondary sm', onclick: () => subir(d.id) }, a ? 'Reemplazar' : 'Subir'));
    return [`${esc(d.nombre)}${d.requerido ? ' <span style="color:var(--danger,#dc2626)">*</span>' : ''}${d.ayuda ? `<small class="muted" style="display:block">${esc(d.ayuda)}</small>` : ''}`, a ? badge('ok', 'Cargado') + `<small class="muted" style="display:block">${esc(a.nombre)} · ${Math.round((a.tam || 0) / 1024)} KB · ${fF(a.subido_at)}</small>` : (d.requerido ? badge('warn', 'Falta') : badge('neutral', 'Opcional')), acc];
  });
  const libres = r.adjuntos.filter(a => !a.doc_id);
  const p = panel('Documentos', tableWrap(['Documento', 'Estado', ''], filas, { empty: '' }));
  if (libres.length || puede) {
    p.append(el('div', { style: 'margin-top:10px', class: 'muted' }, 'Otros archivos: '), ...libres.map(a => el('div', {}, el('button', { class: 'btn ghost sm', onclick: () => descargar(`/api/sc/solicitudes/${s.id}/adjuntos/${a.id}`, a.nombre).catch(falla) }, a.nombre))));
    if (puede) p.append(el('button', { class: 'btn ghost sm', onclick: () => subir(null) }, '+ Agregar otro archivo'));
  }
  p.append(el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, 'Se aceptan PDF, imágenes (JPG, PNG, WEBP, HEIC), Word, Excel, CSV y XML de hasta 15 MB. Los archivos se guardan cifrados.'));
  return p;
}
function panelAdjuntos(s, r, cli) { return panelDocs(s, { docs: [] }, r, cli); }
function panelReferencia(r) {
  const ref = r.referencia_pos || {}; if (!ref.afiliacion) return '';
  const t = ref.tasas || {}; const c = ref.cuenta;
  return panel('Lo que tiene POS de la afiliación', el('div', { class: 'muted', style: 'font-size:13px', html: `<b>${esc(ref.afiliacion.numero)}</b> · ${esc(ref.afiliacion.razon_social)} · MCC ${esc(ref.afiliacion.mcc || '—')} (${esc(ref.afiliacion.giro || '—')})<br>Tasas pactadas: TDD ${t.tdd ?? '—'}% · TDC ${t.tdc ?? '—'}% · INT ${t.int ?? '—'}% · AMEX ${t.amex ?? '—'}%` + (c ? `<br>Liquida a: ${esc(c.banco)} · ${esc(c.clabe)} · ${esc(c.titular || '')}` : '') + `<br><small>Congelado el ${fF(ref.tomada_at)}</small>` }));
}

/* ---------- historial y comentarios ---------- */
function panelHistorial(s, r, cli) {
  const ta = el('textarea', { rows: 2, style: 'width:100%', placeholder: 'Escribe un comentario…' });
  const vis = el('input', { type: 'checkbox' });
  const enviar = el('button', { class: 'btn secondary sm', onclick: async () => { if (!ta.value.trim()) return; enviar.disabled = true; try { await call('POST', `/solicitudes/${s.id}/comentarios`, { texto: ta.value.trim(), visible_cliente: vis.checked }); render(); } catch (e) { falla(e); enviar.disabled = false; } } }, 'Comentar');
  const caja = (SC.yo.rol === 'consulta') ? '' : el('div', { style: 'margin-bottom:10px' }, ta, el('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:6px' }, enviar, cli ? '' : el('label', { class: 'chk' }, vis, ' Visible para el cliente')));
  const lista = el('div', { class: 'timeline' }, ...[...r.eventos].reverse().map(e => el('div', { style: 'border-left:3px solid var(--border,#d1d5db);padding:2px 0 8px 10px;margin-left:4px' },
    el('div', { style: 'font-size:12px;color:var(--muted)' }, `${fF(e.ts)} · ${esc(e.actor_nombre || e.actor || '')}`, e.visible_cliente === false && !cli ? '  · interno' : ''),
    el('div', { html: esc(e.detalle || e.accion).replace(/\n/g, '<br>') }))));
  return panel('Historial y comentarios', caja, lista);
}

/* ============================ ALTA (captura de una solicitud nueva) ============================ */
async function vAlta(v) {
  const tp = tipoDe(SC.nuevo.tipo); const cat = await catalogoDe(SC.nuevo.id_grupo);
  const cli = esCliente(); const d = {};
  // precarga datos del solicitante
  const pf = cat.perfil || { nombre: SC.yo.nombre, email: SC.yo.usuario, puesto: '', telefono: '' };
  if (tp.id === 'usuario_suite') { d.sol_nombre = pf.nombre; d.sol_email = pf.email; if (pf.puesto) d.sol_puesto = pf.puesto; if (pf.telefono) d.sol_tel = pf.telefono; }
  if (tp.id === 'alta_subafiliado') { d.contacto_nombre = pf.nombre; d.contacto_email = pf.email; if (pf.puesto) d.contacto_puesto = pf.puesto; if (pf.telefono) d.contacto_tel = pf.telefono; }
  // Con una sola unidad de negocio (o afiliación) asignada, ya sale elegida.
  if ((cat.unidades || []).length === 1) { const u = cat.unidades[0]; if (tp.id === 'alta_subafiliado') { d.unidad_negocio = u.nombre; if ((u.afiliaciones || []).length === 1) d.afil_principal = u.afiliaciones[0]; } if (tp.id === 'usuario_suite') d.nivel_udn = [u.nombre]; }
  if (tp.requiere_afiliacion && cat.afiliaciones.length === 1 && !d.afil_principal) d.afil_principal = cat.afiliaciones[0].numero;
  const ctx = { d, editables: new Set(['cliente']), cat, errores: {}, dirty: { cliente: {} }, cliente: true };
  if (cat.acotado) ctx.aviso = true;
  cardsAcciones(el('button', { class: 'btn secondary', onclick: volver }, '← Cancelar'), el('button', { class: 'btn ghost', onclick: () => descargar(`/api/sc/formatos/${tp.id}/pdf`, `${tp.formato}-formato-en-blanco.pdf`).catch(falla) }, 'Formato en blanco (PDF)'));
  const grupo = (SC.yo.grupos || []).find(g => g.id_grupo === SC.nuevo.id_grupo);
  v.append(el('div', { class: 'panel' }, el('h2', { style: 'margin:0;font-size:18px' }, tp.nombre), el('div', { class: 'muted', style: 'margin:4px 0' }, `${tp.formato} · ${grupo ? grupo.nombre : ''}`), el('div', { class: 'muted' }, tp.descripcion)));
  if (cat.acotado) v.append(nota('', 'Tu acceso está acotado a ' + (cat.unidades.map(u => u.nombre).join(', ') || 'tus unidades de negocio') + '. Solo verás y podrás pedir lo de esas unidades.'));
  if (tp.requiere_afiliacion && !cat.afiliaciones.length) v.append(nota('err', 'Este cliente no tiene afiliaciones activas en POS, así que no se puede pedir esto todavía. Habla con tu Ejecutivo Comercial.'));
  const form = formulario(tp, ctx); v.append(form.nodo);
  if ((tp.docs || []).length) v.append(nota('', 'Después de guardar el borrador podrás subir los documentos que se piden y enviar la solicitud.'));
  const b = el('button', { class: 'btn', onclick: async () => {
    b.disabled = true;
    try { const r = await withBusy('Guardando…', () => call('POST', '/solicitudes', { tipo: tp.id, id_grupo: SC.nuevo.id_grupo, datos: ctx.d })); toast('Borrador guardado', 'ok'); SC.nuevo = null; SC.sel = r.id; render(); }
    catch (e) { if (e.data && e.data.campos) { ctx.errores = e.data.campos; form.repintar(); } falla(e); b.disabled = false; } } }, 'Guardar borrador');
  v.append(el('div', { style: 'display:flex;gap:8px;margin:10px 0' }, b, el('button', { class: 'btn secondary', onclick: volver }, 'Cancelar')));
  void cli;
}

/* ============================ CLIENTES Y CONTACTOS (personal) ============================ */
async function vClientes(v) {
  const yo = await base(); v.innerHTML = '';
  const filas = await call('GET', '/clientes');
  const ej = yo.puede_asignar ? await call('GET', '/ejecutivos') : [];
  v.append(nota('', 'Por cada cliente defines sus unidades de negocio (se cargan de POS) y das de alta a las personas que entran al portal, con acceso a todo el cliente o solo a algunas unidades. Entran con «Entrar con Google» usando el correo que registres; sus solicitudes ya salen con eso predefinido y solo llenan lo demás.'));
  v.append(panel('', tableWrap(['Cliente', 'Portal', 'Ejecutivo Comercial', 'Unidades de negocio', 'Contactos', 'Abiertas', ''], filas.map(c => { const r = [`<b>${esc(c.nombre)}</b>`, c.portal ? badge('ok', 'Activo') : badge('neutral', 'Sin activar'), c.ejecutivo ? esc(c.ejecutivo) : '<span class="muted">Sin asignar</span>', { num: c.unidades }, { num: c.contactos }, { num: c.abiertas }, '']; r._onclick = () => dlgCliente(c, ej, yo); return r; }), { empty: 'No hay clientes.' })));
}
async function dlgCliente(c, ejecutivos, yo, tab) {
  tab = tab || 'general';
  const [cont, un] = await Promise.all([call('GET', `/clientes/${c.id_grupo}/contactos`), call('GET', `/clientes/${c.id_grupo}/unidades`)]);
  const recarga = (t, msg) => { if (msg) toast(msg, 'ok'); dlgCliente({ ...c, portal: true }, ejecutivos, yo, t || tab); };
  const nombreUn = id => (un.unidades.find(x => x.id === id) || {}).nombre || '';
  const tabs = el('div', { style: 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap' }, ...[['general', 'General'], ['unidades', `Unidades de negocio (${un.unidades.filter(u => u.activo).length})`], ['contactos', `Contactos (${cont.length})`]].map(([k, n]) => el('button', { class: 'btn ' + (tab === k ? '' : 'secondary') + ' sm', onclick: () => recarga(k) }, n)));
  let cuerpo; let pie = el('button', { class: 'btn secondary', onclick: closeModal }, 'Cerrar');

  if (tab === 'general') {
    const sel = el('select', { id: 'scEj', disabled: yo.puede_asignar ? null : 'true' }, el('option', { value: '' }, 'Sin asignar'), ...ejecutivos.map(e => el('option', { value: String(e.id) }, e.nombre)));
    sel.value = c.ejecutivo_id ? String(c.ejecutivo_id) : '';
    const portal = el('input', { type: 'checkbox', id: 'scPortal' }); portal.checked = !!c.portal;
    cuerpo = el('div', {}, el('div', { class: 'form-grid' }, el('label', { class: 'field' }, 'Ejecutivo Comercial', sel), el('label', { class: 'chk', style: 'align-self:end' }, portal, ' Portal activo para este cliente')),
      el('div', { class: 'req-note', style: 'margin-top:10px' }, 'El Ejecutivo Comercial recibe y revisa primero las solicitudes de este cliente. Define sus unidades de negocio en la pestaña siguiente y da a cada contacto acceso a todas o solo a algunas.'));
    pie = el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cerrar'), el('button', { class: 'btn', onclick: async () => { try { const b = { activo: portal.checked }; if (yo.puede_asignar) b.ejecutivo_id = sel.value || null; await call('PUT', '/clientes/' + c.id_grupo, b); closeModal(); toast('Cliente guardado', 'ok'); render(); } catch (e) { falla(e); } } }, 'Guardar'));
  }

  if (tab === 'unidades') {
    const filas = un.unidades.map(u => { const acc = el('div', { class: 'acciones' }, el('button', { class: 'btn ghost sm', onclick: () => dlgUnidad(c, un, u, () => recarga('unidades')) }, 'Editar'),
        el('button', { class: 'btn ghost sm', onclick: async () => { try { await call('PUT', `/clientes/${c.id_grupo}/unidades/${u.id}`, { activo: !u.activo }); recarga('unidades'); } catch (e) { falla(e); } } }, u.activo ? 'Desactivar' : 'Activar'));
      return [`<b>${esc(u.nombre)}</b>${u.activo ? '' : ' ' + badge('neutral', 'Inactiva')}`, esc((u.afiliaciones || []).join(', ') || '—'), `${(u.comercios || []).length} comercio(s)<small class="muted" style="display:block">${esc((u.comercios || []).slice(0, 4).join(', '))}${(u.comercios || []).length > 4 ? '…' : ''}</small>`, acc]; });
    cuerpo = el('div', {}, el('div', { class: 'req-note', style: 'margin-bottom:8px' }, 'Las unidades de negocio salen solas del catálogo de POS (grupo de cliente y sus afiliaciones, con sus comercios); si el cliente recibe una afiliación nueva, aparece aquí sin hacer nada. Cada contacto puede tener acceso a todas o solo a algunas.'),
      tableWrap(['Unidad de negocio', 'Afiliaciones', 'Comercios', ''], filas, { empty: 'Este cliente aún no tiene afiliaciones en el catálogo de POS.' }),
      el('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
        el('button', { class: 'btn secondary', onclick: async () => { try { const r = await call('POST', `/clientes/${c.id_grupo}/unidades/importar`, {}); recarga('unidades', r.creadas ? `${r.creadas} unidad(es) nueva(s) desde POS` : 'Ya está al día con POS'); } catch (e) { falla(e); } } }, 'Actualizar desde POS'),
        el('button', { class: 'btn secondary', onclick: () => dlgUnidad(c, un, null, () => recarga('unidades')) }, '+ Unidad de negocio')));
  }

  if (tab === 'contactos') {
    const resumen = p => !p.unidades.length ? '<span class="muted">Todo el cliente</span>' : esc(p.unidades.map(nombreUn).filter(Boolean).join(', '));
    const lista = tableWrap(['Nombre', 'Correo', 'Acceso', 'Estado', ''], cont.map(p => { const acc = el('div', { class: 'acciones' },
      el('button', { class: 'btn ghost sm', onclick: () => dlgAcceso(c, un, p, () => recarga('contactos', 'Acceso guardado')) }, 'Acceso'),
      el('button', { class: 'btn ghost sm', onclick: async () => { try { await call('PUT', `/clientes/${c.id_grupo}/contactos/${p.usuario_id}`, { activo: !p.activo }); recarga('contactos', p.activo ? 'Contacto desactivado' : 'Contacto activado'); } catch (e) { falla(e); } } }, p.activo ? 'Desactivar' : 'Activar'));
      return [`${esc(p.nombre)}<small class="muted" style="display:block">${esc(p.puesto || '')}</small>`, esc(p.email), resumen(p), p.activo ? badge('ok', 'Activo') : badge('neutral', 'Inactivo'), acc]; }), { empty: 'Aún no hay contactos.' });
    const nombre = el('input', { id: 'sccNombre', maxlength: '120', placeholder: 'Nombre completo' }), email = el('input', { id: 'sccEmail', type: 'email', placeholder: 'correo@cliente.com (cuenta de Google)' }), puesto = el('input', { id: 'scPuesto', maxlength: '80', placeholder: 'Puesto (opcional)' });
    const acceso = selectorUnidades(un, []);
    const add = el('button', { class: 'btn', onclick: async () => { add.disabled = true; try { const r = await call('POST', `/clientes/${c.id_grupo}/contactos`, { nombre: nombre.value, email: email.value, puesto: puesto.value, unidades: acceso.valor() }); recarga('contactos', r.aviso ? 'Contacto agregado y avisado por correo' : 'Contacto agregado'); } catch (e) { falla(e); add.disabled = false; } } }, 'Agregar contacto');
    cuerpo = el('div', {}, lista, el('h4', { style: 'margin:14px 0 6px' }, 'Agregar contacto'), el('div', { class: 'form-grid' }, el('label', { class: 'field' }, 'Nombre', nombre), el('label', { class: 'field' }, 'Correo de Google', email), el('label', { class: 'field' }, 'Puesto', puesto)),
      el('div', { style: 'margin-top:8px' }, acceso.nodo), el('div', { style: 'margin-top:10px' }, add));
  }
  modal(c.nombre, el('div', {}, tabs, cuerpo), pie, true);
}
// Acceso a unidades de negocio: «todo el cliente» o solo las marcadas.
function selectorUnidades(un, marcadas) {
  const activas = un.unidades.filter(u => u.activo); const sel = new Set(marcadas || []);
  const todo = el('input', { type: 'radio', name: 'acc' + Math.random().toString(36).slice(2, 6) }); const solo = el('input', { type: 'radio', name: todo.name });
  todo.checked = !sel.size; solo.checked = !!sel.size;
  const caja = el('div', { style: 'display:flex;flex-direction:column;gap:4px;margin:6px 0 0 22px;max-height:170px;overflow:auto' });
  activas.forEach(u => { const ch = el('input', { type: 'checkbox' }); ch.checked = sel.has(u.id); ch.addEventListener('change', () => { ch.checked ? sel.add(u.id) : sel.delete(u.id); if (sel.size) { solo.checked = true; } }); caja.append(el('label', { class: 'chk' }, ch, ' ' + u.nombre)); });
  todo.addEventListener('change', () => { if (todo.checked) { sel.clear(); caja.querySelectorAll('input').forEach(i => { i.checked = false; }); } });
  const nodo = el('div', {}, el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, 'Acceso a unidades de negocio'), el('label', { class: 'chk' }, todo, ' Todo el cliente'), el('label', { class: 'chk' }, solo, ' Solo estas unidades:'), activas.length ? caja : el('div', { class: 'muted', style: 'margin-left:22px;font-size:12px' }, 'Aún no hay unidades de negocio definidas.'));
  return { nodo, valor: () => (solo.checked ? [...sel] : []) };
}
function dlgAcceso(c, un, p, listo) {
  const sel = selectorUnidades(un, p.unidades);
  modal('Acceso de ' + p.nombre, el('div', {}, el('div', { class: 'banner' }, `${p.email} podrá pedir solicitudes solo de lo que marques. Sin marcar nada, tiene acceso a todo el cliente.`), sel.nodo),
    el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), el('button', { class: 'btn', onclick: async () => { try { await call('PUT', `/clientes/${c.id_grupo}/contactos/${p.usuario_id}`, { unidades: sel.valor() }); closeModal(); listo(); } catch (e) { falla(e); } } }, 'Guardar')));
}
function dlgUnidad(c, un, u, listo) {
  const nombre = el('input', { id: 'scUnNombre', maxlength: '120', value: u ? u.nombre : '', placeholder: 'Ej. Sucursales Monterrey' });
  const afSel = new Set(u ? u.afiliaciones : []); const cmSel = new Set(u ? u.comercios : []);
  const afBox = el('div', { style: 'display:flex;flex-direction:column;gap:4px;max-height:140px;overflow:auto' }); un.afiliaciones.forEach(a => { const ch = el('input', { type: 'checkbox' }); ch.checked = afSel.has(a.numero); ch.addEventListener('change', () => { ch.checked ? afSel.add(a.numero) : afSel.delete(a.numero); }); afBox.append(el('label', { class: 'chk' }, ch, ` ${a.numero} · ${a.razon_social}`)); });
  const cmBox = el('div', { style: 'display:flex;flex-direction:column;gap:4px;max-height:170px;overflow:auto' }); [...new Set([...un.comercios_pos, ...(u ? u.comercios : [])])].forEach(m => { const ch = el('input', { type: 'checkbox' }); ch.checked = cmSel.has(m); ch.addEventListener('change', () => { ch.checked ? cmSel.add(m) : cmSel.delete(m); }); cmBox.append(el('label', { class: 'chk' }, ch, ' ' + m)); });
  const otros = el('textarea', { rows: 2, style: 'width:100%', placeholder: 'Otros comercios (uno por renglón)' });
  const ok = el('button', { class: 'btn', onclick: async () => { ok.disabled = true; try { const b = { nombre: nombre.value, afiliaciones: [...afSel], comercios: [...cmSel, ...otros.value.split(/[\n;]+/).map(x => x.trim()).filter(Boolean)] }; if (u) await call('PUT', `/clientes/${c.id_grupo}/unidades/${u.id}`, b); else await call('POST', `/clientes/${c.id_grupo}/unidades`, b); closeModal(); listo(); } catch (e) { falla(e); ok.disabled = false; } } }, u ? 'Guardar' : 'Crear');
  modal(u ? 'Editar unidad de negocio' : 'Nueva unidad de negocio', el('div', {}, el('label', { class: 'field' }, 'Nombre', nombre), el('div', { class: 'muted', style: 'font-size:12px;margin:10px 0 4px' }, 'Afiliaciones que agrupa'), afBox,
    el('div', { class: 'muted', style: 'font-size:12px;margin:10px 0 4px' }, 'Comercios (los que ya conoce POS)'), cmBox, el('div', { style: 'margin-top:6px' }, otros)), el('div', {}, el('button', { class: 'btn secondary', onclick: closeModal }, 'Cancelar'), ok));
}

/* ============================ FORMATOS (PDF) ============================ */
async function vFormatos(v) {
  await base(); v.innerHTML = '';
  const fs = await call('GET', '/formatos');
  v.append(nota('', 'Son los formatos oficiales de Polipay (POL-OP-F##) en PDF, en blanco, para imprimir y llenar a mano. Cuando una solicitud se captura aquí, su formato <b>ya lleno</b> se descarga desde el detalle de esa solicitud, con quién dio cada paso y cuándo.'));
  v.append(panel('', tableWrap(['Formato', 'Para qué sirve', 'Procedimiento', ''], fs.map(f => { const b = el('button', { class: 'btn secondary sm', onclick: () => descargar(`/api/sc/formatos/${f.id}/pdf`, `${f.formato}-formato-en-blanco.pdf`).catch(falla) }, 'Descargar PDF'); return [`<b>${esc(f.formato)}</b>`, `<b>${esc(f.nombre)}</b><small class="muted" style="display:block">${esc(f.descripcion)}</small>`, esc(f.codigo) + (f.critica ? ' ' + badge('violet', 'Crítica') : ''), b]; }), { empty: '' })));
}

/* ============================ REGISTRO (todas las solicitudes) ============================ */
const REG = { desde: '', hasta: '', tipo: '', estado: '', id_grupo: '', q: '', pagina: 1 };
async function vRegistro(v) {
  const yo = await base(); v.innerHTML = '';
  const par = () => { const p = new URLSearchParams(); Object.entries(REG).forEach(([k, x]) => { if (x && k !== 'pagina') p.set(k, x); }); return p; };
  cardsAcciones(el('button', { class: 'btn', onclick: () => descargar('/api/sc/registro.xlsx?' + par(), 'registro-solicitudes.xlsx').catch(falla) }, 'Descargar registro (Excel)'));
  const campoF = (label, nodo) => el('label', { class: 'field', style: 'min-width:150px' }, label, nodo);
  const desde = el('input', { type: 'date', value: REG.desde }), hasta = el('input', { type: 'date', value: REG.hasta }), q = el('input', { type: 'search', placeholder: 'Folio, nombre, afiliación…', value: REG.q });
  const tp = el('select', {}, el('option', { value: '' }, 'Todos'), ...(yo.tipos || []).map(t => el('option', { value: t.id }, t.corto))); tp.value = REG.tipo;
  const es = el('select', {}, el('option', { value: '' }, 'Todos'), ...(yo.orden || []).map(e => el('option', { value: e }, yo.estados[e].nombre))); es.value = REG.estado;
  const gr = el('select', {}, el('option', { value: '' }, 'Todos'), ...(yo.grupos || []).map(g => el('option', { value: String(g.id_grupo) }, g.nombre))); gr.value = REG.id_grupo;
  v.append(nota('', 'Aquí queda el registro de <b>todas</b> las solicitudes, de cualquier tipo y estado, con su historial. Filtra y descarga el Excel (una hoja general y una por tipo con todos sus datos) para tus bitácoras.'));
  v.append(el('div', { class: 'filters', style: 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:end' }, campoF('Desde', desde), campoF('Hasta', hasta), campoF('Tipo', tp), campoF('Estado', es), campoF('Cliente', gr), campoF('Buscar', q)));
  const cont = el('div', {}); v.append(cont); let t0 = null;
  const pintar = async () => {
    const p = par(); p.set('pagina', REG.pagina);
    let r; try { r = await call('GET', '/solicitudes?' + p); } catch (e) { cont.innerHTML = ''; cont.append(nota('err', esc(errMsg(e)))); return; }
    cont.innerHTML = '';
    cont.append(tableWrap(['Folio', 'Tipo', 'Cliente', 'Solicitud', 'Estado', 'Creada', 'Cerrada'], r.filas.map(s => { const row = [esc(s.folio), esc(s.tipo_nombre), esc(s.cliente || ''), esc(s.titulo || '—'), chipEstado(s.estado, s.estado_nombre), fFecha(s.creado_at), fFecha(s.cerrada_at)]; row._onclick = () => abrir(s.id); return row; }), { empty: 'No hay solicitudes con esos filtros.' }));
    cont.append(el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' }, `${r.total} solicitud(es)`));
    const paginas = Math.max(1, Math.ceil(r.total / r.por));
    if (r.total > r.por) cont.append(el('div', { style: 'display:flex;gap:8px;align-items:center;justify-content:flex-end' }, el('button', { class: 'btn ghost sm', disabled: REG.pagina <= 1 ? 'true' : null, onclick: () => { REG.pagina--; pintar(); } }, '← Anterior'), el('span', { class: 'muted', style: 'font-size:12px' }, `Página ${REG.pagina} de ${paginas}`), el('button', { class: 'btn ghost sm', disabled: REG.pagina >= paginas ? 'true' : null, onclick: () => { REG.pagina++; pintar(); } }, 'Siguiente →')));
  };
  const cambio = () => { Object.assign(REG, { desde: desde.value, hasta: hasta.value, tipo: tp.value, estado: es.value, id_grupo: gr.value, q: q.value, pagina: 1 }); pintar(); };
  q.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(cambio, 300); }); [desde, hasta, tp, es, gr].forEach(x => x.addEventListener('change', cambio));
  pintar();
}

window.SC_VISTAS = { sc_tablero: vTablero, sc_lista: vLista, sc_nueva: vNueva, sc_clientes: vClientes, sc_formatos: vFormatos, sc_registro: vRegistro };
window.SC_TITULOS = {
  sc_tablero: ['Solicitudes de clientes', 'Pide altas, usuarios y cambios, y da seguimiento a cada solicitud'],
  sc_lista: ['Solicitudes', 'Todo lo que se ha pedido, con su estado y quién sigue'],
  sc_nueva: ['Nueva solicitud', 'Elige qué necesitas pedir'],
  sc_registro: ['Registro de solicitudes', 'Todas las solicitudes, de cualquier tipo y estado, con descarga a Excel'],
  sc_formatos: ['Formatos (PDF)', 'Los formatos oficiales para documentar cada solicitud'],
  sc_clientes: ['Clientes y contactos', 'Quién del cliente entra al portal y quién es su Ejecutivo Comercial'],
};
})();
