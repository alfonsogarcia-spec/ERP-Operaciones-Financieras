/* ============================================================================
   lib/catalogo-layout.js — Modificación de Grupos y afiliaciones por LAYOUT (Excel/CSV). Funciones puras (sin base de datos).

   El layout es el mismo archivo que se descarga en «Descargar catálogo»: una fila por relación grupo ↔ afiliación. Se modifica y se vuelve a subir.
   Reglas (pensadas para que un error de captura no cambie dinero en silencio):
     · Primero se SIMULA: se compara contra lo que hay hoy y se muestra cada cambio (antes → después). Nada se escribe hasta confirmar.
     · Celda vacía = NO cambiar (no se convierte en 0). En una relación nueva, vacío en tasas = 0 (con aviso).
     · «PARAM» en int_amex, int_int o fee_broxel = volver a usar el valor de Parámetros (queda en nulo).
     · Las tasas van como NÚMERO DE PORCENTAJE (2.5 = 2.5 %), en columnas con sufijo _pct (tasa_pac_tdd_pct…). No hay que pensar en decimales como 0.025.
       Compatibilidad: un archivo viejo con columnas sin _pct se sigue leyendo como antes (fracción 0.025 o «2.5%»; un 2.5 suelto se rechaza). Fuera de rango es error.
     · Un error en cualquier fila bloquea todo el archivo (todo o nada).
     · El layout no borra: lo que no venga en el archivo se queda como está.
   ========================================================================= */
'use strict';
const MCC = require('./mcc.js');

const CAMPOS_TASA = ['tasa_pac_tdd', 'tasa_pac_tdc', 'tasa_pac_amex', 'tasa_pac_int', 'pct_banca'];
const CAMPOS_COSTO_TASA = ['int_tdd', 'int_tdc', 'int_amex', 'int_int', 'fee_broxel'];
const CAMPOS_ANULABLES = ['int_amex', 'int_int', 'fee_broxel'];             // nulo = usa Parámetros
const CAMPOS_RELACION = [...CAMPOS_TASA, 'costo_x_trx'];                      // viven en afil_grupo
const CAMPOS_COSTOS = CAMPOS_COSTO_TASA;                                      // viven en costos (por afiliación)
const CAMPOS_AFILIACION = ['razon_social', 'mcc'];                            // viven en afiliaciones
// Columnas que se calculan al descargar: se ignoran al subir.
const COLUMNAS_INFORMATIVAS = ['tasa_descuento_tdd', 'tasa_descuento_tdc', 'tasa_descuento_amex', 'tasa_descuento_int', 'descripcion_giro',
  'tasa_descuento_tdd_pct', 'tasa_descuento_tdc_pct', 'tasa_descuento_amex_pct', 'tasa_descuento_int_pct'];
// Columnas que son tasa (porcentaje): en el layout nuevo llevan sufijo _pct y se capturan como número de porcentaje.
const CAMPOS_PORCENTAJE = [...CAMPOS_TASA, ...CAMPOS_COSTO_TASA];
const sufijo = c => c + '_pct';
const COLUMNAS_EDITABLES = ['id_grupo', 'nombre_cliente', 'numero_afiliacion', 'razon_social', ...CAMPOS_RELACION, ...CAMPOS_COSTOS, 'mcc', ...CAMPOS_PORCENTAJE.map(sufijo)];
const OBLIGATORIAS = ['id_grupo', 'numero_afiliacion'];

const MAX_ID_GRUPO = 2147483647, MAX_AFIL = 20, MAX_NOMBRE = 120, MAX_RAZON = 200;
const limpiaTexto = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
/* Nombre comparable: sin acentos, mayúsculas ni espacios de más. Las transacciones se ligan al grupo por NOMBRE de cliente; dos grupos con el mismo
   nombre dejan ambigua la liquidación (cuál grupo toma las transacciones, cuáles tasas, cuál cuenta). */
const normNombre = v => limpiaTexto(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const vacio = v => v === undefined || v === null || String(v).trim() === '';
const soloDigitos = v => String(v == null ? '' : v).replace(/\D/g, '');
const redondea = n => Math.round(n * 1e8) / 1e8;
const igual = (a, b) => (a == null || b == null) ? a == b : redondea(Number(a)) === redondea(Number(b));
const esParam = v => /^(param|params|parametro|parametros|parámetro|parámetros)$/i.test(String(v == null ? '' : v).trim());

/* Número de una celda: acepta 0.025, "2.5%", "$1,200.50", "0,025". → { ok, valor, porcentaje } */
function leerNumero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, valor: v, porcentaje: false } : { ok: false };
  let s = String(v).trim().replace(/\s+/g, '').replace(/^\$/, '');
  let pct = false;
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1); }
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');           // coma decimal
  else s = s.replace(/,/g, '');                                  // coma de miles
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, valor: pct ? n / 100 : n, porcentaje: pct };
}

const pct = n => (Math.round(n * 1e6) / 1e4).toLocaleString('es-MX', { maximumFractionDigits: 4 }) + '%';

/* Lee una celda de tasa/costo. → { vacio } | { param } | { valor, aviso? } | { error }
   modo 'pct' (layout nuevo, columna *_pct): el número ES el porcentaje (2.5 → 2.5 % → 0.025). "2.5%" también vale. Menor a 100.
   modo 'frac' (archivo viejo, columna sin sufijo): fracción 0.025 o «2.5%»; un 2.5 suelto se rechaza para no confundirlo con 250 %. */
function leerTasa(v, campo, modo = 'frac') {
  if (vacio(v)) return { vacio: true };
  if (CAMPOS_ANULABLES.includes(campo) && esParam(v)) return { param: true };
  const r = leerNumero(v);
  const col = modo === 'pct' ? sufijo(campo) : campo;
  if (!r.ok) return { error: `${col}: «${String(v).trim()}» no es un número` };
  if (r.valor < 0) return { error: `${col}: no puede ser negativa` };
  if (modo === 'pct') {
    const valor = r.porcentaje ? r.valor : r.valor / 100;                 // «2.5%» ya viene dividido; 2.5 suelto es el porcentaje
    if (valor >= 1) return { error: `${col}: ${pct(r.porcentaje ? r.valor : r.valor / 100)} está fuera de rango (debe ser menor a 100).` };
    const out = { valor: redondea(valor) };
    if (valor > 0 && valor < 0.0005) out.aviso = `${col}: ${pct(valor)} es muy pequeño. Recuerda que aquí se escribe el porcentaje (2.5 = 2.5%), no la fracción (0.025).`;
    return out;
  }
  if (r.valor >= 1) {
    const sug = !r.porcentaje && r.valor < 100 ? ` ¿Quisiste ${r.valor}%? Escribe ${r.valor}% o ${r.valor / 100}.` : '';
    return { error: `${col}: ${r.valor} está fuera de rango (debe ser menor a 1 = 100%).${sug}` };
  }
  return { valor: redondea(r.valor) };
}

function leerMonto(v, campo) {
  if (vacio(v)) return { vacio: true };
  const r = leerNumero(v);
  if (!r.ok) return { error: `${campo}: «${String(v).trim()}» no es un número` };
  if (r.valor < 0) return { error: `${campo}: no puede ser negativo` };
  if (r.porcentaje) return { error: `${campo} es un monto en pesos, no un porcentaje` };
  return { valor: Math.round(r.valor * 100) / 100 };
}

/* Antes de planificar: un encabezado crudo con «%» (p. ej. «Fee Broxel (%)», «tasa_pac_tdd_%») se lee como columna de porcentaje (_pct), porque
   normHeader borra el signo y la columna caería en el modo de fracción (0.3 se guardaría como 30 %). Devuelve { objs, headers, avisos }. */
function prepararLayout(parsed) {
  const raw = parsed.rawHeaders || [], headers = (parsed.headers || []).slice(), avisos = [...(parsed.avisos || [])];
  const ren = new Map();
  headers.forEach((h, i) => { if (/%/.test(String(raw[i] == null ? '' : raw[i])) && CAMPOS_PORCENTAJE.includes(h)) { ren.set(h, sufijo(h)); headers[i] = sufijo(h); } });
  let objs = parsed.objs;
  if (ren.size) {
    objs = parsed.objs.map(o => { const n = { ...o }; for (const [a, b] of ren) if (a in n) { n[b] = n[a]; delete n[a]; } return n; });
    avisos.push(`Encabezados con «%» leídos como porcentaje: ${[...ren].map(([a, b]) => a + ' → ' + b).join(', ')}`);
  }
  if (parsed.celdasPct) avisos.push(`${parsed.celdasPct} celda(s) con formato de porcentaje de Excel se leyeron como porcentaje (0.025 con formato % = 2.5)`);
  return { ...parsed, objs, headers, avisos };
}

/* Estado actual → índices. actual = { grupos:[{id_grupo,nombre_cliente}], afiliaciones:[{numero_afiliacion,razon_social,mcc,descripcion_giro}],
   afilGrupo:[{id_grupo,numero_afiliacion,tasa_pac_*,costo_x_trx,pct_banca}], costos:[{numero_afiliacion,int_*,fee_broxel}] } */
function indexar(actual) {
  const num = v => (v == null ? null : Number(v));
  const grupos = new Map((actual.grupos || []).map(g => [Number(g.id_grupo), String(g.nombre_cliente || '')]));
  const afiliaciones = new Map((actual.afiliaciones || []).map(a => [String(a.numero_afiliacion), a]));
  const afilGrupo = new Map((actual.afilGrupo || []).map(r => [Number(r.id_grupo) + '|' + String(r.numero_afiliacion), r]));
  const costos = new Map((actual.costos || []).map(c => [String(c.numero_afiliacion), c]));
  const sinCeros = new Map();
  for (const k of afiliaciones.keys()) { const s = k.replace(/^0+/, ''); (sinCeros.get(s) || sinCeros.set(s, []).get(s)).push(k); }
  const gruposDeAfil = new Map();                       // afil → [id_grupo] (para avisar cuando un costo compartido toca grupos que no vienen en el archivo)
  for (const r of (actual.afilGrupo || [])) { const k = String(r.numero_afiliacion); (gruposDeAfil.get(k) || gruposDeAfil.set(k, []).get(k)).push(Number(r.id_grupo)); }
  return { grupos, afiliaciones, afilGrupo, costos, sinCeros, gruposDeAfil, num };
}

/* Un cambio de ×5 o más (o de una quinta parte) casi siempre es un error de escala (p. ej. 2.5 donde iba 0.25): se avisa. */
function saltoGrande(campo, antes, despues, avi) {
  if (despues == null || !(despues > 0)) return;
  // Venía en 0 (o sin valor) y ahora es de 5 % o más: no hay con qué comparar la escala, se pide confirmar.
  if ((antes == null || antes === 0) && despues >= 0.05) { avi(`${campo} pasa de ${antes == null ? 'vacío' : '0%'} a ${pct(despues)}: confirma que la escala es correcta`); return; }
  if (antes == null || !(antes > 0)) return;
  const r = despues / antes;
  if (r >= 5 || r <= 0.2) avi(`${campo} cambia de ${pct(antes)} a ${pct(despues)} (${r >= 1 ? '×' + Math.round(r * 10) / 10 : 'a ' + Math.round(r * 100) + '%'} de lo actual): revisa que no sea un error de escala`);
}

/* Compara un valor actual contra el del archivo y arma el cambio. */
function cambio(campo, antes, despues) { return { campo, antes: antes == null ? null : antes, despues: despues == null ? null : despues }; }

/* Planifica el layout. filas = objetos con encabezados normalizados (X.parseBuffer/parseCSVText), headers = lista de encabezados.
   params = { tasa_int_amex, tasa_int_int, fee_broxel } (para avisar de margen negativo). */
function planificar(filas, actual, opciones = {}) {
  const headers = opciones.headers || (filas[0] ? Object.keys(filas[0]) : []);
  const params = opciones.params || {};
  const ix = indexar(actual);
  const errorArchivo = [];
  for (const h of OBLIGATORIAS) if (!headers.includes(h)) errorArchivo.push(`Falta la columna «${h}». Descarga el catálogo y úsalo como base.`);
  // Cada columna de tasa puede venir como *_pct (porcentaje) o en el formato viejo (fracción). Si vienen las dos, manda la _pct.
  const modoDe = c => (headers.includes(sufijo(c)) ? 'pct' : 'frac');
  const celda = (o, c) => (modoDe(c) === 'pct' ? o[sufijo(c)] : o[c]);
  const ignoradas = headers.filter(h => h && !COLUMNAS_EDITABLES.includes(h) && !COLUMNAS_INFORMATIVAS.includes(h));
  const ambas = CAMPOS_PORCENTAJE.filter(c => headers.includes(c) && headers.includes(sufijo(c)));
  // Todas las columnas de tasa deben venir en el mismo modo: o todas _pct (porcentaje) o todas sin sufijo (archivo anterior, fracción).
  const modosVistos = new Set(CAMPOS_PORCENTAJE.filter(c => headers.includes(c) || headers.includes(sufijo(c))).map(modoDe));
  const modo_tasas = modosVistos.size === 0 ? 'sin_tasas' : modosVistos.size === 2 ? 'mixto' : (modosVistos.has('pct') ? 'porcentaje' : 'fraccion');
  if (modo_tasas === 'mixto') errorArchivo.push('El archivo mezcla columnas de tasa con _pct (porcentaje: 2.5 = 2.5%) y sin _pct (formato anterior: 0.025 = 2.5%). Usa solo una forma; lo recomendado es todas con _pct.');
  if (ambas.length) errorArchivo.push(`El archivo trae la tasa dos veces (${ambas.map(c => c + ' y ' + sufijo(c)).join(', ')}). Deja solo la columna con _pct.`);
  const informativas = headers.filter(h => COLUMNAS_INFORMATIVAS.includes(h));

  const out = { filas: [], grupos_nuevos: [], renombres: [], columnas_ignoradas: ignoradas, columnas_informativas: informativas, errores_archivo: errorArchivo, modo_tasas, avisos_archivo: [], escala_archivo: false };
  // Defensa de columna completa: si TODAS las tasas pactadas de TDD/TDC (3 o más) son menores a 0.5 %, casi seguro se capturaron como fracción
  // o con formato % de Excel. No bloquea, pero exige confirmar (como los demás avisos de escala).
  for (const c of ['tasa_pac_tdd', 'tasa_pac_tdc']) {
    if (modoDe(c) !== 'pct') continue;
    const vals = filas.map(o => leerTasa(celda(o, c), c, 'pct')).filter(r => r.valor > 0).map(r => r.valor);
    if (vals.length >= 3 && vals.every(v => v < 0.005)) { out.escala_archivo = true; out.avisos_archivo.push(`Toda la columna ${sufijo(c)} trae valores menores a 0.5 %: parece que se capturó como fracción (0.025) o con formato de porcentaje de Excel. Escribe 2.5 para 2.5 %.`); }
  }
  if (errorArchivo.length) { out.resumen = resumen(out); out.ok = false; out.requiere_confirmacion = false; return out; }

  const vistasRelacion = new Map();           // id|afil → n de fila (duplicados en el archivo)
  const nombresArchivo = new Map();           // id_grupo → { nombre, fila }
  const afilArchivo = new Map();              // afil → { campo → { valor, fila } } (consistencia entre filas)
  const gruposNuevos = new Map(), renombres = new Map();
  const nombreEnArchivo = new Set();           // grupos que traen nombre en alguna fila (un grupo nuevo lo necesita en al menos una)
  for (const o of filas) if (limpiaTexto(o.nombre_cliente)) nombreEnArchivo.add(String(o.id_grupo == null ? '' : o.id_grupo).trim());
  const afilAcc = new Map();                   // afil → { nueva, cambios:{campo:{antes,despues}}, grupos:Set } (cambios a nivel afiliación, de TODAS las filas)

  filas.forEach((o, i) => {
    const n = i + 2;                           // fila de Excel (1 = encabezado)
    const f = { n, errores: [], avisos: [], cambios: [], accion: 'sin_cambio' };
    const err = m => f.errores.push(m), avi = m => f.avisos.push(m);
    const aviE = m => { f.avisos.push(m); f.escala = true; };            // aviso de ESCALA: exige confirmar antes de aplicar
    const col = c => (modoDe(c) === 'pct' ? sufijo(c) : c);               // nombre de la columna como lo ve el usuario
    const chicos = {};                                                     // avisos «muy pequeño»: solo si el valor cambia (o la relación es nueva)
    const idg = /^\d+$/.test(String(o.id_grupo == null ? '' : o.id_grupo).trim()) ? parseInt(String(o.id_grupo).trim(), 10) : (typeof o.id_grupo === 'number' && Number.isInteger(o.id_grupo) ? o.id_grupo : NaN);
    let afil = soloDigitos(o.numero_afiliacion);
    f.id_grupo = Number.isInteger(idg) ? idg : null;
    f.numero_afiliacion = afil || null;
    if (!idg || idg < 1 || idg > MAX_ID_GRUPO) err(`id_grupo vacío o inválido (entero positivo, máximo ${MAX_ID_GRUPO})`);
    if (!afil) err('numero_afiliacion vacío o inválido');
    else if (afil.length > MAX_AFIL) err(`numero_afiliacion demasiado largo (máximo ${MAX_AFIL} dígitos)`);
    if (f.errores.length) { out.filas.push(f); return; }

    // Excel suele quitar los ceros iniciales de la afiliación: se liga con la existente si es la única coincidencia.
    if (!ix.afiliaciones.has(afil)) {
      const cand = ix.sinCeros.get(afil.replace(/^0+/, '')) || [];
      if (cand.length === 1) { avi(`La afiliación ${afil} se tomó como ${cand[0]} (Excel quita los ceros iniciales)`); afil = cand[0]; f.numero_afiliacion = afil; }
    }
    const kRel = idg + '|' + afil;
    if (vistasRelacion.has(kRel)) { err(`Grupo ${idg} + afiliación ${afil} repetidos en el archivo (también en la fila ${vistasRelacion.get(kRel)})`); out.filas.push(f); return; }
    vistasRelacion.set(kRel, n);

    const grupoExiste = ix.grupos.has(idg);
    const afilExiste = ix.afiliaciones.has(afil);
    const relActual = ix.afilGrupo.get(kRel);
    const afilActual = ix.afiliaciones.get(afil) || {};
    const costoActual = ix.costos.get(afil) || {};
    f.nueva_relacion = !relActual; f.afiliacion_nueva = !afilExiste; f.grupo_nuevo = !grupoExiste;
    if (!relActual && afilExiste) {
      const otros = (ix.gruposDeAfil.get(afil) || []).filter(g => g !== idg);
      if (otros.length) avi(`La afiliación ${afil} ya pertenece al grupo ${otros.join(', ')}. Esta fila AGREGA una relación con el grupo ${idg}; no mueve ni borra la anterior (sus cuentas, retenciones y cortes siguen con el grupo anterior). El id_grupo no se cambia por layout.`);
    }

    // ── Grupo (nombre)
    const nombre = limpiaTexto(o.nombre_cliente);
    if (nombre.length > MAX_NOMBRE) err(`nombre_cliente demasiado largo (máximo ${MAX_NOMBRE} caracteres)`);
    if (nombre) {
      const previo = nombresArchivo.get(idg);
      if (previo && previo.nombre.toLowerCase() !== nombre.toLowerCase()) err(`El grupo ${idg} aparece con dos nombres en el archivo («${previo.nombre}» fila ${previo.fila} y «${nombre}»)`);
      else if (!previo) nombresArchivo.set(idg, { nombre, fila: n });
      if (!grupoExiste) { if (!gruposNuevos.has(idg)) gruposNuevos.set(idg, nombre); }
      else if (limpiaTexto(ix.grupos.get(idg)) !== nombre && !renombres.has(idg)) renombres.set(idg, { id_grupo: idg, antes: ix.grupos.get(idg), despues: nombre, solo_mayusculas: limpiaTexto(ix.grupos.get(idg)).toLowerCase() === nombre.toLowerCase() });
    } else if (!grupoExiste && !nombreEnArchivo.has(String(o.id_grupo == null ? '' : o.id_grupo).trim())) {
      err(`El grupo ${idg} es nuevo y no trae nombre_cliente`);
    }

    // ── Valores del archivo (vacío = no cambiar)
    const nuevoRel = {}, nuevoCosto = {}, nuevoAfil = {};
    for (const c of CAMPOS_TASA) { const r = leerTasa(celda(o, c), c, modoDe(c)); if (r.error) err(r.error); else if (!r.vacio) { nuevoRel[c] = r.valor; if (r.aviso) chicos[c] = r.aviso; } }
    { const r = leerMonto(o.costo_x_trx, 'costo_x_trx'); if (r.error) err(r.error); else if (!r.vacio) { nuevoRel.costo_x_trx = r.valor; if (r.valor > 50) avi(`costo_x_trx de ${r.valor} pesos por transacción es inusualmente alto`); } }
    for (const c of CAMPOS_COSTOS) {
      const r = leerTasa(celda(o, c), c, modoDe(c));
      if (r.error) err(r.error); else if (r.param) nuevoCosto[c] = null; else if (!r.vacio) { nuevoCosto[c] = r.valor; if (r.aviso) chicos[c] = r.aviso; }
    }
    if (!vacio(o.razon_social)) {
      const rz = limpiaTexto(o.razon_social);
      if (rz.length > MAX_RAZON) err(`razon_social demasiado larga (máximo ${MAX_RAZON} caracteres)`);
      else if (rz) nuevoAfil.razon_social = rz;
    }
    if (!vacio(o.mcc)) {
      const m = MCC.normalizarMcc(o.mcc);
      if (!m.ok) err(`mcc: «${String(o.mcc).trim()}» no es un código de hasta 4 dígitos`);
      else if (m.mcc != null && !MCC.enCatalogo(m.mcc) && Number(afilActual.mcc) !== m.mcc) avi(`MCC ${m.mcc} no está en el catálogo: se ignora y se conserva el actual`);
      else if (m.mcc != null) nuevoAfil.mcc = m.mcc;
    }

    // Una afiliación puede venir en varias filas (varios grupos): sus datos propios (razón social, MCC, costos) deben coincidir.
    const reg = afilArchivo.get(afil) || afilArchivo.set(afil, {}).get(afil);
    for (const [c, v] of [...Object.entries(nuevoAfil), ...Object.entries(nuevoCosto)]) {
      if (reg[c] && !igual(reg[c].valor, v) && String(reg[c].valor) !== String(v)) err(`La afiliación ${afil} trae ${c} distinto en la fila ${reg[c].fila} («${reg[c].valor}») y aquí («${v}»)`);
      else if (!reg[c]) reg[c] = { valor: v, fila: n };
    }

    // ── Comparación contra lo actual
    const antesRel = relActual || {};
    const finalRel = {}, finalCosto = {}, finalAfil = {};
    for (const c of CAMPOS_RELACION) {
      const act = relActual ? (antesRel[c] == null ? 0 : Number(antesRel[c])) : null;
      const val = c in nuevoRel ? nuevoRel[c] : (relActual ? act : 0);
      finalRel[c] = val;
      if (!relActual) { if (c in nuevoRel) f.cambios.push(cambio(c, null, val)); }
      else if (c in nuevoRel && !igual(act, val)) { f.cambios.push(cambio(c, act, val)); if (c !== 'costo_x_trx') saltoGrande(col(c), act, val, aviE); }
    }
    for (const c of CAMPOS_COSTOS) {
      const act = costoActual[c] == null ? null : Number(costoActual[c]);
      const hay = c in nuevoCosto;
      const val = hay ? nuevoCosto[c] : (afilExiste && ix.costos.has(afil) ? act : (CAMPOS_ANULABLES.includes(c) ? null : 0));
      finalCosto[c] = val;
      if (hay && !igual(act, val) && !(act == null && val == null)) { f.cambios.push(cambio(c, act, val)); saltoGrande(col(c), act, val, aviE); }
    }
    finalAfil.razon_social = 'razon_social' in nuevoAfil ? nuevoAfil.razon_social : String(afilActual.razon_social || '');
    finalAfil.mcc = 'mcc' in nuevoAfil ? nuevoAfil.mcc : (afilActual.mcc == null ? null : Number(afilActual.mcc));
    if (afilExiste) {
      if ('razon_social' in nuevoAfil && nuevoAfil.razon_social !== String(afilActual.razon_social || '')) f.cambios.push(cambio('razon_social', afilActual.razon_social || '', nuevoAfil.razon_social));
      if ('mcc' in nuevoAfil && Number(afilActual.mcc) !== nuevoAfil.mcc) f.cambios.push(cambio('mcc', afilActual.mcc == null ? null : Number(afilActual.mcc), nuevoAfil.mcc));
    } else {
      if (!finalAfil.razon_social) err(`La afiliación ${afil} es nueva y no trae razon_social`);
      if ('razon_social' in nuevoAfil) f.cambios.push(cambio('razon_social', null, nuevoAfil.razon_social));
      if ('mcc' in nuevoAfil) f.cambios.push(cambio('mcc', null, nuevoAfil.mcc));
    }

    // ── Avisos de negocio (no bloquean)
    const tasa0 = ['tasa_pac_tdd', 'tasa_pac_tdc'].filter(c => !(finalRel[c] > 0));
    if (!relActual && tasa0.length) avi(`Relación nueva con ${tasa0.join(' y ')} en 0: se liquidaría sin comisión por ese producto`);
    const prod0 = ['tasa_pac_amex', 'tasa_pac_int'].filter(c => !(finalRel[c] > 0));
    if (!relActual && prod0.length) avi(`Relación nueva con ${prod0.join(' y ')} en 0: si el grupo procesa ese producto se liquidaría sin comisión`);
    if (!afilExiste && !('int_tdd' in nuevoCosto) && !('int_tdc' in nuevoCosto)) avi(`Afiliación nueva sin intercambio TDD/TDC: quedan en 0 (el costo y la utilidad se verán sin ese costo)`);
    for (const c of CAMPOS_TASA) if (c in nuevoRel && c !== 'pct_banca' && nuevoRel[c] > 0.1) aviE(`${col(c)} de ${pct(nuevoRel[c])} es inusualmente alta`);
    if (finalRel.pct_banca > 0.1 && 'pct_banca' in nuevoRel) aviE(`${col('pct_banca')} (% banca) de ${pct(finalRel.pct_banca)} es inusualmente alto`);
    for (const c of CAMPOS_COSTO_TASA) if (c in nuevoCosto && nuevoCosto[c] != null && nuevoCosto[c] > 0.05) aviE(`${col(c)} de ${pct(nuevoCosto[c])} es inusualmente alto para un costo`);
    // «muy pequeño» (parece fracción): solo cuando el valor cambia o la relación es nueva, no en cada re-subida
    for (const [c, m] of Object.entries(chicos)) if (!relActual || f.cambios.some(x => x.campo === c)) aviE(m);
    const fee = finalCosto.fee_broxel != null ? finalCosto.fee_broxel : (params.fee_broxel == null ? null : Number(params.fee_broxel));
    const efectivo = { tdd: finalCosto.int_tdd, tdc: finalCosto.int_tdc,
      amex: finalCosto.int_amex != null ? finalCosto.int_amex : (params.tasa_int_amex == null ? null : Number(params.tasa_int_amex)),
      int: finalCosto.int_int != null ? finalCosto.int_int : (params.tasa_int_int == null ? null : Number(params.tasa_int_int)) };
    const pactada = { tdd: finalRel.tasa_pac_tdd, tdc: finalRel.tasa_pac_tdc, amex: finalRel.tasa_pac_amex, int: finalRel.tasa_pac_int };
    const tocaProducto = p => ['tasa_pac_' + p, p === 'tdd' ? 'int_tdd' : p === 'tdc' ? 'int_tdc' : p === 'amex' ? 'int_amex' : 'int_int', 'fee_broxel'].some(c => c in nuevoRel || c in nuevoCosto);
    for (const p of ['tdd', 'tdc', 'amex', 'int']) {
      if (!tocaProducto(p) || efectivo[p] == null || fee == null || !(pactada[p] > 0)) continue;
      const costo = efectivo[p] + fee;
      if (pactada[p] < costo) avi(`${p.toUpperCase()}: la tasa pactada (${pct(pactada[p])}) es menor que su costo (intercambio + fee Broxel = ${pct(costo)}): margen negativo`);
    }

    const acc = afilAcc.get(afil) || afilAcc.set(afil, { nueva: !afilExiste, cambios: {}, filas: [] }).get(afil);
    acc.filas.push(f);
    for (const c of f.cambios) if (CAMPOS_COSTOS.includes(c.campo) || CAMPOS_AFILIACION.includes(c.campo)) acc.cambios[c.campo] = { antes: c.antes, despues: c.despues };
    f.final = { relacion: finalRel, costos: finalCosto, afiliacion: finalAfil };
    f.accion = f.errores.length ? 'error' : (!relActual ? 'crear' : (f.cambios.length ? 'modificar' : 'sin_cambio'));
    if (!relActual && !f.errores.length && !f.cambios.length) f.cambios.push(cambio('relacion', null, 'nueva'));
    out.filas.push(f);
  });

  // Datos propios de la AFILIACIÓN fusionados de todas sus filas (razón social, MCC, costos): lo que se escribe, una vez por afiliación.
  out.afiliaciones = {};
  for (const [afil, acc] of afilAcc) {
    const reg = afilArchivo.get(afil) || {}, aAct = ix.afiliaciones.get(afil) || {}, cAct = ix.costos.get(afil);
    const costos = {};
    for (const c of CAMPOS_COSTOS) costos[c] = c in reg ? reg[c].valor : (cAct ? (cAct[c] == null ? null : Number(cAct[c])) : (CAMPOS_ANULABLES.includes(c) ? null : 0));
    out.afiliaciones[afil] = { nueva: acc.nueva, cambios: acc.cambios,
      final: { razon_social: 'razon_social' in reg ? reg.razon_social.valor : String(aAct.razon_social || ''), mcc: 'mcc' in reg ? reg.mcc.valor : (aAct.mcc == null ? null : Number(aAct.mcc)), costos } };
    // Un costo compartido cambia para TODOS los grupos de esa afiliación, vengan o no en el archivo.
    if (!acc.nueva && CAMPOS_COSTOS.some(c => c in acc.cambios)) {
      const otros = (ix.gruposDeAfil.get(afil) || []).filter(g => !vistasRelacion.has(g + '|' + afil));
      if (otros.length) acc.filas[0].avisos.push(`El costo de la afiliación ${afil} también aplica a ${otros.length} grupo(s) que no vienen en el archivo (${otros.slice(0, 5).join(', ')}${otros.length > 5 ? '…' : ''})`);
    }
  }
  // Un grupo nuevo o renombrado solo cuenta si sus filas no tienen error.
  out.grupos_nuevos = [...gruposNuevos].map(([id_grupo, nombre]) => ({ id_grupo, nombre }));
  out.renombres = [...renombres.values()];
  // Un grupo NUEVO o RENOMBRADO no puede llamarse igual que otro grupo (del catálogo o del mismo archivo).
  const porNombre = new Map();                                              // nombre normalizado → [id_grupo] (catálogo actual)
  for (const [id, nom] of ix.grupos) { const k = normNombre(nom); (porNombre.get(k) || porNombre.set(k, []).get(k)).push(id); }
  const nombreFinal = new Map();                                            // id → nombre que quedaría (solo los nuevos o renombrados)
  for (const g of out.grupos_nuevos) nombreFinal.set(g.id_grupo, g.nombre);
  for (const r of out.renombres) nombreFinal.set(r.id_grupo, r.despues);
  const enArchivo = new Map();                                              // nombre normalizado → [id] dentro de los cambios del archivo
  for (const [id, nom] of nombreFinal) { const k = normNombre(nom); (enArchivo.get(k) || enArchivo.set(k, []).get(k)).push(id); }
  for (const [id, nom] of nombreFinal) {
    const k = normNombre(nom);
    // Choca con el nombre ACTUAL de cualquier otro grupo, aunque ese otro también se renombre en este archivo: el renombre es opcional (casilla) y, aun
    // si se aplica, un intercambio o cadena de nombres haría que las transacciones ya cargadas pasen EN SILENCIO a otro grupo (otras tasas y otra cuenta).
    const actualesOtros = (porNombre.get(k) || []).filter(x => x !== id);
    const choque = [...new Set([...actualesOtros, ...(enArchivo.get(k) || []).filter(x => x !== id)])];
    if (!choque.length) continue;
    const seRenombran = actualesOtros.filter(x => nombreFinal.has(x));
    const m = `El nombre «${nom}» ya lo usa el grupo ${choque.join(', ')}${seRenombran.length ? ` (que también se renombra en este archivo: un intercambio o cadena de nombres haría que las transacciones ya cargadas pasen a OTRO grupo, con otras tasas y otra cuenta)` : ''}. Las transacciones se asignan al grupo por el NOMBRE del cliente: dos grupos con el mismo nombre dejan la liquidación ambigua. El id_grupo es la llave de cuentas, conceptos SPEI, cortes y retenciones y no se cambia por layout (un id distinto crea OTRO grupo).`;
    for (const f of out.filas) if (f.id_grupo === id && !f.errores.includes(m)) { f.errores.push(m); f.accion = 'error'; }
  }
  out.nombres_archivo = Object.fromEntries([...nombresArchivo].map(([k, v]) => [k, v.nombre]));
  out.resumen = resumen(out);
  out.ok = out.resumen.error === 0 && out.resumen.total > 0 && !out.errores_archivo.length;
  out.requiere_confirmacion = out.resumen.con_escala > 0 || out.escala_archivo;
  return out;
}

/* Marca error en las filas de un grupo (lo usa el bloqueo de renombres con transacciones pendientes) y recalcula el resumen y los indicadores. */
function marcarError(plan, idGrupo, msg) {
  for (const f of plan.filas) if (f.id_grupo === idGrupo && !f.errores.includes(msg)) { f.errores.push(msg); f.accion = 'error'; }
  plan.resumen = resumen(plan);
  plan.ok = plan.resumen.error === 0 && plan.resumen.total > 0 && !plan.errores_archivo.length;
  plan.requiere_confirmacion = plan.ok && (plan.resumen.con_escala > 0 || plan.escala_archivo);
  return plan;
}

function resumen(p) {
  const r = { total: p.filas.length, crear: 0, modificar: 0, sin_cambio: 0, error: 0, con_avisos: 0, con_escala: 0, afiliaciones_nuevas: 0, grupos_nuevos: (p.grupos_nuevos || []).length, renombres: (p.renombres || []).length };
  const afilNuevas = new Set();
  for (const f of p.filas) {
    r[f.accion] = (r[f.accion] || 0) + 1;
    if (f.errores.length && f.accion !== 'error') r.error++;
    if (f.avisos.length) r.con_avisos++;
    if (f.escala) r.con_escala++;
    if (f.afiliacion_nueva && f.numero_afiliacion) afilNuevas.add(f.numero_afiliacion);
  }
  r.afiliaciones_nuevas = afilNuevas.size;
  return r;
}

const ETIQUETA = { id_grupo: 'Grupo', nombre_cliente: 'Nombre del grupo', razon_social: 'Razón social', mcc: 'MCC', costo_x_trx: 'Costo por transacción',
  tasa_pac_tdd: 'Tasa pactada TDD', tasa_pac_tdc: 'Tasa pactada TDC', tasa_pac_amex: 'Tasa pactada AMEX', tasa_pac_int: 'Tasa pactada Internacional', pct_banca: '% banca',
  int_tdd: 'Intercambio TDD', int_tdc: 'Intercambio TDC', int_amex: 'Intercambio AMEX', int_int: 'Intercambio Internacional', fee_broxel: 'Fee Broxel', relacion: 'Relación' };

/* Texto de un valor para la bitácora / pantalla. */
function textoValor(campo, v) {
  if (v === null || v === undefined || v === '') return campo === 'razon_social' || campo === 'mcc' ? '(vacío)' : (campo === 'int_tdd' || campo === 'int_tdc' ? '0%' : '(Parámetros)');
  if (CAMPOS_TASA.includes(campo) || CAMPOS_COSTO_TASA.includes(campo)) return pct(Number(v));
  if (campo === 'costo_x_trx') return '$' + Number(v).toFixed(2);
  return String(v);
}

module.exports = { marcarError, normNombre, prepararLayout, sufijo, CAMPOS_PORCENTAJE, planificar, leerNumero, leerTasa, leerMonto, textoValor, ETIQUETA, COLUMNAS_EDITABLES, COLUMNAS_INFORMATIVAS, CAMPOS_TASA, CAMPOS_COSTO_TASA, CAMPOS_ANULABLES, CAMPOS_RELACION, CAMPOS_COSTOS, CAMPOS_AFILIACION };
