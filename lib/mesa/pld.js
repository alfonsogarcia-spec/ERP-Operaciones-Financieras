/* lib/mesa/pld.js — Mesa de control: consulta contra listas (PLD/FT) y clasificación de riesgo del cliente.
   Lógica pura (sin BD ni HTTP). Las listas (SAT 69-B, UIF, OFAC, ONU, internas…) las carga Cumplimiento; aquí solo se cruzan. */
'use strict';

const sinAcentos = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
// Partículas y sufijos societarios que no distinguen a una persona: se ignoran al comparar nombres.
const IGNORAR = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'E', 'SA', 'CV', 'SAPI', 'SAB', 'SC', 'RL', 'SRL', 'AC', 'SOFOM', 'ENR', 'S', 'A', 'C', 'V', 'R', 'L', 'P', 'I']);
const normalizar = s => sinAcentos(s).toUpperCase().replace(/[^A-Z0-9Ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = s => normalizar(s).split(' ').filter(t => t && !IGNORAR.has(t));

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const igual = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && lev(a, b) <= 1);

/* Parecido entre dos nombres de 0 a 1: coeficiente de Dice sobre las palabras (con tolerancia de una letra en palabras largas). */
function similitud(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  const libres = [...B]; let coinc = 0;
  for (const t of A) { const i = libres.findIndex(x => igual(t, x)); if (i >= 0) { coinc++; libres.splice(i, 1); } }
  return (2 * coinc) / (A.length + B.length);
}

const limpia = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9Ñ&]/g, '');

/* persona = {nombre, rfc, curp}; lista = filas {id, fuente, tipo, nombre, rfc, curp}. Devuelve las coincidencias de mayor a menor:
   nivel 'alta' (RFC/CURP exacto o nombre ≥ umbral_alta) o 'posible' (nombre ≥ umbral_posible). */
function buscarCoincidencias(persona, lista, cfg) {
  const alta = (cfg && cfg.umbral_alta) || 0.85, posible = (cfg && cfg.umbral_posible) || 0.7;
  const rfc = limpia(persona.rfc), curp = limpia(persona.curp);
  const out = [];
  for (const x of lista || []) {
    let score = 0, motivo = '';
    if (rfc.length >= 10 && rfc === limpia(x.rfc)) { score = 1; motivo = 'RFC idéntico'; }
    else if (curp.length === 18 && curp === limpia(x.curp)) { score = 1; motivo = 'CURP idéntica'; }
    else { score = similitud(persona.nombre, x.nombre); motivo = 'Nombre parecido'; }
    if (score >= posible) out.push({ lista_id: x.id, fuente: x.fuente, nombre: x.nombre, rfc: x.rfc || null, score: Math.round(score * 100) / 100, nivel: score >= alta ? 'alta' : 'posible', motivo });
  }
  return out.sort((a, b) => b.score - a.score);
}

const ACTIVIDADES_RIESGO_DEFAULT = ['casa de cambio', 'cambio de divisas', 'transmision de dinero', 'remesas', 'casino', 'juegos y sorteos', 'joyeria', 'metales preciosos', 'inmobiliaria', 'compraventa de vehiculos', 'arte', 'antiguedades', 'donativos', 'activos virtuales', 'criptomonedas'];

/* Riesgo PLD por factores: suma de puntos → bajo (≤2) · medio (≤4) · alto (>4). Devuelve también los factores para explicarlo. */
function riesgo(x, cfg) {
  const C = cfg || {}, f = [];
  const add = (p, t) => f.push({ puntos: p, texto: t });
  if (x.pep) add(3, 'Persona políticamente expuesta');
  const act = sinAcentos(x.actividad || '').toLowerCase();
  const lista = (C.actividades_riesgo || ACTIVIDADES_RIESGO_DEFAULT).map(a => sinAcentos(a).toLowerCase());
  if (act && lista.some(a => act.includes(a))) add(2, 'Actividad de riesgo: ' + x.actividad);
  if (x.nacionalidad && String(x.nacionalidad).toUpperCase() !== 'MX') add(2, 'Nacionalidad distinta de la mexicana');
  const monto = Number(x.monto) || 0;
  if (monto >= (C.monto_alto || 2000000)) add(2, 'Monto igual o mayor a ' + (C.monto_alto || 2000000).toLocaleString('es-MX'));
  else if (monto >= (C.monto_medio || 500000)) add(1, 'Monto igual o mayor a ' + (C.monto_medio || 500000).toLocaleString('es-MX'));
  if (x.tipo === 'moral' && !String(x.beneficiario_controlador || '').trim()) add(2, 'Persona moral sin beneficiario controlador identificado');
  if (!String(x.origen_recursos || '').trim()) add(1, 'Sin origen de los recursos declarado');
  if (x.coincidencias_posibles > 0) add(2, 'Coincidencias posibles en listas (descartadas o por revisar)');
  const puntos = f.reduce((s, y) => s + y.puntos, 0);
  return { puntos, nivel: puntos <= 2 ? 'bajo' : puntos <= 4 ? 'medio' : 'alto', factores: f };
}

module.exports = { normalizar, similitud, buscarCoincidencias, riesgo, ACTIVIDADES_RIESGO_DEFAULT };
