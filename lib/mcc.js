/* ============================================================================
   lib/mcc.js — Catálogo de MCC (Merchant Category Code) PREESTABLECIDO y validación.
   El catálogo sale de lib/mcc-catalogo.json (generado de "BD MCC.xlsx" con scripts/generar-catalogo-mcc.js).
   El MCC se elige de la lista y su descripción se llena sola.
   ========================================================================= */
'use strict';
const CATALOGO = require('./mcc-catalogo.json');
const POR_MCC = new Map(CATALOGO.map(x => [Number(x.mcc), x.descripcion]));

// Devuelve { ok:true, mcc:number|null } (vacío = sin MCC) o { ok:false }. Acepta 1–4 dígitos (Excel pierde el cero: 742 = 0742).
function normalizarMcc(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { ok: true, mcc: null };
  const s = String(v).trim();
  if (!/^\d{1,4}$/.test(s) || Number(s) < 1) return { ok: false };
  return { ok: true, mcc: Number(s) };
}
const enCatalogo = mcc => POR_MCC.has(Number(mcc));
const descripcionDe = mcc => POR_MCC.get(Number(mcc)) || null;
const limpiarGiro = v => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

module.exports = { CATALOGO, normalizarMcc, enCatalogo, descripcionDe, limpiarGiro };
