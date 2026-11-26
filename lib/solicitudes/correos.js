/* lib/solicitudes/correos.js — Portal de solicitudes: avisos por correo en cada paso (a quien le toca actuar y a quien solicitó). Usa el mismo SES que POS y Cards. */
'use strict';
const F = require('./flujo.js');

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TONO = { ok: '#059669', danger: '#dc2626', warn: '#d97706', info: '#2563eb', violet: '#7c3aed', neutral: '#6b7280' };

function armar({ titulo, folio, tipo, cliente, estado, mensaje, nota, url, paraCliente }) {
  const e = F.ESTADOS[estado] || { nombre: estado, cliente: estado, tono: 'neutral' };
  const etiqueta = paraCliente ? e.cliente : e.nombre;
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7fb;margin:0;padding:24px;color:#111">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <div style="color:#0b1a4b;font-weight:800;font-size:13px;letter-spacing:.5px;margin-bottom:6px">POLIPAY · SOLICITUDES</div>
    <h1 style="margin:0 0 4px 0;font-size:19px;color:#0b1a4b">${esc(titulo)}</h1>
    <div style="color:#6b7280;font-size:13px;margin-bottom:18px">${esc(folio)} · ${esc(tipo)}${cliente ? ' · ' + esc(cliente) : ''}</div>
    <div style="margin-bottom:16px"><span style="display:inline-block;padding:3px 12px;border-radius:12px;background:${TONO[e.tono] || '#6b7280'};color:#fff;font-size:12px;font-weight:600">${esc(etiqueta)}</span></div>
    <p style="font-size:14px;line-height:1.5;margin:0 0 14px">${esc(mensaje)}</p>
    ${nota ? `<div style="background:#f3f4f6;border-radius:8px;padding:12px 14px;font-size:13px;margin:0 0 16px"><b>Comentario:</b><br>${esc(nota).replace(/\n/g, '<br>')}</div>` : ''}
    ${url ? `<a href="${esc(url)}" style="display:inline-block;background:#157BF6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px">Abrir la solicitud</a>` : ''}
    <div style="color:#9ca3af;font-size:11px;margin-top:22px">Mensaje automático del portal de solicitudes de Polipay. No respondas a este correo.</div>
  </div></body></html>`;
  const text = `${titulo}\n${folio} · ${tipo}${cliente ? ' · ' + cliente : ''}\nEstado: ${etiqueta}\n\n${mensaje}${nota ? '\n\nComentario: ' + nota : ''}${url ? '\n\n' + url : ''}`;
  return { html, text };
}

// Quién recibe qué en cada acción. `p` = { solicitante, ejecutivo, porRol(rol) }.
const AVISOS = {
  enviar:    { a: ['ejecutivo', 'dirComercialSiSinEjecutivo'], cc: ['solicitante'], asunto: 'Nueva solicitud para revisar', msg: 'Hay una solicitud nueva de tu cliente. Revísala, complétala con el cliente y libérala a Operación.', paraCliente: false },
  devolver:  { a: ['solicitante'], asunto: 'Necesitamos más información', msg: 'Tu Ejecutivo Comercial devolvió la solicitud para que la completes o corrijas.', paraCliente: true },
  liberar:   { a: ['rol:operacion'], cc: ['ejecutivo'], asunto: 'Solicitud liberada a Operación', msg: 'Comercial liberó una solicitud lista para ejecutar.', paraCliente: false },
  devolver_comercial: { a: ['ejecutivo'], asunto: 'Operación regresó la solicitud a Comercial', msg: 'Operación necesita aclaración o información adicional para continuar.', paraCliente: false },
  ejecutar:  { a: ['rol:coordinacion', 'rol:direccionSiAplica'], asunto: 'Solicitud ejecutada: falta tu validación', msg: 'Operación ejecutó la solicitud y espera la validación.', paraCliente: false },
  observar:  { a: ['rol:operacion'], asunto: 'Coordinación devolvió la solicitud con observaciones', msg: 'La validación tiene observaciones por atender.', paraCliente: false },
  validar:   { a: ['solicitante'], cc: ['ejecutivo'], asunto: 'Tu solicitud está completada', msg: 'La solicitud se ejecutó y quedó validada. Adjuntamos el formato en PDF.', paraCliente: true },
  rechazar:  { a: ['solicitante'], cc: ['ejecutivo'], asunto: 'Tu solicitud fue rechazada', msg: 'La solicitud no procedió. Revisa el motivo.', paraCliente: true },
  cancelar:  { a: ['solicitante', 'ejecutivo'], asunto: 'Solicitud cancelada', msg: 'La solicitud se canceló.', paraCliente: true },
};

module.exports = { armar, AVISOS, esc };
