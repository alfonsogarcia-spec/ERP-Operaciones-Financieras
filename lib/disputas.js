/* ============================================================================
   lib/disputas.js — Lógica de negocio del módulo Disputas.

   Portada desde el sistema Python de Contracargos (services/chargeback_service.py,
   refund_service.py, duplicate_service.py).

   • Folios: CB-YYYY-NNNNNN, REF-YYYY-NNNNNN, DUP-YYYY-NNNNNN. Secuencial por año.
   • Plazos: días hábiles (excluye feriados de la tabla conciliacion.feriados).
   • Transiciones: validación de estados permitidos y side-effects (crear evento).
   ========================================================================= */
'use strict';

/* ---------- folios secuenciales por año ---------- */
// Consulta el máximo folio del año actual para la tabla dada y devuelve el siguiente.
async function generarFolio(db, prefix, tabla) {
  const year = new Date().getUTCFullYear();
  const like = `${prefix}-${year}-%`;
  const r = await db.query(`select folio from disputa.${tabla} where folio like $1 order by folio desc limit 1`, [like]);
  if (!r.rows.length) return `${prefix}-${year}-000001`;
  const ultimo = r.rows[0].folio;
  const n = parseInt(ultimo.split('-')[2], 10) + 1;
  return `${prefix}-${year}-${String(n).padStart(6, '0')}`;
}

/* ---------- días hábiles (excluye sáb/dom + feriados MX) ---------- */
// Feriados leídos desde la tabla existente 'feriados' del schema conciliacion.
let _FERIADOS_CACHE = null; let _FERIADOS_TS = 0;
async function getFeriados(db) {
  const ahora = Date.now();
  if (_FERIADOS_CACHE && (ahora - _FERIADOS_TS) < 60 * 60 * 1000) return _FERIADOS_CACHE;
  try {
    const r = await db.query('select fecha::text as fecha from conciliacion.feriados');
    _FERIADOS_CACHE = new Set(r.rows.map(x => x.fecha));
    _FERIADOS_TS = ahora;
  } catch { _FERIADOS_CACHE = new Set(); }
  return _FERIADOS_CACHE;
}
function isoFecha(d) { return d.toISOString().slice(0, 10); }
function esFinDeSemana(d) { const wd = d.getUTCDay(); return wd === 0 || wd === 6; }

// Suma N días hábiles a la fecha base, saltando fin de semana y feriados.
async function agregarDiasHabiles(db, base, n) {
  if (!base) return null;
  if (n == null || n <= 0) return base;
  const feriados = await getFeriados(db);
  const d = new Date(base + 'T00:00:00Z');
  let restantes = n;
  while (restantes > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (esFinDeSemana(d)) continue;
    if (feriados.has(isoFecha(d))) continue;
    restantes--;
  }
  return isoFecha(d);
}

// Igual que agregarDiasHabiles pero usa el calendario del schema principal
// (public.feriados) — el mismo que usa el motor de liquidación T+n.
let _FERIADOS_CONCIL_CACHE = null, _FERIADOS_CONCIL_TS = 0;
async function getFeriadosConciliacion(db) {
  const ahora = Date.now();
  if (_FERIADOS_CONCIL_CACHE && (ahora - _FERIADOS_CONCIL_TS) < 60 * 60 * 1000) return _FERIADOS_CONCIL_CACHE;
  try {
    const r = await db.query('select fecha::text as fecha from feriados');
    _FERIADOS_CONCIL_CACHE = new Set(r.rows.map(x => x.fecha));
    _FERIADOS_CONCIL_TS = ahora;
  } catch { _FERIADOS_CONCIL_CACHE = new Set(); }
  return _FERIADOS_CONCIL_CACHE;
}
async function agregarDiasHabilesConciliacion(db, base, n) {
  if (!base) return null;
  if (n == null || n <= 0) return base;
  const feriados = await getFeriadosConciliacion(db);
  const d = new Date(base + 'T00:00:00Z');
  let restantes = n;
  while (restantes > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (esFinDeSemana(d)) continue;
    if (feriados.has(isoFecha(d))) continue;
    restantes--;
  }
  return isoFecha(d);
}

/* ---------- plazos por reason code ---------- */
async function computarLimiteComercio(db, baseFechaISO, reasonCodeId) {
  if (!baseFechaISO) return null;
  const rc = reasonCodeId ? (await db.query('select plazo_comercio_dias from disputa.reason_codes where id=$1', [reasonCodeId])).rows[0] : null;
  const dias = rc ? Number(rc.plazo_comercio_dias) : 10; // default 10 días
  return agregarDiasHabiles(db, baseFechaISO, dias);
}
async function computarLimiteRepresentacion(db, baseFechaISO, reasonCodeId) {
  if (!baseFechaISO) return null;
  const rc = reasonCodeId ? (await db.query('select plazo_representacion_dias from disputa.reason_codes where id=$1', [reasonCodeId])).rows[0] : null;
  const dias = rc ? Number(rc.plazo_representacion_dias) : 30; // default 30
  return agregarDiasHabiles(db, baseFechaISO, dias);
}

// Días para vencer (positivo = aún queda, cero/negativo = venció).
function diasParaVencer(limiteISO, hoyISO) {
  if (!limiteISO) return null;
  const hoy = hoyISO || new Date().toISOString().slice(0, 10);
  const a = new Date(hoy + 'T00:00:00Z');
  const b = new Date(limiteISO + 'T00:00:00Z');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

/* ---------- transiciones de estado ---------- */
// Chargeback: matriz de estados permitidos.
const CB_TRANSICIONES = {
  NEW: ['NOTIFIED', 'CANCELLED'],
  NOTIFIED: ['EVIDENCE_REQUESTED', 'UNDER_REVIEW', 'ACCEPTED', 'CANCELLED'],
  EVIDENCE_REQUESTED: ['UNDER_REVIEW', 'EXPIRED', 'ACCEPTED', 'CANCELLED'],
  UNDER_REVIEW: ['REPRESENTED', 'ACCEPTED', 'CANCELLED'],
  REPRESENTED: ['IN_DISPUTE', 'WON', 'LOST', 'CANCELLED'],
  IN_DISPUTE: ['WON', 'LOST', 'CANCELLED'],
  WON: [],
  LOST: [],
  ACCEPTED: [],
  EXPIRED: [],
  CANCELLED: [],
};
function esTransicionCBValida(actual, nuevo) {
  const ok = CB_TRANSICIONES[actual];
  return ok ? ok.includes(nuevo) : false;
}
const REF_TRANSICIONES = {
  NEW: ['NOTIFIED', 'CANCELLED'],
  NOTIFIED: ['ANSWERED', 'EXPIRED', 'CANCELLED'],
  ANSWERED: ['CANCELLED'],
  EXPIRED: [],
  CANCELLED: [],
};
function esTransicionRefValida(actual, nuevo) {
  const ok = REF_TRANSICIONES[actual];
  return ok ? ok.includes(nuevo) : false;
}
const DUP_TRANSICIONES = REF_TRANSICIONES; // mismo flujo
function esTransicionDupValida(actual, nuevo) { return esTransicionRefValida(actual, nuevo); }

/* ---------- creación de eventos (bitácora del ciclo) ---------- */
async function agregarEventoCB(db, chargeback_id, { tipo, estado_anterior, estado_nuevo, actor, detalle, meta } = {}) {
  await db.query(
    'insert into disputa.chargeback_events(chargeback_id, tipo, estado_anterior, estado_nuevo, actor, detalle, meta) values($1,$2,$3,$4,$5,$6,$7)',
    [chargeback_id, tipo || 'note', estado_anterior || null, estado_nuevo || null, actor || 'sistema', detalle || null, meta ? JSON.stringify(meta) : null]
  );
}
async function agregarEventoRef(db, refund_id, opts = {}) {
  await db.query(
    'insert into disputa.refund_events(refund_id, tipo, estado_anterior, estado_nuevo, actor, detalle, meta) values($1,$2,$3,$4,$5,$6,$7)',
    [refund_id, opts.tipo || 'note', opts.estado_anterior || null, opts.estado_nuevo || null, opts.actor || 'sistema', opts.detalle || null, opts.meta ? JSON.stringify(opts.meta) : null]
  );
}
async function agregarEventoDup(db, duplicate_id, opts = {}) {
  await db.query(
    'insert into disputa.duplicate_events(duplicate_id, tipo, estado_anterior, estado_nuevo, actor, detalle, meta) values($1,$2,$3,$4,$5,$6,$7)',
    [duplicate_id, opts.tipo || 'note', opts.estado_anterior || null, opts.estado_nuevo || null, opts.actor || 'sistema', opts.detalle || null, opts.meta ? JSON.stringify(opts.meta) : null]
  );
}

/* ---------- utilidades de listado ---------- */
// Normaliza fecha a ISO YYYY-MM-DD sin importar si viene Date, string ISO o texto Postgres.
function fechaISO(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Enriquece filas de CB con: descifrado (arn, monto, merchant name) + días para vencer.
function enriquecerCB(row, C) {
  const d = { ...row };
  d.arn = C.decryptString(row.arn_cifrado) || row.arn || null;
  d.case_number = C.decryptString(row.case_number_cifrado) || row.case_number || null;
  d.disputed_amount = row.disputed_amount_cifrado ? Number(C.decryptString(row.disputed_amount_cifrado)) : null;
  d.merchant_name_out = C.decryptString(row.merchant_name_cifrado) || row.merchant_name || null;
  d.fecha_limite_comercio = fechaISO(row.fecha_limite_comercio);
  d.fecha_limite_representacion = fechaISO(row.fecha_limite_representacion);
  d.fecha_evento = fechaISO(row.fecha_evento);
  d.fecha_recepcion = fechaISO(row.fecha_recepcion);
  d.fecha_cierre = fechaISO(row.fecha_cierre);
  d.fecha_retencion = fechaISO(row.fecha_retencion);
  d.dias_para_vencer = diasParaVencer(d.fecha_limite_comercio);
  d.dias_representacion = diasParaVencer(d.fecha_limite_representacion);
  // Transacción original — descifrar los campos sensibles
  d.tx_autorizacion = C.decryptString(row.tx_autorizacion_cifrada) || null;
  d.tx_last4 = C.decryptString(row.tx_last4_cifrada) || null;
  d.tx_monto = row.tx_monto_cifrado ? Number(C.decryptString(row.tx_monto_cifrado)) : null;
  d.tx_fecha = fechaISO(row.tx_fecha);
  return d;
}

module.exports = {
  generarFolio,
  agregarDiasHabiles,
  agregarDiasHabilesConciliacion,
  computarLimiteComercio,
  computarLimiteRepresentacion,
  diasParaVencer,
  fechaISO,
  CB_TRANSICIONES, REF_TRANSICIONES, DUP_TRANSICIONES,
  esTransicionCBValida, esTransicionRefValida, esTransicionDupValida,
  agregarEventoCB, agregarEventoRef, agregarEventoDup,
  enriquecerCB,
};
