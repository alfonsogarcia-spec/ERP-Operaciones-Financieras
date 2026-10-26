/* ============================================================================
   lib/cards-correo.js — Avisos por correo del flujo de fondeos de Cards (BSO). Función pura: devuelve { subject, html, text }.
     solicitado → a los destinatarios configurados: alguien registró una solicitud (el solicitante es quien tenía la sesión abierta).
     por_asignar → a tesorería: el comercial cargó el CEP, falta confirmar que el saldo se asignó.
     asignado / rechazado / cancelado → al comercial que solicitó.
   Los avisos que ya tienen CEP lo llevan adjunto y muestran su validación (lo que dice el CEP contra lo registrado).
   ========================================================================= */
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mxn = n => n == null ? '—' : Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const fechaMx = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; };

const FORMATO = { cep_banxico: 'CEP de Banxico', xml: 'CEP en XML', dispersion_polipay: 'Comprobante de dispersión de Polipay' };
const CONFIANZA = { alta: 'alta', media: 'media', baja: 'baja' };
const valor = (campo, v) => v == null || v === '' ? '—' : campo === 'monto' ? mxn(v) : campo === 'fecha' ? fechaMx(v) : String(v);

const TIPOS = {
  solicitado: { titulo: 'Nueva solicitud de fondeo', color: '#1166DB', asunto: 'Nueva solicitud',
    intro: f => `${f.solicitante_nombre || 'Un usuario'} registró una solicitud de fondeo para ${f.empresa_nombre || f.ruta}. La empresa debe depositar ${mxn(f.monto_esperado)}; cuando lo haga se sube su CEP y tesorería recibe el aviso para asignar el saldo.` },
  por_asignar: { titulo: 'Fondeo por asignar', color: '#B45309', asunto: 'Por asignar',
    intro: f => `${f.cep_subido_por || f.solicitante_nombre || 'Un comercial'} cargó el CEP de este fondeo (va adjunto, con el resultado de su validación). Revisa el depósito y confirma en el sistema que el saldo se asignó.` },
  asignado: { titulo: 'Saldo asignado', color: '#187A46', asunto: 'Saldo asignado',
    intro: (f, comp) => 'Tesorería confirmó que el saldo de este fondeo ya se asignó.' + (comp ? ' Va adjunto el comprobante del sistema.' : '') },
  rechazado: { titulo: 'Fondeo rechazado por tesorería', color: '#A81D31', asunto: 'Rechazado',
    intro: () => 'Tesorería no pudo asignar este fondeo. Revisa el motivo, quita el CEP y sube el correcto (o cancela la solicitud).' },
  cancelado: { titulo: 'Solicitud cancelada', color: '#5A647C', asunto: 'Cancelada',
    intro: () => 'Esta solicitud de fondeo se canceló.' },
};

function armarCorreoFondeo({ tipo, fondeo: f, avisos, motivo, nota, appUrl, logoSrc, ceps, comprobantes }) {
  const t = TIPOS[tipo];
  if (!t) throw new Error('tipo_correo_desconocido');
  const url = (appUrl || 'https://polipay-conciliacion-liquidacion.onrender.com').replace(/\/$/, '');
  const total = f.monto_recibido != null ? f.monto_recibido : f.monto_esperado;
  const pct = n => n == null ? '' : ` (${Number(n)}%)`;
  const filas = tipo === 'solicitado' ? [
    ['Folio', f.folio],
    ['Solicitó', (f.solicitante_nombre || '—') + (f.solicitante_email ? ' · ' + f.solicitante_email : '')],
    ['Empresa / destino', f.ruta || f.empresa_nombre],
    ['Beneficiario', f.beneficiario_destino || '—'], ['Banco', f.banco_destino || '—'], ['CLABE', f.clabe_destino || '—'],
    ['Fondeo (neto)', mxn(f.fondeo)], ['Comisión' + pct(f.comision_pct), mxn(f.comision)], ['IVA' + pct(f.iva_pct), mxn(f.iva)],
    ['La empresa debe depositar', mxn(f.monto_esperado), true],
    ...(f.notas ? [['Notas', f.notas]] : []),
  ] : [
    ['Folio', f.folio], ['Destino', f.ruta], ['Fondeo (neto)', mxn(f.fondeo)], ['Comisión', mxn(f.comision)], ['IVA', mxn(f.iva)],
    [f.monto_recibido != null ? 'Total recibido' : 'Total a depositar', mxn(total), true],
    ...(f.clave_rastreo ? [['Clave de rastreo', f.clave_rastreo]] : []), ...(f.fecha_iso || f.fecha ? [['Fecha de abono', fechaMx(f.fecha_iso || f.fecha)]] : []),
    ...(f.ordenante_nombre ? [['Ordenante', f.ordenante_nombre + (f.ordenante_rfc ? ' · ' + f.ordenante_rfc : '')]] : []),
    ...(f.solicitante_nombre ? [['Solicitó', f.solicitante_nombre]] : []),
  ];
  const extra = [...(motivo ? [['Motivo', motivo]] : []), ...(nota ? [['Nota de tesorería', nota]] : [])];
  const subject = `[Cards] ${t.asunto} · ${f.folio} · ${f.empresa_nombre || f.ruta} · ${tipo === 'solicitado' ? mxn(f.monto_esperado) + ' a depositar' : mxn(tipo === 'por_asignar' ? total : f.fondeo)}`;

  // Mismo diseño que los demás correos de MCEB (registro contable, alertas, cortes): paleta, tipografía, logo, tarjeta y pie.
  const accent = '#157BF6', muted = '#707070', line = '#E4E6E7', ink = '#04003A';
  const F = 'Montserrat,Arial,sans-serif';
  const N = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-');
  const hoy = `${N[2]}/${N[1]}/${N[0]}`;
  const saludo = ['asignado', 'rechazado', 'cancelado'].includes(tipo) && f.solicitante_nombre ? `Hola ${String(f.solicitante_nombre).split(' ')[0]},` : 'Estimados,';
  const filasHtml = [...filas, ...extra].map(([k, v, total]) => {
    return `<tr><td width="45%" style="padding:11px 14px;border-top:1px solid ${line};font:${total ? '700' : '400'} 13px/1.4 ${F};color:${total ? ink : muted}">${esc(k)}</td><td style="padding:11px 14px;border-top:1px solid ${line};font:700 ${total ? '15' : '13'}px/1.4 ${F};color:${ink}">${esc(v)}</td></tr>`;
  }).join('');
  // CEP: archivo adjunto y qué tal salió su validación. Cada renglón compara lo que dice el CEP con lo registrado.
  const verde = { bg: '#EAF7EE', borde: '#9AD3AE', tinta: '#1B6B3A' }, rojo = { bg: '#FDECEC', borde: '#F2A9A9', tinta: '#8C1D1D' };
  const bloqueCep = c => {
    const dif = (c.checks || []).filter(k => k.estado === 'difiere');
    const col = c.validado && !dif.some(k => k.duro) ? verde : rojo;
    const estado = !c.validado ? '✗ No validado por el sistema' : dif.length ? `✓ Validado como CEP · ≠ ${dif.length} diferencia${dif.length > 1 ? 's' : ''} por revisar` : '✓ Validado por el sistema · todo coincide';
    const renglones = (c.checks || []).map(k => {
      const ok = k.estado === 'ok', sin = k.estado === 'sin_dato';
      const marca = ok ? '✓' : sin ? '–' : '≠';
      const tinta = ok ? verde.tinta : sin ? muted : rojo.tinta;
      return `<tr><td style="padding:7px 10px;border-top:1px solid ${line};font:400 12px/1.4 ${F};color:${muted}">${esc(k.etiqueta)}</td><td style="padding:7px 10px;border-top:1px solid ${line};font:400 12px/1.4 ${F};color:${ink}">${esc(valor(k.campo, k.cep))}</td><td style="padding:7px 10px;border-top:1px solid ${line};font:400 12px/1.4 ${F};color:${ink}">${esc(valor(k.campo, k.capturado))}</td><td style="padding:7px 10px;border-top:1px solid ${line};font:700 12px/1.4 ${F};color:${tinta};white-space:nowrap">${marca} ${ok ? 'Coincide' : sin ? 'No viene en el CEP' : 'Difiere'}</td></tr>`;
    }).join('');
    return `<div style="margin-top:12px;border:1px solid ${line};border-radius:12px;overflow:hidden">
<div style="padding:12px 16px;font:400 13px/1.5 ${F};color:${ink}"><b>${esc(c.filename)}</b><br><span style="color:${muted}">${esc(FORMATO[c.formato] || 'Documento')}${c.confianza ? ' · lectura ' + esc(CONFIANZA[c.confianza] || c.confianza) : ''} · ${c.adjunto ? 'adjunto a este correo' : 'ábrelo en el sistema (no se adjuntó)'}${c.por ? ' · subido por ' + esc(c.por) : ''}</span></div>
<div style="background:${col.bg};border-top:1px solid ${col.borde};border-bottom:1px solid ${col.borde};padding:9px 16px;font:700 13px/1.4 ${F};color:${col.tinta}">${esc(estado)}</div>
${renglones ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse"><tr><td style="padding:7px 10px;font:700 11px/1.4 ${F};color:${muted};text-transform:uppercase;letter-spacing:.04em">Dato</td><td style="padding:7px 10px;font:700 11px/1.4 ${F};color:${muted};text-transform:uppercase;letter-spacing:.04em">Dice el CEP</td><td style="padding:7px 10px;font:700 11px/1.4 ${F};color:${muted};text-transform:uppercase;letter-spacing:.04em">Registrado</td><td style="padding:7px 10px;font:700 11px/1.4 ${F};color:${muted};text-transform:uppercase;letter-spacing:.04em">Resultado</td></tr>${renglones}</table>` : ''}</div>`;
  };
  const cepsHtml = ceps && ceps.length ? `<tr><td style="padding:24px 36px 0"><div style="font:700 13px/1.4 ${F};color:${ink}">CEP y validación</div>${ceps.map(bloqueCep).join('')}</td></tr>` : '';
  const cepsTexto = ceps && ceps.length ? '\n\nCEP y validación:\n' + ceps.map(c => `- ${c.filename} (${FORMATO[c.formato] || 'documento'}${c.adjunto ? ', adjunto' : ''}): ${c.validado ? 'validado por el sistema' : 'NO validado'}\n` + (c.checks || []).filter(k => k.estado !== 'sin_dato').map(k => `    ${k.estado === 'ok' ? '✓' : '≠'} ${k.etiqueta}: CEP ${valor(k.campo, k.cep)} · registrado ${valor(k.campo, k.capturado)}`).join('\n')).join('\n') : '';
  const compHtml = comprobantes && comprobantes.length ? `<tr><td style="padding:24px 36px 0"><div style="font:700 13px/1.4 ${F};color:${ink}">Comprobante del saldo asignado</div>${comprobantes.map(c => `<div style="margin-top:10px;border:1px solid ${line};border-radius:12px;padding:12px 16px;font:400 13px/1.5 ${F};color:${ink}"><b>${esc(c.filename)}</b><br><span style="color:${muted}">${c.adjunto ? 'adjunto a este correo' : 'ábrelo en el sistema (no se adjuntó)'}${c.por ? ' · subido por ' + esc(c.por) : ''}</span></div>`).join('')}</td></tr>` : '';
  const compTexto = comprobantes && comprobantes.length ? '\n\nComprobante del saldo asignado:\n' + comprobantes.map(c => `- ${c.filename}${c.adjunto ? ' (adjunto)' : ''}`).join('\n') : '';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#EFF2F5;font-family:${F};color:${ink}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#EFF2F5;padding:24px 0"><tr><td align="center">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid ${line};border-radius:14px;overflow:hidden">
<tr><td style="padding:28px 36px 0"><img src="${esc(logoSrc || 'cid:polipay-logo')}" alt="Polipay" height="26" style="display:block;height:26px;border:0"></td></tr>
<tr><td style="padding:14px 36px 0"><div style="height:4px;background:${accent};border-radius:2px;width:64px"></div></td></tr>
<tr><td style="padding:20px 36px 0;font:400 14px/1.5 ${F};color:${muted}">Polipay Cards Settlement · ${esc(t.titulo)}</td></tr>
<tr><td style="padding:28px 36px 0;font:400 14px/1.6 ${F};color:${ink}">${esc(saludo)}</td></tr>
<tr><td style="padding:16px 36px 8px;font:400 14px/1.6 ${F};color:${ink}">${esc(t.intro(f, comprobantes && comprobantes.length))}</td></tr>
<tr><td style="padding:20px 36px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${filasHtml}</table></td></tr>
${cepsHtml}
${compHtml}
${avisos && avisos.length ? `<tr><td style="padding:20px 36px 0"><div style="background:#FFF7ED;border:1px solid #FDBA74;color:#7C2D12;padding:12px 16px;border-radius:12px;font:400 13px/1.55 ${F}"><b>Revisa:</b><ul style="margin:6px 0 0;padding-left:18px">${avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div></td></tr>` : ''}
<tr><td style="padding:24px 36px 0"><a href="${esc(url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font:700 14px/1 ${F};padding:12px 22px;border-radius:999px">Abrir en el sistema</a></td></tr>
<tr><td style="padding:24px 36px 32px;font:400 12px/1.55 ${F};color:${muted}">Este correo se generó automáticamente por Polipay Cards Settlement. Generado ${hoy}.</td></tr>
</table>
<div style="max-width:640px;margin:12px auto 0;padding:0 8px;font:400 11px/1.4 ${F};color:${muted};text-align:center">Polipay Cards Settlement · BSO · ops.emisor@polipay.io</div>
</td></tr></table></body></html>`;
  const text = `Polipay Cards Settlement · ${t.titulo}\n${t.intro(f)}\n\n${[...filas, ...extra].map(([k, v]) => `${k}: ${v}`).join('\n')}${cepsTexto}${compTexto}${avisos && avisos.length ? '\n\nRevisa:\n- ' + avisos.join('\n- ') : ''}\n\n${url}`;
  return { subject, html, text };
}

/* Corte de comisiones de BSO Cards (contabilidad): lo cobrado y guardado hasta el corte, por empresa, con IVA, y la razón social y el RFC a facturar.
   Mismo diseño que los demás correos de MCEB, adaptado a BSO Cards. */
function armarCorteContable({ corte, appUrl, logoSrc, adjunto }) {
  const CONTA = require('./cards-contabilidad.js');
  const url = (appUrl || 'https://polipay-conciliacion-liquidacion.onrender.com').replace(/\/$/, '');
  const accent = '#157BF6', muted = '#707070', line = '#E4E6E7', ink = '#04003A', F = 'Montserrat,Arial,sans-serif';
  const t = corte.totales || {}, filas = corte.resumen || [];
  const titulo = CONTA.tituloCorte(corte), dep = CONTA.textoDepositos(t);
  const N = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-');
  const hoy = `${N[2]}/${N[1]}/${N[0]}`;
  const subject = `[BSO Cards] Corte de comisiones · ${titulo.replace('Corte al ', 'al ')} · ${mxn(t.total || 0)} a facturar`;
  const th = (x, al) => `<td style="padding:8px 10px;font:700 11px/1.3 ${F};color:${muted};text-transform:uppercase;letter-spacing:.04em;text-align:${al || 'left'}">${x}</td>`;
  const td = (x, al, b) => `<td style="padding:10px;border-top:1px solid ${line};font:${b ? '700' : '400'} 13px/1.4 ${F};color:${ink};text-align:${al || 'left'};vertical-align:top">${x}</td>`;
  const cuerpo = filas.length ? filas.map(e => `<tr>${td(`<b>${esc(e.razon_social || e.empresa)}</b>${e.fondeos ? `<br><span style="color:${muted};font-size:11px">${e.fondeos} fondeo${e.fondeos > 1 ? 's' : ''}</span>` : ''}`)}${td(esc(e.rfc || '—'))}${td(mxn(e.comision), 'right')}${td(mxn(e.iva), 'right')}${td(mxn(e.total), 'right', true)}</tr>`).join('')
    : `<tr><td colspan="5" style="padding:14px 10px;border-top:1px solid ${line};font:400 13px/1.5 ${F};color:${muted}">No hay comisiones por facturar en este corte: no se guardó ningún fondeo nuevo desde el corte anterior.</td></tr>`;
  filas.forEach(e => { e.falta = (e.falta || []).filter(x => x !== 'razón social'); });   // la razón social es el nombre de la empresa: nunca falta
  const faltan = filas.filter(e => e.falta && e.falta.length);
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#EFF2F5;font-family:${F};color:${ink}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#EFF2F5;padding:24px 0"><tr><td align="center">
<table role="presentation" width="680" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border:1px solid ${line};border-radius:14px;overflow:hidden">
<tr><td style="padding:28px 36px 0"><img src="${esc(logoSrc || 'cid:polipay-logo')}" alt="Polipay" height="26" style="display:block;height:26px;border:0"></td></tr>
<tr><td style="padding:14px 36px 0"><div style="height:4px;background:${accent};border-radius:2px;width:64px"></div></td></tr>
<tr><td style="padding:20px 36px 0;font:400 14px/1.5 ${F};color:${muted}">BSO Cards · Corte de comisiones</td></tr>
<tr><td style="padding:28px 36px 0;font:400 14px/1.6 ${F};color:${ink}">Estimados,</td></tr>
<tr><td style="padding:16px 36px 8px;font:400 14px/1.6 ${F};color:${ink}">Les compartimos el <b>corte de comisiones de BSO Cards</b>: lo cobrado y guardado hasta el <b>${esc(CONTA.fechaLarga(String(corte.fecha_corte).slice(0, 10)))}</b> (${esc(dep)}), con IVA, y la razón social y el RFC a los que se factura. ${adjunto ? 'Adjuntamos el detalle por fondeo con su fecha de depósito.' : ''}</td></tr>
<tr><td style="padding:12px 36px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse"><tr>${th('Razón social a facturar')}${th('RFC')}${th('Comisión', 'right')}${th('IVA', 'right')}${th('Total a facturar', 'right')}</tr>${cuerpo}
${filas.length ? `<tr><td colspan="2" style="padding:12px 10px;border-top:2px solid ${ink};font:700 13px/1.4 ${F};color:${ink}">TOTAL · ${t.fondeos || 0} fondeo${t.fondeos === 1 ? '' : 's'}</td><td style="padding:12px 10px;border-top:2px solid ${ink};font:700 13px/1.4 ${F};text-align:right">${mxn(t.comision)}</td><td style="padding:12px 10px;border-top:2px solid ${ink};font:700 13px/1.4 ${F};text-align:right">${mxn(t.iva)}</td><td style="padding:12px 10px;border-top:2px solid ${ink};font:700 15px/1.4 ${F};text-align:right">${mxn(t.total)}</td></tr>` : ''}</table></td></tr>
<tr><td style="padding:16px 36px 0;font:400 12px/1.55 ${F};color:${muted}">Cada fondeo entra a un solo corte. Lo que se guarde después de este corte se incluye en el siguiente.</td></tr>
${faltan.length ? `<tr><td style="padding:16px 36px 0"><div style="background:#FFF7ED;border:1px solid #FDBA74;color:#7C2D12;padding:12px 16px;border-radius:12px;font:400 13px/1.55 ${F}"><b>Datos fiscales por completar:</b><ul style="margin:6px 0 0;padding-left:18px">${faltan.map(e => `<li>${esc(e.empresa)}: falta ${esc(e.falta.join(' y '))}</li>`).join('')}</ul></div></td></tr>` : ''}
<tr><td style="padding:24px 36px 0"><a href="${esc(url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font:700 14px/1 ${F};padding:12px 22px;border-radius:999px">Abrir en el sistema</a></td></tr>
<tr><td style="padding:24px 36px 32px;font:400 12px/1.55 ${F};color:${muted}">Este correo se generó automáticamente por BSO Cards, en Polipay Cards Settlement. Generado ${hoy}.</td></tr>
</table>
<div style="max-width:680px;margin:12px auto 0;padding:0 8px;font:400 11px/1.4 ${F};color:${muted};text-align:center">Polipay Cards Settlement · BSO · ops.emisor@polipay.io</div>
</td></tr></table></body></html>`;
  const text = `BSO Cards · Corte de comisiones\n${titulo} (${dep})\n\n${filas.map(e => `${e.razon_social || '(sin razón social)'} · ${e.rfc || 'sin RFC'} · comisión ${mxn(e.comision)} + IVA ${mxn(e.iva)} = ${mxn(e.total)}`).join('\n') || 'Sin comisiones por facturar en este corte.'}\n\nTotal a facturar: ${mxn(t.total || 0)}${faltan.length ? '\n\nDatos fiscales por completar:\n' + faltan.map(e => `- ${e.empresa}: falta ${e.falta.join(' y ')}`).join('\n') : ''}\n\nCada fondeo entra a un solo corte; lo que se guarde después se incluye en el siguiente.\n${url}`;
  return { subject, html, text };
}

module.exports = { armarCorreoFondeo, armarCorteContable, TIPOS };
