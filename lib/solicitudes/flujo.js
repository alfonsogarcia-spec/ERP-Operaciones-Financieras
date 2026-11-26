/* lib/solicitudes/flujo.js — Portal de solicitudes de clientes: roles, estados, transiciones y qué falta capturar en cada etapa.
   Flujo:  Cliente → Comercial revisa → Operación POS ejecuta → Coordinación valida (+ Dirección si aplica) → Completada.
   Esta capa solo decide; la API la hace cumplir y deja asiento de cada paso. */
'use strict';
const V = require('./validar.js');
const CAT = require('./catalogo.js');

/* ---------- roles ---------- */
const ROLES = {
  admin:         { nombre: 'Administrador', staff: true },
  dir_comercial: { nombre: 'Director Comercial', staff: true },
  comercial:     { nombre: 'Ejecutivo Comercial', staff: true },
  operacion:     { nombre: 'Responsable de Operación POS', staff: true },
  coordinacion:      { nombre: 'Coordinación de Operaciones', staff: true },
  direccion:     { nombre: 'Dirección de Operaciones', staff: true },
  consulta:      { nombre: 'Consulta (solo lectura)', staff: true },
  cliente:       { nombre: 'Cliente', staff: false },
};
const lista = () => Object.entries(ROLES).filter(([id]) => id !== 'cliente').map(([id, r]) => ({ id, nombre: r.nombre }));
const esStaff = rol => !!(ROLES[rol] && ROLES[rol].staff);

/* ---------- estados ---------- */
const ESTADOS = {
  borrador:           { nombre: 'Borrador', cliente: 'Borrador', tono: 'neutral' },
  revision_comercial: { nombre: 'En revisión comercial', cliente: 'En revisión', tono: 'info' },
  devuelta:           { nombre: 'Devuelta al cliente', cliente: 'Necesita tu información', tono: 'warn' },
  operacion:          { nombre: 'Pendiente en Operación', cliente: 'En proceso', tono: 'info' },
  ejecucion:          { nombre: 'En ejecución', cliente: 'En proceso', tono: 'info' },
  validacion:         { nombre: 'En validación', cliente: 'En proceso', tono: 'violet' },
  completada:         { nombre: 'Completada', cliente: 'Completada', tono: 'ok' },
  rechazada:          { nombre: 'Rechazada', cliente: 'Rechazada', tono: 'danger' },
  cancelada:          { nombre: 'Cancelada', cliente: 'Cancelada', tono: 'neutral' },
};
const ORDEN = ['borrador', 'revision_comercial', 'devuelta', 'operacion', 'ejecucion', 'validacion', 'completada', 'rechazada', 'cancelada'];
const ABIERTAS = ['borrador', 'revision_comercial', 'devuelta', 'operacion', 'ejecucion', 'validacion'];
const FINALES = ['completada', 'rechazada', 'cancelada'];
// Estados que el personal de Operación, Coordinación y Dirección todavía no ve (todavía es asunto entre el cliente y Comercial).
const PREVIOS_A_OPERACION = ['borrador', 'revision_comercial', 'devuelta'];

/* ---------- acciones ---------- */
// accion → { desde:[estados], hacia, roles, etapa que debe estar completa, comentario obligatorio, visible para el cliente }
const ACCIONES = {
  enviar:           { desde: ['borrador', 'devuelta'], hacia: 'revision_comercial', roles: ['cliente', 'comercial', 'dir_comercial', 'admin'], exige: 'cliente', nombre: 'Enviar' },
  devolver:         { desde: ['revision_comercial'], hacia: 'devuelta', roles: ['comercial', 'dir_comercial', 'admin'], comentario: 10, visible: true, nombre: 'Devolver al cliente' },
  liberar:          { desde: ['revision_comercial'], hacia: 'operacion', roles: ['comercial', 'dir_comercial', 'admin'], exige: 'comercial', nombre: 'Liberar a Operación' },
  tomar:            { desde: ['operacion'], hacia: 'ejecucion', roles: ['operacion', 'admin'], nombre: 'Tomar para ejecución' },
  devolver_comercial: { desde: ['operacion', 'ejecucion'], hacia: 'revision_comercial', roles: ['operacion', 'coordinacion', 'admin'], comentario: 10, nombre: 'Regresar a Comercial' },
  ejecutar:         { desde: ['ejecucion'], hacia: 'validacion', roles: ['operacion', 'admin'], exige: 'operacion', nombre: 'Marcar como ejecutada' },
  observar:         { desde: ['validacion'], hacia: 'ejecucion', roles: ['coordinacion', 'direccion', 'admin'], comentario: 10, nombre: 'Devolver con observaciones' },
  validar:          { desde: ['validacion'], hacia: 'completada', roles: ['coordinacion', 'direccion', 'admin'], nombre: 'Validar y completar', visible: true },
  rechazar:         { desde: ['revision_comercial', 'operacion', 'ejecucion', 'validacion'], hacia: 'rechazada', roles: ['comercial', 'dir_comercial', 'coordinacion', 'direccion', 'admin'], comentario: 10, visible: true, nombre: 'Rechazar' },
  cancelar:         { desde: ['borrador', 'revision_comercial', 'devuelta', 'operacion', 'ejecucion', 'validacion'], hacia: 'cancelada', roles: ['cliente', 'comercial', 'dir_comercial', 'admin'], comentario: 5, visible: true, nombre: 'Cancelar' },
};
// El cliente solo cancela mientras el asunto no llega a Operación.
const CLIENTE_CANCELA_DESDE = ['borrador', 'revision_comercial', 'devuelta'];

/* ---------- qué falta capturar ---------- */
// Campos (de las secciones de una etapa) que están visibles y requeridos y no tienen valor. Devuelve [{key,label,seccion}].
function faltantes(tipo, etapa, datos) {
  const t = typeof tipo === 'string' ? CAT.tipo(tipo) : tipo; const out = [];
  for (const s of CAT.seccionesDe(t, etapa)) {
    if (s.omitir_si && V.visible({ show_if: s.omitir_si }, datos)) continue;
    for (const c of s.campos) {
      if (!V.visible(c, datos)) continue;
      if (c.required && V.vacio(datos[c.key])) out.push({ key: c.key, label: c.label, seccion: s.titulo });
      else if (c.tipo === 'checkbox_group' && c.required && c.key === 'checklist' && Array.isArray(datos[c.key]) && datos[c.key].length < (c.options || []).length) out.push({ key: c.key, label: `${c.label}: faltan por marcar`, seccion: s.titulo });
    }
    if (s.minimo_uno_de && !s.minimo_uno_de.some(k => !V.vacio(datos[k]))) out.push({ key: s.minimo_uno_de[0], label: s.aviso_minimo || 'Falta al menos un dato', seccion: s.titulo });
  }
  return out;
}
// Errores de formato de los campos capturados de una etapa (RFC, CLABE…). Devuelve { key: mensaje }.
function erroresFormato(tipo, etapa, datos) {
  const t = typeof tipo === 'string' ? CAT.tipo(tipo) : tipo; const out = {};
  for (const s of CAT.seccionesDe(t, etapa)) for (const c of s.campos) {
    if (!V.visible(c, datos)) continue;
    const m = V.validarValor(c, datos[c.key]); if (m) out[c.key] = m;
  }
  return out;
}
// Documentos requeridos que aún no tienen archivo. `subidos` = ids de documento ya cargados.
function docsFaltantes(tipo, subidos, etapa) {
  const t = typeof tipo === 'string' ? CAT.tipo(tipo) : tipo; const s = new Set(subidos || []);
  return (t.docs || []).filter(d => d.requerido && (d.etapa || 'cliente') === (etapa || 'cliente') && !s.has(d.id));
}

/* ---------- quién ve qué ---------- */
// ¿Este rol puede ver una solicitud en este estado? (el alcance por cliente lo resuelve la API)
function veEstado(rol, estado) {
  if (rol === 'cliente' || rol === 'comercial' || rol === 'dir_comercial' || rol === 'admin') return true;
  if (['operacion', 'coordinacion', 'direccion', 'consulta'].includes(rol)) return !PREVIOS_A_OPERACION.includes(estado) || rol === 'consulta';
  return false;
}
// Acciones que ESTE usuario puede ejecutar sobre ESTA solicitud, con los motivos de lo que no. `ctx` = { sol, rol, usuario, unicoAdmin }
function accionesDisponibles(ctx) {
  const { sol, rol } = ctx; const out = {};
  for (const [id, a] of Object.entries(ACCIONES)) {
    if (!a.roles.includes(rol) || !a.desde.includes(sol.estado)) continue;
    if (rol === 'cliente' && id === 'cancelar' && !CLIENTE_CANCELA_DESDE.includes(sol.estado)) continue;
    out[id] = { nombre: a.nombre, comentario: a.comentario || 0, hacia: a.hacia };
  }
  return out;
}

module.exports = { ROLES, lista, esStaff, ESTADOS, ORDEN, ABIERTAS, FINALES, PREVIOS_A_OPERACION, ACCIONES, CLIENTE_CANCELA_DESDE, faltantes, erroresFormato, docsFaltantes, veEstado, accionesDisponibles };
