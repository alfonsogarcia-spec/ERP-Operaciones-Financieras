/* lib/mesa/motor.js — Mesa de control: motor de decisión paramétrico.
   Evalúa una solicitud contra la política del producto y devuelve, regla por regla, si cumple, pasa a revisión, se recomienda rechazar o está
   pendiente de información. La recomendación NO decide: la decisión la firma una persona (y si va contra el motor debe justificarse).
   Lógica pura (sin BD ni HTTP). */
'use strict';
const crypto = require('crypto');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const PERIODOS = { mensual: 12, quincenal: 24, semanal: 52 };

const POLITICA_DEFAULT = {
  pti_max: 0.35,        // pagos totales / ingreso mensual: hasta aquí cumple
  pti_rechazo: 0.45,    // arriba de esto se recomienda rechazar; entre ambos pasa a revisión
  score_min: 600,       // score de buró mínimo para cumplir
  score_rechazo: 550,   // abajo de esto se recomienda rechazar; entre ambos revisión
  antig_min: 12,        // meses de antigüedad del negocio o empleo para cumplir
  antig_rechazo: 6,     // abajo de esto se recomienda rechazar
  edad_min: 18,
  edad_max: 75,         // edad máxima al vencimiento del crédito
};

/* Pago periódico de un crédito con amortización francesa (cuota fija). tasaAnual en fracción (0.36 = 36%). */
function cuota(monto, tasaAnual, plazoMeses, periodicidad) {
  const ppy = PERIODOS[periodicidad] || 12;
  const n = Math.max(1, Math.round((Number(plazoMeses) || 0) * ppy / 12));
  const r = (Number(tasaAnual) || 0) / ppy;
  const m = Number(monto) || 0;
  const c = r === 0 ? m / n : m * r / (1 - Math.pow(1 + r, -n));
  return { cuota: round2(c), periodos: n, por_anio: ppy, mensualizada: round2(c * ppy / 12), total_intereses: round2(c * n - m) };
}

const stable = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort().reduce((a, x) => (a[x] = v[x], a), {}) : v);
const huella = o => crypto.createHash('sha256').update(stable(o)).digest('hex');

function edadAl(fechaNac, fecha) {
  if (!fechaNac) return null;
  const n = new Date(fechaNac), f = fecha ? new Date(fecha) : new Date();
  let e = f.getUTCFullYear() - n.getUTCFullYear();
  const m = f.getUTCMonth() - n.getUTCMonth();
  if (m < 0 || (m === 0 && f.getUTCDate() < n.getUTCDate())) e--;
  return e;
}

/* entrada = { monto, plazo_meses, periodicidad, tasa_anual,
               producto:{monto_min,monto_max,plazo_min,plazo_max},
               solicitante:{tipo, edad, antiguedad_meses, ingresos_mensuales, egresos_mensuales, otras_deudas_mensuales, score_buro, pep},
               docs:{faltantes:[]}, pld:{pendientes, confirmadas, riesgo} }
   politica = los umbrales (se completan con POLITICA_DEFAULT). */
function evaluar(entrada, politicaIn) {
  const P = { ...POLITICA_DEFAULT, ...(politicaIn || {}) };
  const e = entrada || {}, s = e.solicitante || {}, pr = e.producto || {}, d = e.docs || {}, l = e.pld || {};
  const reglas = [];
  const R = (id, nombre, resultado, detalle, extra) => reglas.push({ id, nombre, resultado, detalle, ...(extra || {}) });
  const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
  const monto = num(e.monto), plazo = num(e.plazo_meses);
  const c = cuota(monto, e.tasa_anual, plazo, e.periodicidad);

  // 1-2 · dentro de los rangos del producto
  const fuera = (v, min, max) => v === null || (min != null && v < Number(min)) || (max != null && v > Number(max));
  R('monto', 'Monto dentro del rango del producto', fuera(monto, pr.monto_min, pr.monto_max) ? 'rechazo' : 'cumple',
    `Solicitado ${fmt(monto)}; el producto admite de ${fmt(pr.monto_min)} a ${fmt(pr.monto_max)}.`);
  R('plazo', 'Plazo dentro del rango del producto', fuera(plazo, pr.plazo_min, pr.plazo_max) ? 'rechazo' : 'cumple',
    `Solicitado ${plazo == null ? '—' : plazo + ' meses'}; el producto admite de ${pr.plazo_min ?? '—'} a ${pr.plazo_max ?? '—'} meses.`);

  // 3 · expediente completo (pendiente = no se puede decidir)
  const falt = d.faltantes || [];
  R('documentos', 'Expediente completo y validado', falt.length ? 'pendiente' : 'cumple', falt.length ? `Faltan por validar: ${falt.join(', ')}.` : 'Todos los documentos requeridos están validados.');

  // 4-5 · PLD
  if (l.confirmadas > 0) R('pld_listas', 'Listas de personas bloqueadas', 'rechazo', `${l.confirmadas} coincidencia(s) confirmada(s) en listas.`);
  else if (l.pendientes > 0) R('pld_listas', 'Listas de personas bloqueadas', 'pendiente', `${l.pendientes} coincidencia(s) por revisar por Cumplimiento.`);
  else if (l.consultado === false) R('pld_listas', 'Listas de personas bloqueadas', 'pendiente', 'Aún no se consulta contra las listas (o los datos cambiaron desde la última consulta).');
  else R('pld_listas', 'Listas de personas bloqueadas', 'cumple', 'Sin coincidencias.');
  R('pld_riesgo', 'Nivel de riesgo PLD', l.riesgo === 'alto' ? 'revision' : 'cumple', `Riesgo ${l.riesgo || 'bajo'}${l.riesgo === 'alto' ? ': exige la firma de Cumplimiento (debida diligencia reforzada).' : '.'}`);
  if (s.pep) R('pep', 'Persona políticamente expuesta', 'revision', 'Marcada como PEP: requiere debida diligencia reforzada.');

  // 6 · capacidad de pago
  const ing = num(s.ingresos_mensuales);
  if (ing === null || ing <= 0) R('capacidad', 'Capacidad de pago', 'pendiente', 'Falta capturar el ingreso mensual.', { cuota: c.mensualizada });
  else {
    const otras = num(s.otras_deudas_mensuales) || 0, egr = num(s.egresos_mensuales) || 0;
    const pti = (c.mensualizada + otras) / ing, libre = ing - egr - otras;
    const res = (pti > P.pti_rechazo || libre < c.mensualizada) ? 'rechazo' : pti > P.pti_max ? 'revision' : 'cumple';
    R('capacidad', 'Capacidad de pago', res,
      `Pago mensual ${fmt(c.mensualizada)} + otras deudas ${fmt(otras)} = ${(pti * 100).toFixed(1)}% del ingreso (máximo ${(P.pti_max * 100).toFixed(0)}%, rechazo desde ${(P.pti_rechazo * 100).toFixed(0)}%). Ingreso libre tras egresos y deudas: ${fmt(libre)}.`,
      { pti: round2(pti * 100) / 100, cuota: c.mensualizada, valor: pti, umbral: P.pti_max });
  }

  // 7 · score de buró
  const sc = num(s.score_buro);
  R('score', 'Score de buró', sc === null ? 'revision' : sc >= P.score_min ? 'cumple' : sc >= P.score_rechazo ? 'revision' : 'rechazo',
    sc === null ? 'No se capturó el score: la mesa debe revisarlo.' : `Score ${sc} (mínimo ${P.score_min}; rechazo bajo ${P.score_rechazo}).`, { valor: sc, umbral: P.score_min });

  // 8 · antigüedad del negocio o empleo
  const an = num(s.antiguedad_meses);
  R('antiguedad', 'Antigüedad del negocio o empleo', an === null ? 'revision' : an >= P.antig_min ? 'cumple' : an >= P.antig_rechazo ? 'revision' : 'rechazo',
    an === null ? 'No se capturó la antigüedad.' : `${an} meses (mínimo ${P.antig_min}; rechazo bajo ${P.antig_rechazo}).`, { valor: an, umbral: P.antig_min });

  // 9 · edad (personas físicas): al contratar y al vencimiento
  if (s.tipo === 'fisica') {
    const ed = num(s.edad);
    if (ed === null) R('edad', 'Edad del solicitante', 'pendiente', 'Falta la fecha de nacimiento.');
    else {
      const alVenc = ed + Math.ceil((plazo || 0) / 12);
      R('edad', 'Edad del solicitante', ed < P.edad_min || alVenc > P.edad_max ? 'rechazo' : 'cumple', `${ed} años hoy y ${alVenc} al vencimiento (rango ${P.edad_min}–${P.edad_max}).`);
    }
  }

  const hay = r => reglas.some(x => x.resultado === r);
  const recomendacion = hay('pendiente') ? 'incompleta' : hay('rechazo') ? 'rechazar' : hay('revision') ? 'revision' : 'aprobar';
  const resumen = { cumple: 0, revision: 0, rechazo: 0, pendiente: 0 };
  reglas.forEach(r => { resumen[r.resultado]++; });
  return { reglas, recomendacion, resumen, cuota: c, politica: P, huella: huella({ entrada: e, politica: P }) };
}

function fmt(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

const RECOMENDACIONES = {
  aprobar: 'Aprobación recomendada', revision: 'Revisión manual', rechazar: 'Rechazo recomendado', incompleta: 'Información incompleta',
};

module.exports = { POLITICA_DEFAULT, PERIODOS, cuota, evaluar, huella, edadAl, RECOMENDACIONES, round2 };
