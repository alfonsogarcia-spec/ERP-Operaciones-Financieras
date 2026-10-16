// Puente Disputas → Ledger de comercio.
//
// `syncCbAContracargos(db, cbId, {crypto, actor})` crea/actualiza/cancela el
// CARGO correspondiente en `comercio_ledger_cargos` (fuente de verdad del
// corte) a partir del estado actual del chargeback, y espeja el resultado
// hacia la tabla legacy `contracargos` para que la vista "Contracargos" siga
// mostrando algo coherente sin haber sido reescrita todavía.
//
// Con el rediseño a ledger (deuda persistente, FIFO, "se cobra hasta
// agotarse"), la fecha de retención del CB ya NO se ajusta a "el siguiente
// corte que no exista": es simplemente el piso a partir del cual el ledger
// puede empezar a intentar cobrarlo. Si el corte de ese día (o de cualquier
// otro) no alcanza a cubrirlo completo, el ledger lo retoma automáticamente
// en el siguiente — nunca queda huérfano ni expira.

const L = require('./ledger.js');

// Se conservan por si algo más los importa, pero YA NO se usan para gatear
// el cobro de contracargos (ver nota arriba).
const E = require('../engine.js');
async function siguienteCorteNoGenerado(db, propuestaIso, feriados) {
  const fset = E.feriadoSet(feriados || []);
  let d = E.parseFecha(propuestaIso);
  if (!d) return propuestaIso;
  for (let i = 0; i < 3660; i++) {
    const iso = E.isoFecha(d);
    if (!E.esHabil(d, fset)) { d = E.addDays(d, 1); continue; }
    const existe = (await db.query('select 1 from cortes where fecha_liq_iso=$1 limit 1', [iso])).rows.length > 0;
    if (!existe) return iso;
    d = E.addDays(d, 1);
  }
  return E.isoFecha(d);
}
function nEsimoDiaHabilIso(iso, n, feriados) {
  const fset = E.feriadoSet(feriados || []);
  const base = E.parseFecha(iso);
  if (!base) return iso;
  return E.isoFecha(E.nEsimoDiaHabil(base, n, fset));
}

async function syncCbAContracargos(db, cbId, opts) {
  const { crypto: C, actor } = opts || {};
  const cb = (await db.query(`
    select cb.id, cb.status, cb.archivado, cb.fecha_retencion::text as fecha_retencion,
           cb.merchant_affiliation, cb.brand, cb.disputed_amount_cifrado,
           cb.client_group_id, cg.nombre as grupo_nombre,
           cb.merchant_name, cb.merchant_name_cifrado, cb.fecha_evento::text as fecha_evento,
           cb.folio
      from disputa.chargebacks cb
      left join disputa.client_groups cg on cg.id = cb.client_group_id
     where cb.id = $1
  `, [cbId])).rows[0];
  if (!cb) return { ok: false, motivo: 'no_existe' };

  // El folio real (CB-2026-NNNNNN) es estable y único — a diferencia del id
  // interno crudo, nunca choca con los folios cortos del reporte xlsx viejo
  // (CB-12, CB-13...). Un cambio de estatus del CB NUNCA debe generar un
  // cargo nuevo: sigue siendo el mismo origen_ref, así que registrarCargo()
  // solo actualiza el existente (idempotente por (origen, origen_ref)).
  const origen_ref = cb.folio;
  // Solo WON (ganado) y CANCELLED dejan de ser deuda. ACCEPTED, LOST y EXPIRED SÍ se retienen; lo ya retenido de un WON se devuelve con "Liberar contracargo".
  const cancelado = cb.archivado || ['CANCELLED', 'WON'].includes(String(cb.status || '').toUpperCase());

  if (cancelado) {
    await L.cancelarCargo(db, { origen: 'disputa', origen_ref, motivo: 'CB status=' + cb.status });
    const existente = (await db.query('select id, estatus from contracargos where origen_folio=$1', [origen_ref])).rows[0];
    if (existente && existente.estatus === 'Pendiente') {
      await db.query("update contracargos set estatus='Cancelado' where origen_folio=$1", [origen_ref]);
    }
    return { ok: true, accion: existente ? 'cancelado' : 'ignorado' };
  }

  if (!cb.fecha_retencion || !cb.merchant_affiliation) return { ok: false, motivo: 'sin_fecha_o_afiliacion' };
  let monto = 0;
  try { monto = Number(C && cb.disputed_amount_cifrado ? C.decryptString(cb.disputed_amount_cifrado) : 0) || 0; }
  catch (_e) { monto = 0; }
  if (!monto || monto <= 0) return { ok: false, motivo: 'sin_monto' };

  let grupoNombre = cb.grupo_nombre || '';
  if (!grupoNombre && C && cb.merchant_name_cifrado) { try { grupoNombre = C.decryptString(cb.merchant_name_cifrado) || ''; } catch (_e) { /* */ } }
  if (!grupoNombre) grupoNombre = cb.merchant_name || '';

  const bloque = String(cb.brand || '').toUpperCase() === 'AMEX' ? 'AMEX' : 'DOM';
  const fechaRetencionIso = String(cb.fecha_retencion).slice(0, 10);
  const afil = String(cb.merchant_affiliation);

  const out = await L.registrarCargo(db, {
    origen: 'disputa', origen_ref, numero_afiliacion: afil, grupo_cliente: grupoNombre, bloque,
    tipo: 'contracargo', monto, fecha_retencion_desde: fechaRetencionIso,
    snapshot_correo: { grupo: grupoNombre, afil, marca: cb.brand, monto, folio: cb.folio },
    creado_por: actor || 'sync-disputas',
  });

  // Espejo a la tabla legacy `contracargos` (vista "Contracargos" aún no reescrita).
  const existente = (await db.query('select id, estatus from contracargos where origen_folio=$1', [origen_ref])).rows[0];
  if (!existente) {
    await db.query(`
      insert into contracargos(
        origen_folio, cargado_en_fecha, fecha_registro, numero_afiliacion, comercio,
        grupo_cliente, marca, bloque, monto, estatus, creado_por, archivo_origen, ledger_origen
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pendiente',$10,$11,'disputa')
      on conflict (origen_folio) do nothing
    `, [origen_ref, fechaRetencionIso, cb.fecha_evento || null, afil,
        cb.merchant_name || grupoNombre, grupoNombre, cb.brand || '', bloque, monto,
        actor || 'sync-disputas', 'disputas:' + (cb.folio || cb.id)]);
  } else if (existente.estatus !== 'Aplicado') {
    await db.query(`
      update contracargos set
        cargado_en_fecha=$1, grupo_cliente=$2, numero_afiliacion=$3,
        bloque=$4, monto=$5, estatus='Pendiente', marca=$6
      where origen_folio=$7
    `, [fechaRetencionIso, grupoNombre, afil, bloque, monto, cb.brand || '', origen_ref]);
  }

  return { ok: true, accion: out.accion, fecha: fechaRetencionIso };
}

// Duplicados y devoluciones sospechosas: NO se retienen al alta ni al notificar. Se retiene (cargo en el ledger, día hábil
// siguiente a la resolución) cuando:
//   · Duplicado  → ANSWERED con decisión DUPLICADA, o EXPIRED (el comercio no respondió a tiempo)
//   · Devolución → ANSWERED con decisión PROCEDE,   o EXPIRED
// Si el caso se cancela o se resuelve en contra (NO_DUPLICADA / NO_PROCEDE) se cancela el saldo aún pendiente.
const CASOS = {
  DUP: { tabla: 'duplicates', origen: 'disputa_dup', decision: 'DUPLICADA', motivo: 'Transacción duplicada', sel: 'du.tx_a_monto_cifrado, du.tx_b_monto_cifrado' },
  REF: { tabla: 'refunds', origen: 'disputa_ref', decision: 'PROCEDE', motivo: 'Devolución sospechosa procedente', sel: 'du.amount_cifrado' },
};
async function syncCasoACargo(db, tipo, id, opts) {
  const cfg = CASOS[tipo];
  const { crypto: C, actor, feriados } = opts || {};
  const { montoDelCaso } = require('./disputa-monto.js');
  const d = (await db.query(`
    select du.id, du.folio, du.status, du.decision, du.brand, du.merchant_name, du.merchant_affiliation, ${cfg.sel}, cg.nombre as grupo_nombre
      from disputa.${cfg.tabla} du
      left join disputa.client_groups cg on cg.id = du.client_group_id
     where du.id = $1`, [id])).rows[0];
  if (!d) return { ok: false, motivo: 'no_existe' };
  const origen = cfg.origen, origen_ref = d.folio;
  const st = String(d.status || '').toUpperCase();
  const retiene = (st === 'ANSWERED' && String(d.decision || '').toUpperCase() === cfg.decision) || st === 'EXPIRED';
  if (!retiene) {
    await L.cancelarCargo(db, { origen, origen_ref, motivo: tipo + ' status=' + d.status + (d.decision ? ' decision=' + d.decision : '') });
    await db.query("update contracargos set estatus='Cancelado' where origen_folio=$1 and estatus='Pendiente'", [origen_ref]);
    return { ok: true, accion: 'sin_retencion' };
  }
  const afil = String(d.merchant_affiliation || '').replace(/\D/g, '');
  if (!afil) return { ok: false, motivo: 'sin_afiliacion' };
  const monto = Math.abs(montoDelCaso(d, C ? C.decryptString : null) || 0);
  if (!(monto > 0)) return { ok: false, motivo: 'sin_monto' };
  const ya = (await db.query('select id, estatus, fecha_retencion_desde::text as f from comercio_ledger_cargos where origen=$1 and origen_ref=$2', [origen, origen_ref])).rows[0];
  if (ya && ya.estatus !== 'Cancelado') return { ok: true, accion: 'sin_cambio', fecha: ya.f };
  const hoyMx = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const fecha = nEsimoDiaHabilIso(hoyMx, 1, feriados);
  const grupo = d.grupo_nombre || d.merchant_name || '';
  const bloque = String(d.brand || '').toUpperCase() === 'AMEX' ? 'AMEX' : 'DOM';
  if (ya) await db.query("update comercio_ledger_cargos set estatus='Pendiente', motivo_cancelacion=null, monto_original=$1, monto_retenido=0, fecha_retencion_desde=$2, actualizado_at=now() where id=$3", [monto, fecha, ya.id]);
  else await L.registrarCargo(db, {
    origen, origen_ref, numero_afiliacion: afil, grupo_cliente: grupo, bloque, tipo: 'contracargo', monto, fecha_retencion_desde: fecha,
    snapshot_correo: { grupo, afil, marca: d.brand, monto, folio: d.folio, motivo: cfg.motivo },
    creado_por: actor || 'sync-' + cfg.tabla,
  });
  await db.query(`insert into contracargos(origen_folio, cargado_en_fecha, fecha_registro, numero_afiliacion, comercio, grupo_cliente, marca, bloque, monto, estatus, creado_por, archivo_origen, ledger_origen)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pendiente',$10,$11,$12)
    on conflict (origen_folio) do update set estatus='Pendiente', cargado_en_fecha=excluded.cargado_en_fecha, monto=excluded.monto`,
    [origen_ref, fecha, hoyMx, afil, d.merchant_name || grupo, grupo, d.brand || '', bloque, monto, actor || 'sync-' + cfg.tabla, cfg.tabla + ':' + d.folio, origen]);
  return { ok: true, accion: 'retencion_programada', fecha, monto };
}
const syncDupACargo = (db, id, opts) => syncCasoACargo(db, 'DUP', id, opts);
const syncRefACargo = (db, id, opts) => syncCasoACargo(db, 'REF', id, opts);

module.exports = { siguienteCorteNoGenerado, nEsimoDiaHabilIso, syncCbAContracargos, syncCasoACargo, syncDupACargo, syncRefACargo };
