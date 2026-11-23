/* lib/mesa/config.js — Mesa de control: parámetros generales (facultades, tiempos de atención, política del motor, PLD) con sus valores de origen.
   Lo que el administrador cambia en «Facultades y política» se guarda en mc_config y se mezcla sobre estos valores. */
'use strict';
const { POLITICA_DEFAULT } = require('./motor.js');
const { ACTIVIDADES_RIESGO_DEFAULT } = require('./pld.js');
const { ESTIMACION_DEFAULT } = require('./amortiza.js');

const DEFAULT = {
  facultades: { limite_mesa: 250000, vigencia_dias: 30 },                                // sobre el límite se suma la firma del comité (administrador)
  sla: { borrador: 5, devuelta: 3, verificacion: 2, decision: 1 },                       // días de atención por etapa
  politica: { ...POLITICA_DEFAULT },
  pld: { umbral_alta: 0.85, umbral_posible: 0.7, monto_medio: 500000, monto_alto: 2000000, actividades_riesgo: ACTIVIDADES_RIESGO_DEFAULT },
  cartera: { dias_vencida: 90, iva: 0.16, estimacion: { ...ESTIMACION_DEFAULT } },        // desde cuántos días de atraso el capital se considera cartera vencida; reserva por tramo de atraso
  uif: { umbral_relevante: 150000, ventana_dias: 7, min_pagos_estructuracion: 3, meses_liquidacion_anticipada: 3 },
  contabilidad: { envio_activo: true, dia_semana: 1 },                                    // corte semanal de ingresos por facturar: se envía solo ese día (0 domingo … 6 sábado; 1 = lunes)
  sofom: { nombre: 'SOLVENDOM, S.A. DE C.V., SOFOM, E.N.R.', representante: '[Representante legal de la SOFOM]' },
  motivos_rechazo: ['Política de crédito', 'Capacidad de pago', 'Historial crediticio', 'Documentación', 'Prevención de lavado de dinero', 'Información no verificable', 'Monto o plazo fuera de producto', 'Otro'],
  documentos: {
    fisica: ['Identificación oficial vigente', 'Comprobante de domicilio', 'Constancia de situación fiscal', 'Comprobante de ingresos o estados de cuenta'],
    moral: ['Acta constitutiva', 'Poder del representante legal', 'Identificación del representante legal', 'Constancia de situación fiscal', 'Comprobante de domicilio fiscal', 'Estados financieros o declaraciones'],
  },
};

const mezcla = (base, extra) => {
  const o = { ...base };
  for (const k of Object.keys(extra || {})) o[k] = (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) ? { ...base[k], ...extra[k] } : extra[k];
  return o;
};

async function cargar(q) {
  const r = (await q.query("select valor from credit_solvendom.mc_config where clave='general'")).rows[0];
  const v = r ? (typeof r.valor === 'string' ? JSON.parse(r.valor) : r.valor) : {};
  return mezcla(DEFAULT, v);
}

/* Valida lo que manda el administrador: devuelve { ok, cfg } con solo las secciones permitidas y números dentro de rango, o { ok:false, error }. */
function validar(b) {
  const out = {}, num = (v, min, max, nom) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${nom} debe estar entre ${min} y ${max}.`); return n; };
  try {
    if (b.facultades) out.facultades = { limite_mesa: num(b.facultades.limite_mesa, 0, 1e9, 'El límite de la mesa'), vigencia_dias: Math.round(num(b.facultades.vigencia_dias, 1, 365, 'La vigencia')) };
    if (b.sla) { out.sla = {}; for (const k of ['borrador', 'devuelta', 'verificacion', 'decision']) out.sla[k] = Math.round(num(b.sla[k], 1, 60, 'El tiempo de atención')); }
    if (b.politica) {
      const p = b.politica, x = {};
      x.pti_max = num(p.pti_max, 0.05, 1, 'El máximo de pagos sobre ingreso'); x.pti_rechazo = num(p.pti_rechazo, x.pti_max, 1.5, 'El umbral de rechazo por capacidad de pago');
      x.score_min = Math.round(num(p.score_min, 300, 850, 'El score mínimo')); x.score_rechazo = Math.round(num(p.score_rechazo, 300, x.score_min, 'El score de rechazo'));
      x.antig_min = Math.round(num(p.antig_min, 0, 600, 'La antigüedad mínima')); x.antig_rechazo = Math.round(num(p.antig_rechazo, 0, x.antig_min, 'La antigüedad de rechazo'));
      x.edad_min = Math.round(num(p.edad_min, 18, 99, 'La edad mínima')); x.edad_max = Math.round(num(p.edad_max, x.edad_min, 110, 'La edad máxima'));
      out.politica = x;
    }
    if (b.pld) {
      const p = b.pld, x = {};
      x.umbral_posible = num(p.umbral_posible, 0.5, 0.99, 'El umbral de coincidencia posible'); x.umbral_alta = num(p.umbral_alta, x.umbral_posible, 1, 'El umbral de coincidencia alta');
      x.monto_medio = num(p.monto_medio, 0, 1e10, 'El monto de riesgo medio'); x.monto_alto = num(p.monto_alto, x.monto_medio, 1e10, 'El monto de riesgo alto');
      if (Array.isArray(p.actividades_riesgo)) x.actividades_riesgo = p.actividades_riesgo.map(s => String(s).trim()).filter(Boolean).slice(0, 80);
      out.pld = x;
    }
    if (b.cartera) {
      const c = b.cartera, x = { dias_vencida: Math.round(num(c.dias_vencida, 1, 365, 'Los días para cartera vencida')), iva: num(c.iva, 0, 0.3, 'El IVA'), estimacion: {} };
      for (const k of ['al_corriente', '1-30', '31-60', '61-90', '91+']) x.estimacion[k] = num((c.estimacion || {})[k], 0, 1, 'La estimación preventiva');
      out.cartera = x;
    }
    if (b.uif) { const u = b.uif; out.uif = { umbral_relevante: num(u.umbral_relevante, 1, 1e10, 'El umbral de operación relevante'), ventana_dias: Math.round(num(u.ventana_dias, 1, 90, 'La ventana de estructuración')), min_pagos_estructuracion: Math.round(num(u.min_pagos_estructuracion, 2, 50, 'El mínimo de pagos')), meses_liquidacion_anticipada: Math.round(num(u.meses_liquidacion_anticipada, 1, 36, 'Los meses de liquidación anticipada')) }; }
    if (b.contabilidad) out.contabilidad = { envio_activo: b.contabilidad.envio_activo !== false, dia_semana: Math.round(num(b.contabilidad.dia_semana, 0, 6, 'El día de envío')) };
    if (b.sofom) out.sofom = { nombre: String(b.sofom.nombre || '').trim().slice(0, 200) || DEFAULT.sofom.nombre, representante: String(b.sofom.representante || '').trim().slice(0, 200) || DEFAULT.sofom.representante };
    if (Array.isArray(b.motivos_rechazo)) { const m = b.motivos_rechazo.map(s => String(s).trim()).filter(Boolean); if (!m.length) throw new Error('Deja al menos un motivo de rechazo.'); out.motivos_rechazo = m.slice(0, 30); }
    if (b.documentos) { out.documentos = {}; for (const t of ['fisica', 'moral']) { const d = (b.documentos[t] || []).map(s => String(s).trim()).filter(Boolean); if (!d.length) throw new Error('Cada tipo de persona necesita al menos un documento requerido.'); out.documentos[t] = d.slice(0, 30); } }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, cfg: out };
}

module.exports = { DEFAULT, cargar, validar, mezcla };
