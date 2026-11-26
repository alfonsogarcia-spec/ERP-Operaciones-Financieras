/* lib/solicitudes/impresion.js — Portal de solicitudes: el formato oficial (POL-OP-F02/F03/F07/F08/F11/F13) ya lleno, listo para imprimir o guardar como PDF,
   con quién hizo cada paso y cuándo (en lugar de la firma de papel) y la huella de la bitácora. Se archiva en el expediente (conservación: 5 años). */
'use strict';
const V = require('./validar.js');
const CAT = require('./catalogo.js');
const F = require('./flujo.js');
const { esc } = require('./correos.js');

const fF = v => { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? '—' : d.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' }); };
const valor = (c, v) => {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '<span style="color:#9ca3af">—</span>';
  if (c.tipo === 'checkbox') return v ? 'Sí' : 'No';
  if (Array.isArray(v)) return esc(v.join(', '));
  if (c.tipo === 'porcentaje') return esc(v) + ' %';
  return esc(v).replace(/\n/g, '<br>');
};

// `s` = solicitud completa (con datos de las tres etapas), `cliente` = nombre del grupo, `eventos` = bitácora, `adjuntos` = archivos vigentes.
function formatoHTML({ s, cliente, eventos, adjuntos }) {
  const t = CAT.tipo(s.tipo); const all = { ...s.datos, ...s.datos_comercial, ...s.datos_operacion };
  const secciones = t.secciones.map(sec => {
    const filas = sec.campos.filter(c => V.visible(c, all)).map(c => `<tr><th>${esc(c.label)}</th><td>${c.privado && all[c.key] ? '•••• (registrado en el sistema)' : valor(c, all[c.key])}</td></tr>`).join('');
    const quien = { cliente: 'Parte 1 · Cliente', comercial: 'Ejecutivo Comercial', operacion: 'Parte 2 · Operación POS' }[sec.llena];
    return `<h3>${esc(sec.titulo)} <small>${quien}</small></h3><table>${filas}</table>`;
  }).join('');
  const docs = (t.docs || []).length ? `<h3>Documentos</h3><table>${t.docs.map(d => {
    const a = adjuntos.find(x => x.doc_id === d.id && !x.retirado);
    return `<tr><th>${esc(d.nombre)}${d.requerido ? ' *' : ''}</th><td>${a ? esc(a.nombre) + ' · ' + fF(a.subido_at) : '<span style="color:#9ca3af">Sin archivo</span>'}</td></tr>`;
  }).join('')}</table>` : '';
  const paso = acc => eventos.filter(e => e.accion === acc).slice(-1)[0];
  const firma = (rol, quien, cuando) => `<td><b>${esc(rol)}</b><br>${quien ? esc(quien) : '—'}<br><small>${quien ? fF(cuando) : 'Pendiente'}</small></td>`;
  const ev = a => paso(a);
  const firmas = `<h3>Autorizaciones <small>constancia electrónica en lugar de firma de papel</small></h3><table class="firmas"><tr>
    ${firma('Solicita', s.solicitante_nombre || s.solicitante, s.enviada_at)}
    ${firma('Ejecutivo Comercial (libera)', s.liberada_por, ev('liberar') && ev('liberar').ts)}
    ${firma('Operación POS (ejecuta)', s.ejecutada_por, s.ejecutada_at)}
    ${firma('Coordinación de Operaciones (valida)', s.validada_por, ev('validar') && ev('validar').ts)}
    ${s.requiere_direccion ? firma('Dirección de Operaciones', s.direccion_por, ev('validar') && ev('validar').ts) : ''}
  </tr></table>`;
  const ultimo = eventos[eventos.length - 1];
  const hist = `<h3>Historial</h3><table class="hist">${eventos.map(e => `<tr><td>${fF(e.ts)}</td><td>${esc(e.actor_nombre || e.actor)}</td><td>${esc(e.accion)}${e.estado_nvo ? ' → ' + esc((F.ESTADOS[e.estado_nvo] || {}).nombre || e.estado_nvo) : ''}${e.detalle ? '<br><small>' + esc(e.detalle) + '</small>' : ''}</td></tr>`).join('')}</table>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(t.formato)} · ${esc(s.folio)}</title><style>
    body{font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:28px auto;max-width:820px;padding:0 18px}
    header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0b1a4b;padding-bottom:10px;margin-bottom:14px}
    h1{font-size:18px;margin:0;color:#0b1a4b} h3{font-size:13px;margin:18px 0 6px;color:#0b1a4b} h3 small{font-weight:400;color:#6b7280;margin-left:6px}
    table{width:100%;border-collapse:collapse} th,td{border:1px solid #d1d5db;padding:5px 8px;text-align:left;vertical-align:top} th{background:#f3f4f6;width:34%;font-weight:600}
    .firmas td{width:20%} .hist td{font-size:12px} .meta{color:#6b7280;font-size:12px} .hash{font-family:ui-monospace,monospace;font-size:11px;color:#6b7280;margin-top:14px;word-break:break-all}
    @media print{body{margin:0}}
  </style></head><body>
  <header><div><div class="meta">MCEB S.A. de C.V. (Polipay)</div><h1>${esc(t.nombre)}</h1><div class="meta">${esc(t.formato)} · Procedimiento ${esc(t.codigo)}</div></div>
  <div style="text-align:right"><b>${esc(s.folio)}</b><div class="meta">Creada ${fF(s.creado_at)}<br>Estado: ${esc((F.ESTADOS[s.estado] || {}).nombre || s.estado)}</div></div></header>
  <div class="meta" style="margin-bottom:6px">Cliente: <b>${esc(cliente)}</b>${s.afiliacion ? ' · Afiliación principal: <b>' + esc(s.afiliacion) + '</b>' : ''}</div>
  ${secciones}${docs}${firmas}${hist}
  <div class="hash">Huella de la bitácora: ${ultimo ? esc(ultimo.hash) : '—'}<br>Archivar con la evidencia de validación. Conservación: 5 años. Confidencial · MCEB S.A. de C.V. (Polipay).</div>
  </body></html>`;
}

module.exports = { formatoHTML };
