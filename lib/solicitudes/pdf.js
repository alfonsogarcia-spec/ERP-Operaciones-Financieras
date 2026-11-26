/* lib/solicitudes/pdf.js — Portal de solicitudes: los formatos oficiales (POL-OP-F02/F03/F07/F08/F11/F13) en PDF.
   · Ya llenos, de una solicitud: con lo que capturó cada parte, los documentos, quién dio cada paso y cuándo (constancia electrónica en lugar de firma de papel) y la huella de la bitácora.
   · En blanco, de un tipo: el mismo formato listo para imprimir y llenar a mano. */
'use strict';
const PDFDocument = require('pdfkit');
const CAT = require('./catalogo.js');
const F = require('./flujo.js');
const V = require('./validar.js');

const AZUL = '#04003A', GRIS = '#6b7280', LINEA = '#c9ced6', FONDO = '#eef1f6';
// Helvetica (WinAnsi) no trae algunos símbolos: se sustituyen para que el texto no salga con huecos.
const limpia = s => String(s == null ? '' : s).replace(/[→⇒]/g, '->').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/[✓✔]/g, 'x').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\u0009\u000a -ÿŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]/g, '?');
const fF = v => { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? '—' : d.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' }); };
const fFecha = v => { if (!v) return ''; const d = new Date(String(v).length === 10 ? v + 'T12:00:00' : v); return isNaN(d) ? String(v) : d.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: 'short', year: 'numeric' }); };

// Texto de un campo, según el tipo y si el formato va en blanco.
function textoCampo(c, v, blanco, privado) {
  const marca = (op, on) => `[${on ? 'X' : '  '}] ${op}`;
  if (c.tipo === 'checkbox_group') { const sel = blanco ? [] : (Array.isArray(v) ? v : []); return (c.options || []).map(o => marca(o, sel.includes(o))).join('\n'); }
  if (c.tipo === 'radio' || c.tipo === 'select') { if (c.options && c.options.length && (c.tipo === 'radio' || blanco || c.options.length <= 3)) return c.options.map(o => marca(o, !blanco && v === o)).join('     '); }
  if (blanco) return '';
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (privado) return '•••• (registrado en el sistema)';
  if (Array.isArray(v)) return v.join(', ');
  if (c.tipo === 'porcentaje') return v + ' %';
  if (c.tipo === 'date') return fFecha(v);
  return String(v);
}

function render({ t, s, cliente, eventos, adjuntos, blanco, paraCliente }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 56, left: 48, right: 48 }, bufferPages: true, info: { Title: `${t.formato} ${s ? s.folio : '(en blanco)'}`, Author: 'MCEB S.A. de C.V. (Polipay)', Subject: t.nombre } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right, X = doc.page.margins.left, pie = () => doc.page.height - doc.page.margins.bottom;
    const salto = h => { if (doc.y + h > pie()) { doc.addPage(); doc.y = doc.page.margins.top; } };
    const todo = s ? { ...(s.datos || {}), ...(s.datos_comercial || {}), ...(s.datos_operacion || {}) } : {};

    // ---- encabezado
    doc.rect(X, doc.y, W, 4).fill(AZUL); doc.moveDown(0.6);
    const y0 = doc.y;
    doc.fillColor(GRIS).font('Helvetica').fontSize(8.5).text('MCEB S.A. de C.V. (Polipay)', X, y0);
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(16).text(limpia(t.nombre), X, doc.y + 2, { width: W - 150 });
    doc.fillColor(GRIS).font('Helvetica').fontSize(9).text(limpia(`${t.formato} · Procedimiento ${t.codigo} · Versión 1.0`), X, doc.y + 2, { width: W - 150 });
    const yFin = doc.y;
    // recuadro de folio
    doc.roundedRect(X + W - 140, y0, 140, 50, 4).lineWidth(0.8).strokeColor(LINEA).stroke();
    doc.fillColor(GRIS).fontSize(7.5).text('FOLIO', X + W - 132, y0 + 6); doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(11).text(s ? s.folio : '________________', X + W - 132, y0 + 16, { width: 124 });
    doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(s ? 'Creada ' + fF(s.creado_at) : 'Fecha: ____ / ____ / ________', X + W - 132, y0 + 34, { width: 124 });
    doc.y = Math.max(yFin, y0 + 54) + 8;
    if (s) {
      const est = (F.ESTADOS[s.estado] || {}); doc.fillColor('#111').font('Helvetica').fontSize(9).text(limpia(`Cliente: ${cliente || '—'}${s.afiliacion ? '   ·   Afiliación principal: ' + s.afiliacion : ''}   ·   Estado: ${paraCliente ? est.cliente : est.nombre}`), X, doc.y, { width: W });
      doc.moveDown(0.5);
    } else {
      doc.fillColor(GRIS).fontSize(8.5).text(limpia('Instrucciones: complete todos los campos requeridos (*) y marque con una X las opciones que apliquen. Este formato debe ser firmado por quien lo solicita, por Operación POS (ejecuta) y por la Coordinación de Operaciones (valida). Referencia: ' + t.codigo + '.'), X, doc.y, { width: W });
      doc.moveDown(0.5);
    }

    // ---- secciones
    const colL = Math.round(W * 0.36), colR = W - colL;
    const titulo = (txt, nota) => { salto(40); doc.moveDown(0.4); const y = doc.y; doc.rect(X, y, W, 17).fill(FONDO); doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(9.5).text(limpia(txt), X + 6, y + 4, { width: W - 12, continued: !!nota }); if (nota) doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(limpia('   ' + nota)); doc.y = y + 17; };
    const fila = (label, valor, requerido) => {
      doc.font('Helvetica-Bold').fontSize(8.5); const hl = doc.heightOfString(limpia(label) + (requerido ? ' *' : ''), { width: colL - 10 });
      doc.font('Helvetica').fontSize(9); const hv = Math.max(doc.heightOfString(limpia(valor) || ' ', { width: colR - 10 }), blanco ? 14 : 0);
      const h = Math.max(hl, hv) + 8; salto(h);
      const y = doc.y; doc.lineWidth(0.5).strokeColor(LINEA).rect(X, y, colL, h).stroke(); doc.rect(X + colL, y, colR, h).stroke();
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.5).text(limpia(label) + (requerido ? ' *' : ''), X + 5, y + 4, { width: colL - 10 });
      doc.font('Helvetica').fontSize(9).fillColor('#111').text(limpia(valor), X + colL + 5, y + 4, { width: colR - 10 }); doc.y = y + h;
    };
    const QUIEN = { cliente: 'Parte 1 · Cliente', comercial: 'Ejecutivo Comercial', operacion: 'Parte 2 · Operación POS' };
    t.secciones.forEach(sec => {
      if (paraCliente && sec.llena === 'operacion' && s && s.estado !== 'completada') return;
      if (paraCliente && sec.llena === 'comercial') { const visibles = sec.campos.filter(c => /^(tasa_|monto_fijo|esquema_liq)/.test(c.key)); if (!visibles.length) return; }
      titulo(sec.titulo, QUIEN[sec.llena]);
      sec.campos.forEach(c => {
        if (paraCliente && sec.llena === 'comercial' && !/^(tasa_|monto_fijo|esquema_liq)/.test(c.key)) return;
        if (paraCliente && sec.llena === 'operacion' && (c.privado || c.key === 'obs_operacion')) return;
        if (!blanco && c.show_if && !V.visible(c, todo)) return;
        fila(c.label, textoCampo(c, todo[c.key], blanco, !!c.privado && !blanco), !!c.required);
      });
    });
    // ---- documentos
    if ((t.docs || []).length) {
      titulo('Documentos', 'Los marcados con * son obligatorios');
      t.docs.forEach(d => { const a = !blanco && (adjuntos || []).find(x => x.doc_id === d.id && !x.retirado); fila(d.nombre, blanco ? '[  ] Entregado' : (a ? `[X] ${a.nombre} (${fF(a.subido_at)})` : '[  ] Sin archivo'), d.requerido); });
    }
    // ---- autorizaciones
    titulo('Autorizaciones', blanco ? 'Nombre, firma y fecha' : 'Constancia electrónica: quién dio cada paso y cuándo');
    const ev = a => (eventos || []).filter(e => e.accion === a).slice(-1)[0];
    const requiereDir = blanco ? !!(t.firma_direccion || t.critica) : !!(s && s.requiere_direccion);
    const cols = [['Solicita', s && (s.solicitante_nombre || s.solicitante), s && s.enviada_at], ['Ejecutivo Comercial\n(libera)', s && s.liberada_por, ev('liberar') && ev('liberar').ts], ['Operación POS\n(ejecuta)', s && s.ejecutada_por, s && s.ejecutada_at], ['Coordinación de Operaciones\n(valida)', s && s.validada_por, ev('validar') && ev('validar').ts]];
    if (requiereDir) cols.push(['Dirección de Operaciones\n(autoriza)', s && s.direccion_por, ev('validar') && ev('validar').ts]);
    const cw = W / cols.length; const hf = 74; salto(hf + 4); const yy = doc.y;
    cols.forEach(([n, quien, cuando], i) => {
      const x = X + i * cw; doc.lineWidth(0.5).strokeColor(LINEA).rect(x, yy, cw, hf).stroke();
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(8).text(limpia(n), x + 5, yy + 4, { width: cw - 10 });
      if (blanco || paraCliente && i > 0) { doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Nombre:', x + 5, yy + 30).text('Firma:', x + 5, yy + 44).text('Fecha: ___/___/_____', x + 5, yy + 60); }
      else { doc.fillColor('#111').font('Helvetica').fontSize(8.5).text(limpia(quien || 'Pendiente'), x + 5, yy + 30, { width: cw - 10 }); doc.fillColor(GRIS).fontSize(7.5).text(quien ? fF(cuando) : '', x + 5, yy + 56, { width: cw - 10 }); }
    });
    doc.y = yy + hf + 6;
    // ---- historial (solo con solicitud)
    if (s && eventos && eventos.length) {
      titulo('Historial');
      eventos.forEach(e => {
        const txt = `${fF(e.ts)} · ${e.actor_nombre || e.actor || ''} · ${e.detalle || e.accion}${e.estado_nvo ? '  [' + ((F.ESTADOS[e.estado_nvo] || {}).nombre || e.estado_nvo) + ']' : ''}`;
        doc.font('Helvetica').fontSize(8); const h = doc.heightOfString(limpia(txt), { width: W - 10 }) + 5; salto(h);
        doc.fillColor('#111').text(limpia(txt), X + 5, doc.y + 2, { width: W - 10 }); doc.moveDown(0.1);
      });
      const ult = eventos[eventos.length - 1];
      if (!paraCliente && ult && ult.hash) { salto(30); doc.moveDown(0.5); doc.fillColor(GRIS).font('Courier').fontSize(7).text('Huella de la bitácora: ' + ult.hash, X, doc.y, { width: W }); }
    }
    doc.moveDown(0.6); salto(30);
    doc.fillColor(GRIS).font('Helvetica').fontSize(7.5).text(limpia('Este formato debe archivarse en el expediente junto con la evidencia de validación. Tiempo de conservación: 5 años. La información contenida es confidencial y de uso exclusivo de MCEB S.A. de C.V. (Polipay).'), X, doc.y, { width: W });
    // ---- pie con número de página
    const rango = doc.bufferedPageRange();
    for (let i = rango.start; i < rango.start + rango.count; i++) {
      doc.switchToPage(i); doc.page.margins.bottom = 0; doc.fillColor(GRIS).font('Helvetica').fontSize(7.5).text(limpia(`${t.formato} · ${s ? s.folio : 'Formato en blanco'}`), X, doc.page.height - 38, { width: W / 2, lineBreak: false })
        .text(`Página ${i + 1} de ${rango.count}`, X + W / 2, doc.page.height - 38, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

const formatoPDF = (args) => render({ ...args, t: CAT.tipo(args.s ? args.s.tipo : args.tipo), blanco: false });
const formatoEnBlanco = tipoId => render({ t: CAT.tipo(tipoId), s: null, blanco: true });

module.exports = { formatoPDF, formatoEnBlanco };
