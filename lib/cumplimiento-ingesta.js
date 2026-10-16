/* ============================================================================
   lib/cumplimiento-ingesta.js — Lectura del archivo del gateway para la base de
   transacciones de CUMPLIMIENTO (PLD / antifraude). Independiente de la ingesta
   de liquidación: acepta TODAS las operaciones, sea cual sea su estatus.
   Funciones puras (sin BD) para poder probarlas aisladas.
   ========================================================================= */
'use strict';
const crypto = require('crypto');
const XLSX = require('xlsx');
const E = require('../engine.js');
const { normHeader } = require('./excel.js');

// Encabezados del gateway ya normalizados (lib/excel.js → normHeader) por campo.
const ALIAS = {
  id_gateway:          ['id', 'id_gateway', 'id_transaccion', 'id_de_transaccion', 'transaction_id'],
  fecha:               ['fecha_local', 'fecha', 'fecha_operacion', 'fecha_transaccion', 'date'],
  hora:                ['hora_local', 'hora', 'hora_operacion', 'time'],
  fecha_utc:           ['fecha_creacion_utc', 'fecha_utc', 'fecha_creacion'],
  cliente:             ['cliente', 'grupo', 'nombre_cliente'],
  comercio:            ['comercio', 'nombre_comercio', 'merchant'],
  numero_afiliacion:   ['afiliacion', 'numero_afiliacion', 'no_afiliacion', 'num_afiliacion', 'id_afiliacion'],
  estatus:             ['estatus', 'estado', 'status'],
  estatus_fin:         ['estatus_finan', 'estatus_financiero', 'estatus_fin'],
  tipo_trans:          ['tipo_trans', 'tipo_transaccion', 'tipo_de_transaccion'],
  producto:            ['producto', 'tipo_producto', 'tipo_de_producto'],
  metodo:              ['metodo', 'marca', 'red'],
  monto:               ['monto', 'importe', 'monto_venta', 'monto_operacion', 'monto_transaccion', 'amount', 'total'],
  propina:             ['propina', 'tip'],
  cashback:            ['cashback', 'cash_back'],
  meses:               ['meses', 'msi'],
  folio:               ['folio', 'no_folio'],
  referencia:          ['referencia', 'ref'],
  referencia_anterior: ['referencia_anterior', 'ref_anterior'],
  autorizacion:        ['autorizacion', 'codigo_autorizacion', 'no_autorizacion', 'auth'],
  terminal:            ['terminal', 'no_terminal'],
  bin:                 ['bin', 'bin_tarjeta', 'primeros_6', 'primeros_8'],
  ultimos4:            ['ultimos_4', 'ultimos4', 'ultimos_4_digitos', 'last4'],
  emisor:              ['emisor', 'banco_emisor', 'issuer'],
  agregador:           ['agregador', 'aggregator'],
  banco_adq:           ['bancoadq', 'banco_adq', 'banco_adquirente', 'adquirente'],
  modo_entrada:        ['modo_entrada_url', 'modo_entrada', 'modo_de_entrada', 'entry_mode'],
  // Motivo/respuesta del rechazo (fondos insuficientes, tarjeta robada o perdida…): alimenta las alertas POL-CUM-FOR-006.
  motivo:              ['motivo', 'motivo_rechazo', 'motivo_de_rechazo', 'mensaje', 'mensaje_respuesta', 'descripcion_respuesta', 'respuesta', 'codigo_respuesta', 'response_message', 'response_code'],
};
const CAMPOS_TEXTO = ['id_gateway', 'cliente', 'comercio', 'numero_afiliacion', 'estatus', 'estatus_fin', 'tipo_trans', 'producto', 'metodo',
  'folio', 'referencia', 'referencia_anterior', 'autorizacion', 'terminal', 'emisor', 'agregador', 'banco_adq', 'modo_entrada', 'motivo'];
const EN_MAYUSCULAS = new Set(['estatus', 'estatus_fin', 'tipo_trans', 'emisor', 'agregador', 'banco_adq', 'modo_entrada', 'motivo']);

function pick(o, campo) {
  for (const a of ALIAS[campo]) { if (o[a] != null && String(o[a]).trim() !== '') return o[a]; }
  return '';
}
const vacio = v => v == null || String(v).trim() === '';

// Normaliza una fila del archivo. Devuelve { ok:true, r } o { ok:false, motivo }.
// `hmac` es C.hmac del servidor (huella de tarjeta); se inyecta para no acoplar este módulo a las llaves.
function normalizarFila(o, hmac) {
  const f = E.parseFecha(pick(o, 'fecha'));
  if (!f) return { ok: false, motivo: 'fecha' };
  const montoRaw = pick(o, 'monto');
  // E.parseMonto devuelve 0 si no entiende el texto: sin esta guarda un "abc" entraría como $0 en silencio.
  if (vacio(montoRaw) || (typeof montoRaw !== 'number' && !/\d/.test(String(montoRaw)))) return { ok: false, motivo: 'monto' };
  const monto = E.parseMonto(montoRaw);
  if (!Number.isFinite(monto)) return { ok: false, motivo: 'monto' };

  const r = { fecha: E.isoFecha(f), hora: E.horaStr(pick(o, 'hora')) || null, monto };
  for (const c of CAMPOS_TEXTO) {
    const s = String(pick(o, c) == null ? '' : pick(o, c)).trim();
    r[c] = s ? (EN_MAYUSCULAS.has(c) ? s.toUpperCase() : s) : null;
  }
  // Algunos exports del gateway traen el estatus en femenino ("APROBADA"): todo el sistema usa "APROBADO".
  if (r.estatus && /^APROBAD[AO]S?$/.test(r.estatus)) r.estatus = 'APROBADO';
  r.numero_afiliacion = r.numero_afiliacion ? r.numero_afiliacion.replace(/\D/g, '') || null : null;
  const fu = pick(o, 'fecha_utc');
  r.fecha_utc = fu instanceof Date ? fu.toISOString() : (vacio(fu) ? null : String(fu).trim());
  r.propina = vacio(pick(o, 'propina')) ? null : E.parseMonto(pick(o, 'propina'));
  r.cashback = vacio(pick(o, 'cashback')) ? null : E.parseMonto(pick(o, 'cashback'));
  const meses = parseInt(String(pick(o, 'meses')).replace(/\D/g, ''), 10);
  r.meses = Number.isFinite(meses) ? meses : null;

  const dig = v => String(v == null ? '' : v).replace(/\D/g, '');
  r.bin = dig(pick(o, 'bin')).slice(0, 8) || null;
  const u4 = dig(pick(o, 'ultimos4'));
  r.ultimos4 = u4 ? u4.slice(-4).padStart(4, '0') : null;     // Excel pierde el cero a la izquierda (234 → 0234)
  r.tarjeta_key = (hmac && r.bin && r.bin.length >= 6 && r.ultimos4) ? hmac(r.bin.slice(0, 6) + '|' + r.ultimos4) : null;

  // Llave anti-duplicados: el ID del gateway si viene; si no, hash de la fila.
  r.llave = r.id_gateway
    ? 'gw:' + r.id_gateway
    : 'h:' + crypto.createHash('sha256').update([r.fecha, r.hora, r.numero_afiliacion, r.monto, r.folio, r.referencia, r.autorizacion, r.terminal, r.bin, r.ultimos4, r.estatus].join('|')).digest('hex');
  return { ok: true, r };
}


/* ---------- Lectura por BLOQUES (memoria acotada) ----------
   Un archivo grande NO se materializa completo (filas → objetos → bloques): el servidor tiene poca
   RAM y 50,000 filas llegaron a tumbarlo (heap out of memory). Aquí se procesa de a `tam` filas. */
const MAX_FILAS_CSV = 100000, MAX_FILAS_XLSX = 30000;

// Lector CSV/TSV por flujo: genera una fila (arreglo de campos) a la vez.
function* filasCsv(texto) {
  let i = texto.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const nl = texto.indexOf('\n', i);
  const primera = texto.slice(i, nl < 0 ? texto.length : nl);
  const delim = primera.includes('\t') && !primera.includes(',') ? '\t' : (primera.split(';').length > primera.split(',').length ? ';' : ',');
  let campo = '', fila = [], q = false;
  for (const L = texto.length; i < L; i++) {
    const ch = texto[i];
    if (q) { if (ch === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && texto[i + 1] === '\n') i++; fila.push(campo); campo = ''; yield fila; fila = []; }
    else campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); yield fila; }
}
const filaVacia = a => a.every(c => c == null || String(c).trim() === '');

// Llama a `alBloque(objs)` con bloques de hasta `tam` filas (objetos con encabezados normalizados).
// Devuelve { tipo, filas }. Lanza { codigo, mensaje } si el archivo no se puede leer o excede el tope.
async function leerPorBloques(buffer, tam, alBloque) {
  const esZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B;
  const esOle = buffer.length > 4 && buffer[0] === 0xD0 && buffer[1] === 0xCF;
  let total = 0;
  if (esZip || esOle) {
    let wb;
    try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }); }
    catch (e) { throw { codigo: 'archivo_ilegible', mensaje: 'No se pudo leer el archivo Excel.' }; }
    // La hoja con más filas (igual que la ingesta de liquidación).
    let mejor = null;
    for (const n of wb.SheetNames) {
      const ws = wb.Sheets[n]; if (!ws || !ws['!ref']) continue;
      const r = XLSX.utils.decode_range(ws['!ref']);
      if (!mejor || r.e.r > mejor.rango.e.r) mejor = { ws, rango: r };
    }
    if (!mejor) throw { codigo: 'sin_datos', mensaje: 'El archivo no trae filas.' };
    const { ws, rango } = mejor; const filas = rango.e.r;       // sin contar el encabezado
    if (filas > MAX_FILAS_XLSX) throw { codigo: 'archivo_muy_grande', mensaje: `El archivo Excel trae ${filas} filas; el máximo por carga es ${MAX_FILAS_XLSX}. Divídelo por rango de fechas, o súbelo como CSV (admite hasta ${MAX_FILAS_CSV}).` };
    const head = (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, range: { s: { r: 0, c: rango.s.c }, e: { r: 0, c: rango.e.c } } })[0] || []).map(h => normHeader(h));
    for (let r0 = 1; r0 <= rango.e.r; r0 += tam) {
      const r1 = Math.min(r0 + tam - 1, rango.e.r);
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, range: { s: { r: r0, c: rango.s.c }, e: { r: r1, c: rango.e.c } } });
      const objs = [];
      for (const a of arr) { if (filaVacia(a)) continue; const o = {}; head.forEach((h, i) => { if (h) o[h] = a[i] != null ? a[i] : ''; }); objs.push(o); }
      total += objs.length;
      if (objs.length) await alBloque(objs);
    }
    return { tipo: 'xlsx', filas: total };
  }
  // CSV / TSV
  let saltos = 0; for (let i = buffer.indexOf(10); i !== -1; i = buffer.indexOf(10, i + 1)) saltos++;
  if (saltos > MAX_FILAS_CSV + 2) throw { codigo: 'archivo_muy_grande', mensaje: `El archivo trae unas ${saltos} filas; el máximo por carga es ${MAX_FILAS_CSV}. Divídelo por rango de fechas.` };
  let head = null, objs = [];
  for (const a of filasCsv(buffer.toString('utf8'))) {
    if (!head) { head = a.map(h => normHeader(h)); continue; }
    if (filaVacia(a)) continue;
    const o = {}; head.forEach((h, i) => { if (h) o[h] = a[i] != null ? a[i] : ''; });
    objs.push(o); total++;
    if (objs.length >= tam) { const b = objs; objs = []; await alBloque(b); }
  }
  if (objs.length) await alBloque(objs);
  if (!total) throw { codigo: 'sin_datos', mensaje: 'El archivo no trae filas.' };
  return { tipo: 'csv', filas: total };
}

// Orden de columnas al insertar (debe coincidir con db/schema-cumplimiento.sql).
const COLUMNAS = ['llave', 'id_gateway', 'fecha', 'hora', 'fecha_utc', 'cliente', 'comercio', 'numero_afiliacion', 'estatus', 'estatus_fin', 'tipo_trans',
  'producto', 'metodo', 'monto', 'propina', 'cashback', 'meses', 'folio', 'referencia', 'referencia_anterior', 'autorizacion', 'terminal',
  'bin', 'ultimos4', 'tarjeta_key', 'emisor', 'agregador', 'banco_adq', 'modo_entrada', 'motivo'];

// Encabezados que usa el gateway (para la plantilla descargable).
const ENCABEZADOS_GATEWAY = ['ID', 'Fecha local', 'Hora local', 'Fecha Creación UTC', 'Cliente', 'Comercio', 'Afiliación', 'Estatus', 'BIN', 'Últimos 4',
  'Estatus Finan.', 'Método', 'Terminal', 'Tipo Trans.', 'Producto', 'Folio', 'Referencia', 'Referencia anterior', 'Autorización', 'Meses',
  'Monto', 'Propina', 'Cashback', 'Emisor', 'Agregador', 'BancoAdq', 'Modo Entrada URL'];

module.exports = { ALIAS, normalizarFila, leerPorBloques, COLUMNAS, ENCABEZADOS_GATEWAY, MAX_FILAS_CSV, MAX_FILAS_XLSX };
