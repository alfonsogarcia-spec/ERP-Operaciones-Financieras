/* lib/mesa/flujo.js — Mesa de control (Credit Solvendom): estados de la solicitud, transiciones permitidas y tiempos de atención.
   Lógica pura (sin BD ni HTTP). */
'use strict';

const ESTADOS = {
  borrador:     { t: 'Borrador',        d: 'El ejecutivo arma la solicitud y el expediente.' },
  devuelta:     { t: 'Devuelta',        d: 'La mesa pidió correcciones; el ejecutivo las atiende y la reenvía.' },
  verificacion: { t: 'En verificación', d: 'El analista valida documentos y la consulta PLD.' },
  decision:     { t: 'En decisión',     d: 'Evaluada por el motor; espera la autorización de la mesa (y comité o cumplimiento si aplica).' },
  autorizada:   { t: 'Autorizada',      d: 'Autorizada con monto, tasa y plazo; lista para formalizar.' },
  rechazada:    { t: 'Rechazada',       d: 'Rechazada con motivo registrado.' },
  cancelada:    { t: 'Cancelada',       d: 'Cancelada antes de la decisión.' },
};
const ORDEN = ['borrador', 'devuelta', 'verificacion', 'decision', 'autorizada', 'rechazada', 'cancelada'];
const ABIERTOS = ['borrador', 'devuelta', 'verificacion', 'decision'];
const FINALES = ['autorizada', 'rechazada', 'cancelada'];
const EDITABLES = ['borrador', 'devuelta'];

// acción → estados desde los que se puede ejecutar
const ACCIONES = {
  enviar:    { desde: ['borrador', 'devuelta'], hacia: 'verificacion' },
  verificar: { desde: ['verificacion'], hacia: 'decision' },
  devolver:  { desde: ['verificacion', 'decision'], hacia: 'devuelta' },
  autorizar: { desde: ['decision'], hacia: 'autorizada' },       // el estado final solo se alcanza al firmar el último nivel
  rechazar:  { desde: ['verificacion', 'decision'], hacia: 'rechazada' },
  cancelar:  { desde: ['borrador', 'devuelta', 'verificacion', 'decision'], hacia: 'cancelada' },
};
const accionValida = (estado, accion) => !!(ACCIONES[accion] && ACCIONES[accion].desde.includes(estado));

/* Niveles de firma que exige la decisión, en orden: cumplimiento (solo si el riesgo PLD es alto), mesa, y comité (solo si el monto rebasa la
   facultad de la mesa). */
function nivelesRequeridos(monto, riesgoPld, facultades) {
  const lim = Number(facultades && facultades.limite_mesa) || 0;
  const n = [];
  if (riesgoPld === 'alto') n.push('cumplimiento');
  n.push('mesa');
  if (lim > 0 && Number(monto) > lim) n.push('comite');
  return n;
}
/* Primer nivel que aún no firma (dadas las decisiones 'aprueba' ya registradas), o null si ya firmaron todos. */
const nivelPendiente = (requeridos, firmados) => requeridos.find(n => !(firmados || []).includes(n)) || null;

const MS_DIA = 864e5;
const diasEntre = (desde, hasta) => Math.max(0, Math.floor(((hasta ? new Date(hasta) : new Date()) - new Date(desde)) / MS_DIA));
// Semáforo contra el tiempo de atención de la etapa: dentro de plazo / último día / vencido.
function semaforo(dias, sla) {
  const s = Number(sla);
  if (!s) return 'ok';
  return dias > s ? 'vencido' : dias === s ? 'alerta' : 'ok';
}

module.exports = { ESTADOS, ORDEN, ABIERTOS, FINALES, EDITABLES, ACCIONES, accionValida, nivelesRequeridos, nivelPendiente, diasEntre, semaforo };
