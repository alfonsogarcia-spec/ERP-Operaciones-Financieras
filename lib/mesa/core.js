/* lib/mesa/core.js — Mesa de control: lectura del estado completo de una solicitud (expediente, PLD, riesgo, evaluación, firmas) y reglas que
   comparten la API y los ejemplos. Todo se calcula aquí una sola vez para que lo que ve la pantalla y lo que valida el servidor sean lo mismo. */
'use strict';
const CR = require('../crypto.js');
const F = require('./flujo.js');
const M = require('./motor.js');
const P = require('./pld.js');

const S = 'credit_solvendom.';
const num = v => (v === null || v === undefined ? null : Number(v));
const cif = v => (v == null || String(v).trim() === '' ? null : CR.encrypt(String(v).trim()));
const descif = v => (v ? CR.decryptString(v) : null);
const limpiaId = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9Ñ&]/g, '');
const rfcHash = rfc => { const r = limpiaId(rfc); return r ? CR.hmac(r) : null; };

function mapSolicitud(r) {
  return { ...r, monto: num(r.monto), tasa_anual: num(r.tasa_anual), ingresos_mensuales: num(r.ingresos_mensuales), egresos_mensuales: num(r.egresos_mensuales),
    otras_deudas_mensuales: num(r.otras_deudas_mensuales), monto_autorizado: num(r.monto_autorizado), tasa_autorizada: num(r.tasa_autorizada),
    vigencia_hasta: r.vigencia_hasta ? String(r.vigencia_hasta instanceof Date ? r.vigencia_hasta.toISOString() : r.vigencia_hasta).slice(0, 10) : null };
}
function mapProducto(p) {
  return { ...p, monto_min: num(p.monto_min), monto_max: num(p.monto_max), tasa_min: num(p.tasa_min), tasa_max: num(p.tasa_max), tasa_default: num(p.tasa_default), tasa_moratoria: num(p.tasa_moratoria),
    comision_apertura: num(p.comision_apertura), politica: typeof p.politica === 'string' ? JSON.parse(p.politica) : (p.politica || {}), docs_extra: typeof p.docs_extra === 'string' ? JSON.parse(p.docs_extra) : (p.docs_extra || []) };
}
function mapSolicitante(r) {
  return { id: r.id, tipo: r.tipo, nombre: r.nombre, rfc: descif(r.rfc_cifrado), curp: descif(r.curp_cifrado), fecha_nacimiento: r.fecha_nacimiento ? String(r.fecha_nacimiento instanceof Date ? r.fecha_nacimiento.toISOString() : r.fecha_nacimiento).slice(0, 10) : null,
    nacionalidad: r.nacionalidad, actividad: r.actividad, domicilio: descif(r.domicilio_cifrado), telefono: descif(r.telefono_cifrado), email: descif(r.email_cifrado), pep: !!r.pep,
    beneficiario_controlador: r.beneficiario_controlador, origen_recursos: r.origen_recursos, es_ejemplo: !!r.es_ejemplo };
}

const docsRequeridos = (cfg, tipoPersona, producto) => [...((cfg.documentos || {})[tipoPersona] || []), ...((producto && producto.docs_extra) || [])];
const huellaPersona = s => M.huella({ n: P.normalizar(s.nombre), r: limpiaId(s.rfc), c: limpiaId(s.curp) });

/* Política efectiva: la general y, encima, lo que el producto sobrescriba. */
const politicaDe = (cfg, producto) => ({ ...cfg.politica, ...((producto && producto.politica) || {}) });

/* Carga el estado completo. q = objeto con query(). Devuelve null si no existe. */
async function contexto(q, id, cfg) {
  const sr = (await q.query(`select * from ${S}mc_solicitudes where id=$1`, [id])).rows[0];
  if (!sr) return null;
  const sol = mapSolicitud(sr);
  const solicitante = mapSolicitante((await q.query(`select * from ${S}mc_solicitantes where id=$1`, [sol.solicitante_id])).rows[0]);
  const producto = mapProducto((await q.query(`select * from ${S}mc_productos where id=$1`, [sol.producto_id])).rows[0]);
  const docs = (await q.query(`select id, tipo, estado, archivo_nombre, archivo_mime, archivo_tam, (archivo_cifrado is not null) as tiene_archivo, vigencia, comentario, subido_por, subido_at, revisado_por, revisado_at
                                 from ${S}mc_documentos where solicitud_id=$1 order by id`, [id])).rows.map(d => ({ ...d, vigencia: d.vigencia ? String(d.vigencia instanceof Date ? d.vigencia.toISOString() : d.vigencia).slice(0, 10) : null }));
  const requeridos = docsRequeridos(cfg, solicitante.tipo, producto);
  const docsReq = requeridos.map(t => docs.find(d => d.tipo === t) || { tipo: t, estado: 'pendiente', tiene_archivo: false });
  const faltantes = docsReq.filter(d => d.estado !== 'validado').map(d => d.tipo);

  // PLD: última consulta; vale solo si los datos consultados no han cambiado desde entonces.
  const consulta = (await q.query(`select * from ${S}mc_pld_consultas where solicitud_id=$1 order by id desc limit 1`, [id])).rows[0] || null;
  const vigente = !!consulta && consulta.huella === huellaPersona(solicitante);
  const coinc = consulta ? (await q.query(`select * from ${S}mc_pld_coincidencias where consulta_id=$1 order by score desc, id`, [consulta.id])).rows.map(c => ({ ...c, score: num(c.score) })) : [];
  const pld = {
    consulta: consulta ? { id: consulta.id, ejecutada_por: consulta.ejecutada_por, ejecutada_at: consulta.ejecutada_at, listas_vigentes: consulta.listas_vigentes } : null, vigente, coincidencias: coinc,
    pendientes: coinc.filter(c => c.estado === 'pendiente').length, confirmadas: coinc.filter(c => c.estado === 'confirmada').length,
    posibles: coinc.filter(c => c.estado !== 'confirmada').length,
  };
  const riesgo = P.riesgo({ ...solicitante, monto: sol.monto, coincidencias_posibles: vigente ? pld.posibles : 0 }, cfg.pld);

  const entrada = {
    monto: sol.monto, plazo_meses: sol.plazo_meses, periodicidad: sol.periodicidad, tasa_anual: sol.tasa_anual,
    producto: { monto_min: producto.monto_min, monto_max: producto.monto_max, plazo_min: producto.plazo_min, plazo_max: producto.plazo_max },
    solicitante: { tipo: solicitante.tipo, edad: M.edadAl(solicitante.fecha_nacimiento), antiguedad_meses: sol.antiguedad_meses, ingresos_mensuales: sol.ingresos_mensuales,
      egresos_mensuales: sol.egresos_mensuales, otras_deudas_mensuales: sol.otras_deudas_mensuales, score_buro: sol.score_buro, pep: solicitante.pep },
    docs: { faltantes }, pld: { pendientes: pld.pendientes, confirmadas: pld.confirmadas, riesgo: riesgo.nivel, consultado: vigente },
  };
  const evaluacion = M.evaluar(entrada, politicaDe(cfg, producto));
  const guardada = (await q.query(`select id, huella, recomendacion, reglas, creado_por, creado_at from ${S}mc_evaluaciones where solicitud_id=$1 order by id desc limit 1`, [id])).rows[0] || null;
  const decisiones = (await q.query(`select * from ${S}mc_decisiones where solicitud_id=$1 order by id`, [id])).rows.map(d => ({ ...d, monto: num(d.monto), tasa: num(d.tasa) }));

  const niveles = F.nivelesRequeridos(sol.monto, riesgo.nivel, cfg.facultades);
  // Las firmas valen desde la última vez que la solicitud entró a decisión (si se devolvió y regresó, se firma de nuevo).
  const ultVerif = [...decisiones].reverse().find(d => d.decision === 'verifica');
  const desde = ultVerif ? ultVerif.id : 0;
  const firmas = decisiones.filter(d => d.id > desde && d.decision === 'aprueba');
  const firmados = firmas.map(d => d.nivel), firmantes = firmas.map(d => d.usuario);
  return { sol, solicitante, producto, docs, docsReq, requeridos, faltantes, pld, riesgo, entrada, evaluacion,
    guardada: guardada ? { ...guardada, vigente: guardada.huella === evaluacion.huella } : null,
    decisiones, niveles, firmados, firmantes, nivelPendiente: F.nivelPendiente(niveles, firmados), verificador: ultVerif ? ultVerif.usuario : null };
}

module.exports = { S, num, cif, descif, limpiaId, rfcHash, mapSolicitud, mapProducto, mapSolicitante, docsRequeridos, huellaPersona, politicaDe, contexto };
