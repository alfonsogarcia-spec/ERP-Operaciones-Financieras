/* ============================================================================
   lib/cards-comprobante.js — Validación del COMPROBANTE DEL SALDO ASIGNADO (Cards).
   Tesorería sube la evidencia del sistema donde se ve el saldo asignado (PDF, Excel o captura). Igual que con el CEP, el sistema
   la lee y valida que el monto concilie con lo calculado (el fondeo neto de la solicitud):
     · PDF con texto y Excel → se leen todos los importes del archivo; debe aparecer el calculado.
     · Captura (imagen) o archivo sin importes legibles → no hay OCR: tesorería captura el monto que ve y debe ser el calculado.
   Funciones puras salvo `extraerMontos` (lee el archivo).
   ========================================================================= */
'use strict';
const CEPX = require('./cards-cep-extract.js');

const TOL = 0.01;
const MAX_MONTOS = 400;                       // importes que se guardan/consideran por archivo
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const mxn = n => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const quitaAcentos = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = s => quitaAcentos(s).toUpperCase().replace(/\s+/g, ' ').trim();

/* Importes de un texto: "$300,000.00", "300,000.00", "300000.00", "$ 300000". Se descartan fechas, folios largos y cuentas. */
function montosDeTexto(texto) {
  const out = [];
  const t = String(texto == null ? '' : texto);
  const re = /\$\s*\d[\d,]*(?:\.\d+)?|(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])|(?<![\d.,/-])\d+\.\d{1,2}(?![\d/-])/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const n = Number(m[0].replace(/[$,\s]/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 1e12) out.push(round2(n));
    if (out.length >= MAX_MONTOS) break;
  }
  return out;
}

/* Lee el archivo y devuelve { formato: 'pdf'|'xlsx'|'imagen'|'error', legible, montos: [..], texto } (texto en MAYÚSCULAS sin acentos, para buscar el destino). */
async function extraerMontos(buf, mime) {
  try {
    if (mime === 'application/pdf') {
      const texto = await Promise.race([CEPX.textoDePdf(buf), new Promise((_r, rej) => setTimeout(() => rej(new Error('pdf_lento')), 10000))]);
      if (texto.replace(/\s/g, '').length < 20) return { formato: 'pdf', legible: false, montos: [], texto: '', aviso: 'El PDF no trae texto legible (¿es una imagen?).' };
      const montos = montosDeTexto(texto);
      return { formato: 'pdf', legible: montos.length > 0, montos, texto: norm(texto).slice(0, 60000), aviso: montos.length ? null : 'No se encontraron importes en el PDF.' };
    }
    if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
      const montos = [], textos = [];
      for (const nombre of wb.SheetNames.slice(0, 5)) {
        const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, raw: true, defval: null, blankrows: false }).slice(0, 3000);
        for (const fila of filas) for (const c of fila.slice(0, 60)) {
          if (typeof c === 'number') { if (c > 0 && c < 1e12 && montos.length < MAX_MONTOS) montos.push(round2(c)); }
          else if (typeof c === 'string' && c.trim()) { textos.push(c); for (const x of montosDeTexto(c)) if (montos.length < MAX_MONTOS) montos.push(x); }
        }
      }
      return { formato: 'xlsx', legible: montos.length > 0, montos, texto: norm(textos.join(' | ')).slice(0, 60000), aviso: montos.length ? null : 'No se encontraron importes en el Excel.' };
    }
    return { formato: 'imagen', legible: false, montos: [], texto: '', aviso: 'Las imágenes no se leen automáticamente.' };
  } catch (e) {
    return { formato: 'error', legible: false, montos: [], texto: '', aviso: e && e.message === 'pdf_lento' ? 'El PDF tardó demasiado en leerse.' : 'No se pudo leer el archivo.' };
  }
}

/* ¿El comprobante menciona a quién se asignó el saldo? (nombre de la entidad/empresa, correo del usuario o terminación de la CLABE). Solo informa. */
function mencionaDestino(texto, ctx) {
  if (!texto) return null;
  const buscar = [];
  for (const v of [ctx.entidad_nombre, ctx.empresa_nombre, ctx.empresa_comercial]) { const n = norm(v); if (n.length >= 4) buscar.push(n); }
  if (ctx.correo_usuario) buscar.push(norm(ctx.correo_usuario));
  if (ctx.clabe && String(ctx.clabe).length === 18) buscar.push(String(ctx.clabe));
  return buscar.some(b => texto.includes(b));
}

/* Evalúa lo leído contra lo calculado.
   lectura = salida de extraerMontos · ctx = { esperado, recibido?, capturado?, entidad_nombre, empresa_nombre, correo_usuario, clabe }
   Devuelve { ok, codigo?, mensaje?, monto?, origen: 'lectura'|'captura', checks, datos }. */
function evaluarComprobante(lectura, ctx) {
  const esperado = round2(ctx.esperado);
  const iguales = (a, b) => Math.round(Math.abs(Number(a) - Number(b)) * 100) <= Math.round(TOL * 100);   // en centavos: evita el error de coma flotante
  const base = { checks: [], datos: { formato: lectura.formato, montos: [...new Set(lectura.montos)].slice(0, 30), destino: null } };
  base.datos.destino = mencionaDestino(lectura.texto, ctx);
  const destinoCheck = () => base.datos.destino === true ? [{ campo: 'destino', etiqueta: 'Destino', leido: 'Aparece en el comprobante', esperado: null, estado: 'ok' }] : [];
  const sugerencia = m => {
    if (ctx.recibido != null && iguales(m, ctx.recibido) && !iguales(m, esperado)) return ` Ese monto es el total depositado (con comisión e IVA); el saldo asignado debe ser el fondeo neto de ${mxn(esperado)}.`;
    return '';
  };
  const noCoincide = (vistos, desde) => ({ ok: false, codigo: 'monto_no_coincide', ...base,
    mensaje: `El monto del comprobante no coincide con lo calculado: ${desde} y el fondeo calculado es ${mxn(esperado)}.${vistos.length === 1 ? sugerencia(vistos[0]) : ''} Verifica que se haya asignado el saldo correcto en el sistema.` });

  if (lectura.legible && lectura.montos.length) {
    const hit = lectura.montos.find(m => iguales(m, esperado));
    if (hit !== undefined) return { ok: true, monto: esperado, origen: 'lectura', ...base, checks: [{ campo: 'monto', etiqueta: 'Saldo asignado', leido: esperado, esperado, estado: 'ok' }, ...destinoCheck()] };
    const unicos = [...new Set(lectura.montos)];
    const lista = unicos.slice(0, 6).map(mxn).join(', ') + (unicos.length > 6 ? ' …' : '');
    const r = noCoincide(unicos, `el archivo trae ${unicos.length === 1 ? 'el importe' : 'los importes'} ${lista}`);
    r.checks = [{ campo: 'monto', etiqueta: 'Saldo asignado', leido: unicos.length === 1 ? unicos[0] : null, esperado, estado: 'difiere' }];
    return r;
  }
  // Sin importes legibles (captura, imagen, PDF escaneado): el monto lo captura tesorería.
  // Lo que escribe tesorería: acepta "$300,000.00", "300,000" o "300000.5".
  const cap = ctx.capturado == null ? null : String(ctx.capturado).replace(/[$,\s]|MXN/gi, '');
  if (cap === null || cap === '' || !Number.isFinite(Number(cap)))
    return { ok: false, codigo: 'monto_requerido', ...base, mensaje: `${lectura.aviso || 'No se pudo leer el monto del archivo.'} Escribe el monto de saldo asignado que muestra el comprobante para validarlo contra lo calculado.`, legible: false };
  if (!(Number(cap) > 0) || Number(cap) > 1e11) return { ok: false, codigo: 'monto_invalido', ...base, mensaje: 'El monto capturado debe ser mayor a 0.' };
  const c = round2(cap);
  if (!iguales(c, esperado)) {
    const r = noCoincide([c], `capturaste ${mxn(c)}`);
    r.checks = [{ campo: 'monto', etiqueta: 'Saldo asignado', leido: c, esperado, estado: 'difiere' }];
    return r;
  }
  return { ok: true, monto: c, origen: 'captura', ...base, checks: [{ campo: 'monto', etiqueta: 'Saldo asignado (capturado por tesorería)', leido: c, esperado, estado: 'ok' }] };
}

module.exports = { TOL, montosDeTexto, extraerMontos, mencionaDestino, evaluarComprobante };
