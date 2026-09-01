// Puente Disputas ↔ Contracargos y helpers de fecha para retención T+1.
//
// - `siguienteCorteNoGenerado(db, iso, feriados)` devuelve el primer día
//    hábil ≥ iso que NO tenga ya un `cortes` generado (cualquier estado).
// - `nEsimoDiaHabilIso(iso, n, feriados)` avanza n días hábiles desde iso.
// - `syncCbAContracargos(db, cbId, {crypto, feriados, actor})` crea/actualiza/
//    cancela el registro en `contracargos` a partir del estado actual del CB.

const E = require('../engine.js');

async function siguienteCorteNoGenerado(db, propuestaIso, feriados) {
  const fset = E.feriadoSet(feriados || []);
  let d = E.parseFecha(propuestaIso);
  if (!d) return propuestaIso;
  for (let i = 0; i < 3660; i++) {
    const iso = E.isoFecha(d);
    // Debe ser hábil
    if (!E.esHabil(d, fset)) { d = E.addDays(d, 1); continue; }
    // No debe existir corte ya generado
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

// Puente: sincroniza el CB (schema disputa) hacia contracargos.
// Reglas:
//  - Si el CB está archivado o su status ∈ {CANCELLED,EXPIRED,WON} → contracargo Cancelado (auditoría).
//  - Si el CB está activo → crear/actualizar contracargo Pendiente con fecha = siguienteCorteNoGenerado(fecha_retencion).
//  - Un contracargo YA Aplicado no se toca (auditoría).
async function syncCbAContracargos(db, cbId, opts) {
  const { crypto: C, feriados, actor } = opts || {};
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

  const origen_folio = 'CB-' + cb.id;
  const existente = (await db.query('select id, estatus from contracargos where origen_folio=$1', [origen_folio])).rows[0];

  const cancelado = cb.archivado || ['CANCELLED', 'EXPIRED', 'WON'].includes(String(cb.status || '').toUpperCase());
  if (cancelado) {
    if (existente && existente.estatus === 'Pendiente') {
      await db.query("update contracargos set estatus='Cancelado' where origen_folio=$1", [origen_folio]);
      return { ok: true, accion: 'cancelado' };
    }
    return { ok: true, accion: existente ? 'sin_cambio' : 'ignorado' };
  }

  if (!cb.fecha_retencion || !cb.merchant_affiliation) {
    return { ok: false, motivo: 'sin_fecha_o_afiliacion' };
  }
  let monto = 0;
  try { monto = Number(C && cb.disputed_amount_cifrado ? C.decryptString(cb.disputed_amount_cifrado) : 0) || 0; }
  catch (_e) { monto = 0; }
  if (!monto || monto <= 0) return { ok: false, motivo: 'sin_monto' };

  let grupoNombre = cb.grupo_nombre || '';
  if (!grupoNombre && C && cb.merchant_name_cifrado) { try { grupoNombre = C.decryptString(cb.merchant_name_cifrado) || ''; } catch (_e) { /* */ } }
  if (!grupoNombre) grupoNombre = cb.merchant_name || '';

  const bloque = String(cb.brand || '').toUpperCase() === 'AMEX' ? 'AMEX' : 'DOM';
  const fechaRetencionIso = String(cb.fecha_retencion).slice(0, 10);
  const fechaFinal = await siguienteCorteNoGenerado(db, fechaRetencionIso, feriados);

  if (existente) {
    if (existente.estatus === 'Aplicado') return { ok: true, accion: 'ya_aplicado' };
    await db.query(`
      update contracargos set
        cargado_en_fecha=$1, grupo_cliente=$2, numero_afiliacion=$3,
        bloque=$4, monto=$5, estatus='Pendiente', marca=$6
      where origen_folio=$7
    `, [fechaFinal, grupoNombre, String(cb.merchant_affiliation), bloque, monto, cb.brand || '', origen_folio]);
    return { ok: true, accion: 'actualizado', fecha: fechaFinal };
  }

  await db.query(`
    insert into contracargos(
      origen_folio, cargado_en_fecha, fecha_registro, numero_afiliacion, comercio,
      grupo_cliente, marca, bloque, monto, estatus, creado_por, archivo_origen
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pendiente',$10,$11)
    on conflict (origen_folio) do nothing
  `, [origen_folio, fechaFinal, cb.fecha_evento || null, String(cb.merchant_affiliation),
      cb.merchant_name || grupoNombre, grupoNombre, cb.brand || '', bloque, monto,
      actor || 'sync-disputas', 'disputas:' + (cb.folio || cb.id)]);
  return { ok: true, accion: 'creado', fecha: fechaFinal };
}

module.exports = { siguienteCorteNoGenerado, nEsimoDiaHabilIso, syncCbAContracargos };
