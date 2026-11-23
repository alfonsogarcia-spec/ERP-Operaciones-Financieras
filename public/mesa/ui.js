/* ============================================================================
   public/mesa/ui.js — Credit Solvendom · MESA DE CONTROL de una SOFOM (pantallas), con el diseño de este sistema.
   Usa los mismos ayudantes que el resto de la app (el, api, tableWrap, cards, modal, toast, confirmar, descargar…), que ya existen al pintar una vista.
   Las vistas se registran en window.CARTERA_VISTAS y los títulos en window.CARTERA_TITULOS; index.html los une a su enrutador.
   Toda regla (permisos, segregación, versiones) la hace cumplir el servidor; aquí solo se muestran y se capturan.
   ============================================================================ */
(function () {
'use strict';
const MC = { yo: null, cat: null, sel: null, tab: 'resumen', lista: { q: '', estado: '', producto: '', mias: false, pag: 0 }, bit: { q: '', usuario: '', entidad: '', desde: '', hasta: '', pag: 0 }, pld: { q: '', pag: 0 } };
const call = (m, p, b) => api(m, '/api/cartera/mc' + p, b);
const puede = p => !!(MC.yo && (MC.yo.permisos || []).includes(p));
const lsGet = k => { try { return localStorage.getItem(k); } catch (_e) { return null; } };
void lsGet;

/* ---------- utilidades ---------- */
const fF = iso => iso ? new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fD = iso => iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const pc = v => v == null || v === '' ? '—' : (Number(v) * 100).toLocaleString('es-MX', { maximumFractionDigits: 2 }) + '%';
const m$ = v => v == null || isNaN(v) ? '—' : mxn(v);
const badge = (cls, txt, title) => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(txt)}</span>`;
const ESTADO_CLS = { borrador: 'neutral', devuelta: 'warn', verificacion: 'info', decision: 'violet', autorizada: 'ok', rechazada: 'danger', cancelada: 'neutral' };
const estadoTxt = e => (MC.cat && MC.cat.estados[e] ? MC.cat.estados[e].t : e);
const chipEstado = e => badge(ESTADO_CLS[e] || 'neutral', estadoTxt(e));
const SEM = { ok: ['ok', 'En tiempo'], alerta: ['warn', 'Último día'], vencido: ['danger', 'Vencida'] };
const chipSem = (s, dias, sla) => s ? badge(SEM[s][0], `${dias} d`, `${SEM[s][1]} · atención en ${sla} día(s)`) : '';
const REC_CLS = { aprobar: 'ok', revision: 'warn', rechazar: 'danger', incompleta: 'neutral' };
const chipRec = r => r ? badge(REC_CLS[r] || 'neutral', (MC.cat && MC.cat.recomendaciones[r]) || r) : '<span class="muted">—</span>';
const REGLA_CLS = { cumple: 'ok', revision: 'warn', rechazo: 'danger', pendiente: 'neutral' };
const REGLA_TXT = { cumple: 'Cumple', revision: 'Revisión', rechazo: 'No cumple', pendiente: 'Pendiente' };
const DOC_CLS = { pendiente: 'neutral', recibido: 'info', validado: 'ok', rechazado: 'danger' };
const NIVEL_TXT = { cumplimiento: 'Cumplimiento', mesa: 'Mesa de control', comite: 'Comité', verificacion: 'Verificación', rechazo: 'Rechazo', devolucion: 'Devolución', cancelacion: 'Cancelación' };
const RIESGO_CLS = { bajo: 'ok', medio: 'warn', alto: 'danger' };
const kv = (k, v, strong) => el('div', { class: 'testline' }, el('span', { style: 'flex:1;color:var(--muted)' }, k), el('span', { class: strong ? 'flagok' : '', style: 'font-variant-numeric:tabular-nums;text-align:right', html: v == null || v === '' ? '—' : String(v) }));
const panel = (titulo, ...hijos) => { const p = el('div', { class: 'panel' }); if (titulo) p.append(el('h3', {}, titulo)); hijos.forEach(h => h && p.append(h)); return p; };
const nota = (cls, html) => el('div', { class: 'banner' + (cls ? ' ' + cls : ''), html });
const pager = (total, pag, por, ir) => {
  const paginas = Math.max(1, Math.ceil(total / por)); if (total <= por) return el('span', {});
  return el('div', { style: 'display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap;margin-top:10px' },
    el('span', { class: 'muted', style: 'font-size:12px' }, `${pag * por + 1}–${Math.min(total, (pag + 1) * por)} de ${total}`),
    el('button', { class: 'btn ghost sm', type: 'button', disabled: pag === 0 ? 'true' : null, onclick: () => ir(pag - 1) }, '← Anterior'),
    el('span', { class: 'muted', style: 'font-size:12px' }, `Página ${pag + 1} de ${paginas}`),
    el('button', { class: 'btn ghost sm', type: 'button', disabled: pag >= paginas - 1 ? 'true' : null, onclick: () => ir(pag + 1) }, 'Siguiente →'));
};
const campo = (label, input, ayuda) => el('label', { class: 'field' }, label, input, ayuda ? el('span', { class: 'req-note', style: 'margin:0' }, ayuda) : '');
const inp = (attrs) => el('input', attrs);
const textarea = (attrs) => el('textarea', { rows: 3, style: 'width:100%', ...attrs });
const falla = e => toast(errMsg(e), 'err');

async function base() {
  if (!MC.yo) {
    MC.yo = await call('GET', '/yo');
    window.MC_PERM = MC.yo.permisos;
    try { renderNav(); } catch (_e) { /* el menú se vuelve a pintar con lo que su rol puede ver */ }
  }
  if (!MC.cat) MC.cat = await call('GET', '/catalogos');
}
const abrir = (id, tab) => { MC.sel = id; MC.tab = tab || 'resumen'; if (typeof VIEW !== 'undefined' && VIEW === 'mc_solicitudes') render(); else go('mc_solicitudes'); };
const volver = () => { MC.sel = null; render(); };

/* ============================ TABLERO ============================ */
async function vTablero(v) {
  await base();
  const t = await call('GET', '/tablero');
  v.innerHTML = '';
  if (puede('crear')) $('#pageAction').append(el('button', { class: 'btn', onclick: () => formSolicitud() }, '+ Nueva solicitud'));
  const k = t.kpi;
  v.append(cards([
    ['En proceso', t.abiertas, 'solicitudes abiertas'],
    ['Autorizadas · 30 días', k.autorizadas, m$(k.monto_autorizado)],
    ['Rechazadas · 30 días', k.rechazadas],
    ['Tasa de aprobación', k.tasa_aprobacion == null ? '—' : k.tasa_aprobacion + '%', 'autorizadas / resueltas'],
    ['Días a decisión', k.dias_decision == null ? '—' : k.dias_decision, 'promedio de captura a resolución'],
    ['Devueltas · 30 días', k.devueltas, 'a corrección'],
  ]));
  const al = t.alertas;
  if (al.autoaprobadas || al.contra_motor || al.vigencias) {
    const l = [];
    if (al.autoaprobadas) l.push(`<b>${al.autoaprobadas}</b> acción(es) autoaprobada(s) en 30 días: quien capturó o verificó también firmó (solo se permite al único administrador). Revísalas en la bitácora.`);
    if (al.contra_motor) l.push(`<b>${al.contra_motor}</b> autorización(es) en 30 días fueron <b>contra la recomendación del motor</b> (con justificación escrita).`);
    if (al.vigencias) l.push(`<b>${al.vigencias}</b> autorización(es) vencen en 7 días o menos sin formalizarse.`);
    v.append(nota('warn', l.join('<br>')));
  }
  // Cartera y operación (si el rol ve la cartera)
  if (puede('ver_todas')) {
    let pc_ = null; try { pc_ = await call('GET', '/panel-cartera'); } catch (_e) { pc_ = null; }
    if (pc_ && (pc_.resumen.creditos || Object.values(pc_.pendientes).some(n => n))) {
      const r = pc_.resumen, pe = pc_.pendientes, ir = (txt, vista, n) => n ? `<a href="#" data-ir="${vista}" style="text-decoration:underline;margin-right:14px">${esc(txt)}: <b>${n}</b></a>` : '';
      const nodo = el('div', {});
      nodo.append(cards([['Cartera vigente', m$(r.capital), `${r.creditos} crédito(s)`], ['IMOR', (r.imor * 100).toFixed(2) + '%', `vencida desde ${r.dias_vencida} días: ${m$(r.vencida)}`], ['Con atraso', r.atrasados, `moratorios ${m$(r.moratorios)}`], ['Estimación preventiva', m$(r.estimacion), 'ICOR ' + (r.icor * 100).toFixed(2) + '%'], ['Pagos por vencer (7 días)', pc_.vencen_7_dias]]));
      const txt = [ir('Autorizadas sin formalizar', 'mc_solicitudes', pe.autorizadas_sin_credito), ir('Créditos por formalizar', 'mc_creditos', pe.formalizar), ir('Por desembolsar', 'mc_creditos', pe.por_desembolsar), ir('Desembolsos por autorizar', 'mc_creditos', pe.desembolso_autorizar), ir('Movimientos por conciliar', 'mc_conciliacion', pe.conciliar), ir('Pagos sin conciliar', 'mc_conciliacion', pe.pagos_sin_conciliar), ir('Operaciones UIF por dictaminar', 'mc_uif', pe.uif)].join('');
      if (txt) { const b = el('div', { class: 'banner', html: 'Pendientes de operación: ' + txt }); b.addEventListener('click', e => { const a = e.target.closest('[data-ir]'); if (a) { e.preventDefault(); go(a.dataset.ir); } }); nodo.append(b); }
      v.append(panel('Cartera y operación', nodo));
    }
  }
  // Para hoy
  const hoy = t.para_hoy;
  v.append(panel(t.todas ? 'Para hoy' : 'Tus pendientes',
    hoy.length ? tableWrap(['Folio', 'Solicitante', 'Qué sigue', { t: 'Monto' }, 'Tiempo'], hoy.map(x => {
      const r = [x.folio, esc(x.nombre || ''), esc(x.texto), { num: x.monto == null ? '' : m$(x.monto) }, x.tipo === 'pld' ? badge('warn', 'Por resolver') : chipSem(x.semaforo, x.dias, '')];
      r._onclick = () => x.id ? abrir(x.id, x.tipo === 'firma' ? 'resumen' : 'resumen') : go('mc_pld'); return r;
    }), { empty: '' }) : nota('ok', 'Nada pendiente para ti por ahora.')));
  // Embudo
  const max = Math.max(1, ...t.embudo.map(e => e.n));
  const emb = el('div', {});
  t.embudo.forEach(e => {
    emb.append(el('div', { style: 'display:grid;grid-template-columns:150px 1fr 110px 120px 100px;gap:12px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)' },
      el('div', { html: chipEstado(e.estado) + `<div class="muted" style="font-size:11px;margin-top:3px">atención: ${e.sla} día(s)</div>` }),
      el('div', { style: 'background:var(--glass-2);border-radius:6px;height:14px;overflow:hidden' }, el('div', { style: `width:${Math.round(e.n / max * 100)}%;height:100%;background:var(--accent-fill)` })),
      el('div', { style: 'font-variant-numeric:tabular-nums;font-weight:600' }, `${e.n} solicitud(es)`),
      el('div', { class: 'muted', style: 'font-variant-numeric:tabular-nums' }, m$(e.monto)),
      el('div', { html: e.vencidas ? badge('danger', `${e.vencidas} vencida(s)`) : (e.n ? `<span class="muted" style="font-size:12px">prom. ${e.dias_prom} d</span>` : '') })));
  });
  v.append(panel('Embudo de la mesa', emb));
  if (t.motivos.length) v.append(panel('Motivos de rechazo · 30 días', tableWrap(['Motivo', { t: 'Solicitudes' }], t.motivos.map(m => [esc(m.motivo || '—'), { num: String(m.n) }]))));
}

/* ============================ SOLICITUDES: LISTA ============================ */
async function vSolicitudes(v) {
  await base();
  if (MC.sel) return detalle(v, MC.sel);
  if (puede('crear')) $('#pageAction').append(el('button', { class: 'btn', onclick: () => formSolicitud() }, '+ Nueva solicitud'));
  const F = MC.lista;
  const fq = inp({ type: 'search', placeholder: 'Folio, nombre o RFC', value: F.q, style: 'width:220px' });
  const fe = el('select', { style: 'width:160px' }, el('option', { value: '' }, 'Todos los estados'), ...MC.cat.orden.map(e => el('option', { value: e }, estadoTxt(e)))); fe.value = F.estado;
  const fp = el('select', { style: 'width:220px' }, el('option', { value: '' }, 'Todos los productos'), ...MC.cat.productos.map(p => el('option', { value: p.id }, p.nombre))); fp.value = F.producto;
  const fm = inp({ type: 'checkbox', id: 'mc-mias' }); fm.checked = F.mias;
  const tabla = el('div', {}), cuenta = el('span', { class: 'muted', style: 'font-size:12px' });
  const pintar = async () => {
    Object.assign(F, { q: fq.value, estado: fe.value, producto: fp.value, mias: fm.checked });
    const qs = new URLSearchParams({ q: F.q, estado: F.estado, producto: F.producto, mias: F.mias ? '1' : '', pag: F.pag }); [...qs.keys()].forEach(k => { if (!qs.get(k)) qs.delete(k); });
    let r; try { r = await call('GET', '/solicitudes?' + qs); } catch (e) { tabla.innerHTML = ''; tabla.append(nota('err', esc(errMsg(e)))); return; }
    cuenta.textContent = `${r.total} solicitud(es)`;
    tabla.innerHTML = '';
    tabla.append(tableWrap(['Folio', 'Solicitante', 'Producto', { t: 'Monto' }, 'Etapa', 'Motor', 'Ejecutivo'], r.filas.map(s => {
      const row = [`<b>${esc(s.folio)}</b>${s.es_ejemplo ? ' ' + badge('neutral', 'ejemplo') : ''}`, `${esc(s.nombre)}<small class="muted" style="display:block">${s.tipo_persona === 'moral' ? 'Persona moral' : 'Persona física'}</small>`, esc(s.producto),
        { num: m$(s.monto_autorizado != null && s.estado === 'autorizada' ? s.monto_autorizado : s.monto) }, chipEstado(s.estado) + ' ' + chipSem(s.semaforo, s.dias, MC.cat.sla[s.estado]), chipRec(s.recomendacion), esc(s.ejecutivo_nombre || '')];
      row._onclick = () => abrir(s.id); return row;
    }), { empty: 'Ninguna solicitud coincide con esos filtros.' }), pager(r.total, r.pag, r.por_pag, n => { F.pag = n; pintar(); }));
  };
  let tmr; fq.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { F.pag = 0; pintar(); }, 300); });
  [fe, fp, fm].forEach(x => x.addEventListener('change', () => { F.pag = 0; pintar(); }));
  const limpiar = el('button', { class: 'btn ghost sm', onclick: () => { fq.value = fe.value = fp.value = ''; fm.checked = false; F.pag = 0; pintar(); } }, 'Limpiar');
  v.innerHTML = '';
  const p = panel('Solicitudes');
  const filtros = el('div', { class: 'filters' }, fq, fe, fp);
  if (puede('ver_todas')) filtros.append(el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, fm, 'Solo mías'));
  filtros.append(limpiar, el('span', { class: 'spacer' }), cuenta);
  p.append(filtros, tabla); v.append(p); pintar();
}

/* ============================ SOLICITUDES: DETALLE ============================ */
async function detalle(v, id) {
  let d; try { d = await call('GET', '/solicitudes/' + id); } catch (e) { MC.sel = null; v.innerHTML = ''; v.append(nota('err', esc(errMsg(e)))); v.append(el('button', { class: 'btn ghost', onclick: volver }, '← Solicitudes')); return; }
  const s = d.solicitud, a = d.acciones;
  const accion = async (nombre, extra, okMsg) => {
    try { const r = await call('POST', `/solicitudes/${id}/accion`, { accion: nombre, _v: s.version, ...(extra || {}) }); closeModal(); toast(okMsg || 'Hecho', 'ok'); render(); return r; }
    catch (e) { if (e.data && e.data.codigo === 'version') { toast(errMsg(e), 'err'); render(); } else falla(e); }
  };
  v.innerHTML = '';
  // encabezado
  const enc = el('div', { class: 'panel', style: 'display:flex;flex-wrap:wrap;gap:14px 24px;align-items:center' });
  enc.append(el('button', { class: 'btn ghost sm', onclick: volver }, '← Solicitudes'),
    el('div', { style: 'flex:1;min-width:240px' }, el('div', { style: 'font-size:var(--fs-lg);font-weight:600', html: `${esc(s.folio)} · ${esc(d.solicitante.nombre)}` + (s.es_ejemplo ? ' ' + badge('neutral', 'ejemplo') : '') }),
      el('div', { class: 'muted', style: 'font-size:13px', html: `${esc(d.producto.nombre)} · ${m$(s.monto)} a ${s.plazo_meses} meses · captura de ${esc(s.ejecutivo_nombre || s.ejecutivo)}` })),
    el('div', { html: chipEstado(s.estado) + ' ' + chipSem(s.semaforo, s.dias_en_etapa, s.sla) + (d.evaluacion_guardada ? ' ' + chipRec(d.evaluacion_guardada.recomendacion) : '') }));
  v.append(enc);
  // acciones según rol y estado
  const bar = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px' });
  const btn = (txt, cls, fn) => bar.append(el('button', { class: 'btn sm ' + cls, onclick: fn }, txt));
  if (a.editar) btn('Editar solicitud', 'secondary', () => formSolicitud(d));
  if (a.enviar) btn('Enviar a verificación', '', () => dlgSimple('Enviar a verificación', 'Se revisa que la captura y el expediente estén completos. Después de enviarla ya no se puede editar hasta que se devuelva.', 'Enviar', c => accion('enviar', { comentario: c }, 'Enviada a verificación'), false));
  if (a.verificar) btn('Cerrar verificación', '', () => dlgSimple('Cerrar la verificación', 'Confirma que los documentos están validados y la consulta PLD está resuelta. El motor evalúa y la solicitud pasa a decisión.' + (s.ejecutivo ? '' : ''), 'Pasar a decisión', c => accion('verificar', { comentario: c }, 'Pasó a decisión'), false, 'Comentario (obligatorio solo si tú la capturaste)'));
  if (a.autorizar) btn(`Firmar como ${NIVEL_TXT[a.nivel_firma] || a.nivel_firma}`, '', () => dlgAutorizar(d, accion));
  if (a.devolver) btn('Devolver', 'secondary', () => dlgSimple('Devolver para corrección', 'El ejecutivo recibe tus comentarios y la reenvía cuando los atienda.', 'Devolver', c => accion('devolver', { comentario: c }, 'Devuelta al ejecutivo'), true, 'Qué debe corregir (mínimo 15 caracteres)'));
  if (a.rechazar) btn('Rechazar', 'danger', () => dlgRechazar(accion));
  if (s.estado === 'autorizada' && d.credito) btn(`Ver crédito ${d.credito.folio}`, '', () => window.MCUI.abrirCred(d.credito.id));
  else if (s.estado === 'autorizada' && puede('formalizar')) btn('Formalizar: abrir el crédito', '', () => dlgSimple('Abrir el crédito', 'Se crea el crédito con las condiciones autorizadas (monto, plazo y tasa), con su CAT y tabla de pagos prevista. Sigue la captura de la cuenta de depósito, el contrato y las firmas.', 'Abrir crédito', async () => { try { const r = await call('POST', `/solicitudes/${s.id}/credito`); closeModal(); toast(`Crédito ${r.folio} abierto`, 'ok'); window.MCUI.abrirCred(r.id); } catch (e) { falla(e); } }, false));
  if (a.cancelar) btn('Cancelar solicitud', 'ghost', () => dlgSimple('Cancelar solicitud', 'Se cierra sin decisión. No se puede reabrir.', 'Cancelar solicitud', c => accion('cancelar', { comentario: c }, 'Solicitud cancelada'), true, 'Motivo (mínimo 10 caracteres)'));
  if (bar.children.length) v.append(bar);
  // pestañas
  const TABS = [['resumen', 'Resumen'], ['solicitante', 'Solicitante'], ['expediente', `Expediente (${d.documentos.filter(x => x.estado === 'validado').length}/${d.documentos.length})`], ['pld', 'KYC / PLD' + (d.pld.pendientes ? ` · ${d.pld.pendientes} por resolver` : '')], ['decision', 'Decisiones'], ['historial', 'Historial']];
  const tabs = el('div', { class: 'tabs', role: 'tablist' }), cuerpo = el('div', {});
  const pintarTab = () => { cuerpo.innerHTML = ''; cuerpo.append(({ resumen: tabResumen, solicitante: tabSolicitante, expediente: tabExpediente, pld: tabPld, decision: tabDecision, historial: tabHistorial })[MC.tab](d, accion)); [...tabs.children].forEach((b, i) => b.classList.toggle('active', TABS[i][0] === MC.tab)); };
  TABS.forEach(([k, t]) => tabs.append(el('button', { class: 'tab' + (MC.tab === k ? ' active' : ''), type: 'button', role: 'tab', onclick: () => { MC.tab = k; pintarTab(); } }, t)));
  v.append(tabs, cuerpo); pintarTab();
}

function dlgSimple(titulo, texto, verbo, fn, comObligatorio, etiqueta) {
  const body = el('div', {}); body.append(nota('', esc(texto)));
  const com = textarea({ placeholder: etiqueta || 'Comentario (opcional)' }); body.append(campo(etiqueta || 'Comentario', com));
  const ok = el('button', { class: 'btn', onclick: async () => { ok.disabled = true; try { await fn(com.value.trim()); } finally { ok.disabled = false; } } }, verbo);
  void comObligatorio;
  modal(titulo, body, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Volver'), ok));
}
function dlgRechazar(accion) {
  const body = el('div', {}), mot = el('select', {}, el('option', { value: '' }, 'Elige un motivo…'), ...MC.cat.motivos.map(m => el('option', { value: m }, m))), com = textarea({ placeholder: 'Explica el rechazo (mínimo 15 caracteres)' });
  body.append(nota('', 'El rechazo queda registrado con motivo, comentario, quién y cuándo. No se puede deshacer.'), campo('Motivo', mot), campo('Comentario', com));
  const ok = el('button', { class: 'btn danger', onclick: () => { if (!mot.value) return toast('Elige el motivo del rechazo', 'err'); accion('rechazar', { motivo: mot.value, comentario: com.value.trim() }, 'Solicitud rechazada'); } }, 'Rechazar');
  modal('Rechazar solicitud', body, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Volver'), ok));
}
function dlgAutorizar(d, accion) {
  const s = d.solicitud, p = d.producto, ev = d.evaluacion_guardada, body = el('div', {});
  const contra = ev && ev.recomendacion !== 'aprobar';
  body.append(nota(contra ? 'warn' : '', `Firmas requeridas: <b>${d.niveles.map(n => NIVEL_TXT[n] + (d.firmados.includes(n) ? ' ✓' : '')).join(' → ')}</b>. Te toca <b>${esc(NIVEL_TXT[d.nivel_pendiente])}</b>.<br>Motor: <b>${esc((MC.cat.recomendaciones[ev ? ev.recomendacion : ''] || '—'))}</b>.` +
    (contra ? ' <b>Vas contra la recomendación del motor: tu comentario es obligatorio.</b>' : '') + (d.acciones.conflicto_firma ? '<br><b>Ya participaste en esta solicitud</b>: solo se permite si eres el único administrador, con comentario de 20 caracteres como mínimo (queda marcada como autoaprobada).' : '')));
  const monto = inp({ type: 'number', value: s.monto, min: p.monto_min, max: s.monto, step: '0.01' }), plazo = inp({ type: 'number', value: s.plazo_meses, min: p.plazo_min, max: p.plazo_max }), tasa = inp({ type: 'number', value: +(s.tasa_anual * 100).toFixed(4), min: p.tasa_min * 100, max: p.tasa_max * 100, step: '0.01' });
  const com = textarea({ placeholder: 'Comentario' });
  body.append(el('div', { class: 'form-grid' }, campo('Monto autorizado', monto, `Máximo lo solicitado: ${m$(s.monto)}`), campo('Plazo (meses)', plazo, `Del producto: ${p.plazo_min}–${p.plazo_max}`), campo('Tasa anual (%)', tasa, `Del producto: ${(p.tasa_min * 100).toFixed(2)}–${(p.tasa_max * 100).toFixed(2)}`)), campo('Comentario', com));
  const ok = el('button', { class: 'btn', onclick: () => accion('autorizar', { monto_autorizado: +monto.value, plazo_autorizado: +plazo.value, tasa_autorizada: +tasa.value / 100, comentario: com.value.trim() }, 'Firma registrada') }, 'Firmar');
  modal('Firmar autorización', body, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Volver'), ok), true);
}

/* ---------- pestañas del detalle ---------- */
function tabResumen(d, accion) {
  const s = d.solicitud, c = d.cuota, e = d.evaluacion, cont = el('div', {});
  if (s.estado === 'autorizada') cont.append(panel('Autorización', nota('ok', `Autorizada por <b>${m$(s.monto_autorizado)}</b> a <b>${s.plazo_autorizado} meses</b> al <b>${pc(s.tasa_autorizada)}</b> anual. Vigente hasta <b>${fD(s.vigencia_hasta)}</b>. Lista para formalizar.`)));
  if (s.estado === 'rechazada') cont.append(panel('Rechazo', nota('err', `<b>${esc(s.motivo_rechazo || '—')}</b>: ${esc(s.comentario_cierre || '')}`)));
  if (s.estado === 'cancelada') cont.append(panel('Cancelación', nota('', esc(s.comentario_cierre || ''))));
  const g = el('div', { class: 'form-grid' });
  g.append(panel('Crédito solicitado', kv('Producto', esc(d.producto.nombre)), kv('Monto', m$(s.monto), true), kv('Plazo', `${s.plazo_meses} meses · ${s.periodicidad}`), kv('Tasa anual', pc(s.tasa_anual)),
    kv('Pago estimado', `${m$(c.cuota)} ${s.periodicidad} (${c.periodos} pagos)`), kv('Intereses totales', m$(c.total_intereses)), kv('Destino', esc(s.destino || '—')), kv('Garantía o aval', esc(s.garantia || '—'))),
  panel('Capacidad de pago', kv('Ingreso mensual', m$(s.ingresos_mensuales)), kv('Egresos mensuales', m$(s.egresos_mensuales)), kv('Pagos de otras deudas', m$(s.otras_deudas_mensuales)), kv('Antigüedad', s.antiguedad_meses == null ? '—' : s.antiguedad_meses + ' meses'), kv('Score de buró', s.score_buro == null ? '—' : s.score_buro)));
  cont.append(g);
  if (['decision', 'autorizada'].includes(s.estado) || d.decisiones.some(x => x.decision === 'aprueba')) {
    cont.append(panel('Firmas', el('div', { html: d.niveles.map(n => badge(d.firmados.includes(n) ? 'ok' : (n === d.nivel_pendiente && s.estado === 'decision' ? 'warn' : 'neutral'), `${NIVEL_TXT[n]}${d.firmados.includes(n) ? ' ✓' : n === d.nivel_pendiente && s.estado === 'decision' ? ' · pendiente' : ''}`)).join(' → ') }),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, 'Cada nivel lo firma una persona distinta. El comité entra cuando el monto rebasa la facultad de la mesa; Cumplimiento cuando el riesgo PLD es alto.')));
  }
  // motor
  const motor = panel('Motor de decisión');
  motor.querySelector('h3').append(el('span', { class: 'right' }, el('button', { class: 'btn secondary sm', onclick: async () => { try { await call('POST', `/solicitudes/${s.id}/evaluar`); toast('Evaluación actualizada', 'ok'); render(); } catch (er) { falla(er); } } }, 'Evaluar de nuevo')));
  motor.append(nota(REC_CLS[e.recomendacion] === 'ok' ? 'ok' : REC_CLS[e.recomendacion] === 'danger' ? 'err' : REC_CLS[e.recomendacion] === 'warn' ? 'warn' : '', `Recomendación: <b>${esc(MC.cat.recomendaciones[e.recomendacion])}</b> · ${e.resumen.cumple} cumplen, ${e.resumen.revision} en revisión, ${e.resumen.rechazo} no cumplen, ${e.resumen.pendiente} pendientes.` +
    (d.evaluacion_guardada && !d.evaluacion_guardada.vigente ? '<br><b>La evaluación guardada quedó desactualizada</b>: cambió algún dato desde que se evaluó.' : '') + '<br><span class="muted">La recomendación no decide: la firma una persona y, si va contra ella, debe justificarlo por escrito.</span>'));
  motor.append(tableWrap(['Regla', 'Resultado', 'Detalle'], e.reglas.map(r => [esc(r.nombre), badge(REGLA_CLS[r.resultado], REGLA_TXT[r.resultado]), `<span style="font-size:13px">${esc(r.detalle)}</span>`])));
  cont.append(motor);
  void accion;
  return cont;
}
function tabSolicitante(d) {
  const x = d.solicitante, r = d.riesgo, cont = el('div', {});
  const g = el('div', { class: 'form-grid' });
  g.append(panel('Datos', kv('Tipo', x.tipo === 'moral' ? 'Persona moral' : 'Persona física'), kv('Nombre o razón social', esc(x.nombre)), kv('RFC', esc(x.rfc || '—')), kv('CURP', esc(x.curp || '—')), kv('Fecha de nacimiento', x.fecha_nacimiento ? fD(x.fecha_nacimiento) : '—'),
    kv('Nacionalidad', esc(x.nacionalidad)), kv('Actividad', esc(x.actividad || '—')), kv('Domicilio', esc(x.domicilio || '—')), kv('Teléfono', esc(x.telefono || '—')), kv('Correo', esc(x.email || '—'))),
  panel('Riesgo PLD', el('div', { html: badge(RIESGO_CLS[r.nivel], 'Riesgo ' + r.nivel) + ` <span class="muted" style="font-size:12px">${r.puntos} punto(s)</span>` }),
    r.factores.length ? el('div', { style: 'margin-top:10px' }, ...r.factores.map(f => kv(f.texto, '+' + f.puntos))) : el('div', { class: 'muted', style: 'margin-top:8px' }, 'Sin factores de riesgo.'),
    kv('Persona políticamente expuesta', x.pep ? 'Sí' : 'No'), kv('Beneficiario controlador', esc(x.beneficiario_controlador || '—')), kv('Origen de los recursos', esc(x.origen_recursos || '—')),
    r.nivel === 'alto' ? nota('warn', 'Riesgo alto: se exige la firma de Cumplimiento (debida diligencia reforzada).') : null));
  cont.append(g); return cont;
}
function tabExpediente(d) {
  const a = d.acciones, s = d.solicitud, cont = el('div', {});
  const subir = tipo => { const f = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png', style: 'display:none' }); f.addEventListener('change', async () => { if (!f.files[0]) return; const fd = new FormData(); fd.append('tipo', tipo); fd.append('archivo', f.files[0]); try { await withBusy('Subiendo documento…', () => call('POST', `/solicitudes/${s.id}/documentos`, fd)); toast('Documento cargado', 'ok'); render(); } catch (e) { falla(e); } }); f.click(); };
  const revisar = (tipo, estado) => {
    const done = async c => { try { await call('PATCH', `/solicitudes/${s.id}/documentos`, { tipo, estado, comentario: c }); closeModal(); toast(estado === 'validado' ? 'Documento validado' : 'Documento rechazado', 'ok'); render(); } catch (e) { falla(e); } };
    if (estado === 'validado') return done('');
    dlgSimple('Rechazar documento', `«${tipo}»: el ejecutivo debe cargar uno nuevo.`, 'Rechazar documento', done, true, 'Motivo (mínimo 10 caracteres)');
  };
  cont.append(panel('Documentos requeridos', tableWrap(['Documento', 'Estado', 'Archivo', 'Vigencia', 'Comentario', ''], d.documentos.map(x => {
    const acc = el('span', { style: 'display:inline-flex;gap:6px;flex-wrap:wrap' });
    if (x.tiene_archivo) acc.append(el('button', { class: 'btn secondary sm', onclick: () => descargar(`/api/cartera/mc/solicitudes/${s.id}/documentos/archivo?tipo=${encodeURIComponent(x.tipo)}`, x.archivo_nombre || 'documento').catch(falla) }, 'Ver'));
    if (a.subir_docs) acc.append(el('button', { class: 'btn secondary sm', onclick: () => subir(x.tipo) }, x.tiene_archivo ? 'Reemplazar' : 'Subir'));
    if (a.validar_docs && x.tiene_archivo && x.estado !== 'validado') acc.append(el('button', { class: 'btn ok sm', onclick: () => revisar(x.tipo, 'validado') }, 'Validar'));
    if (a.validar_docs && x.tiene_archivo && x.estado !== 'rechazado') acc.append(el('button', { class: 'btn danger sm', onclick: () => revisar(x.tipo, 'rechazado') }, 'Rechazar'));
    return [esc(x.tipo), badge(DOC_CLS[x.estado], x.estado[0].toUpperCase() + x.estado.slice(1)), x.tiene_archivo ? `${esc(x.archivo_nombre || '')}<small class="muted" style="display:block">${Math.round((x.archivo_tam || 0) / 1024)} KB · ${esc(x.subido_por || '')} · ${fF(x.subido_at)}</small>` : '<span class="muted">Sin archivo</span>', x.vigencia ? fD(x.vigencia) : '—', esc(x.comentario || ''), acc];
  }), { empty: 'Sin documentos requeridos.' }), el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, 'Se aceptan PDF, JPG o PNG de hasta 8 MB. Los archivos se guardan cifrados y cada descarga queda en la bitácora. Quien sube un documento no puede validarlo.')));
  return cont;
}
function tabPld(d) {
  const a = d.acciones, p = d.pld, s = d.solicitud, cont = el('div', {});
  const pan = panel('Consulta contra listas');
  if (a.pld_consultar) pan.querySelector('h3').append(el('span', { class: 'right' }, el('button', { class: 'btn sm', onclick: async () => { try { const r = await withBusy('Consultando listas…', () => call('POST', `/solicitudes/${s.id}/pld`)); toast(`${r.coincidencias} coincidencia(s) en ${r.listas} registros vigentes`, 'ok'); render(); } catch (e) { falla(e); } } }, p.consulta ? 'Consultar de nuevo' : 'Consultar listas')));
  if (!p.consulta) pan.append(nota('warn', 'Aún no se consulta contra las listas. Es obligatorio antes de cerrar la verificación.'));
  else {
    pan.append(nota(p.vigente ? (p.pendientes ? 'warn' : 'ok') : 'warn', p.vigente ? `Consultada el <b>${fF(p.consulta.ejecutada_at)}</b> por ${esc(p.consulta.ejecutada_por)} contra <b>${p.consulta.listas_vigentes}</b> registros vigentes: ${p.coincidencias.length ? p.coincidencias.length + ' coincidencia(s)' : 'sin coincidencias'}.`
      : '<b>La consulta ya no vale</b>: cambiaron el nombre, RFC o CURP después de consultar. Vuelve a consultar.'));
    if (p.coincidencias.length) pan.append(tableWrap(['Coincidencia', 'Fuente', 'Parecido', 'Motivo', 'Estado', ''], p.coincidencias.map(k => {
      const acc = el('span', { style: 'display:inline-flex;gap:6px' });
      if (a.pld_revisar && k.estado === 'pendiente' && p.vigente) {
        const res = estado => dlgSimple(estado === 'confirmada' ? 'Confirmar coincidencia' : 'Descartar coincidencia', estado === 'confirmada' ? `«${k.nombre}» es la misma persona: la solicitud ya no podrá autorizarse.` : `«${k.nombre}» es un homónimo o no corresponde.`, estado === 'confirmada' ? 'Confirmar' : 'Descartar',
          async c => { try { await call('PATCH', `/pld/coincidencias/${k.id}`, { estado, comentario: c }); closeModal(); toast('Coincidencia resuelta', 'ok'); render(); } catch (e) { falla(e); } }, true, 'Fundamento (mínimo 15 caracteres)');
        acc.append(el('button', { class: 'btn secondary sm', onclick: () => res('descartada') }, 'Descartar'), el('button', { class: 'btn danger sm', onclick: () => res('confirmada') }, 'Confirmar'));
      }
      return [esc(k.nombre) + (k.rfc ? `<small class="muted" style="display:block">${esc(k.rfc)}</small>` : ''), esc(k.fuente || ''), { num: Math.round(k.score * 100) + '%' }, esc(k.motivo || '') + ' ' + badge(k.nivel === 'alta' ? 'danger' : 'warn', k.nivel), badge({ pendiente: 'warn', descartada: 'neutral', confirmada: 'danger' }[k.estado], k.estado) + (k.comentario ? `<small class="muted" style="display:block">${esc(k.comentario)} · ${esc(k.revisado_por || '')}</small>` : ''), acc];
    })));
  }
  cont.append(pan);
  return cont;
}
function tabDecision(d) {
  const cont = el('div', {});
  cont.append(panel('Decisiones y firmas', tableWrap(['Fecha', 'Nivel', 'Decisión', 'Persona', 'Comentario', 'Marcas'], d.decisiones.slice().reverse().map(x => [fF(x.creado_at), esc(NIVEL_TXT[x.nivel] || x.nivel),
    badge({ aprueba: 'ok', rechaza: 'danger', devuelve: 'warn', verifica: 'info', cancela: 'neutral' }[x.decision], { aprueba: 'Aprueba', rechaza: 'Rechaza', devuelve: 'Devuelve', verifica: 'Verifica', cancela: 'Cancela' }[x.decision]) + (x.monto ? `<small class="muted" style="display:block">${m$(x.monto)} · ${x.plazo} m · ${pc(x.tasa)}</small>` : ''),
    `${esc(x.usuario_nombre || x.usuario)}<small class="muted" style="display:block">${esc(x.rol || '')}</small>`, esc(x.comentario || ''), (x.contra_motor ? badge('warn', 'contra el motor') + ' ' : '') + (x.autoaprobada ? badge('danger', 'autoaprobada') : '')]), { empty: 'Aún no hay decisiones.' })));
  return cont;
}
function tabHistorial(d) {
  const cont = el('div', {});
  cont.append(panel('Historial (bitácora inalterable)', tableWrap(['Fecha', 'Persona', 'Acción'], d.linea.map(x => [fF(x.ts), `${esc(x.usuario || '')}<small class="muted" style="display:block">${esc(x.rol || '')}</small>`, esc(x.resumen || x.accion)]), { empty: 'Sin movimientos.' })));
  return cont;
}

/* ============================ ALTA / EDICIÓN ============================ */
function cuotaJS(monto, tasa, meses, per) {
  const ppy = { mensual: 12, quincenal: 24, semanal: 52 }[per] || 12, n = Math.max(1, Math.round(meses * ppy / 12)), r = tasa / ppy;
  return r === 0 ? monto / n : monto * r / (1 - Math.pow(1 + r, -n));
}
function formSolicitud(d) {
  const ed = !!d, S = ed ? d.solicitud : {}, X = ed ? d.solicitante : {};
  const body = el('div', {});
  const productos = MC.cat.productos;
  const sel = (opts, val) => { const s = el('select', {}, ...opts.map(([v, t]) => el('option', { value: v }, t))); s.value = val == null ? '' : val; return s; };
  const tipo = sel([['moral', 'Persona moral'], ['fisica', 'Persona física']], X.tipo || 'moral');
  const nombre = inp({ value: X.nombre || '', maxlength: 200, placeholder: 'Nombre o razón social' }), rfc = inp({ value: X.rfc || '', maxlength: 13, style: 'text-transform:uppercase' }), curp = inp({ value: X.curp || '', maxlength: 18, style: 'text-transform:uppercase' });
  const fnac = inp({ type: 'date', value: X.fecha_nacimiento || '' }), nac = inp({ value: X.nacionalidad || 'MX', maxlength: 3 }), act = inp({ value: X.actividad || '', placeholder: 'Giro o actividad' });
  const dom = inp({ value: X.domicilio || '' }), tel = inp({ value: X.telefono || '' }), mail = inp({ type: 'email', value: X.email || '' });
  const pep = inp({ type: 'checkbox' }); pep.checked = !!X.pep;
  const bc = inp({ value: X.beneficiario_controlador || '', placeholder: 'Nombre del beneficiario controlador' }), org = inp({ value: X.origen_recursos || '', placeholder: 'Ej. Ventas de su negocio' });
  const prod = sel(productos.map(p => [p.id, p.nombre]), S.producto_id || (productos[0] && productos[0].id));
  const monto = inp({ type: 'number', min: 1, step: '0.01', value: S.monto || '' }), plazo = inp({ type: 'number', min: 1, value: S.plazo_meses || 12 }), per = el('select', {}), tasa = inp({ type: 'number', step: '0.01', value: S.tasa_anual != null ? +(S.tasa_anual * 100).toFixed(4) : '' });
  const dest = inp({ value: S.destino || '', placeholder: 'Capital de trabajo, equipo…' }), ing = inp({ type: 'number', min: 0, step: '0.01', value: S.ingresos_mensuales ?? '' }), egr = inp({ type: 'number', min: 0, step: '0.01', value: S.egresos_mensuales ?? '' }), deu = inp({ type: 'number', min: 0, step: '0.01', value: S.otras_deudas_mensuales ?? '' });
  const ant = inp({ type: 'number', min: 0, value: S.antiguedad_meses ?? '' }), sco = inp({ type: 'number', min: 0, max: 1000, value: S.score_buro ?? '' }), gar = inp({ value: S.garantia || '' }), nts = textarea({ value: S.notas || '', rows: 2 }); nts.value = S.notas || '';
  const info = el('div', { class: 'req-note', style: 'margin-top:-4px' }), cuota = el('div', { class: 'banner', style: 'margin-top:6px' });
  const producto = () => productos.find(p => String(p.id) === String(prod.value)) || productos[0];
  const refrescar = () => {
    const p = producto(); if (!p) return;
    const keep = per.value; per.innerHTML = ''; p.periodicidades.forEach(x => per.append(el('option', { value: x }, x))); per.value = p.periodicidades.includes(keep) ? keep : p.periodicidades[0];
    info.textContent = `Producto: ${m$(p.monto_min)}–${m$(p.monto_max)} · ${p.plazo_min}–${p.plazo_max} meses · tasa ${(p.tasa_min * 100).toFixed(2)}–${(p.tasa_max * 100).toFixed(2)}%`;
    const t = (+tasa.value || p.tasa_default * 100) / 100, m = +monto.value, n = +plazo.value;
    cuota.innerHTML = m > 0 && n > 0 ? `Pago estimado: <b>${mxn(cuotaJS(m, t, n, per.value))}</b> ${esc(per.value)} (amortización francesa, tasa ${(t * 100).toFixed(2)}% anual, sin IVA).` : 'Captura monto y plazo para ver el pago estimado.';
    esFisica();
  };
  const esFisica = () => { const f = tipo.value === 'fisica'; curpL.style.display = fnacL.style.display = f ? '' : 'none'; bcL.style.display = f ? 'none' : ''; };
  const curpL = campo('CURP', curp), fnacL = campo('Fecha de nacimiento', fnac), bcL = campo('Beneficiario controlador', bc, 'Persona que, en última instancia, es dueña o controla a la empresa.');
  if (!ed && !tasa.value) tasa.value = productos[0] ? +(productos[0].tasa_default * 100).toFixed(4) : '';
  prod.addEventListener('change', () => { tasa.value = +(producto().tasa_default * 100).toFixed(4); refrescar(); });
  [monto, plazo, tasa, per].forEach(x => x.addEventListener('input', refrescar)); tipo.addEventListener('change', refrescar);
  body.append(el('h4', { style: 'margin:0 0 10px' }, 'Solicitante'),
    el('div', { class: 'form-grid' }, campo('Tipo de persona', tipo), campo('Nombre o razón social', nombre), campo('RFC', rfc), curpL, fnacL, campo('Nacionalidad', nac, 'Clave de 2 letras (MX)'), campo('Actividad', act), campo('Domicilio', dom), campo('Teléfono', tel), campo('Correo', mail), bcL, campo('Origen de los recursos', org)),
    el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px;margin:0 0 14px' }, pep, 'Es persona políticamente expuesta (PEP)'),
    el('h4', { style: 'margin:6px 0 10px' }, 'Crédito'),
    el('div', { class: 'form-grid' }, campo('Producto', prod), campo('Periodicidad', per), campo('Monto solicitado', monto), campo('Plazo (meses)', plazo), campo('Tasa anual (%)', tasa), campo('Destino del crédito', dest)), info, cuota,
    el('h4', { style: 'margin:14px 0 10px' }, 'Capacidad de pago y buró'),
    el('div', { class: 'form-grid' }, campo('Ingreso mensual', ing), campo('Egresos mensuales', egr), campo('Pagos mensuales de otras deudas', deu), campo('Antigüedad del negocio o empleo (meses)', ant), campo('Score de buró', sco, 'Captúralo de la consulta al buró'), campo('Garantía o aval', gar)), campo('Notas', nts));
  refrescar();
  const num = x => x.value === '' ? null : Number(x.value);
  const guardar = el('button', { class: 'btn', onclick: async () => {
    const b = { _v: ed ? S.version : undefined,
      solicitante: { tipo: tipo.value, nombre: nombre.value, rfc: rfc.value, curp: curp.value, fecha_nacimiento: fnac.value || null, nacionalidad: nac.value, actividad: act.value, domicilio: dom.value, telefono: tel.value, email: mail.value, pep: pep.checked, beneficiario_controlador: bc.value, origen_recursos: org.value },
      solicitud: { producto_id: Number(prod.value), monto: num(monto), plazo_meses: num(plazo), periodicidad: per.value, tasa_anual: tasa.value === '' ? null : Number(tasa.value) / 100, destino: dest.value, ingresos_mensuales: num(ing), egresos_mensuales: num(egr), otras_deudas_mensuales: num(deu), antiguedad_meses: num(ant), score_buro: num(sco), garantia: gar.value, notas: nts.value } };
    guardar.disabled = true;
    try {
      const r = ed ? await call('PUT', '/solicitudes/' + S.id, b) : await call('POST', '/solicitudes', b);
      closeModal(); toast(ed ? 'Solicitud actualizada' : `Solicitud ${r.folio} creada${r.solicitante_reutilizado ? ' (el solicitante ya existía y se actualizó)' : ''}`, 'ok');
      if (ed) render(); else abrir(r.id, 'expediente');
    } catch (e) { falla(e); guardar.disabled = false; if (e.data && e.data.codigo === 'version') { closeModal(); render(); } }
  } }, ed ? 'Guardar cambios' : 'Crear solicitud');
  modal(ed ? `Editar ${S.folio}` : 'Nueva solicitud', body, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Cancelar'), guardar), true);
}

/* ============================ LISTAS Y PLD ============================ */
async function vPld(v) {
  await base();
  const F = MC.pld;
  v.innerHTML = '';
  let pend = []; if (puede('pld_revisar') || puede('ver_todas')) { try { pend = await call('GET', '/pld/pendientes'); } catch (_e) { pend = []; } }
  v.append(panel('Coincidencias por resolver', pend.length ? tableWrap(['Folio', 'Solicitante', 'Coincide con', 'Fuente', { t: 'Parecido' }, 'Etapa'], pend.map(k => { const r = [k.folio, esc(k.nombre), esc(k.lista_nombre), esc(k.fuente || ''), { num: Math.round(k.score * 100) + '%' }, chipEstado(k.estado)]; r._onclick = () => abrir(k.solicitud_id, 'pld'); return r; }))
    : nota('ok', 'No hay coincidencias de listas por resolver.')));
  const pan = panel('Listas vigentes'), res = el('div', {}), tabla = el('div', {});
  const pintar = async () => {
    let r; try { r = await call('GET', `/listas?pag=${F.pag}&q=${encodeURIComponent(F.q)}`); } catch (e) { res.innerHTML = ''; res.append(nota('', 'Tu rol no consulta las listas.')); return; }
    res.innerHTML = ''; res.append(r.resumen.length ? cards(r.resumen.map(x => [x.fuente, x.n, 'cargada ' + fD(x.ultima)])) : nota('warn', 'Aún no hay listas cargadas: sin ellas la consulta PLD no encuentra nada. Importa las listas oficiales (SAT 69-B, UIF, OFAC, ONU) o las internas.'));
    tabla.innerHTML = ''; tabla.append(tableWrap(['Fuente', 'Nombre', 'RFC', 'Notas', 'Carga', ''], r.filas.map(f => { const acc = (puede('pld_revisar') || puede('administrar')) ? el('button', { class: 'btn ghost sm', onclick: async () => { if (await confirmar(`¿Dar de baja «${f.nombre}» de ${f.fuente}?`)) { try { await call('POST', `/listas/${f.id}/baja`); pintar(); } catch (e) { falla(e); } } } }, 'Dar de baja') : ''; return [esc(f.fuente) + (f.es_ejemplo ? ' ' + badge('neutral', 'ejemplo') : ''), esc(f.nombre), esc(f.rfc || '—'), esc(f.notas || ''), fD(f.cargado_at), acc]; }), { empty: 'Sin registros.' }), pager(r.total, r.pag, r.por_pag, n => { F.pag = n; pintar(); }));
  };
  const q = inp({ type: 'search', placeholder: 'Buscar nombre o RFC', value: F.q, style: 'width:240px' }); let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { F.q = q.value; F.pag = 0; pintar(); }, 300); });
  if (puede('pld_revisar') || puede('administrar')) pan.querySelector('h3').append(el('span', { class: 'right' }, el('button', { class: 'btn secondary sm', onclick: () => dlgImportarListas(pintar) }, '⬆ Importar archivo'), el('button', { class: 'btn secondary sm', onclick: () => dlgAltaLista(pintar) }, '+ Agregar registro')));
  pan.append(res, el('div', { class: 'filters' }, q), tabla); v.append(pan); pintar();
}
function dlgImportarListas(listo) {
  const body = el('div', {}), f = el('input', { type: 'file', accept: '.xlsx,.xls,.csv' }), fu = inp({ placeholder: 'Ej. SAT 69-B (si el archivo no trae la columna fuente)' }), rep = inp({ type: 'checkbox' });
  body.append(nota('', 'Columnas: <b>fuente, tipo (persona/empresa), nombre, rfc, curp, notas</b>. Solo «nombre» es indispensable. Las listas oficiales las descargas del SAT, la UIF, OFAC y la ONU y las cargas aquí.'), campo('Archivo (.xlsx o .csv)', f), campo('Fuente por omisión', fu),
    el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px' }, rep, 'Reemplazar: dar de baja los registros anteriores de esas fuentes'));
  const ok = el('button', { class: 'btn', onclick: async () => { if (!f.files[0]) return toast('Elige el archivo', 'err'); const fd = new FormData(); fd.append('archivo', f.files[0]); fd.append('fuente', fu.value); fd.append('reemplazar', rep.checked ? '1' : ''); try { const r = await withBusy('Cargando listas…', () => call('POST', '/listas/importar', fd)); closeModal(); toast(`${r.cargados} registro(s) cargados${r.retirados ? `, ${r.retirados} dados de baja` : ''}${r.omitidas ? `, ${r.omitidas} fila(s) omitidas` : ''}`, 'ok'); listo(); } catch (e) { falla(e); } } }, 'Importar');
  modal('Importar lista PLD', body, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Cancelar'), ok));
}
function dlgAltaLista(listo) {
  const body = el('div', {}), fu = inp({ placeholder: 'Ej. Interna' }), tp = el('select', {}, el('option', { value: 'persona' }, 'Persona'), el('option', { value: 'empresa' }, 'Empresa')), nb = inp({}), rf = inp({ style: 'text-transform:uppercase' }), nt = inp({});
  body.append(el('div', { class: 'form-grid' }, campo('Fuente', fu), campo('Tipo', tp), campo('Nombre', nb), campo('RFC (opcional)', rf), campo('Notas', nt)));
  const ok = el('button', { class: 'btn', onclick: async () => { try { await call('POST', '/listas', { fuente: fu.value, tipo: tp.value, nombre: nb.value, rfc: rf.value, notas: nt.value }); closeModal(); toast('Registro agregado', 'ok'); listo(); } catch (e) { falla(e); } } }, 'Agregar');
  modal('Agregar a una lista', body, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Cancelar'), ok));
}

/* ============================ PRODUCTOS ============================ */
async function vProductos(v) {
  await base();
  const ps = await call('GET', '/productos'), adm = puede('administrar');
  if (adm) $('#pageAction').append(el('button', { class: 'btn', onclick: () => formProducto() }, '+ Nuevo producto'));
  v.innerHTML = '';
  v.append(panel('Productos de crédito', tableWrap(['Producto', 'Tipo', { t: 'Monto' }, 'Plazo', 'Tasa anual', 'Periodicidad', 'Estado'], ps.map(p => { const r = [esc(p.nombre) + (p.es_ejemplo ? ' ' + badge('neutral', 'ejemplo') : '') + `<small class="muted" style="display:block">${esc(p.clave)}</small>`, p.tipo === 'revolvente' ? 'Revolvente' : 'Simple', { num: `${m$(p.monto_min)} – ${m$(p.monto_max)}` }, `${p.plazo_min}–${p.plazo_max} meses`, `${pc(p.tasa_min)}–${pc(p.tasa_max)} (ref. ${pc(p.tasa_default)})`, esc(p.periodicidades.join(', ')), p.activo ? badge('ok', 'Activo') : badge('neutral', 'Inactivo')]; if (adm) r._onclick = () => formProducto(p); return r; }), { empty: 'Aún no hay productos. Crea el primero o carga los datos de ejemplo en «Facultades y política».' })));
}
function formProducto(p) {
  const ed = !!p, P = p || { tipo: 'simple', monto_min: 0, plazo_min: 1, tasa_min: 0, periodicidades: ['mensual'], comision_apertura: 0, politica: {}, docs_extra: [], activo: true };
  const body = el('div', {}), n = (v, f) => inp({ type: 'number', step: 'any', value: v == null ? '' : f ? f(v) : v });
  const clave = inp({ value: P.clave || '', placeholder: 'minusculas_sin_espacios', disabled: ed ? 'true' : null }), nom = inp({ value: P.nombre || '' }), tipo = el('select', {}, el('option', { value: 'simple' }, 'Crédito simple'), el('option', { value: 'revolvente' }, 'Línea revolvente')); tipo.value = P.tipo;
  const mmin = n(P.monto_min), mmax = n(P.monto_max), pmin = n(P.plazo_min), pmax = n(P.plazo_max), tmin = n(P.tasa_min, x => +(x * 100).toFixed(4)), tmax = n(P.tasa_max, x => +(x * 100).toFixed(4)), tdef = n(P.tasa_default, x => +(x * 100).toFixed(4)), tmor = n(P.tasa_moratoria, x => +(x * 100).toFixed(4)), com = n(P.comision_apertura, x => +(x * 100).toFixed(4));
  const pers = ['mensual', 'quincenal', 'semanal'].map(x => { const c = inp({ type: 'checkbox' }); c.checked = P.periodicidades.includes(x); return [x, c]; });
  const pol = {}; const polDef = { pti_max: ['Pagos/ingreso máx. (%)', 100], pti_rechazo: ['Rechazo desde (%)', 100], score_min: ['Score mínimo', 1], score_rechazo: ['Score de rechazo', 1], antig_min: ['Antigüedad mín. (meses)', 1], antig_rechazo: ['Antigüedad de rechazo', 1] };
  Object.entries(polDef).forEach(([k, [, mul]]) => { pol[k] = inp({ type: 'number', step: 'any', placeholder: 'general', value: P.politica[k] != null ? +(P.politica[k] * mul).toFixed(4) : '' }); });
  const docs = textarea({ rows: 3, placeholder: 'Un documento por renglón' }); docs.value = (P.docs_extra || []).join('\n');
  const act = inp({ type: 'checkbox' }); act.checked = P.activo !== false;
  body.append(el('div', { class: 'form-grid' }, campo('Clave', clave), campo('Nombre', nom), campo('Tipo', tipo), campo('Comisión de apertura (%)', com), campo('Monto mínimo', mmin), campo('Monto máximo', mmax), campo('Plazo mínimo (meses)', pmin), campo('Plazo máximo (meses)', pmax), campo('Tasa mínima (%)', tmin), campo('Tasa máxima (%)', tmax), campo('Tasa de referencia (%)', tdef), campo('Tasa moratoria (%)', tmor)),
    el('div', { style: 'display:flex;gap:16px;margin:0 0 14px;flex-wrap:wrap' }, el('b', {}, 'Periodicidad:'), ...pers.map(([x, c]) => el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, c, x))),
    el('h4', { style: 'margin:6px 0 4px' }, 'Política propia del producto'), el('div', { class: 'req-note' }, 'Déjalo vacío para usar la política general (Facultades y política).'),
    el('div', { class: 'form-grid' }, ...Object.entries(polDef).map(([k, [t]]) => campo(t, pol[k]))), campo('Documentos adicionales que pide este producto', docs),
    el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px' }, act, 'Producto activo (disponible para nuevas solicitudes)'));
  const f = x => x.value === '' ? null : Number(x.value);
  const guardar = el('button', { class: 'btn', onclick: async () => {
    const b = { _v: ed ? P.version : undefined, clave: clave.value, nombre: nom.value, tipo: tipo.value, monto_min: f(mmin), monto_max: f(mmax), plazo_min: f(pmin), plazo_max: f(pmax), tasa_min: f(tmin) == null ? null : f(tmin) / 100, tasa_max: f(tmax) == null ? null : f(tmax) / 100, tasa_default: f(tdef) == null ? null : f(tdef) / 100, tasa_moratoria: f(tmor) == null ? null : f(tmor) / 100,
      comision_apertura: f(com) == null ? 0 : f(com) / 100, periodicidades: pers.filter(([, c]) => c.checked).map(([x]) => x), politica: Object.fromEntries(Object.entries(pol).filter(([, i]) => i.value !== '').map(([k, i]) => [k, Number(i.value) / polDef[k][1]])), docs_extra: docs.value.split('\n').map(s => s.trim()).filter(Boolean), activo: act.checked };
    try { ed ? await call('PUT', '/productos/' + P.id, b) : await call('POST', '/productos', b); MC.cat = null; closeModal(); toast('Producto guardado', 'ok'); render(); } catch (e) { falla(e); }
  } }, 'Guardar');
  modal(ed ? 'Editar producto' : 'Nuevo producto', body, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Cancelar'), guardar), true);
}

/* ============================ FACULTADES Y POLÍTICA ============================ */
async function vConfig(v) {
  await base();
  const r = await call('GET', '/config'), C = r.config, ed = r.puede_editar;
  v.innerHTML = '';
  const dis = ed ? null : 'true';
  const n = (val, o) => inp({ type: 'number', step: 'any', value: val, disabled: dis, ...(o || {}) });
  const lim = n(C.facultades.limite_mesa), vig = n(C.facultades.vigencia_dias);
  const sla = Object.fromEntries(['borrador', 'devuelta', 'verificacion', 'decision'].map(k => [k, n(C.sla[k])]));
  const po = C.politica, pol = { pti_max: n(+(po.pti_max * 100).toFixed(2)), pti_rechazo: n(+(po.pti_rechazo * 100).toFixed(2)), score_min: n(po.score_min), score_rechazo: n(po.score_rechazo), antig_min: n(po.antig_min), antig_rechazo: n(po.antig_rechazo), edad_min: n(po.edad_min), edad_max: n(po.edad_max) };
  const pd = C.pld, pld = { umbral_posible: n(+(pd.umbral_posible * 100).toFixed(1)), umbral_alta: n(+(pd.umbral_alta * 100).toFixed(1)), monto_medio: n(pd.monto_medio), monto_alto: n(pd.monto_alto) };
  const acts = textarea({ rows: 4, disabled: dis }); acts.value = pd.actividades_riesgo.join('\n');
  const mot = textarea({ rows: 5, disabled: dis }); mot.value = C.motivos_rechazo.join('\n');
  const dF = textarea({ rows: 5, disabled: dis }); dF.value = C.documentos.fisica.join('\n'); const dM = textarea({ rows: 6, disabled: dis }); dM.value = C.documentos.moral.join('\n');
  const lines = t => t.value.split('\n').map(s => s.trim()).filter(Boolean);
  v.append(nota(ed ? '' : 'warn', ed ? 'Lo que cambies aquí rige para las <b>evaluaciones nuevas</b>; las ya firmadas conservan la política con la que se evaluaron. Cada cambio queda en la bitácora con su antes y después.' : 'Solo el administrador puede cambiar estos parámetros.'));
  v.append(panel('Facultades', el('div', { class: 'form-grid' }, campo('Límite de la mesa de control (monto)', lim, 'Por encima de esto se suma la firma del comité (administrador)'), campo('Vigencia de una autorización (días)', vig))));
  v.append(panel('Tiempos de atención por etapa (días)', el('div', { class: 'form-grid' }, campo('Borrador', sla.borrador), campo('Devuelta', sla.devuelta), campo('En verificación', sla.verificacion), campo('En decisión', sla.decision)), el('div', { class: 'req-note' }, 'El semáforo del tablero marca «último día» al llegar a este número y «vencida» al pasarlo.')));
  v.append(panel('Política del motor de decisión', el('div', { class: 'form-grid' }, campo('Pagos totales / ingreso: cumple hasta (%)', pol.pti_max), campo('Rechazo recomendado desde (%)', pol.pti_rechazo), campo('Score de buró mínimo', pol.score_min), campo('Score de rechazo bajo', pol.score_rechazo), campo('Antigüedad mínima (meses)', pol.antig_min), campo('Antigüedad de rechazo bajo (meses)', pol.antig_rechazo), campo('Edad mínima', pol.edad_min), campo('Edad máxima al vencimiento', pol.edad_max)), el('div', { class: 'req-note' }, 'Cada producto puede tener su propia política (Productos). Entre «cumple» y «rechazo» la recomendación es revisión manual.')));
  v.append(panel('PLD', el('div', { class: 'form-grid' }, campo('Coincidencia posible desde (% de parecido)', pld.umbral_posible), campo('Coincidencia alta desde (%)', pld.umbral_alta), campo('Monto de riesgo medio', pld.monto_medio), campo('Monto de riesgo alto', pld.monto_alto)), campo('Actividades de riesgo (una por renglón)', acts)));
  const ca = C.cartera, car = { dias_vencida: n(ca.dias_vencida), iva: n(+(ca.iva * 100).toFixed(2)) }, est = Object.fromEntries(['al_corriente', '1-30', '31-60', '61-90', '91+'].map(k => [k, n(+(ca.estimacion[k] * 100).toFixed(2))]));
  const ui_ = C.uif, uif = { umbral_relevante: n(ui_.umbral_relevante), ventana_dias: n(ui_.ventana_dias), min_pagos_estructuracion: n(ui_.min_pagos_estructuracion), meses_liquidacion_anticipada: n(ui_.meses_liquidacion_anticipada) };
  const sofN = inp({ value: C.sofom.nombre, disabled: dis }), sofR = inp({ value: C.sofom.representante, disabled: dis });
  v.append(panel('Cartera y estimación preventiva', el('div', { class: 'form-grid' }, campo('Días de atraso para cartera vencida', car.dias_vencida, 'Desde aquí el capital pasa a cartera vencida y deja de devengar interés'), campo('IVA (%)', car.iva)),
    el('h4', { style: 'margin:6px 0 8px' }, 'Estimación preventiva (% del saldo de capital según el atraso)'), el('div', { class: 'form-grid' }, campo('Al corriente', est.al_corriente), campo('1 a 30 días', est['1-30']), campo('31 a 60 días', est['31-60']), campo('61 a 90 días', est['61-90']), campo('Más de 90 días', est['91+']))));
  v.append(panel('UIF · operaciones relevantes e inusuales', el('div', { class: 'form-grid' }, campo('Pago en efectivo relevante desde (MXN)', uif.umbral_relevante), campo('Ventana para detectar fraccionamiento (días)', uif.ventana_dias), campo('Pagos en efectivo que se consideran fraccionamiento', uif.min_pagos_estructuracion), campo('Liquidación anticipada si ocurre antes de (meses)', uif.meses_liquidacion_anticipada)),
    el('div', { class: 'req-note' }, 'Confirma con Cumplimiento los umbrales que aplican a la SOFOM según su régimen. El sistema detecta y lleva el dictamen; el aviso se presenta en el portal de la autoridad.')));
  v.append(panel('Datos de la SOFOM para el contrato', el('div', { class: 'form-grid' }, campo('Denominación', sofN), campo('Representante legal', sofR))));
  v.append(panel('Motivos de rechazo y documentos requeridos', el('div', { class: 'form-grid' }, campo('Motivos de rechazo (uno por renglón)', mot), campo('Documentos · persona física', dF), campo('Documentos · persona moral', dM))));
  if (ed) {
    v.append(el('div', { style: 'margin-bottom:var(--sp-5)' }, el('button', { class: 'btn', onclick: async () => {
      const b = { facultades: { limite_mesa: +lim.value, vigencia_dias: +vig.value }, sla: Object.fromEntries(Object.entries(sla).map(([k, i]) => [k, +i.value])),
        politica: { pti_max: +pol.pti_max.value / 100, pti_rechazo: +pol.pti_rechazo.value / 100, score_min: +pol.score_min.value, score_rechazo: +pol.score_rechazo.value, antig_min: +pol.antig_min.value, antig_rechazo: +pol.antig_rechazo.value, edad_min: +pol.edad_min.value, edad_max: +pol.edad_max.value },
        pld: { umbral_posible: +pld.umbral_posible.value / 100, umbral_alta: +pld.umbral_alta.value / 100, monto_medio: +pld.monto_medio.value, monto_alto: +pld.monto_alto.value, actividades_riesgo: lines(acts) }, motivos_rechazo: lines(mot), documentos: { fisica: lines(dF), moral: lines(dM) },
        cartera: { dias_vencida: +car.dias_vencida.value, iva: +car.iva.value / 100, estimacion: Object.fromEntries(Object.entries(est).map(([k, i]) => [k, +i.value / 100])) }, uif: Object.fromEntries(Object.entries(uif).map(([k, i]) => [k, +i.value])), sofom: { nombre: sofN.value, representante: sofR.value } };
      try { await call('PUT', '/config', b); MC.cat = null; toast('Parámetros guardados', 'ok'); render(); } catch (e) { falla(e); }
    } }, 'Guardar cambios')));
  }
  // matriz de roles
  const roles = MC.yo.roles, perms = MC.yo.catalogoPermisos;
  v.append(panel('Roles y qué puede hacer cada uno', tableWrap(['Permiso', ...roles.map(x => x.nombre)], Object.entries(perms).map(([k, t]) => [esc(t), ...roles.map(x => MC.yo.matriz[x.id].includes(k) ? '<span class="flagok">✓</span>' : '<span class="muted">·</span>')])),
    el('div', { class: 'req-note', style: 'margin-top:8px' }, 'El rol de cada persona se asigna en Administración → Usuarios (campo «Rol en Credit Solvendom»). Quien captura no verifica ni autoriza; quien verifica no autoriza; cada nivel de firma lo da una persona distinta. Solo el único administrador activo puede autoaprobar, con comentario y en alerta.')));
  if (ed) {
    const ej = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, el('button', { class: 'btn secondary', onclick: async () => { try { const x = await withBusy('Generando ejemplos…', () => call('POST', '/ejemplos')); MC.cat = null; toast(`Ejemplos cargados: ${x.solicitudes} solicitudes, ${x.listas} registros de listas`, 'ok'); render(); } catch (e) { falla(e); } } }, 'Cargar datos de ejemplo'),
      el('button', { class: 'btn danger', onclick: async () => { if (await confirmar('¿Borrar todos los datos de ejemplo? Las solicitudes y listas marcadas como ejemplo se eliminan; sus asientos en la bitácora se conservan (es inalterable).')) { try { const x = await call('DELETE', '/ejemplos'); MC.cat = null; toast(`Ejemplos borrados: ${x.solicitudes} solicitudes`, 'ok'); render(); } catch (e) { falla(e); } } } }, 'Borrar datos de ejemplo'));
    v.append(panel('Datos de ejemplo', el('div', { class: 'req-note', style: 'margin:0 0 10px' }, 'Genera 8 solicitudes ficticias en distintas etapas, listas PLD de muestra y dos productos para probar el flujo completo. Todo queda marcado «ejemplo» y se borra con un clic.'), ej));
  }
}

/* ============================ BITÁCORA ============================ */
async function vBitacora(v) {
  await base();
  const F = MC.bit; v.innerHTML = '';
  const fq = inp({ type: 'search', placeholder: 'Buscar en el resumen', value: F.q, style: 'width:220px' }), fu = inp({ type: 'search', placeholder: 'Persona', value: F.usuario, style: 'width:180px' });
  const fe = el('select', { style: 'width:150px' }, el('option', { value: '' }, 'Todo'), ...['solicitud', 'config', 'producto', 'lista', 'acceso', 'ejemplos'].map(x => el('option', { value: x }, x))); fe.value = F.entidad;
  const fd = inp({ type: 'date', value: F.desde }), fh = inp({ type: 'date', value: F.hasta });
  const tabla = el('div', {}), cuenta = el('span', { class: 'muted', style: 'font-size:12px' }), ver = el('div', {});
  const pintar = async () => {
    Object.assign(F, { q: fq.value, usuario: fu.value, entidad: fe.value, desde: fd.value, hasta: fh.value });
    const qs = new URLSearchParams({ q: F.q, usuario: F.usuario, entidad: F.entidad, desde: F.desde, hasta: F.hasta, pag: F.pag }); [...qs.keys()].forEach(k => { if (!qs.get(k)) qs.delete(k); });
    const r = await call('GET', '/bitacora?' + qs); cuenta.textContent = `${r.total} asiento(s)`;
    tabla.innerHTML = ''; tabla.append(tableWrap(['#', 'Fecha', 'Persona', 'Acción', 'Resumen'], r.filas.map(x => [String(x.id), fF(x.ts), `${esc(x.usuario || '')}<small class="muted" style="display:block">${esc(x.rol || '')}</small>`, badge('info', x.accion), esc(x.resumen || '')]), { empty: 'Sin asientos con esos filtros.' }), pager(r.total, r.pag, r.por_pag, n => { F.pag = n; pintar(); }));
  };
  let tm; [fq, fu].forEach(x => x.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { F.pag = 0; pintar(); }, 300); })); [fe, fd, fh].forEach(x => x.addEventListener('change', () => { F.pag = 0; pintar(); }));
  const verificar = el('button', { class: 'btn secondary sm', onclick: async () => { try { const r = await withBusy('Verificando la cadena…', () => call('GET', '/bitacora/verificar')); ver.innerHTML = ''; ver.append(r.ok ? nota('ok', `Cadena íntegra: <b>${r.total}</b> asiento(s) verificados; ninguno fue alterado ni falta.`) : nota('err', `<b>La cadena está rota</b> en el asiento #${r.primero_roto}: ${esc(r.motivo)} Hay manipulación o pérdida de datos: avisa al administrador de sistemas.`)); } catch (e) { falla(e); } } }, 'Verificar integridad');
  const p = panel('Bitácora inalterable'); p.querySelector('h3').append(el('span', { class: 'right' }, verificar));
  p.append(el('div', { class: 'req-note', style: 'margin:0 0 10px' }, 'Cada asiento guarda la huella del anterior y la base rechaza cambios y borrados: si alguien altera uno, «Verificar integridad» lo detecta.'), ver,
    el('div', { class: 'filters' }, fq, fu, fe, fd, fh, el('span', { class: 'spacer' }), cuenta), tabla);
  v.append(p); pintar();
}

window.MCUI = { MC, call, puede, fF, fD, pc, m$, badge, kv, panel, nota, pager, campo, inp, textarea, falla, base, abrir, volver, chipEstado, estadoTxt, ESTADO_CLS, NIVEL_TXT };

/* ---------- registro en el enrutador de la app ---------- */
window.CARTERA_VISTAS = { mc_tablero: vTablero, mc_solicitudes: vSolicitudes, mc_pld: vPld, mc_productos: vProductos, mc_config: vConfig, mc_bitacora: vBitacora };
window.CARTERA_TITULOS = {
  mc_tablero: ['Mesa de control', 'Qué sigue, qué está atrasado y cómo va la decisión de crédito'],
  mc_solicitudes: ['Solicitudes de crédito', 'Del expediente a la autorización: verificación, PLD, motor de decisión y firmas'],
  mc_pld: ['Listas y PLD', 'Coincidencias por resolver y listas de personas bloqueadas o de riesgo'],
  mc_productos: ['Productos de crédito', 'Rangos, tasas, periodicidad, política y documentos de cada producto'],
  mc_config: ['Facultades y política', 'Quién firma qué, tiempos de atención, reglas del motor y parámetros PLD'],
  mc_bitacora: ['Bitácora', 'Quién hizo qué y cuándo, con cadena de huellas que detecta cualquier alteración'],
};
})();
