/* ============================================================================
   lib/pld-correo.js — Correo de alertas y bloqueo por operativa inusual (POL-CUM-FOR-006).
   Un correo con el resumen y, por cada alerta, la ACCIÓN EJECUTABLE (suspender terminal, bloquear
   tarjeta/BIN, dar aviso…). Función pura: devuelve { subject, html, text }.
   ========================================================================= */
'use strict';
const { accionEjecutable, NIVELES } = require('./pld-alertas.js');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mxn = n => (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const ORDEN = ['BLOQUEO', 'SUSPENDER', 'AVISO'];
const COLOR = { BLOQUEO: { bg: '#FDE2E2', ink: '#9B1C1C', bar: '#DC2626' }, SUSPENDER: { bg: '#FFF4D6', ink: '#7C4A03', bar: '#F59E0B' }, AVISO: { bg: '#E6F0FF', ink: '#0F3E8A', bar: '#3083F4' } };
const POR_NIVEL = 25;

function armarCorreoAlertas({ alertas, reglas, appUrl, nombre }) {
  const por = { BLOQUEO: [], SUSPENDER: [], AVISO: [] };
  for (const a of alertas) (por[a.nivel] || por.AVISO).push(a);
  const n = k => por[k].length;
  const partes = ORDEN.filter(k => n(k)).map(k => `${n(k)} ${NIVELES[k].toLowerCase()}`);
  const subject = `[PLD] ${n('BLOQUEO') ? '⚠ ' : ''}${partes.join(' · ')} — alertas por operativa inusual`;
  const url = appUrl || 'https://polipay-conciliacion-liquidacion.onrender.com';
  const seccion = (k) => {
    if (!n(k)) return '';
    const c = COLOR[k]; const lista = por[k].slice(0, POR_NIVEL);
    const filas = lista.map(a => {
      const donde = [a.terminal && 'Terminal ' + a.terminal, a.comercio, a.afil && 'Afil. ' + a.afil].filter(Boolean).join(' · ') || '—';
      return `<tr><td style="padding:12px 14px;border-top:1px solid #e5e7eb;vertical-align:top;font:400 13px/1.5 Arial,Helvetica,sans-serif;color:#111827">
        <div style="font-weight:700">${esc(a.regla)} · ${esc((reglas[a.regla] || {}).titulo || '')}</div>
        <div style="color:#6b7280;font-size:12px;margin:2px 0 6px">${esc(a.fecha)} ${esc(a.hora_ini || '')}${a.hora_fin && a.hora_fin !== a.hora_ini ? ' – ' + esc(a.hora_fin) : ''} · ${esc(donde)}${a.tarjeta || a.bin ? ' · ' + esc(a.tarjeta || 'BIN ' + a.bin) : ''} · ${esc(a.n_ops)} op. · ${esc(mxn(a.monto))}</div>
        <div>${esc(a.detalle || '')}</div>
        <div style="margin-top:8px;padding:8px 10px;background:${c.bg};color:${c.ink};border-radius:8px;font-weight:700">Acción: ${esc(accionEjecutable(a).replace(/^(AVISO|SUSPENDER|BLOQUEAR) · /, ''))}</div></td></tr>`;
    }).join('');
    const mas = n(k) > POR_NIVEL ? `<tr><td style="padding:10px 14px;font:400 12px Arial,Helvetica,sans-serif;color:#6b7280">… y ${n(k) - POR_NIVEL} más. Están todas en el Excel adjunto y en el sistema.</td></tr>` : '';
    return `<tr><td style="padding:20px 28px 0"><div style="border-left:4px solid ${c.bar};padding-left:10px;font:700 14px Arial,Helvetica,sans-serif;color:#111827;margin-bottom:6px">${esc(NIVELES[k].toUpperCase())} · ${n(k)} alerta(s)</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:10px">${filas}${mas}</table></td></tr>`;
  };
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f6f8;padding:24px 0"><tr><td align="center">
<table role="presentation" width="680" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
<tr><td style="padding:26px 28px 0"><img src="cid:polipay-logo" alt="Polipay" height="32" style="display:block;height:32px;border:0"></td></tr>
<tr><td style="padding:12px 28px 0"><div style="height:4px;width:64px;background:#3083F4;border-radius:2px"></div></td></tr>
<tr><td style="padding:18px 28px 0;font:700 17px Arial,Helvetica,sans-serif">Alertas por operativa inusual · POL-CUM-FOR-006</td></tr>
<tr><td style="padding:10px 28px 0;font:400 14px/1.6 Arial,Helvetica,sans-serif">${nombre ? 'Hola ' + esc(nombre) + ',<br>' : ''}Se detectaron <b>${alertas.length}</b> alerta(s) nueva(s): ${esc(partes.join(' · '))}. Abajo, para cada una, <b>la acción a ejecutar</b>. El sistema no suspende ni bloquea por sí solo: la medida debe aplicarse en el gateway y registrarse en <i>Cumplimiento → Alertas</i>.</td></tr>
${ORDEN.map(seccion).join('')}
<tr><td style="padding:22px 28px 6px"><a href="${esc(url)}" style="display:inline-block;background:#3083F4;color:#fff;text-decoration:none;font:700 13px Arial,Helvetica,sans-serif;padding:12px 22px;border-radius:8px">Revisar y registrar la medida →</a></td></tr>
<tr><td style="padding:14px 28px 26px;font:400 11px/1.5 Arial,Helvetica,sans-serif;color:#6b7280">Correo automático de Polipay POS Settlement · Cumplimiento (PLD). De la tarjeta solo se muestran BIN y últimos 4 dígitos. No respondas a este correo.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Alertas por operativa inusual (POL-CUM-FOR-006): ${partes.join(', ')}.\n\n` + ORDEN.flatMap(k => por[k].slice(0, POR_NIVEL).map(a => `[${NIVELES[k]}] ${a.regla} ${a.fecha} ${a.terminal || a.comercio || a.afil || ''} — ${a.detalle || ''}\n   Acción: ${accionEjecutable(a)}`)).join('\n') + `\n\nRevisa y registra la medida en ${url}`;
  return { subject, html, text };
}

module.exports = { armarCorreoAlertas };
