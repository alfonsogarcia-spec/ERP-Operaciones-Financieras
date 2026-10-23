/* ============================================================================
   lib/cards-fondeo.js — Cálculo de fondeos de Cards (BSO) y validación de CLABE. Funciones puras.
   La empresa manda: fondeo neto + comisión (% sobre el fondeo) + IVA (% sobre la comisión).
     Ej.: fondeo 300,000 · comisión 0.5% = 1,500 · IVA 16% de la comisión = 240  →  recibe 301,740.
   ========================================================================= */
'use strict';

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Dado lo que LLEGÓ, obtiene el fondeo neto, la comisión y el IVA. `redondeo` = centavos que no cuadran (normalmente 0).
function desglosarRecibido(recibido, comisionPct, ivaPct) {
  const r = Number(recibido), f = Number(comisionPct) / 100, i = Number(ivaPct) / 100;
  const fondeo = round2(r / (1 + f * (1 + i)));
  const comision = round2(fondeo * f);
  const iva = round2(comision * i);
  return { recibido: round2(r), fondeo, comision, iva, redondeo: round2(r - (fondeo + comision + iva)) };
}

// Dado el fondeo que quieren, cuánto deben mandar.
function desglosarFondeo(fondeo, comisionPct, ivaPct) {
  const fo = round2(fondeo), f = Number(comisionPct) / 100, i = Number(ivaPct) / 100;
  const comision = round2(fo * f);
  const iva = round2(comision * i);
  return { fondeo: fo, comision, iva, total: round2(fo + comision + iva) };
}

const normalizarClabe = v => String(v == null ? '' : v).replace(/\D/g, '');

// CLABE: 18 dígitos; el último es verificador (pesos 3-7-1 sobre los 17 primeros, módulo 10).
function clabeValida(v) {
  const c = normalizarClabe(v);
  if (!/^\d{18}$/.test(c)) return false;
  const pesos = [3, 7, 1];
  let s = 0;
  for (let i = 0; i < 17; i++) s += (Number(c[i]) * pesos[i % 3]) % 10;
  return (10 - (s % 10)) % 10 === Number(c[17]);
}

// Tasa efectiva de una entidad: la propia o la del ancestro más cercano que la defina.
// `porId` = Map(id → {parent_id, comision_pct, iva_pct}).
function tasasEfectivas(id, porId) {
  let comision = null, iva = null, n = porId.get(Number(id)), saltos = 0;
  while (n && saltos++ < 10) {
    if (comision === null && n.comision_pct != null) comision = Number(n.comision_pct);
    if (iva === null && n.iva_pct != null) iva = Number(n.iva_pct);
    if (comision !== null && iva !== null) break;
    n = n.parent_id != null ? porId.get(Number(n.parent_id)) : null;
  }
  return { comision_pct: comision, iva_pct: iva };
}

module.exports = { round2, desglosarRecibido, desglosarFondeo, normalizarClabe, clabeValida, tasasEfectivas };
