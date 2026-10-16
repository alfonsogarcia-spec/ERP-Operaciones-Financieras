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
  NOTIFIED: ['EVIDENCE_REQUESTED', 'UNDER_REVIEW', 'ACCEPTED', 'EXPIRED', 'CANCELLED'],
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

/* ---------- Días de retención: desde que se retiene hasta que se libera ---------- */
// Días naturales entre dos fechas ISO (YYYY-MM-DD).
function diasEntre(aISO, bISO) {
  if (!aISO || !bISO) return null;
  return Math.round((Date.UTC(...bISO.split('-').map((n, i) => i === 1 ? n - 1 : +n)) - Date.UTC(...aISO.split('-').map((n, i) => i === 1 ? n - 1 : +n))) / 86400000);
}
const hoyMxISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

// Calcula el estado de la retención de UN caso según su estatus.
//   ini         = fecha del primer corte que lo retuvo (null si aún no se ha retenido)
//   programada  = fecha de retención programada (solo informativa mientras no haya corte)
//   liberado_at = fecha en que se pulsó "Liberar contracargo" (solo CB ganados)
// Estados: por_retener · en_curso · por_liberar · liberado · definitiva · sin_retencion
//   Se retiene en: ACCEPTED, LOST, EXPIRED (contracargos); DUPLICADA/PROCEDE o EXPIRED (duplicados/devoluciones).
//   Solo un contracargo ganado (WON) se libera: queda "por_liberar" hasta que se pulsa el botón; de ahí "liberado".
function calcRetencion({ tipo, status, decision, fecha_cierre, ini, programada, brand, hoy, liberado_at }) {
  hoy = hoy || hoyMxISO();
  const st = String(status || '').toUpperCase(), dec = String(decision || '').toUpperCase();
  let final = false, desenlace = null;
  if (tipo === 'CB') {
    if (st === 'WON') { final = true; desenlace = 'liberable'; }
    else if (['LOST', 'ACCEPTED', 'EXPIRED'].includes(st)) { final = true; desenlace = 'definitiva'; }
    else if (st === 'CANCELLED') { final = true; desenlace = 'cancelado'; }
  } else {
    if (st === 'ANSWERED') { final = true; desenlace = dec === (tipo === 'DUP' ? 'DUPLICADA' : 'PROCEDE') ? 'definitiva' : 'sin_retencion'; }
    else if (st === 'EXPIRED') { final = true; desenlace = 'definitiva'; }
    else if (st === 'CANCELLED') { final = true; desenlace = 'cancelado'; }
  }
  const limite = String(brand || '').toUpperCase() === 'INTERNACIONAL' ? 180 : 45;   // días naturales (LTOSF art. 23)
  const base = { estado: null, dias: null, desde: ini || null, hasta: null, programada: programada || null, limite, excede: false, liberado_at: liberado_at || null, atraso: 0 };
  if (!ini) {
    // `atraso`: días naturales desde la fecha en que debió retenerse y ningún corte lo ha hecho.
    const atraso = programada && programada < hoy ? diasEntre(programada, hoy) : 0;
    if (!final) return { ...base, estado: programada ? 'por_retener' : 'sin_retencion', atraso };
    // Resuelto a favor de la retención pero aún no hay corte que la ejecute.
    if (desenlace === 'definitiva' && programada) return { ...base, estado: 'por_retener', atraso };
    return { ...base, estado: 'sin_retencion' };
  }
  const fin = final ? (fecha_cierre || hoy) : hoy;
  if (!final) { const dias = Math.max(0, diasEntre(ini, hoy)); return { ...base, estado: 'en_curso', dias, excede: dias > limite }; }
  if (desenlace === 'liberable') {
    if (liberado_at) return { ...base, estado: 'liberado', dias: Math.max(0, diasEntre(ini, liberado_at)), hasta: liberado_at };
    return { ...base, estado: 'por_liberar', dias: Math.max(0, diasEntre(ini, hoy)) };
  }
  if (desenlace === 'sin_retencion') return { ...base, estado: 'sin_retencion' };
  return { ...base, estado: 'definitiva', dias: Math.max(0, diasEntre(ini, fin)), hasta: fin };
}

// Retención real por folio, tomada del ledger: primer corte que aplicó el cargo y montos.
async function retencionPorFolios(db, origen, folios) {
  const out = new Map();
  if (!folios || !folios.length) return out;
  const rows = (await db.query(
    `select c.origen_ref, c.estatus, c.monto_original, c.monto_retenido, min(co.fecha_liq_iso)::text as ini,
           (select co2.fecha_liq_iso::text from contracargos lc join cortes co2 on co2.id_corte = lc.aplicado_en_corte_id where lc.origen_folio = c.origen_ref limit 1) as ini_legacy,
           c.fecha_retencion_desde::text as programada
       from comercio_ledger_cargos c
       left join corte_aplicaciones a on a.cargo_id = c.id
       left join cortes co on co.id_corte = a.corte_id
      where c.origen = $1 and c.origen_ref = any($2::text[])
      group by c.id`, [origen, folios])).rows;
  // Abonos por "Liberar contracargo" (dispersiones_pendientes con origen 'disputa_cb').
  const libs = origen === 'disputa' ? (await db.query(
    `select origen_ref, min((creado_at at time zone 'America/Mexico_City')::date)::text as lib, sum(monto) as monto,
            bool_and(estatus = 'Aplicado') as abonado, max(aplicado_en_corte_id) as corte
       from dispersiones_pendientes
      where origen = 'disputa_cb' and estatus <> 'Cancelado' and origen_ref = any($1::text[])
      group by origen_ref`, [folios])).rows : [];
  const libMap = new Map(libs.map(x => [x.origen_ref, x]));
  for (const r of rows) out.set(r.origen_ref, { ini: r.ini || r.ini_legacy || null, programada: r.programada || null, estatus: r.estatus, monto_original: Number(r.monto_original), monto_retenido: Number(r.monto_retenido), liberado_at: (libMap.get(r.origen_ref) || {}).lib || null, monto_liberado: libMap.has(r.origen_ref) ? Number(libMap.get(r.origen_ref).monto) : null, abonado: libMap.has(r.origen_ref) ? !!libMap.get(r.origen_ref).abonado : false, abonado_corte: libMap.has(r.origen_ref) ? libMap.get(r.origen_ref).corte : null });
  return out;
}

// Días que pasó el caso en cada estatus, a partir de su timeline de eventos.
function diasPorEstatus(eventos, hoy, cierre) {
  hoy = hoy || hoyMxISO();
  const pts = (eventos || []).filter(e => e.estado_nuevo).map(e => ({ estado: e.estado_nuevo, desde: new Date(e.ts).toISOString().slice(0, 10) }));
  return pts.map((p, i) => {
    const sig = pts[i + 1];
    const hasta = sig ? sig.desde : null;
    // El último estatus de un caso cerrado es el desenlace: no tiene duración.
    if (!sig && cierre) return { estado: p.estado, desde: p.desde, hasta: null, dias: null, final: true };
    return { estado: p.estado, desde: p.desde, hasta, dias: Math.max(0, diasEntre(p.desde, hasta || hoy)) };
  });
}

module.exports = {
  generarFolio,
  agregarDiasHabiles,
  agregarDiasHabilesConciliacion,
  computarLimiteComercio,
  computarLimiteRepresentacion,
  diasParaVencer,
  fechaISO,
  calcRetencion, retencionPorFolios, diasPorEstatus, diasEntre,
  CB_TRANSICIONES, REF_TRANSICIONES, DUP_TRANSICIONES,
  esTransicionCBValida, esTransicionRefValida, esTransicionDupValida,
  agregarEventoCB, agregarEventoRef, agregarEventoDup,
  enriquecerCB,
};
