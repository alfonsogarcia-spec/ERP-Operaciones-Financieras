/* ============================================================================
   lib/tasas-comercio.js — Tasas por COMERCIO (además de la tasa pactada del grupo/afiliación). Funciones puras, sin base de datos.

   Un comercio que se liquida a su propia CLABE (cuenta con `comercio`) puede tener tasas propias: TDD, TDC, AMEX, Internacional, costo por transacción y
   % de banca. Se guardan en la misma cuenta; lo que quede vacío sigue con la tasa pactada del grupo. Aplican a las transacciones de ESE comercio en el
   corte, el registro contable y el detalle transaccional (ver engine.js · calcularCompensacion, que suma comercio por comercio).
   ========================================================================= */
'use strict';
const { normComercio } = require('../engine.js');

/* columna de la cuenta → clave del motor */
const COLUMNAS = { com_tasa_tdd: 'pac_tdd', com_tasa_tdc: 'pac_tdc', com_tasa_amex: 'pac_amex', com_tasa_int: 'pac_int', com_costo_x_trx: 'costo_x_trx', com_pct_banca: 'pct_banca' };
/* campo del formulario → columna de la cuenta */
const CAMPOS = { tasa_tdd: 'com_tasa_tdd', tasa_tdc: 'com_tasa_tdc', tasa_amex: 'com_tasa_amex', tasa_int: 'com_tasa_int', costo_x_trx: 'com_costo_x_trx', pct_banca: 'com_pct_banca' };
const ETIQUETA = { tasa_tdd: 'La tasa de débito', tasa_tdc: 'La tasa de crédito', tasa_amex: 'La tasa AMEX', tasa_int: 'La tasa internacional', costo_x_trx: 'El costo por transacción', pct_banca: 'El % de banca' };

/* Tasas propias de una cuenta (solo lo definido), en el formato del motor. {} si no tiene. */
function deCuenta(c) {
  const out = {};
  for (const [col, clave] of Object.entries(COLUMNAS)) { const v = c && c[col]; if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) out[clave] = Number(v); }
  return out;
}

/* De las cuentas de comercio de una fila del corte (ver reparto-comercio.cuentasDeFila) → [{ comercio, tasas }] para el motor. Si un comercio aparece en
   dos cuentas manda la primera, igual que en el reparto, y solo entran los que tienen tasas propias. */
function comerciosDeFila(cuentasComercio) {
  const vistos = new Set(), out = [];
  for (const c of cuentasComercio || []) {
    const k = normComercio(c.comercio); if (!k || vistos.has(k)) continue; vistos.add(k);
    const tasas = deCuenta(c); if (Object.keys(tasas).length) out.push({ comercio: c.comercio, tasas });
  }
  return out;
}

/* Tasa propia de un comercio para un producto (clave del motor: tdd, tdc, amex, int), o null si usa la del grupo. */
function tasaDeProducto(comercios, comercio, producto) {
  const k = normComercio(comercio); if (!k) return null;
  const c = (comercios || []).find(x => normComercio(x.comercio) === k);
  const v = c && c.tasas['pac_' + producto];
  return v === undefined ? null : v;
}

/* Valida lo que llega del formulario. Vacío = sin tasa propia (usa la pactada). Tasas y % de banca en fracción, [0, 1). */
function normalizar(b) {
  const valores = {}, errores = [];
  for (const [campo, col] of Object.entries(CAMPOS)) {
    const crudo = b ? b[campo] : undefined;
    if (crudo === undefined || crudo === null || String(crudo).trim() === '') { valores[col] = null; continue; }
    const n = Number(String(crudo).replace(/[\s,]/g, ''));
    const tope = campo === 'costo_x_trx' ? 1000 : 1;
    if (!Number.isFinite(n) || n < 0 || (campo === 'costo_x_trx' ? n > tope : n >= tope)) { errores.push(campo === 'costo_x_trx' ? `${ETIQUETA[campo]} debe estar entre 0 y ${tope}.` : `${ETIQUETA[campo]} debe ser una fracción menor a 1 (2.5 % = 0.025).`); continue; }
    valores[col] = n;
  }
  return { ok: !errores.length, valores, errores };
}

/* Avisos (no bloquean): una tasa propia por debajo de lo que cuesta (intercambio + fee Broxel) deja pérdida en ese comercio. */
function avisosCosto(valores, costos, params) {
  if (!costos) return [];
  const p = params || {}, fee = costos.fee_broxel != null ? Number(costos.fee_broxel) : (Number(p.fee_broxel) || 0);
  const costo = { com_tasa_tdd: Number(costos.int_tdd) || 0, com_tasa_tdc: Number(costos.int_tdc) || 0,
    com_tasa_amex: costos.int_amex != null ? Number(costos.int_amex) : Number(p.tasa_int_amex || 0), com_tasa_int: costos.int_int != null ? Number(costos.int_int) : Number(p.tasa_int_int || 0) };
  const nombre = { com_tasa_tdd: 'débito', com_tasa_tdc: 'crédito', com_tasa_amex: 'AMEX', com_tasa_int: 'internacional' };
  const out = [];
  for (const col of Object.keys(costo)) { const t = valores[col]; if (t != null && t < costo[col] + fee) out.push(`La tasa de ${nombre[col]} (${(t * 100).toFixed(2)} %) queda por debajo del costo (${((costo[col] + fee) * 100).toFixed(2)} %): ese comercio daría pérdida.`); }
  return out;
}

/* Guarda las tasas en la cuenta de comercio `id` (q = (sql, params) => Promise). Solo una cuenta con comercio puede tener tasas propias. */
class ErrorTasas extends Error { constructor(status, codigo, mensaje) { super(mensaje); this.status = status; this.codigo = codigo; } }
async function guardarEnCuenta(q, id, valores) {
  const c = (await q('select id, id_grupo, numero_afiliacion, comercio from cuentas where id = $1', [id])).rows[0];
  if (!c) throw new ErrorTasas(404, 'no_existe', 'Esa cuenta no existe.');
  if (!String(c.comercio || '').trim()) throw new ErrorTasas(400, 'solo_comercio', 'Solo una cuenta de comercio (con su CLABE propia) puede tener tasas propias.');
  const cols = Object.keys(COLUMNAS);
  const sets = cols.map((k, i) => k + ' = $' + (i + 2)).join(', ');
  await q('update cuentas set ' + sets + ' where id = $1', [id, ...cols.map(k => (valores[k] === undefined ? null : valores[k]))]);
  return c;
}

module.exports = { ErrorTasas, guardarEnCuenta, COLUMNAS, CAMPOS, deCuenta, comerciosDeFila, tasaDeProducto, normalizar, avisosCosto };
