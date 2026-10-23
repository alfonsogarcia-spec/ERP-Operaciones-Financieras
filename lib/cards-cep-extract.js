/* ============================================================================
   lib/cards-cep-extract.js — Lee un CEP (PDF / XML) y extrae sus datos: clave de rastreo, monto, fecha de abono,
   ordenante, beneficiario (CLABE) y concepto.   Solo LEE: nunca ejecuta ni abre nada del archivo.

   Formatos que reconoce
     1. CEP de Banxico (PDF "Comprobante Electrónico de Pago"): trae la *cadena original* firmada, una línea con los datos
        en orden fijo, que es la fuente más confiable; la clave de rastreo y la referencia salen de las etiquetas.
     2. "Comprobante de dispersión" de Polipay (PDF con renglones "Etiqueta: valor").
     3. XML del CEP de Banxico (mejor esfuerzo; ver parseXml).
     4. Cualquier otro PDF de texto (recibos de banco): lectura genérica de baja confianza, para que el usuario la revise.
   Imágenes (PNG/JPG) no se leen (no hay OCR): se piden los datos a mano.
   ========================================================================= */
'use strict';
const { clabeValida, round2 } = require('./cards-fondeo.js');
const BNK = require('./cards-bancos.js');

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const p2 = n => String(n).padStart(2, '0');
const iso = (y, m, d) => { const f = `${y}-${p2(m)}-${p2(d)}`; const t = new Date(f + 'T00:00:00Z'); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === f ? f : null; };
const quitaAcentos = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const limpia = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const dinero = s => { const x = String(s == null ? '' : s).replace(/[$,\s]|MXN/gi, ''); if (x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

// "10 de junio de 2026" → 2026-06-10
function fechaLarga(txt) {
  const m = /(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+de\s+(\d{4})/.exec(String(txt || ''));
  if (!m) return null;
  const mes = MESES[quitaAcentos(m[2]).toLowerCase()];
  return mes ? iso(m[3], mes, Number(m[1])) : null;
}
// "10062026" (ddmmaaaa) → 2026-06-10
const fechaCompacta = s => { const m = /^(\d{2})(\d{2})(\d{4})$/.exec(String(s || '').trim()); return m ? iso(m[3], Number(m[2]), Number(m[1])) : null; };
// "16/10/2026" → 2026-10-16
const fechaDiagonal = s => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || '')); return m ? iso(m[3], Number(m[2]), Number(m[1])) : null; };
const horaCompacta = s => { const m = /^(\d{2})(\d{2})(\d{2})$/.exec(String(s || '').trim()); return m ? `${m[1]}:${m[2]}:${m[3]}` : null; };

const vacio = () => ({
  monto: null, iva: null, concepto: null, referencia: null, clave_rastreo: null,
  fecha_operacion: null, fecha_abono: null, hora_abono: null,
  ordenante: { nombre: null, rfc: null, cuenta: null, institucion: null },
  beneficiario: { nombre: null, rfc: null, cuenta: null, institucion: null },
  certificado: null, cadena_original: false,
});
const cuentaOk = c => /^\d{10,18}$/.test(String(c || ''));

/* ---------- 1. CEP de Banxico (PDF) ---------- */
// Cadena original: ||versión|fechaOper|fechaAbono|horaAbono|claveReceptora|instEmisora|ordNombre|tipoCta|ordCuenta|ordRFC|instReceptora|benNombre|tipoCta|benCuenta|benRFC|concepto|IVA|monto|…|certificado||
function parseCadena(texto) {
  const m = /Cadena\s+Original[^|]*?(\|\|[\s\S]*?\|\|)\s*Sello/i.exec(texto);
  if (!m) return null;
  const partes = limpia(m[1]).split('|').map(s => s.trim());
  const f = partes.slice(2); while (f.length && f[f.length - 1] === '') f.pop();
  if (f.length < 18 || !fechaCompacta(f[1]) || !/^[\d.]+$/.test(f[17] || '') || !cuentaOk(f[8]) || !cuentaOk(f[13])) return null;
  return {
    fecha_operacion: fechaCompacta(f[1]), fecha_abono: fechaCompacta(f[2]), hora_abono: horaCompacta(f[3]),
    ordenante: { institucion: f[5] || null, nombre: f[6] || null, cuenta: f[8], rfc: f[9] && f[9] !== 'NA' ? f[9] : null },
    beneficiario: { institucion: f[10] || null, nombre: f[11] || null, cuenta: f[13], rfc: f[14] && f[14] !== 'NA' ? f[14] : null },
    concepto: f[15] && f[15] !== 'NA' ? f[15] : null, iva: dinero(f[16]), monto: dinero(f[17]),
    certificado: /^\d{15,25}$/.test(f[f.length - 1]) ? f[f.length - 1] : null,
  };
}

function parseBanxicoPdf(texto) {
  const d = vacio(), avisos = [];
  const lineas = texto.split('\n').map(s => s.trim());
  const cad = parseCadena(texto);
  if (cad) { Object.assign(d, { ...cad, cadena_original: true }); }
  else avisos.push('No se encontró la cadena original del CEP; se leyó solo el texto visible.');
  // Bloque de etiquetas: ...Clave de rastreo → [fecha] concepto $monto $iva referencia clave... Fecha de operación en el SPEI
  const i0 = lineas.findIndex(l => /^Clave de rastreo$/i.test(l));
  const i1 = lineas.findIndex((l, i) => i > i0 && /^Fecha de operaci[oó]n en el SPEI/i.test(l));
  if (i0 >= 0 && i1 > i0) {
    const bloque = lineas.slice(i0 + 1, i1).filter(Boolean);
    const im = bloque.findIndex(l => /^\$\s*[\d,]+\.\d{2}$/.test(l));
    if (im >= 0) {
      const fechaOp = bloque.slice(0, im).map(fechaLarga).find(Boolean);
      const concepto = bloque.slice(0, im).filter(l => !fechaLarga(l) || l.length > 22).join(' ');
      const resto = bloque.slice(im + 2);                               // lo que sigue a monto e IVA
      const ref = resto.length >= 2 && /^\d{1,12}$/.test(resto[0]) ? resto[0] : null;
      const clave = resto.length >= 2 ? resto[resto.length - 1] : (resto[0] && !/^\d{1,7}$/.test(resto[0]) ? resto[0] : null);
      const montoTxt = dinero(bloque[im]);
      if (!d.cadena_original) { d.monto = montoTxt; d.iva = dinero(bloque[im + 1]); d.concepto = concepto || null; d.fecha_operacion = fechaOp || null; }
      else if (montoTxt != null && d.monto != null && Math.abs(montoTxt - d.monto) > 0.005) avisos.push('El monto impreso no coincide con el de la cadena original: revisa el archivo.');
      if (ref) d.referencia = ref;
      if (clave && /^[A-Za-z0-9\-_.\/]{3,40}$/.test(clave)) d.clave_rastreo = clave;
    }
  }
  if (!d.cadena_original) {                                                // sin cadena: fecha/hora de abono del texto
    const ia = lineas.findIndex(l => /^Fecha de operaci[oó]n en el SPEI/i.test(l));
    if (ia >= 0) { d.fecha_abono = lineas.slice(ia + 1, ia + 5).map(fechaLarga).find(Boolean) || null; const h = lineas.slice(ia + 1, ia + 5).map(l => /^(\d{2}:\d{2}:\d{2})\s*horas/i.exec(l)).find(Boolean); d.hora_abono = h ? h[1] : null; }
  }
  return { datos: d, avisos, confianza: d.cadena_original && d.clave_rastreo ? 'alta' : (d.monto != null ? 'media' : 'baja') };
}

/* ---------- 2. Comprobante de dispersión (Polipay) ---------- */
function parsePolipay(texto) {
  const d = vacio(), kv = {};
  texto.split('\n').forEach(l => { const m = /^\s*([^:]{3,40}):\s*(.+?)\s*$/.exec(l); if (m && !(quitaAcentos(m[1]).toLowerCase() in kv)) kv[quitaAcentos(m[1]).toLowerCase().trim()] = m[2]; });
  const g = k => kv[k] || null;
  const fh = g('fecha - hora');
  d.fecha_abono = d.fecha_operacion = fh ? fechaDiagonal(fh) : null;
  const h = fh && /(\d{2}:\d{2}:\d{2})/.exec(fh); d.hora_abono = h ? h[1] : null;
  d.monto = dinero(g('monto')); d.concepto = g('concepto'); d.referencia = g('referencia numerica');
  const rastreo = g('clave de rastreo'); d.clave_rastreo = rastreo && /^[A-Za-z0-9\-_.\/]{3,40}$/.test(rastreo) ? rastreo : null;
  d.ordenante = { nombre: g('titular del ordenante'), cuenta: g('clabe del ordenante'), rfc: null, institucion: g('empresa') };
  d.beneficiario = { nombre: g('titular del beneficiario'), cuenta: g('clabe del beneficiario'), rfc: null, institucion: g('banco destino') };
  return { datos: d, avisos: [], confianza: d.monto != null && d.clave_rastreo && cuentaOk(d.beneficiario.cuenta) ? 'alta' : 'media' };
}

/* ---------- 2b. Consulta de estado del pago de Banxico: NO es un CEP (el propio documento lo dice) ---------- */
function parseConsultaEstado(texto) {
  const d = vacio(), kv = {};
  texto.split('\n').forEach(l => { const m = /^\s*(N[uú]mero de Referencia|Clave de Rastreo|Instituci[oó]n emisora del pago|Instituci[oó]n receptora del pago|Estado del pago en Banxico|Fecha y hora de recepci[oó]n|Cuenta Beneficiaria|Monto)\s+(.+?)\s*$/i.exec(l); if (m && !(quitaAcentos(m[1]).toLowerCase() in kv)) kv[quitaAcentos(m[1]).toLowerCase()] = m[2]; });
  d.clave_rastreo = kv['clave de rastreo'] && /^[A-Za-z0-9\-_.\/]{3,40}$/.test(kv['clave de rastreo']) ? kv['clave de rastreo'] : null;
  d.referencia = kv['numero de referencia'] || null; d.monto = dinero(kv['monto']);
  d.beneficiario = { nombre: null, rfc: null, cuenta: kv['cuenta beneficiaria'] || null, institucion: kv['institucion receptora del pago'] || null };
  d.ordenante = { nombre: null, rfc: null, cuenta: null, institucion: kv['institucion emisora del pago'] || null };
  const fh = kv['fecha y hora de recepcion']; d.fecha_abono = d.fecha_operacion = fh ? fechaDiagonal(fh) : null; const h = fh && /(\d{2}:\d{2}:\d{2})/.exec(fh); d.hora_abono = h ? h[1] : null;
  return { datos: d, avisos: ['Este documento NO es un CEP: es la consulta del estado del pago. Descarga el CEP en el portal de Banxico (SPEI) y súbelo.'], confianza: 'media', es_cep: false };
}

/* ---------- 3. XML del CEP (mejor esfuerzo, solo con expresiones regulares: sin entidades ni DTD) ---------- */
const atributos = s => { const o = {}; String(s || '').replace(/([A-Za-z_:][\w:.\-]*)\s*=\s*"([^"]*)"/g, (_m, k, v) => { o[quitaAcentos(k).toLowerCase().replace(/^.*:/, '')] = v; return ''; }); return o; };
const elemento = (xml, nombre) => { const m = new RegExp('<(?:[\\w.\\-]+:)?' + nombre + '\\b([^>]*)>', 'i').exec(xml); return m ? atributos(m[1]) : null; };
function parseXml(texto) {
  const xml = texto.slice(0, 300000), d = vacio(), avisos = [];
  const raiz = elemento(xml, 'SPEI_Tercero') || elemento(xml, 'CEP') || elemento(xml, 'Comprobante') || {};
  const ben = elemento(xml, 'Beneficiario') || {}, ord = elemento(xml, 'Ordenante') || {};
  d.clave_rastreo = raiz.claverastreo || ben.claverastreo || null;
  d.fecha_operacion = raiz.fechaoperacion ? (/^\d{4}-\d{2}-\d{2}/.test(raiz.fechaoperacion) ? raiz.fechaoperacion.slice(0, 10) : fechaCompacta(raiz.fechaoperacion)) : null;
  const fa = raiz.fechaabono || raiz.fechaoperacion || null;
  d.fecha_abono = fa ? (/^\d{4}-\d{2}-\d{2}/.test(fa) ? fa.slice(0, 10) : fechaCompacta(fa)) : null;
  d.hora_abono = raiz.horaabono || raiz.hora || null;
  d.monto = dinero(ben.montopago || ben.monto || raiz.montopago); d.iva = dinero(ben.iva);
  d.concepto = ben.concepto || null; d.referencia = raiz.referencianumerica || ben.referencianumerica || null;
  d.ordenante = { nombre: ord.nombre || null, rfc: ord.rfc || null, cuenta: ord.cuenta || null, institucion: ord.bancoemisor || null };
  d.beneficiario = { nombre: ben.nombre || null, rfc: ben.rfc || null, cuenta: ben.cuenta || null, institucion: ben.bancoreceptor || null };
  d.certificado = raiz.numerocertificado || null;
  if (raiz.cadenacda) { const c = parseCadena('Cadena Original ' + raiz.cadenacda + ' Sello'); if (c) { d.cadena_original = true; if (d.monto == null) d.monto = c.monto; if (!d.fecha_abono) d.fecha_abono = c.fecha_abono; } }
  if (d.monto == null && !d.clave_rastreo) avisos.push('El XML no tiene la estructura esperada del CEP de Banxico; captura los datos a mano.');
  return { datos: d, avisos, confianza: d.monto != null && d.clave_rastreo ? 'media' : 'baja' };
}

/* ---------- 4. Otros PDF de texto (recibos de bancos): lectura genérica, siempre de baja confianza ---------- */
function parseGenerico(texto) {
  const d = vacio();
  const plano = texto.replace(/[ \t]+/g, ' ');
  const rast = /clave\s+de\s+rastreo\s*[:\-]?\s*\n?\s*([A-Za-z0-9]{5,30})/i.exec(plano) || /\brastreo\s*[:\-]?\s*\n?\s*([A-Za-z0-9]{8,30})/i.exec(plano);
  d.clave_rastreo = rast ? rast[1] : null;
  const mon = /(?:monto|importe|cantidad)[^\d$\n]{0,25}\$?\s*([\d,]+\.\d{2})/i.exec(plano) || /\$\s*([\d,]+\.\d{2})/.exec(plano);
  d.monto = mon ? dinero(mon[1]) : null;
  const clabes = [...new Set((plano.match(/(?<!\d)\d{18}(?!\d)/g) || []).filter(clabeValida))];
  if (clabes.length) d.beneficiario.cuenta = clabes[clabes.length - 1];
  if (clabes.length > 1) d.ordenante.cuenta = clabes[0];
  const fecha = fechaLarga(plano) || fechaDiagonal(plano);
  d.fecha_abono = d.fecha_operacion = fecha || null;
  return { datos: d, avisos: ['Formato de comprobante no reconocido: se leyó lo que se pudo. Revisa cada dato antes de guardar.'], confianza: 'baja' };
}

/* ---------- PDF → texto (unpdf: sin dependencias; límites de páginas y de tiempo) ---------- */
let _unpdf = null;
// El PDF.js de unpdf usa `Iterator` (global desde Node 22). Render corre Node 20, donde no existe y la lectura fallaba con
// "Iterator is not defined": se define el mínimo que necesita para poder leer PDF en Node 20 también.
function asegurarIterator() {
  if (typeof globalThis.Iterator !== 'undefined') return;
  function Iterator() {}
  Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  globalThis.Iterator = Iterator;
}
async function textoDePdf(buf) {
  asegurarIterator();
  _unpdf = _unpdf || await import('unpdf');
  const doc = await _unpdf.getDocumentProxy(new Uint8Array(buf), { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  if (doc.numPages > 5) { try { await doc.destroy(); } catch (_e) { /* nada */ } throw Object.assign(new Error('pdf_muchas_paginas'), { codigo: 'pdf_muchas_paginas' }); }
  try {
    // Renglones: marca de fin de línea del PDF o cambio de posición vertical (hay PDF que solo traen lo segundo).
    let out = '';
    for (let n = 1; n <= doc.numPages; n++) {
      const tc = await (await doc.getPage(n)).getTextContent(); let lastY = null;
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        const y = it.transform ? it.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
        out += it.str; if (it.hasEOL) out += '\n'; lastY = y;
      }
      out += '\n';
    }
    return out;
  }
  finally { try { await doc.destroy(); } catch (_e) { /* nada */ } }
}

// Punto de entrada. `tipo` = mime ya validado ('application/pdf' | 'application/xml' | 'image/*').
async function extraerCep(buf, tipo) {
  const base = { formato: 'desconocido', confianza: 'baja', datos: vacio(), avisos: [], legible: false, es_cep: null };
  try {
    if (tipo === 'application/xml') {
      const r = parseXml(buf.toString('utf8').replace(/^﻿/, ''));
      return { ...base, formato: 'xml', ...r, legible: r.datos.monto != null || !!r.datos.clave_rastreo };
    }
    if (tipo === 'application/pdf') {
      const texto = await Promise.race([textoDePdf(buf), new Promise((_r, rej) => setTimeout(() => rej(Object.assign(new Error('pdf_lento'), { codigo: 'pdf_lento' })), 10000))]);
      if (texto.replace(/\s/g, '').length < 40) return { ...base, formato: 'pdf_sin_texto', avisos: ['El PDF no trae texto legible (¿es una imagen escaneada?). Captura los datos a mano.'] };
      let formato, r;
      if (/no es un Comprobante Electr[óo]nico de Pago/i.test(texto) && /Clave de Rastreo/i.test(texto)) { formato = 'consulta_estado_banxico'; r = parseConsultaEstado(texto); }
      else if (/COMPROBANTE\s+ELECTR[ÓO]NICO\s+DE\s+PAGO/i.test(texto) && /Clave de rastreo/i.test(texto) && /Fecha de operaci[oó]n en el SPEI/i.test(texto)) { formato = 'cep_banxico'; r = parseBanxicoPdf(texto); }
      else if (/Comprobante de dispersi[oó]n/i.test(texto) && /Clave de rastreo/i.test(texto)) { formato = 'dispersion_polipay'; r = parsePolipay(texto); }
      else { formato = 'pdf_generico'; r = parseGenerico(texto); }
      return { ...base, formato, ...r, legible: r.datos.monto != null || !!r.datos.clave_rastreo };
    }
    return { ...base, formato: 'imagen', avisos: ['Las imágenes no se leen automáticamente: captura los datos a mano (o sube el PDF/XML del CEP).'] };
  } catch (e) {
    if (!e.codigo) console.error('[cards] no se pudo leer el archivo del CEP:', e && e.message);
    const msg = e.codigo === 'pdf_muchas_paginas' ? 'El PDF tiene demasiadas páginas para ser un CEP.' : e.codigo === 'pdf_lento' ? 'El PDF tardó demasiado en leerse.' : 'No se pudo leer el archivo.';
    return { ...base, formato: 'error', avisos: [msg] };
  }
}

/* ---------- Verificación contra lo capturado ---------- */
// `f` = { monto_recibido, clave_rastreo, clabe_destino, fecha }.  duro = una diferencia aquí exige nota al validar.
function verificar(datos, f) {
  const checks = [];
  const add = (campo, etiqueta, cep, cap, ok, duro) => checks.push({ campo, etiqueta, cep, capturado: cap, estado: cep == null || cep === '' ? 'sin_dato' : (ok ? 'ok' : 'difiere'), duro });
  add('monto', 'Monto', datos.monto, Number(f.monto_recibido), datos.monto != null && Math.abs(Number(datos.monto) - Number(f.monto_recibido)) <= 0.01, true);
  add('clabe', 'CLABE beneficiaria', datos.beneficiario && datos.beneficiario.cuenta, f.clabe_destino, datos.beneficiario && datos.beneficiario.cuenta === String(f.clabe_destino), true);
  add('rastreo', 'Clave de rastreo', datos.clave_rastreo, f.clave_rastreo || null, !!f.clave_rastreo && String(datos.clave_rastreo).toUpperCase() === String(f.clave_rastreo).toUpperCase(), true);
  add('fecha', 'Fecha de abono', datos.fecha_abono, f.fecha, datos.fecha_abono === f.fecha, false);
  // Titular y banco de la cuenta de fondeo: lo que dice el CEP debe ser lo que se definió para esa CLABE.
  const ben = datos.beneficiario || {};
  if (f.beneficiario_destino) add('beneficiario', 'Beneficiario', ben.nombre, f.beneficiario_destino, BNK.nombresCoinciden(ben.nombre, f.beneficiario_destino) === true, true);
  if (f.banco_codigo_destino) add('banco', 'Banco beneficiario', ben.institucion, f.banco_destino, BNK.bancoCoincide(ben.institucion, { codigo_spei: f.banco_codigo_destino, nombre: f.banco_destino }, f.bancos) === true, true);
  const conflicto = checks.some(c => c.duro && c.estado === 'difiere');
  const leidos = checks.filter(c => c.estado !== 'sin_dato').length;
  return { checks, conflicto, coincide: leidos > 0 && !checks.some(c => c.estado === 'difiere'), leidos };
}

module.exports = { extraerCep, verificar, parseCadena, parseBanxicoPdf, parsePolipay, parseConsultaEstado, parseXml, parseGenerico, fechaLarga, fechaCompacta, round2 };
