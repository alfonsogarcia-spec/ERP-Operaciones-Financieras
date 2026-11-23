/* ============================================================================
   public/mesa/ui2.js — Credit Solvendom · MESA DE CONTROL, ciclo del crédito: créditos (formalización, desembolso, pagos), cobranza, conciliación,
   fondeo, contabilidad, reportes y UIF. Usa los ayudantes de public/mesa/ui.js (window.MCUI) y los de la aplicación. Las reglas las hace cumplir el servidor.
   ============================================================================ */
(function () {
'use strict';
const { MC, call, puede, fF, fD, pc, m$, badge, kv, panel, nota, pager, campo, inp, textarea, falla, base } = window.MCUI;
const S2 = { cred: { q: '', estado: '', bucket: '', pag: 0 }, sel: null, tab: 'resumen', cob: { bucket: '' }, conc: { estado: 'pendiente', pag: 0 }, uif: { estado: '', pag: 0 }, rep: { fecha: '', desde: '', hasta: '' } };
const hoy = () => hoyMx();
const ST_CRED = { formalizacion: ['warn', 'En formalización'], desembolso: ['info', 'Por desembolsar'], vigente: ['ok', 'Vigente'], liquidado: ['neutral', 'Liquidado'], cancelado: ['danger', 'Cancelado'] };
const chipCred = e => badge(ST_CRED[e][0], ST_CRED[e][1]);
const BUCK = { al_corriente: ['ok', 'Al corriente'], '1-30': ['warn', '1 a 30 días'], '31-60': ['warn', '31 a 60 días'], '61-90': ['danger', '61 a 90 días'], '91+': ['danger', 'Más de 90 días'] };
const chipBuck = b => b ? badge(BUCK[b][0], BUCK[b][1]) : '';
const select = (opts, val) => { const s = el('select', {}, ...opts.map(([v, t]) => el('option', { value: v }, t))); s.value = val == null ? '' : val; return s; };
const num = x => x.value === '' ? null : Number(x.value);
const bajar = (path, nombre) => descargar(path, nombre).catch(falla);

/* diálogo estándar: cuerpo + botón de acción que ejecuta fn() y cierra si no falla */
function dlg(titulo, cuerpo, verbo, fn, ancho, cls) {
  const ok = el('button', { class: 'btn' + (cls ? ' ' + cls : ''), onclick: async () => { ok.disabled = true; try { await fn(); } catch (e) { falla(e); } finally { ok.disabled = false; } } }, verbo);
  modal(titulo, cuerpo, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Volver'), ok), !!ancho);
}
const abrirCred = (id, tab) => { S2.sel = id; S2.tab = tab || 'resumen'; if (VIEW === 'mc_creditos') render(); else go('mc_creditos'); };

/* ============================ CRÉDITOS ============================ */
async function vCreditos(v) {
  await base();
  if (S2.sel) return detalleCredito(v, S2.sel);
  const F = S2.cred;
  const fq = inp({ type: 'search', placeholder: 'Folio o acreditado', value: F.q, style: 'width:220px' });
  const fe = select([['', 'Todos los estados'], ...Object.entries(ST_CRED).map(([k, x]) => [k, x[1]])], F.estado);
  const fb = select([['', 'Todos los tramos'], ...Object.entries(BUCK).map(([k, x]) => [k, x[1]])], F.bucket);
  const tabla = el('div', {}), cuenta = el('span', { class: 'muted', style: 'font-size:12px' });
  const pintar = async () => {
    Object.assign(F, { q: fq.value, estado: fe.value, bucket: fb.value });
    const qs = new URLSearchParams({ q: F.q, estado: F.estado, bucket: F.bucket, pag: F.pag }); [...qs.keys()].forEach(k => { if (!qs.get(k) || qs.get(k) === '0' && k === 'pag') qs.delete(k); });
    let r; try { r = await call('GET', '/creditos?' + qs); } catch (e) { tabla.innerHTML = ''; tabla.append(nota('err', esc(errMsg(e)))); return; }
    cuenta.textContent = `${r.total} crédito(s)`; tabla.innerHTML = '';
    tabla.append(tableWrap(['Crédito', 'Acreditado', 'Producto', { t: 'Monto' }, 'Estado', { t: 'Saldo' }, 'Atraso', 'Próximo pago'], r.filas.map(c => {
      const row = [`<b>${esc(c.folio)}</b>${c.es_ejemplo ? ' ' + badge('neutral', 'ejemplo') : ''}`, esc(c.nombre), esc(c.producto), { num: m$(c.monto) }, chipCred(c.estado), { num: c.saldo == null ? '—' : m$(c.saldo) }, c.bucket ? chipBuck(c.bucket) + (c.dias ? ` <small class="muted">${c.dias} d</small>` : '') : '—', c.proximo ? `${fD(c.proximo.fecha)}<small class="muted" style="display:block">${m$(c.proximo.monto)}</small>` : '—'];
      row._onclick = () => abrirCred(c.id); return row;
    }), { empty: 'Aún no hay créditos. Se crean al formalizar una solicitud autorizada.' }), pager(r.total, r.pag, r.por_pag, n => { F.pag = n; pintar(); }));
  };
  let tm; fq.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { F.pag = 0; pintar(); }, 300); }); [fe, fb].forEach(x => x.addEventListener('change', () => { F.pag = 0; pintar(); }));
  v.innerHTML = '';
  const p = panel('Créditos'); p.append(el('div', { class: 'filters' }, fq, fe, fb, el('button', { class: 'btn ghost sm', onclick: () => { fq.value = fe.value = fb.value = ''; F.pag = 0; pintar(); } }, 'Limpiar'), el('span', { class: 'spacer' }), cuenta), tabla);
  v.append(p); pintar();
}

async function detalleCredito(v, id) {
  let d; try { d = await call('GET', '/creditos/' + id); } catch (e) { S2.sel = null; v.innerHTML = ''; v.append(nota('err', esc(errMsg(e))), el('button', { class: 'btn ghost', onclick: () => render() }, '← Créditos')); return; }
  const c = d.credito, a = d.acciones, st = d.st;
  const accion = async (nombre, extra, msg) => { try { await call('POST', `/creditos/${id}/accion`, { accion: nombre, _v: c.version, ...(extra || {}) }); closeModal(); toast(msg || 'Hecho', 'ok'); render(); } catch (e) { if (e.data && e.data.codigo === 'version') { toast(errMsg(e), 'err'); render(); } else falla(e); } };
  v.innerHTML = '';
  v.append(el('div', { class: 'panel', style: 'display:flex;flex-wrap:wrap;gap:14px 24px;align-items:center' },
    el('button', { class: 'btn ghost sm', onclick: () => { S2.sel = null; render(); } }, '← Créditos'),
    el('div', { style: 'flex:1;min-width:240px' }, el('div', { style: 'font-size:var(--fs-lg);font-weight:600', html: `${esc(c.folio)} · ${esc(d.solicitante.nombre)}` + (c.es_ejemplo ? ' ' + badge('neutral', 'ejemplo') : '') }),
      el('div', { class: 'muted', style: 'font-size:13px', html: `${esc(d.producto.nombre)} · ${m$(c.monto)} a ${c.plazo_meses} meses al ${pc(c.tasa_anual)} · CAT ${c.cat == null ? '—' : (c.cat * 100).toFixed(1) + '%'} · solicitud <a href="#" id="ir-sol">${esc(d.solicitud.folio)}</a>` })),
    el('div', { html: chipCred(c.estado) + (st ? ' ' + chipBuck(st.bucket) : '') })));
  setTimeout(() => { const l = document.getElementById('ir-sol'); if (l) l.onclick = e => { e.preventDefault(); window.MCUI.abrir(d.solicitud.id); }; }, 0);
  const bar = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px' }), btn = (t, cls, fn) => bar.append(el('button', { class: 'btn sm ' + cls, onclick: fn }, t));
  if (a.editar) btn('Cuenta y condiciones', 'secondary', () => formCredito(d));
  btn('Contrato', 'secondary', () => bajar(`/api/cartera/mc/creditos/${id}/contrato`, `contrato_${c.folio}.html`));
  if (a.firmar) btn('Registrar firma', 'secondary', () => formFirma(d));
  if (a.formalizar) btn('Formalizar', '', () => dlg('Formalizar el crédito', nota('', 'Se verifica que el acreditado (o su representante legal) y la SOFOM hayan firmado la versión actual del contrato. Después el crédito pasa a desembolso y las condiciones ya no cambian.'), 'Formalizar', () => accion('formalizar', {}, 'Crédito formalizado')));
  if (a.solicitar_desembolso) btn('Solicitar desembolso', '', () => formDesembolso(d));
  if (a.pagar) btn('Registrar pago', '', () => formPago(d));
  if (a.gestionar) btn('Gestión de cobranza', 'secondary', () => formGestion(d));
  if (st) btn('Estado de cuenta', 'secondary', () => bajar(`/api/cartera/mc/creditos/${id}/estado-cuenta`, `estado_cuenta_${c.folio}.html`));
  if (a.cancelar) btn('Cancelar crédito', 'ghost', () => dlgTexto('Cancelar el crédito', 'Se cancela antes de desembolsar. No se puede reabrir.', 'Cancelar crédito', 10, 'Motivo', t => accion('cancelar', { comentario: t }, 'Crédito cancelado'), true));
  if (bar.children.length) v.append(bar);
  const TABS = [['resumen', 'Resumen'], ['calendario', 'Calendario'], ['pagos', `Pagos (${d.pagos.filter(p => p.estado === 'registrado').length})`], ['contrato', 'Contrato y firmas'], ['desembolso', 'Desembolso'], ['cobranza', `Cobranza (${d.gestiones.length})`], ['historial', 'Historial']];
  const tabs = el('div', { class: 'tabs', role: 'tablist' }), cuerpo = el('div', {});
  const pintar = () => { cuerpo.innerHTML = ''; cuerpo.append(({ resumen: tResumen, calendario: tCalendario, pagos: tPagos, contrato: tContrato, desembolso: tDesembolso, cobranza: tCobranza, historial: tHistorial })[S2.tab](d)); [...tabs.children].forEach((b, i) => b.classList.toggle('active', TABS[i][0] === S2.tab)); };
  TABS.forEach(([k, t]) => tabs.append(el('button', { class: 'tab' + (S2.tab === k ? ' active' : ''), type: 'button', role: 'tab', onclick: () => { S2.tab = k; pintar(); } }, t)));
  v.append(tabs, cuerpo); pintar();
}
function dlgTexto(titulo, texto, verbo, min, etiqueta, fn, peligro) {
  const t = textarea({ placeholder: etiqueta }), b = el('div', {}); b.append(nota('', esc(texto)), campo(etiqueta + ` (mínimo ${min} caracteres)`, t));
  dlg(titulo, b, verbo, async () => { if (t.value.trim().length < min) throw new Error(`${etiqueta}: mínimo ${min} caracteres.`); await fn(t.value.trim()); }, false, peligro ? 'danger' : '');
}

/* ---------- pestañas ---------- */
function tResumen(d) {
  const c = d.credito, st = d.st, cont = el('div', {}), g = el('div', { class: 'form-grid' });
  if (c.estado === 'cancelado') cont.append(panel('Cancelación', nota('', esc(c.comentario_cierre || ''))));
  g.append(panel('Condiciones', kv('Monto', m$(c.monto), true), kv('Plazo', `${c.plazo_meses} meses · ${c.periodicidad}`), kv('Tasa ordinaria', pc(c.tasa_anual)), kv('Tasa moratoria', c.tasa_moratoria == null ? 'No pactada' : pc(c.tasa_moratoria)),
    kv('Comisión de apertura', pc(c.comision_apertura)), kv('IVA', pc(c.iva_pct)), kv('CAT sin IVA', c.cat == null ? '—' : (c.cat * 100).toFixed(1) + '% anual'), kv('Desembolso', c.fecha_desembolso ? fD(c.fecha_desembolso) : 'Por definir'),
    kv('Cuenta de depósito', `${esc(c.beneficiario || '—')} · ${esc(c.clabe_mascara || '—')}`), kv('Línea de fondeo', d.fondeo ? `${esc(d.fondeo.nombre)} (disponible ${m$(d.fondeo.disponible)})` : '—')));
  if (st) g.append(panel('Estado al ' + fD(d.fecha), kv('Saldo de capital', m$(st.saldoCapital), true), kv('Vencido (capital, interés e IVA)', m$(st.vencido.cuotas)), kv('Moratorios con IVA', m$(st.moratorios + st.ivaMoratorios)), kv('Total vencido', m$(st.vencido.total), true),
    kv('Días de atraso', st.diasAtraso + (st.cuotasVencidas ? ` (${st.cuotasVencidas} pago(s) vencido(s))` : '')), kv('Próximo pago', st.proximo ? `${fD(st.proximo.fecha)} · ${m$(st.proximo.monto)}` : '—'), kv('Para liquidar hoy', m$(st.liquidar)), kv('Pagado a la fecha', m$(st.pagado))));
  cont.append(g);
  if (st && st.diasAtraso > 0) cont.append(nota('warn', `Atraso de <b>${st.diasAtraso}</b> día(s): ${chipBuck(st.bucket)}. Para ponerse al corriente: <b>${m$(st.vencido.total)}</b>.`));
  if (st && st.liquidado) cont.append(nota('ok', 'El crédito está liquidado.'));
  return cont;
}
function tCalendario(d) {
  const filas = d.st ? d.st.filas : d.filas.map(f => ({ ...f, pCap: f.capital, pInt: f.interes, pIva: f.iva, pagada: false, vencida: false }));
  const tot = filas.reduce((s, f) => ({ cap: s.cap + f.capital, int: s.int + f.interes, iva: s.iva + f.iva, tot: s.tot + f.total }), { cap: 0, int: 0, iva: 0, tot: 0 });
  return panel(d.st ? 'Calendario de pagos' : 'Calendario previsto (se congela al desembolsar)', tableWrap(['No.', 'Fecha', { t: 'Capital' }, { t: 'Interés' }, { t: 'IVA' }, { t: 'Pago' }, { t: 'Pendiente' }, 'Estado'],
    [...filas.map(f => [String(f.num), fD(f.fecha), { num: m$(f.capital) }, { num: m$(f.interes) }, { num: m$(f.iva) }, { num: m$(f.total) }, { num: m$(f.pCap + f.pInt + f.pIva) }, f.pagada ? badge('ok', 'Pagado') : f.vencida ? badge('danger', 'Vencido') : badge('neutral', 'Por vencer')]),
      ['', '<b>Totales</b>', { num: `<b>${m$(tot.cap)}</b>` }, { num: `<b>${m$(tot.int)}</b>` }, { num: `<b>${m$(tot.iva)}</b>` }, { num: `<b>${m$(tot.tot)}</b>` }, '', '']]));
}
function tPagos(d) {
  const c = d.credito, ap = new Map((d.st ? d.st.aplicaciones : []).map(x => [x.id, x]));
  return panel('Pagos recibidos', tableWrap(['Fecha', { t: 'Monto' }, 'Medio', 'Referencia', 'Aplicación', 'Estado', ''], d.pagos.map(p => {
    const x = ap.get(p.id), acc = d.acciones.cancelar_pago && p.estado === 'registrado' ? el('button', { class: 'btn ghost sm', onclick: () => dlgTexto('Cancelar pago', `Se cancela el pago de ${m$(p.monto)} y el saldo se recalcula. Queda en la bitácora.`, 'Cancelar pago', 15, 'Motivo', async t => { await call('POST', `/pagos/${p.id}/cancelar`, { comentario: t }); closeModal(); toast('Pago cancelado', 'ok'); render(); }, true) }, 'Cancelar') : '';
    return [fD(p.fecha), { num: m$(p.monto) }, esc(p.medio), esc(p.referencia || '—'), x ? `<small>moratorios ${m$(x.mor)} · interés ${m$(x.interes)} · IVA ${m$(x.iva)} · capital ${m$(x.capital)}${x.exceso ? ' · a favor ' + m$(x.exceso) : ''}</small>` : '—',
      p.estado === 'registrado' ? badge('ok', 'Registrado') + (p.mov_id ? ' ' + badge('info', 'conciliado') : '') : badge('danger', 'Cancelado', p.motivo_cancelacion || ''), acc];
  }), { empty: 'Aún no hay pagos.' }));
}
function tContrato(d) {
  const k = d.contrato, cont = el('div', {});
  cont.append(panel('Contrato', nota(k.listo ? 'ok' : 'warn', k.listo ? `Firmado por el acreditado y por la SOFOM sobre la versión actual (huella <code>${esc(k.hash.slice(0, 12))}</code>).` : `Faltan firmas sobre la versión actual del contrato: ${k.firmado_acreditado ? '' : '<b>acreditado o representante legal</b> '}${k.firmado_sofom ? '' : '<b>la SOFOM</b>'}. Si cambias condiciones o la cuenta después de firmar, hay que firmar de nuevo.`),
    tableWrap(['Firmante', 'Calidad', 'Método', 'Fecha', 'Evidencia', 'Versión del contrato', 'Registró'], d.firmas.map(f => [esc(f.firmante), esc(f.calidad.replace(/_/g, ' ')), esc(f.metodo), fD(f.fecha), f.tiene_archivo ? esc(f.archivo_nombre) : '—', f.doc_hash === k.hash ? badge('ok', 'vigente') : badge('neutral', 'anterior'), esc(f.registrado_por || '')]), { empty: 'Aún no hay firmas.' })));
  return cont;
}
function tDesembolso(d) {
  const a = d.acciones;
  return panel('Desembolsos', tableWrap(['Estado', { t: 'Monto' }, { t: 'Neto' }, 'Fecha', 'Solicitó', 'Autorizó', 'Referencia', ''], d.desembolsos.map(x => {
    const acc = el('span', { style: 'display:inline-flex;gap:6px;flex-wrap:wrap' }), act = (t, cls, fn) => acc.append(el('button', { class: 'btn sm ' + cls, onclick: fn }, t));
    const post = (accionN, extra, msg) => async () => { await call('POST', `/desembolsos/${x.id}/accion`, { accion: accionN, ...(extra || {}) }); closeModal(); toast(msg, 'ok'); render(); };
    if (x.estado === 'solicitado' && puede('desembolso_autorizar')) act('Autorizar', '', () => dlg('Autorizar desembolso', (() => { const t = textarea({ placeholder: 'Comentario (obligatorio solo si tú lo solicitaste)' }); t.id = 'des-com'; const b = el('div', {}); b.append(nota('', `Autorizas el desembolso de ${m$(x.monto)} (neto ${m$(x.neto)}) a ${esc(d.credito.beneficiario)}.`), campo('Comentario', t)); return b; })(), 'Autorizar', async () => post('autorizar', { comentario: document.getElementById('des-com').value }, 'Desembolso autorizado')()));
    if (['autorizado', 'enviado'].includes(x.estado) && puede('desembolso_solicitar')) act('Layout SPEI', 'secondary', () => bajar(`/api/cartera/mc/desembolsos/${x.id}/layout.xlsx`, `layout_desembolso_${d.credito.folio}.xlsx`));
    if (x.estado === 'autorizado' && puede('desembolso_solicitar')) act('Marcar enviado', '', () => dlg('Marcar como enviado al banco', nota('', 'Confirma que ya subiste el layout al banco. Falta confirmar el desembolso con la clave de rastreo.'), 'Marcar enviado', post('enviar', {}, 'Marcado como enviado')));
    if (x.estado === 'enviado' && puede('desembolso_solicitar')) act('Confirmar', '', () => { const r = inp({ placeholder: 'Clave de rastreo o referencia SPEI' }), f = inp({ type: 'date', value: hoy(), max: hoy() }), t = textarea({ placeholder: 'Comentario' }); const b = el('div', {}); b.append(nota('', 'Al confirmar, el crédito queda vigente y la tabla de pagos se congela con esta fecha.'), el('div', { class: 'form-grid' }, campo('Referencia', r), campo('Fecha del desembolso', f)), campo('Comentario', t)); dlg('Confirmar desembolso', b, 'Confirmar', async () => post('confirmar', { referencia: r.value, fecha_real: f.value, comentario: t.value }, 'Desembolso confirmado · crédito vigente')()); });
    if (['solicitado', 'autorizado', 'enviado'].includes(x.estado)) act('Cancelar', 'ghost', () => dlgTexto('Cancelar desembolso', 'El crédito vuelve a quedar por desembolsar.', 'Cancelar desembolso', 10, 'Motivo', async t => post('cancelar', { comentario: t }, 'Desembolso cancelado')(), true));
    const est = { solicitado: ['warn', 'Por autorizar'], autorizado: ['info', 'Autorizado'], enviado: ['violet', 'Enviado al banco'], confirmado: ['ok', 'Confirmado'], cancelado: ['danger', 'Cancelado'] }[x.estado];
    return [badge(est[0], est[1]) + (x.autoaprobado ? ' ' + badge('danger', 'autoaprobado') : ''), { num: m$(x.monto) }, { num: m$(x.neto) }, x.fecha_real ? fD(x.fecha_real) : x.fecha_prevista ? fD(x.fecha_prevista) : '—', esc(x.solicitado_por || ''), esc(x.autorizado_por || '—'), esc(x.referencia || '—'), acc];
  }), { empty: a.solicitar_desembolso ? 'Aún no se solicita el desembolso.' : 'Sin desembolsos.' }));
}
function tCobranza(d) {
  return panel('Gestiones de cobranza', tableWrap(['Fecha', 'Tipo', 'Resultado', 'Comentario', 'Promesa', 'Próxima', 'Gestor'], d.gestiones.map(g => [fD(g.fecha), esc(g.tipo), esc(g.resultado || '—'), esc(g.comentario || ''), g.promesa_fecha ? `${m$(g.promesa_monto)} el ${fD(g.promesa_fecha)}` : '—', g.proxima ? fD(g.proxima) : '—', esc(g.usuario || '')]), { empty: 'Sin gestiones.' }));
}
function tHistorial(d) { return panel('Historial (bitácora inalterable)', tableWrap(['Fecha', 'Persona', 'Acción'], d.linea.map(x => [fF(x.ts), `${esc(x.usuario || '')}<small class="muted" style="display:block">${esc(x.rol || '')}</small>`, esc(x.resumen || x.accion)]), { empty: 'Sin movimientos.' })); }

/* ---------- formularios del crédito ---------- */
async function formCredito(d) {
  const c = d.credito, cat = await call('GET', '/catalogo/bancos');
  const b = el('div', {}), ben = inp({ value: c.beneficiario || d.solicitante.nombre }), clabe = inp({ placeholder: c.tiene_clabe ? `Actual ${c.clabe_mascara} (déjalo vacío para no cambiarla)` : '18 dígitos', maxlength: 22 });
  const banco = select([['', 'Elige el banco…'], ...cat.bancos.map(x => [x.codigo_spei + '|' + x.nombre, `${x.nombre} (${x.codigo_spei})`])], c.banco_codigo ? c.banco_codigo + '|' + (c.banco_nombre || '') : '');
  const fecha = inp({ type: 'date', value: c.fecha_desembolso || hoy(), min: hoy() }), fond = select([['', 'Sin línea de fondeo'], ...cat.fondeos.map(f => [f.id, f.nombre])], c.fondeo_id || '');
  b.append(nota('warn', 'Si cambias algo que aparece en el contrato (cuenta, fecha, línea) después de firmar, las firmas anteriores dejan de valer y hay que firmar de nuevo.'), el('div', { class: 'form-grid' }, campo('Beneficiario', ben), campo('CLABE de depósito', clabe, 'Se valida el dígito verificador. Se guarda cifrada.'), campo('Banco', banco), campo('Fecha de desembolso', fecha), campo('Línea de fondeo', fond)));
  dlg('Cuenta y condiciones', b, 'Guardar', async () => {
    const [cod, nom] = banco.value ? banco.value.split('|') : ['', ''];
    const body = { _v: c.version, beneficiario: ben.value, banco_codigo: cod || null, banco_nombre: nom || null, fecha_desembolso: fecha.value, fondeo_id: fond.value || null }; if (clabe.value.trim()) body.clabe = clabe.value;
    await call('PUT', '/creditos/' + c.id, body); closeModal(); toast('Crédito actualizado', 'ok'); render();
  }, true);
}
function formFirma(d) {
  const b = el('div', {}), nom = inp({ placeholder: 'Nombre completo de quien firma' }), cal = select([['representante_legal', 'Representante legal del acreditado'], ['acreditado', 'Acreditado (persona física)'], ['la_sofom', 'La SOFOM'], ['aval', 'Aval'], ['obligado_solidario', 'Obligado solidario']], d.solicitante.tipo === 'moral' ? 'representante_legal' : 'acreditado');
  const met = select([['autografa', 'Autógrafa (se sube el escaneo)'], ['electronica', 'Electrónica']], 'autografa'), fec = inp({ type: 'date', value: hoy(), max: hoy() }), arc = inp({ type: 'file', accept: '.pdf,.jpg,.jpeg,.png' });
  b.append(nota('', `Se registra la firma sobre la versión actual del contrato (huella ${esc(d.contrato.hash.slice(0, 12))}). Descarga el contrato, fírmalo y sube el escaneo. La firma electrónica queda registrada como evidencia interna; su validez legal depende del proveedor y del contrato que uses.`),
    el('div', { class: 'form-grid' }, campo('Firmante', nom), campo('Calidad', cal), campo('Método', met), campo('Fecha de firma', fec)), campo('Contrato firmado (PDF, JPG o PNG)', arc));
  dlg('Registrar firma', b, 'Registrar', async () => { const f = new FormData(); f.append('firmante', nom.value); f.append('calidad', cal.value); f.append('metodo', met.value); f.append('fecha', fec.value); if (arc.files[0]) f.append('archivo', arc.files[0]); await call('POST', `/creditos/${d.credito.id}/firmas`, f); closeModal(); toast('Firma registrada', 'ok'); render(); }, true);
}
function formDesembolso(d) {
  const c = d.credito, com = Math.round(c.monto * c.comision_apertura * (1 + c.iva_pct) * 100) / 100, fec = inp({ type: 'date', value: c.fecha_desembolso || hoy(), min: hoy() }), b = el('div', {});
  b.append(nota('', `Desembolso de <b>${m$(c.monto)}</b> menos comisión de apertura con IVA <b>${m$(com)}</b> = neto <b>${m$(c.monto - com)}</b> a ${esc(c.beneficiario || '—')} (${esc(c.clabe_mascara || '—')}). Lo autoriza otra persona de la mesa y después se envía el layout al banco.`), campo('Fecha prevista', fec));
  dlg('Solicitar desembolso', b, 'Solicitar', async () => { await call('POST', `/creditos/${c.id}/desembolsos`, { fecha_prevista: fec.value }); closeModal(); toast('Desembolso solicitado', 'ok'); S2.tab = 'desembolso'; render(); });
}
function formPago(d) {
  const st = d.st, b = el('div', {}), fec = inp({ type: 'date', value: hoy(), max: hoy() }), mon = inp({ type: 'number', step: '0.01', min: '0.01', value: st && st.vencido.total > 0 ? st.vencido.total : st && st.proximo ? st.proximo.monto : '' }), med = select([['spei', 'SPEI'], ['deposito', 'Depósito'], ['efectivo', 'Efectivo'], ['tercero', 'Pago de un tercero'], ['otro', 'Otro']], 'spei'), ref = inp({ placeholder: 'Clave de rastreo o referencia' }), com = inp({ placeholder: 'Comentario (opcional)' });
  b.append(nota('', `Total vencido a hoy: <b>${m$(st.vencido.total)}</b> · para liquidar: <b>${m$(st.liquidar)}</b>. El pago se aplica a moratorios, interés, IVA y capital, en ese orden, empezando por lo más viejo. Lo que sobre adelanta pagos.`), el('div', { class: 'form-grid' }, campo('Fecha del pago', fec), campo('Monto', mon), campo('Medio', med), campo('Referencia', ref, 'Obligatoria salvo efectivo; no se repite')), campo('Comentario', com));
  dlg('Registrar pago', b, 'Registrar', async () => { const r = await call('POST', `/creditos/${d.credito.id}/pagos`, { fecha: fec.value, monto: num(mon), medio: med.value, referencia: ref.value, comentario: com.value }); closeModal(); toast(r.liquidado ? 'Pago registrado · crédito liquidado' : 'Pago registrado', 'ok'); S2.tab = 'pagos'; render(); });
}
function formGestion(d) {
  const b = el('div', {}), tipo = select([['llamada', 'Llamada'], ['visita', 'Visita'], ['mensaje', 'Mensaje'], ['correo', 'Correo'], ['promesa', 'Promesa de pago'], ['otro', 'Otro']], 'llamada'), res = inp({ placeholder: 'Ej. Contestó, no localizado, promesa' }), com = textarea({ placeholder: 'Qué pasó' }),
    pf = inp({ type: 'date' }), pm = inp({ type: 'number', step: '0.01', min: '0' }), px = inp({ type: 'date' });
  b.append(el('div', { class: 'form-grid' }, campo('Tipo', tipo), campo('Resultado', res)), campo('Comentario', com), el('div', { class: 'form-grid' }, campo('Promesa de pago: fecha', pf), campo('Promesa de pago: monto', pm), campo('Próxima gestión', px)));
  dlg('Gestión de cobranza', b, 'Guardar', async () => { await call('POST', `/creditos/${d.credito.id}/gestiones`, { tipo: tipo.value, resultado: res.value, comentario: com.value, promesa_fecha: pf.value || null, promesa_monto: pm.value === '' ? null : Number(pm.value), proxima: px.value || null }); closeModal(); toast('Gestión registrada', 'ok'); S2.tab = 'cobranza'; render(); }, true);
}

/* ============================ COBRANZA ============================ */
async function vCobranza(v) {
  await base();
  const r = await call('GET', '/cobranza' + (S2.cob.bucket ? '?bucket=' + encodeURIComponent(S2.cob.bucket) : ''));
  v.innerHTML = '';
  const tot = r.resumen;
  v.append(cards([['Cartera vigente', m$(tot.capital), `${tot.creditos} crédito(s)`], ['Con atraso', tot.atrasados, `moratorios ${m$(tot.moratorios)}`], ['IMOR', (tot.imor * 100).toFixed(2) + '%', `desde ${tot.dias_vencida} días`], ['Estimación', m$(tot.estimacion), 'ICOR ' + (tot.icor * 100).toFixed(2) + '%']]));
  const chips = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' });
  chips.append(el('button', { class: 'btn sm ' + (S2.cob.bucket ? 'ghost' : ''), onclick: () => { S2.cob.bucket = ''; render(); } }, 'Todos'));
  r.buckets.filter(b => b.bucket !== 'al_corriente').forEach(b => chips.append(el('button', { class: 'btn sm ' + (S2.cob.bucket === b.bucket ? '' : 'ghost'), onclick: () => { S2.cob.bucket = b.bucket; render(); } }, `${BUCK[b.bucket][1]} · ${b.n} · ${m$(b.vencido)}`)));
  v.append(panel('Cartera con atraso', chips, tableWrap(['Crédito', 'Acreditado', { t: 'Días' }, 'Tramo', { t: 'Vencido' }, { t: 'Saldo' }, 'Última gestión', 'Promesa'], r.filas.map(f => {
    const row = [`<b>${esc(f.folio)}</b>`, esc(f.nombre), { num: String(f.dias) }, chipBuck(f.bucket), { num: m$(f.vencido) }, { num: m$(f.saldo) }, f.ultima ? `${fD(f.ultima.fecha)} · ${esc(f.ultima.tipo)}<small class="muted" style="display:block">${esc(f.ultima.resultado || '')}${f.proxima ? ' · próxima ' + fD(f.proxima) : ''}</small>` : '<span class="muted">Sin gestiones</span>',
      f.promesa ? badge({ pendiente: 'warn', cumplida: 'ok', incumplida: 'danger' }[f.promesa.estado], `${f.promesa.estado} · ${m$(f.promesa.monto)} el ${fD(f.promesa.fecha)}`) : '—'];
    row._onclick = () => abrirCred(f.id, 'cobranza'); return row;
  }), { empty: 'Ningún crédito con atraso.' })));
}

/* ============================ CONCILIACIÓN ============================ */
async function vConciliacion(v) {
  await base();
  if (puede('conciliar')) $('#pageAction').append(el('button', { class: 'btn', onclick: dlgImportarBanco }, '⬆ Importar estado de cuenta'));
  const F = S2.conc, r = await call('GET', `/conciliacion?estado=${F.estado}&pag=${F.pag}`);
  v.innerHTML = '';
  const por = Object.fromEntries(r.resumen.map(x => [x.estado, x]));
  v.append(cards([['Por conciliar', (por.pendiente || { n: 0 }).n, m$((por.pendiente || { monto: 0 }).monto)], ['Conciliados', (por.conciliado || { n: 0 }).n, m$((por.conciliado || { monto: 0 }).monto)], ['Ignorados', (por.ignorado || { n: 0 }).n], ['Pagos sin conciliar', r.pagos_sin_conciliar.length, 'SPEI o depósito sin movimiento bancario']]));
  const tabs = el('div', { class: 'tabs' }); [['pendiente', 'Por conciliar'], ['conciliado', 'Conciliados'], ['ignorado', 'Ignorados']].forEach(([k, t]) => tabs.append(el('button', { class: 'tab' + (F.estado === k ? ' active' : ''), onclick: () => { F.estado = k; F.pag = 0; render(); } }, t)));
  v.append(panel('Movimientos del banco', tabs, tableWrap(['Fecha', 'Descripción', 'Referencia', { t: 'Monto' }, 'Detalle', ''], r.filas.map(m => {
    const acc = el('span', { style: 'display:inline-flex;gap:6px' });
    if (m.estado === 'pendiente' && puede('conciliar')) acc.append(el('button', { class: 'btn sm', onclick: () => dlgMovimiento(m) }, 'Registrar pago'), el('button', { class: 'btn ghost sm', onclick: () => dlgTexto('Ignorar movimiento', `${m$(m.monto)} · ${m.referencia || m.descripcion || ''}. Queda en la bitácora.`, 'Ignorar', 10, 'Motivo', async t => { await call('POST', `/conciliacion/${m.id}/ignorar`, { nota: t }); closeModal(); toast('Movimiento ignorado', 'ok'); render(); }, true) }, 'Ignorar'));
    return [fD(m.fecha), esc(m.descripcion || ''), esc(m.referencia || '—'), { num: m$(m.monto) }, m.sugerido ? badge('info', 'parece ' + m.sugerido.folio) : esc(m.nota || ''), acc];
  }), { empty: 'Sin movimientos en esta lista.' }), pager(r.total, r.pag, r.por_pag, n => { F.pag = n; render(); })));
  if (r.pagos_sin_conciliar.length) v.append(panel('Pagos registrados sin movimiento bancario', tableWrap(['Fecha', 'Crédito', { t: 'Monto' }, 'Medio', 'Referencia'], r.pagos_sin_conciliar.map(p => [fD(p.fecha), esc(p.folio), { num: m$(p.monto) }, esc(p.medio), esc(p.referencia || '—')])), el('div', { class: 'req-note' }, 'Importa el estado de cuenta del banco: si la referencia y el monto coinciden, se concilian solos.')));
}
function dlgImportarBanco() {
  const b = el('div', {}), f = inp({ type: 'file', accept: '.xlsx,.xls,.csv' });
  b.append(nota('', 'Columnas: <b>fecha, descripción, referencia, monto</b> (abonos en positivo; los cargos se omiten). Los abonos cuya referencia y monto coinciden con un pago registrado se concilian solos; los repetidos no se vuelven a cargar.'), campo('Estado de cuenta (.xlsx o .csv)', f));
  dlg('Importar estado de cuenta', b, 'Importar', async () => { if (!f.files[0]) throw new Error('Elige el archivo.'); const fd = new FormData(); fd.append('archivo', f.files[0]); const r = await withBusy('Importando…', () => call('POST', '/conciliacion/importar', fd)); closeModal(); toast(`${r.importados} abono(s) nuevos · ${r.conciliados} conciliado(s) solos · ${r.repetidos} repetido(s)`, 'ok'); render(); });
}
function dlgMovimiento(m) {
  const b = el('div', {}), q = inp({ placeholder: 'Buscar crédito por folio o acreditado', value: m.sugerido ? m.sugerido.folio : '' }), sel = el('select', { size: 5, style: 'width:100%' });
  const buscar = async () => { const r = await call('GET', '/creditos?estado=vigente&q=' + encodeURIComponent(q.value)); sel.innerHTML = ''; r.filas.forEach(c => sel.append(el('option', { value: c.id }, `${c.folio} · ${c.nombre} · saldo ${m$(c.saldo)}`))); if (r.filas.length) sel.selectedIndex = 0; };
  let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(buscar, 300); }); buscar();
  b.append(nota('', `Se registra un pago de <b>${m$(m.monto)}</b> con fecha ${fD(m.fecha)} y referencia «${esc(m.referencia || 'MOV-' + m.id)}» al crédito que elijas.`), campo('Crédito', q), sel);
  dlg('Registrar pago desde el movimiento', b, 'Registrar pago', async () => { if (!sel.value) throw new Error('Elige el crédito.'); const r = await call('POST', `/conciliacion/${m.id}/pago`, { credito_id: Number(sel.value) }); closeModal(); toast(r.liquidado ? 'Pago registrado · crédito liquidado' : 'Pago registrado y conciliado', 'ok'); render(); });
}

/* ============================ FONDEO ============================ */
async function vFondeo(v) {
  await base();
  if (puede('fondeo')) $('#pageAction').append(el('button', { class: 'btn', onclick: () => formFondeo() }, '+ Nueva línea'));
  const fs = await call('GET', '/fondeos'); v.innerHTML = '';
  const tot = fs.filter(f => f.estado === 'vigente').reduce((s, f) => ({ linea: s.linea + f.monto_linea, col: s.col + f.colocado, disp: s.disp + f.disponible, deuda: s.deuda + f.deuda }), { linea: 0, col: 0, disp: 0, deuda: 0 });
  v.append(cards([['Líneas vigentes', m$(tot.linea)], ['Colocado', m$(tot.col), 'saldo de capital de créditos con fondeo'], ['Disponible', m$(tot.disp)], ['Deuda de fondeo', m$(tot.deuda), 'dispuesto − pagos de capital']]));
  v.append(panel('Líneas y fuentes de fondeo', tableWrap(['Fuente', 'Tipo', { t: 'Línea' }, { t: 'Colocado' }, { t: 'Disponible' }, { t: 'Deuda' }, 'Vence', 'Estado'], fs.map(f => { const r = [esc(f.nombre) + (f.es_ejemplo ? ' ' + badge('neutral', 'ejemplo') : '') + `<small class="muted" style="display:block">${pc(f.tasa_anual)} · ${f.revolvente ? 'revolvente' : 'no revolvente'}</small>`, esc(f.tipo.replace('_', ' ')), { num: m$(f.monto_linea) }, { num: m$(f.colocado) }, { num: m$(f.disponible) }, { num: m$(f.deuda) }, f.fecha_vencimiento ? fD(f.fecha_vencimiento) : '—', badge(f.estado === 'vigente' ? 'ok' : 'neutral', f.estado)]; r._onclick = () => dlgFondeo(f); return r; }), { empty: 'Aún no hay líneas de fondeo.' })));
}
function formFondeo(f) {
  const ed = !!f, F = f || { tipo: 'institucional', revolvente: true, estado: 'vigente', tasa_anual: 0 }, b = el('div', {});
  const nom = inp({ value: F.nombre || '' }), tipo = select([['institucional', 'Institucional'], ['friends_family', 'Friends & family'], ['capital_propio', 'Capital propio'], ['otro', 'Otro']], F.tipo), lin = inp({ type: 'number', step: '0.01', value: F.monto_linea || '' }), tas = inp({ type: 'number', step: '0.01', value: +(F.tasa_anual * 100).toFixed(4) }), rev = inp({ type: 'checkbox' }), fi = inp({ type: 'date', value: F.fecha_inicio || '' }), fv = inp({ type: 'date', value: F.fecha_vencimiento || '' }), est = select([['vigente', 'Vigente'], ['liquidado', 'Liquidado'], ['cancelado', 'Cancelado']], F.estado), nt = inp({ value: F.notas || '' });
  rev.checked = F.revolvente !== false;
  b.append(el('div', { class: 'form-grid' }, campo('Nombre', nom), campo('Tipo', tipo), campo('Monto de la línea', lin), campo('Tasa anual (%)', tas), campo('Inicio', fi), campo('Vencimiento', fv), campo('Estado', est), campo('Notas', nt)), el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px' }, rev, 'Revolvente: lo que se repaga vuelve a estar disponible'));
  dlg(ed ? 'Editar línea' : 'Nueva línea de fondeo', b, 'Guardar', async () => { const body = { nombre: nom.value, tipo: tipo.value, monto_linea: num(lin), tasa_anual: num(tas) == null ? 0 : num(tas) / 100, revolvente: rev.checked, fecha_inicio: fi.value || null, fecha_vencimiento: fv.value || null, estado: est.value, notas: nt.value }; ed ? await call('PUT', '/fondeos/' + F.id, body) : await call('POST', '/fondeos', body); closeModal(); toast('Línea guardada', 'ok'); render(); }, true);
}
async function dlgFondeo(f) {
  const r = await call('GET', `/fondeos/${f.id}/movimientos`), b = el('div', {});
  b.append(el('div', { class: 'form-grid' }, kv('Línea', m$(f.monto_linea)), kv('Dispuesto', m$(f.dispuesto)), kv('Pagado de capital', m$(f.pagado_capital)), kv('Pagado de interés', m$(f.pagado_interes)), kv('Deuda', m$(f.deuda)), kv('Colocado en créditos', m$(f.colocado))));
  if (Math.abs(f.descalce) > 0.01) b.append(nota('warn', `Descalce de ${m$(Math.abs(f.descalce))}: la deuda de fondeo ${f.descalce > 0 ? 'supera' : 'es menor que'} lo colocado.`));
  b.append(tableWrap(['Fecha', 'Tipo', { t: 'Monto' }, 'Referencia', 'Registró'], r.movimientos.map(m => [fD(m.fecha), esc(m.tipo.replace('_', ' ')), { num: m$(m.monto) }, esc(m.referencia || '—'), esc(m.registrado_por || '')]), { empty: 'Sin movimientos.' }));
  if (r.creditos.length) b.append(el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, 'Créditos con esta línea: ' + r.creditos.map(c => c.folio).join(', ')));
  const pie = el('div', {}); pie.append(el('button', { class: 'btn ghost', onclick: closeModal }, 'Cerrar'));
  if (puede('fondeo')) { pie.append(el('button', { class: 'btn secondary', onclick: () => formFondeo(f) }, 'Editar línea'), el('button', { class: 'btn', onclick: () => formMovFondeo(f) }, '+ Movimiento')); }
  modal(f.nombre, b, pie, true);
}
function formMovFondeo(f) {
  const b = el('div', {}), tipo = select([['disposicion', 'Disposición'], ['pago_capital', 'Pago de capital'], ['pago_interes', 'Pago de interés'], ['comision', 'Comisión']], 'disposicion'), mon = inp({ type: 'number', step: '0.01', min: '0.01' }), fec = inp({ type: 'date', value: hoy(), max: hoy() }), ref = inp({ placeholder: 'Referencia' }), com = inp({ placeholder: 'Comentario' });
  b.append(el('div', { class: 'form-grid' }, campo('Tipo', tipo), campo('Monto', mon), campo('Fecha', fec), campo('Referencia', ref)), campo('Comentario', com));
  dlg('Movimiento de fondeo', b, 'Registrar', async () => { await call('POST', `/fondeos/${f.id}/movimientos`, { tipo: tipo.value, monto: num(mon), fecha: fec.value, referencia: ref.value, comentario: com.value }); closeModal(); toast('Movimiento registrado', 'ok'); render(); });
}

/* ============================ CONTABILIDAD ============================ */
async function vContab(v) {
  await base();
  const ps = await call('GET', '/contabilidad/periodos'); v.innerHTML = '';
  const ultCerrado = ps.filter(p => p.estado === 'cerrado').map(p => p.periodo).sort().pop();
  try { v.append(await panelIngresos()); } catch (e) { v.append(nota('err', esc(errMsg(e)))); }
  v.append(nota('', 'Las pólizas se generan solas desde los desembolsos, pagos y saldos; no se capturan a mano. Los periodos se cierran en orden y un periodo cerrado no admite pagos ni desembolsos con fecha dentro de él. Criterios simplificados: el contador los valida antes de usarlos como contabilidad oficial.'));
  v.append(panel('Periodos', tableWrap(['Periodo', 'Estado', { t: 'Pólizas' }, { t: 'Cartera' }, { t: 'Vencida' }, { t: 'Estimación' }, 'Cerró', ''], ps.map(p => {
    const acc = el('span', { style: 'display:inline-flex;gap:6px;flex-wrap:wrap' }), r = p.resumen;
    acc.append(el('button', { class: 'btn secondary sm', onclick: () => verPolizas(p.periodo) }, p.estado === 'cerrado' ? 'Ver pólizas' : 'Vista previa'));
    if (p.estado === 'abierto' && !p.en_curso && puede('contabilidad')) acc.append(el('button', { class: 'btn sm', onclick: async () => { if (await confirmar(`¿Cerrar el periodo ${p.periodo}? Se generan sus pólizas y ya no se podrán registrar pagos ni desembolsos con fecha en él.`, { ok: 'Cerrar periodo', titulo: 'Cerrar periodo' })) { try { const x = await withBusy('Generando pólizas…', () => call('POST', `/contabilidad/periodos/${p.periodo}/cerrar`)); toast(`Periodo cerrado: ${x.polizas} póliza(s)`, 'ok'); render(); } catch (e) { falla(e); } } } }, 'Cerrar'));
    if (p.estado === 'cerrado' && p.periodo === ultCerrado && puede('administrar')) acc.append(el('button', { class: 'btn ghost sm', onclick: () => dlgTexto('Reabrir periodo', `Se borran las pólizas de ${p.periodo} y el periodo vuelve a abrirse. Queda en la bitácora.`, 'Reabrir', 20, 'Motivo', async t => { await call('POST', `/contabilidad/periodos/${p.periodo}/reabrir`, { comentario: t }); closeModal(); toast('Periodo reabierto', 'ok'); render(); }, true) }, 'Reabrir'));
    return [`<b>${esc(p.periodo)}</b>${p.en_curso ? ' ' + badge('info', 'en curso') : ''}`, p.estado === 'cerrado' ? badge('ok', 'Cerrado') : badge('warn', 'Abierto'), { num: String(p.polizas) }, { num: r ? m$(r.capital) : '—' }, { num: r ? m$(r.vencida_saldo) : '—' }, { num: r ? m$(r.estimacion) : '—' }, p.cerrado_por ? `${esc(p.cerrado_por)}<small class="muted" style="display:block">${fF(p.cerrado_at)}</small>` : '—', acc];
  }), { empty: 'Aún no hay desembolsos: el primer periodo aparece al desembolsar el primer crédito.' })));
}
async function verPolizas(periodo) {
  const r = await call('GET', '/contabilidad/polizas?periodo=' + periodo), nom = new Map(r.cuentas.map(c => [c.clave, c.nombre])), b = el('div', {});
  b.append(nota(r.vista_previa ? 'warn' : 'ok', r.vista_previa ? 'Vista previa: el periodo sigue abierto y estas pólizas aún no están guardadas.' : 'Periodo cerrado: pólizas guardadas.'), cards([['Debe', m$(r.totales.debe)], ['Haber', m$(r.totales.haber)], ['Pólizas', r.polizas.length]]));
  b.append(tableWrap(['Fecha', 'Tipo', 'Concepto', 'Cuenta', { t: 'Debe' }, { t: 'Haber' }], r.polizas.flatMap(p => p.lineas.map((l, i) => [i === 0 ? fD(p.fecha) : '', i === 0 ? esc(p.tipo) : '', i === 0 ? esc(p.concepto) : '', `${esc(l.cuenta)} ${esc(nom.get(l.cuenta) || '')}`, { num: l.debe ? m$(l.debe) : '' }, { num: l.haber ? m$(l.haber) : '' }])), { empty: 'Sin movimientos en el periodo.' }));
  const pie = el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Cerrar'), el('button', { class: 'btn secondary', onclick: async () => { const bal = await call('GET', '/contabilidad/balanza?periodo=' + periodo); modal('Balanza al ' + periodo, (() => { const n = el('div', {}); n.append(nota(bal.cuadra ? 'ok' : 'err', bal.cuadra ? 'La balanza cuadra.' : 'La balanza NO cuadra.'), tableWrap(['Cuenta', 'Naturaleza', { t: 'Debe' }, { t: 'Haber' }, { t: 'Saldo' }], bal.cuentas.map(c => [esc(c.clave + ' ' + c.nombre), esc(c.naturaleza), { num: m$(c.debe) }, { num: m$(c.haber) }, { num: m$(c.saldo) }]))); return n; })(), el('div', {}, el('button', { class: 'btn', onclick: closeModal }, 'Cerrar')), true); } }, 'Balanza'), el('button', { class: 'btn', onclick: () => bajar('/api/cartera/mc/contabilidad/polizas.csv?periodo=' + periodo, `polizas_${periodo}.csv`) }, '⬇ CSV'));
  modal('Pólizas · ' + periodo, b, pie, true);
}


/* ---------- ingresos por facturar: comisiones por apertura e intereses cobrados, corte semanal a contabilidad ---------- */
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
async function panelIngresos() {
  const r = await call('GET', '/contabilidad/ingresos'), T = r.pendiente.totales, p = panel('Ingresos por facturar · comisiones por apertura e intereses cobrados');
  const e = r.envio;
  p.append(nota(e.activo && e.destinatarios && e.correo ? '' : 'warn', `Lo cobrado (comisiones por apertura al desembolsar; intereses ordinarios y moratorios al recibir cada pago), con IVA, para <b>facturar como ingreso</b>. Cada cobro entra a un solo corte y se manda a contabilidad por correo <b>${e.activo ? 'automáticamente cada ' + DIAS[e.dia_semana] : 'solo cuando lo envíes tú (el envío automático está apagado)'}</b>.`
    + (!e.destinatarios ? ' <b>Falta agregar al menos un destinatario «Para».</b>' : ` Destinatarios: <b>${e.destinatarios}</b>.`) + (!e.correo ? ' <b>El correo no está configurado en este servidor.</b>' : '')));
  p.append(cards([['Comisiones por apertura', m$(T.comision_apertura.total), `base ${m$(T.comision_apertura.base)} + IVA ${m$(T.comision_apertura.iva)}`], ['Intereses ordinarios', m$(T.interes.total), `base ${m$(T.interes.base)} + IVA ${m$(T.interes.iva)}`], ['Intereses moratorios', m$(T.moratorio.total), `base ${m$(T.moratorio.base)} + IVA ${m$(T.moratorio.iva)}`], ['Total por facturar', m$(T.total), `${T.movimientos} cobro(s) · ${T.acreditados} acreditado(s)`]]));
  if (T.ajuste.total) p.append(nota('warn', `Hay ajustes por pagos cancelados: <b>${m$(T.ajuste.total)}</b> (nota de crédito) que entran a este corte.`));
  if (T.sin_rfc) p.append(nota('warn', `<b>${T.sin_rfc}</b> acreditado(s) sin RFC válido: no se les puede facturar hasta tener sus datos fiscales.`));
  p.append(tableWrap(['Razón social (a quien se factura)', 'RFC', { t: 'Comisión apertura' }, { t: 'Intereses' }, { t: 'Moratorios' }, { t: 'Base' }, { t: 'IVA' }, { t: 'Total' }], r.pendiente.resumen.map(x => [`<b>${esc(x.razon_social)}</b><small class="muted" style="display:block">${esc(x.creditos.join(', '))}</small>`, x.falta.length ? badge('danger', 'Falta ' + x.falta.join(' / ')) : esc(x.rfc), { num: m$(x.comision_apertura.base + x.comision_apertura.iva) }, { num: m$(x.interes.base + x.interes.iva) }, { num: m$(x.moratorio.base + x.moratorio.iva) }, { num: m$(x.base) }, { num: m$(x.iva) }, { num: `<b>${m$(x.total)}</b>` }]), { empty: 'Nada por facturar: todo lo cobrado ya entró a un corte.' }));
  const bar = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:12px 0' });
  if (r.puede) {
    const hacer = enviar => async () => { if (!T.movimientos) return toast('No hay cobros nuevos por cortar', 'err'); if (!await confirmar(`¿Hacer el corte de ${m$(T.total)} (${T.movimientos} cobros)?${enviar ? ' Se enviará por correo a contabilidad.' : ''}`, { ok: enviar ? 'Hacer corte y enviar' : 'Hacer corte', titulo: 'Corte de ingresos por facturar' })) return; try { const x = await withBusy('Haciendo el corte…', () => call('POST', '/contabilidad/ingresos/cortes', { enviar })); toast(x.envio && x.envio.ok ? `Corte #${x.id} hecho y enviado a ${x.envio.destinatarios} destinatario(s)` : x.envio && x.envio.mensaje ? `Corte #${x.id} hecho; no se envió: ${x.envio.mensaje}` : `Corte #${x.id} hecho`, x.envio && x.envio.error ? 'err' : 'ok'); render(); } catch (er) { falla(er); } };
    bar.append(el('button', { class: 'btn', onclick: hacer(true) }, 'Hacer corte y enviar'), el('button', { class: 'btn secondary', onclick: hacer(false) }, 'Hacer corte sin enviar'), el('button', { class: 'btn secondary', onclick: dlgDestinatarios }, 'Destinatarios del correo'), el('button', { class: 'btn secondary', onclick: () => dlgEnvio(e) }, 'Programación del envío'));
  }
  p.append(bar);
  p.append(el('h4', { style: 'margin:16px 0 8px' }, 'Cortes anteriores'), tableWrap(['Corte', 'Hecho', 'Cobros hasta', 'Origen', { t: 'Base' }, { t: 'IVA' }, { t: 'Total' }, 'Estado', ''], r.cortes.map(c => {
    const acc = el('span', { style: 'display:inline-flex;gap:6px;flex-wrap:wrap' });
    acc.append(el('button', { class: 'btn secondary sm', onclick: () => verCorteIng(c.id) }, 'Ver'), el('button', { class: 'btn secondary sm', onclick: () => bajar(`/api/cartera/mc/contabilidad/ingresos/cortes/${c.id}/excel`, `ingresos_por_facturar_${c.fecha_corte}_${c.id}.xlsx`) }, 'Excel'));
    if (r.puede) { acc.append(el('button', { class: 'btn sm', onclick: async () => { try { const x = await withBusy('Enviando…', () => call('POST', `/contabilidad/ingresos/cortes/${c.id}/enviar`)); toast(`Enviado a ${x.destinatarios} destinatario(s)`, 'ok'); render(); } catch (er) { falla(er); } } }, c.estado === 'ENVIADO' ? 'Reenviar' : 'Enviar'));
      if (c.estado !== 'ENVIADO') acc.append(el('button', { class: 'btn ghost sm', onclick: async () => { if (await confirmar(`¿Deshacer el corte #${c.id}? Sus cobros vuelven a quedar por cortar.`, { ok: 'Deshacer', titulo: 'Deshacer corte' })) { try { await call('DELETE', `/contabilidad/ingresos/cortes/${c.id}`); toast('Corte deshecho', 'ok'); render(); } catch (er) { falla(er); } } } }, 'Deshacer')); }
    return [`<b>#${c.id}</b>${c.es_ejemplo ? ' ' + badge('neutral', 'ejemplo') : ''}`, fD(c.fecha_corte), fD(c.hasta), badge(c.origen === 'AUTOMATICO' ? 'info' : 'neutral', c.origen === 'AUTOMATICO' ? 'Automático' : 'Manual'), { num: m$(c.totales.base) }, { num: m$(c.totales.iva) }, { num: `<b>${m$(c.totales.total)}</b>` }, c.estado === 'ENVIADO' ? badge('ok', 'Enviado') + `<small class="muted" style="display:block">${fF(c.enviado_at)}</small>` : badge('warn', 'Sin enviar'), acc];
  }), { empty: 'Aún no hay cortes.' }));
  return p;
}
async function verCorteIng(id) {
  const c = await call('GET', '/contabilidad/ingresos/cortes/' + id), T = c.totales, b = el('div', {});
  b.append(cards([['Comisiones por apertura', m$(T.comision_apertura.total)], ['Intereses ordinarios', m$(T.interes.total)], ['Intereses moratorios', m$(T.moratorio.total)], ['Total a facturar', m$(T.total), `base ${m$(T.base)} + IVA ${m$(T.iva)}`]]));
  b.append(tableWrap(['Razón social', 'RFC', { t: 'Base' }, { t: 'IVA' }, { t: 'Total' }], c.resumen.map(x => [esc(x.razon_social), x.rfc ? esc(x.rfc) : badge('danger', 'Sin RFC'), { num: m$(x.base) }, { num: m$(x.iva) }, { num: `<b>${m$(x.total)}</b>` }])));
  b.append(el('h4', { style: 'margin:14px 0 8px' }, 'Detalle de cada cobro'), tableWrap(['Fecha', 'Crédito', 'Acreditado', 'Concepto', { t: 'Base' }, { t: 'IVA' }], c.detalle.map(d => [fD(d.fecha), esc(d.folio), esc(d.acreditado), esc(({ comision_apertura: 'Comisión por apertura', interes: 'Intereses ordinarios', moratorio: 'Intereses moratorios', ajuste: 'Ajuste por pago cancelado' })[d.tipo]) + (d.nota ? `<small class="muted" style="display:block">${esc(d.nota)}</small>` : ''), { num: m$(d.base) }, { num: m$(d.iva) }])));
  modal(`Corte de ingresos #${c.id}`, b, el('div', {}, el('button', { class: 'btn ghost', onclick: closeModal }, 'Cerrar'), el('button', { class: 'btn', onclick: () => bajar(`/api/cartera/mc/contabilidad/ingresos/cortes/${c.id}/excel`, `ingresos_por_facturar_${c.fecha_corte}_${c.id}.xlsx`) }, '⬇ Excel')), true);
}
async function dlgDestinatarios() {
  const lista = await call('GET', '/contabilidad/ingresos/destinatarios'), b = el('div', {});
  const em = inp({ type: 'email', placeholder: 'correo@empresa.com' }), nm = inp({ placeholder: 'Nombre (opcional)' }), tp = select([['to', 'Para'], ['cc', 'Copia (CC)'], ['bcc', 'Copia oculta (BCC)']], 'to');
  b.append(nota('', 'Reciben el correo del corte de ingresos por facturar, con el Excel adjunto.'), tableWrap(['Correo', 'Nombre', 'Tipo', ''], lista.map(d => [esc(d.email || '—'), esc(d.nombre || ''), esc({ to: 'Para', cc: 'CC', bcc: 'BCC' }[d.tipo]), el('button', { class: 'btn ghost sm', onclick: async () => { try { await call('DELETE', '/contabilidad/ingresos/destinatarios/' + d.id); closeModal(); dlgDestinatarios(); render(); } catch (er) { falla(er); } } }, 'Quitar')]), { empty: 'Aún no hay destinatarios.' }),
    el('h4', { style: 'margin:14px 0 8px' }, 'Agregar'), el('div', { class: 'form-grid' }, campo('Correo', em), campo('Nombre', nm), campo('Tipo', tp)));
  dlg('Destinatarios del correo de contabilidad', b, 'Agregar', async () => { await call('POST', '/contabilidad/ingresos/destinatarios', { email: em.value, nombre: nm.value, tipo: tp.value }); closeModal(); toast('Destinatario guardado', 'ok'); dlgDestinatarios(); render(); }, true);
}
function dlgEnvio(e) {
  const act = inp({ type: 'checkbox' }); act.checked = !!e.activo; const dia = select(DIAS.map((d, i) => [i, d]), e.dia_semana), b = el('div', {});
  b.append(nota('', 'El día elegido el sistema hace el corte de todo lo cobrado hasta el día anterior y lo manda a contabilidad. Si ese día no hubo cobros nuevos, no manda nada. Si el correo falla, lo reintenta cada hora el mismo día.'), el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:12px' }, act, 'Enviar automáticamente cada semana'), campo('Día de la semana', dia));
  dlg('Programación del envío semanal', b, 'Guardar', async () => { await call('PUT', '/contabilidad/ingresos/envio', { envio_activo: act.checked, dia_semana: Number(dia.value) }); closeModal(); toast('Programación guardada', 'ok'); render(); });
}

/* ============================ REPORTES ============================ */
async function vReportes(v) {
  await base();
  const R = S2.rep; if (!R.fecha) { R.fecha = hoy(); R.hasta = hoy(); R.desde = hoy().slice(0, 8) + '01'; }
  v.innerHTML = '';
  const fecha = inp({ type: 'date', value: R.fecha, max: hoy() }), cuerpo = el('div', {});
  const pintar = async () => {
    R.fecha = fecha.value || hoy(); const r = await call('GET', '/reportes/cartera?fecha=' + R.fecha), s = r.resumen; cuerpo.innerHTML = '';
    cuerpo.append(cards([['Cartera', m$(s.capital), `${s.creditos} crédito(s)`], ['Cartera vencida', m$(s.vencida), `desde ${s.dias_vencida} días`], ['IMOR', (s.imor * 100).toFixed(2) + '%'], ['Estimación', m$(s.estimacion), 'ICOR ' + (s.icor * 100).toFixed(2) + '%']]),
      tableWrap(['Tramo', { t: 'Créditos' }, { t: 'Saldo de capital' }, { t: 'Vencido' }, { t: 'Estimación' }], Object.entries(s.buckets).map(([k, x]) => [chipBuck(k), { num: String(x.n) }, { num: m$(x.capital) }, { num: m$(x.vencido) }, { num: m$(x.estimacion) }])),
      el('div', { style: 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap' }, el('button', { class: 'btn secondary sm', onclick: () => bajar('/api/cartera/mc/reportes/cartera.csv?fecha=' + R.fecha, `cartera_${R.fecha}.csv`) }, '⬇ Cartera (CSV)'), el('button', { class: 'btn secondary sm', onclick: () => bajar('/api/cartera/mc/reportes/buro.csv?fecha=' + R.fecha, `borrador_buro_${R.fecha}.csv`) }, '⬇ Borrador para buró (CSV)')),
      el('div', { class: 'req-note', style: 'margin-top:8px' }, 'El archivo para buró es un borrador con los datos del crédito y una clave MOP aproximada: hay que ajustarlo al layout de intercambio de la sociedad de información crediticia contratada.'));
  };
  fecha.addEventListener('change', pintar);
  const p1 = panel('Cartera y morosidad'); p1.append(el('div', { class: 'filters' }, campo('Al día', fecha)), cuerpo); v.append(p1); pintar();
  const d1 = inp({ type: 'date', value: R.desde }), d2 = inp({ type: 'date', value: R.hasta, max: hoy() }), cm = el('div', {});
  const pintarC = async () => { R.desde = d1.value; R.hasta = d2.value; const r = await call('GET', `/reportes/comisiones?desde=${R.desde}&hasta=${R.hasta}`); cm.innerHTML = ''; cm.append(tableWrap(['Fecha', 'Crédito', 'Concepto', { t: 'Base' }, { t: 'IVA' }, { t: 'Total' }], [...r.filas.map(f => [fD(f.fecha), esc(f.folio), esc(f.concepto), { num: m$(f.base) }, { num: m$(f.iva) }, { num: m$(f.total) }]), ['', '', '<b>Total</b>', { num: `<b>${m$(r.totales.base)}</b>` }, { num: `<b>${m$(r.totales.iva)}</b>` }, { num: `<b>${m$(r.totales.total)}</b>` }]], { empty: 'Sin comisiones en el rango.' }), el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn secondary sm', onclick: () => bajar(`/api/cartera/mc/reportes/comisiones?desde=${R.desde}&hasta=${R.hasta}&csv=1`, `comisiones_${R.desde}_${R.hasta}.csv`) }, '⬇ Comisiones (CSV)'))); };
  [d1, d2].forEach(x => x.addEventListener('change', pintarC));
  const p2 = panel('Comisiones cobradas (apertura y moratorios)'); p2.append(el('div', { class: 'filters' }, campo('Desde', d1), campo('Hasta', d2)), cm); v.append(p2); pintarC();
}

/* ============================ UIF ============================ */
async function vUif(v) {
  await base();
  const F = S2.uif; const r = await call('GET', `/uif?estado=${F.estado}&pag=${F.pag}`); v.innerHTML = '';
  if (r.puede_dictaminar) $('#pageAction').append(el('button', { class: 'btn secondary', onclick: async () => { try { const x = await withBusy('Revisando pagos…', () => call('POST', '/uif/detectar')); toast(`${x.nuevas} operación(es) nuevas`, 'ok'); render(); } catch (e) { falla(e); } } }, 'Revisar pagos'), el('button', { class: 'btn ghost', onclick: () => bajar('/api/cartera/mc/uif.csv', 'uif.csv') }, '⬇ CSV'));
  const por = Object.fromEntries(r.resumen.map(x => [x.estado, x.n]));
  v.append(nota('', 'El sistema detecta pagos en efectivo relevantes, posibles fraccionamientos, pagos de terceros y liquidaciones anticipadas, y lleva el dictamen y el folio de acuse. <b>No presenta avisos</b>: se presentan en el portal de la autoridad con el archivo exportado.'));
  v.append(cards([['Por dictaminar', por.detectada || 0], ['Por reportar', por.reportar || 0], ['Reportadas', por.reportada || 0], ['No se reportan', por.no_reportar || 0]]));
  const fe = select([['', 'Todas'], ['detectada', 'Por dictaminar'], ['reportar', 'Por reportar'], ['reportada', 'Reportadas'], ['no_reportar', 'No se reportan']], F.estado); fe.addEventListener('change', () => { F.estado = fe.value; F.pag = 0; render(); });
  const TIPO = { relevante: ['warn', 'Relevante'], inusual: ['danger', 'Inusual'], interna_preocupante: ['danger', 'Interna preocupante'] }, EST = { detectada: ['warn', 'Por dictaminar'], reportar: ['info', 'Por reportar'], reportada: ['ok', 'Reportada'], no_reportar: ['neutral', 'No se reporta'] };
  v.append(panel('Operaciones relevantes e inusuales', el('div', { class: 'filters' }, fe), tableWrap(['Fecha', 'Tipo', 'Crédito', 'Descripción', { t: 'Monto' }, 'Estado', ''], r.filas.map(u => {
    const acc = el('span', { style: 'display:inline-flex;gap:6px' });
    if (r.puede_dictaminar && u.estado === 'detectada') acc.append(el('button', { class: 'btn sm', onclick: () => dlgDictamen(u) }, 'Dictaminar'));
    if (r.puede_dictaminar && u.estado === 'reportar') acc.append(el('button', { class: 'btn sm', onclick: () => { const f = inp({ placeholder: 'Folio del acuse' }), b = el('div', {}); b.append(campo('Folio del acuse de la autoridad', f)); dlg('Marcar como reportada', b, 'Marcar', async () => { await call('POST', `/uif/${u.id}/reportada`, { folio_acuse: f.value }); closeModal(); toast('Operación marcada como reportada', 'ok'); render(); }); } }, 'Reportada'));
    return [fD(u.fecha), badge(...TIPO[u.tipo]) + `<small class="muted" style="display:block">${esc(u.regla.replace(/_/g, ' '))}</small>`, esc(u.folio || '—'), `<span style="font-size:13px">${esc(u.descripcion || '')}</span>${u.dictamen ? `<small class="muted" style="display:block">Dictamen: ${esc(u.dictamen)} (${esc(u.dictaminado_por || '')})</small>` : ''}`, { num: u.monto == null ? '' : m$(u.monto) }, badge(...EST[u.estado]) + (u.folio_acuse ? `<small class="muted" style="display:block">${esc(u.folio_acuse)}</small>` : ''), acc];
  }), { empty: 'Sin operaciones en esta lista.' }), pager(r.total, r.pag, r.por_pag, n => { F.pag = n; render(); })));
}
function dlgDictamen(u) {
  const est = select([['reportar', 'Se reporta a la autoridad'], ['no_reportar', 'No se reporta']], 'reportar'), t = textarea({ placeholder: 'Fundamento del dictamen' }), b = el('div', {});
  b.append(nota('', esc(u.descripcion || '')), campo('Dictamen', est), campo('Fundamento (mínimo 20 caracteres)', t));
  dlg('Dictaminar operación', b, 'Guardar dictamen', async () => { await call('POST', `/uif/${u.id}/dictamen`, { estado: est.value, dictamen: t.value }); closeModal(); toast('Dictamen guardado', 'ok'); render(); });
}

/* ---------- registro ---------- */
window.MCUI.abrirCred = abrirCred;
Object.assign(window.CARTERA_VISTAS, { mc_creditos: vCreditos, mc_cobranza: vCobranza, mc_conciliacion: vConciliacion, mc_fondeo: vFondeo, mc_contab: vContab, mc_reportes: vReportes, mc_uif: vUif });
Object.assign(window.CARTERA_TITULOS, {
  mc_creditos: ['Créditos', 'Formalización, desembolso, pagos y estado de cada crédito'],
  mc_cobranza: ['Cobranza', 'Cartera con atraso por tramo, gestiones y promesas de pago'],
  mc_conciliacion: ['Conciliación bancaria', 'Abonos del banco contra los pagos registrados'],
  mc_fondeo: ['Fondeo', 'Líneas, disposiciones, colocación y disponible'],
  mc_contab: ['Contabilidad', 'Pólizas automáticas, cierre de periodo y balanza'],
  mc_reportes: ['Reportes', 'Cartera y morosidad, borrador para buró y comisiones cobradas'],
  mc_uif: ['UIF · operaciones', 'Operaciones relevantes e inusuales: detección, dictamen y control del reporte'],
});
})();
