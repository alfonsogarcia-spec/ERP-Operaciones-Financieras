// Ledger de comercio — "cuenta corriente" de contracargos/retenciones.
//
// Reemplaza el modelo viejo (gating por `cargado_en_fecha === fecha_del_corte`,
// que producía "huérfanos" si el corte de esa fecha ya existía) por deuda
// persistente: cada contracargo/retención es un CARGO que se cobra por FIFO
// en cada corte hasta agotarse. Si un corte no alcanza a cubrirlo completo,
// queda "Parcial" y el SIGUIENTE corte (cualquiera, sin importar fecha) sigue
// cobrando el resto. Nunca prescribe.
//
// Las tablas legacy `contracargos` y `financiamientos` se conservan para no
// romper las vistas existentes: cada alta ahí llama a registrarCargo() aquí
// también (dual-write), y tras cada corte se espeja el estatus de vuelta
// (mirrorLegacyEstatus) para que esas vistas sigan mostrando algo coherente.

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Crea o actualiza un cargo. Idempotente por (origen, origen_ref): si ya existe
// y sigue Pendiente/Parcial, actualiza los datos (permite corregir monto/bloque
// antes de que se empiece a cobrar); si ya está Aplicado/Cancelado, no lo toca.
async function registrarCargo(db, p) {
  const existente = (await db.query(
    'select id, estatus from comercio_ledger_cargos where origen=$1 and origen_ref=$2',
    [p.origen, p.origen_ref]
  )).rows[0];

  if (existente) {
    if (['Aplicado', 'Cancelado'].includes(existente.estatus)) {
      return { id: existente.id, accion: 'sin_cambio', estatus: existente.estatus };
    }
    await db.query(
      `update comercio_ledger_cargos set
         numero_afiliacion=$1, grupo_cliente=$2, bloque=$3, tipo=$4,
         monto_original=$5, fecha_retencion_desde=$6, snapshot_correo=$7,
         actualizado_at=now()
       where id=$8`,
      [String(p.numero_afiliacion), p.grupo_cliente || null, p.bloque, p.tipo,
       round2(p.monto), p.fecha_retencion_desde || null, JSON.stringify(p.snapshot_correo || {}), existente.id]
    );
    return { id: existente.id, accion: 'actualizado' };
  }

  const row = (await db.query(
    `insert into comercio_ledger_cargos(
       origen, origen_ref, numero_afiliacion, grupo_cliente, bloque, tipo,
       monto_original, fecha_retencion_desde, snapshot_correo, creado_por
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id`,
    [p.origen, p.origen_ref, String(p.numero_afiliacion), p.grupo_cliente || null, p.bloque, p.tipo,
     round2(p.monto), p.fecha_retencion_desde || null, JSON.stringify(p.snapshot_correo || {}), p.creado_por || null]
  )).rows[0];
  return { id: row.id, accion: 'creado' };
}

// Cancela el saldo PENDIENTE de un cargo (lo ya retenido queda retenido).
async function cancelarCargo(db, { origen, origen_ref, motivo }) {
  const r = await db.query(
    `update comercio_ledger_cargos
        set estatus='Cancelado', motivo_cancelacion=$1, actualizado_at=now()
      where origen=$2 and origen_ref=$3 and estatus in ('Pendiente','Parcial')
      returning id`,
    [motivo || null, origen, origen_ref]
  );
  return { ok: true, afectados: r.rows.length };
}

// Cargos cobrables para una fecha de corte dada, agrupados por afil||bloque,
// en orden FIFO (el más antiguo primero). `fecha_retencion_desde` actúa como
// piso ("no cobrar antes de"), nunca como techo/expiración.
async function pendientesPorAfilBloque(db, fechaLiqIso) {
  const rows = (await db.query(
    `select id, numero_afiliacion, bloque, tipo,
            monto_original, monto_retenido,
            (monto_original - monto_retenido) as monto_pendiente
       from comercio_ledger_cargos
      where estatus in ('Pendiente','Parcial')
        and (fecha_retencion_desde is null or fecha_retencion_desde <= $1::date)
      order by creado_at asc, id asc`,
    [fechaLiqIso]
  )).rows;
  const map = new Map();
  for (const r of rows) {
    const k = String(r.numero_afiliacion) + '||' + r.bloque;
    const arr = map.get(k) || [];
    arr.push({
      id: r.id, tipo: r.tipo,
      monto_original: Number(r.monto_original),
      monto_retenido: Number(r.monto_retenido),
      monto_pendiente: round2(r.monto_pendiente),
    });
    map.set(k, arr);
  }
  return map;
}

// Aplica una lista de {cargo_id, monto_aplicado, bloque} a un corte: registra
// la aplicación (para poder revertirla exactamente si se borra el corte),
// suma monto_retenido y recalcula estatus (Aplicado si ya cubrió todo, si no
// Parcial). Espeja el resultado hacia las tablas legacy.
async function aplicarEnCorte(db, corteId, aplicaciones) {
  for (const a of aplicaciones) {
    if (!(a.monto_aplicado > 0.004)) continue;
    await db.query(
      `insert into corte_aplicaciones(corte_id, cargo_id, bloque, monto_aplicado)
       values($1,$2,$3,$4) on conflict (corte_id, cargo_id) do nothing`,
      [corteId, a.cargo_id, a.bloque, round2(a.monto_aplicado)]
    );
    const row = (await db.query(
      `update comercio_ledger_cargos
          set monto_retenido = monto_retenido + $1, actualizado_at = now()
        where id = $2
        returning monto_original, monto_retenido`,
      [round2(a.monto_aplicado), a.cargo_id]
    )).rows[0];
    const nuevoEstatus = Number(row.monto_retenido) >= Number(row.monto_original) - 0.004 ? 'Aplicado' : 'Parcial';
    await db.query('update comercio_ledger_cargos set estatus=$1 where id=$2', [nuevoEstatus, a.cargo_id]);
    await mirrorLegacyEstatus(db, a.cargo_id, corteId);
  }
}

// Revierte TODAS las aplicaciones de un corte (al borrarlo): resta lo
// retenido, recalcula estatus (respetando Cancelado) y espeja a legacy.
// El caller debe llamar esto ANTES de `delete from cortes` (que cascadea
// corte_aplicaciones); si no, ya no habrá filas que leer aquí.
async function revertirCorte(db, corteId) {
  const aplicaciones = (await db.query(
    'select cargo_id, monto_aplicado from corte_aplicaciones where corte_id=$1',
    [corteId]
  )).rows;
  for (const a of aplicaciones) {
    const row = (await db.query(
      `update comercio_ledger_cargos
          set monto_retenido = greatest(monto_retenido - $1, 0), actualizado_at = now()
        where id = $2
        returning monto_original, monto_retenido, estatus`,
      [round2(a.monto_aplicado), a.cargo_id]
    )).rows[0];
    if (row && row.estatus !== 'Cancelado') {
      const nuevoEstatus = Number(row.monto_retenido) <= 0.004 ? 'Pendiente' : 'Parcial';
      await db.query('update comercio_ledger_cargos set estatus=$1 where id=$2', [nuevoEstatus, a.cargo_id]);
    }
    await mirrorLegacyEstatus(db, a.cargo_id, null);
  }
  return { revertidos: aplicaciones.length };
}

// Refleja el estatus del cargo hacia la tabla legacy de la que vino, para que
// las vistas "Contracargos" y "Retenciones" (aún no reescritas) sigan
// mostrando algo coherente. 'Parcial' se muestra como 'Pendiente' ahí (esas
// tablas no tienen ese concepto) — el detalle fino vive en el ledger.
async function mirrorLegacyEstatus(db, cargoId, corteId) {
  const cargo = (await db.query('select * from comercio_ledger_cargos where id=$1', [cargoId])).rows[0];
  if (!cargo) return;
  const legacyEstatus = cargo.estatus === 'Aplicado' ? 'Aplicado' : cargo.estatus === 'Cancelado' ? 'Cancelado' : 'Pendiente';
  const legacyCorteId = cargo.estatus === 'Aplicado' ? corteId : null;

  if (cargo.origen === 'financiamiento_legacy') {
    await db.query(
      'update financiamientos set estatus=$1, aplicado_en_corte_id=$2 where folio=$3',
      [legacyEstatus, legacyCorteId, cargo.origen_ref]
    );
    return;
  }
  await db.query(
    'update contracargos set estatus=$1, aplicado_en_corte_id=$2 where origen_folio=$3',
    [legacyEstatus, legacyCorteId, cargo.origen_ref]
  );
  if (cargo.origen === 'disputa') {
    const cbId = parseInt(String(cargo.origen_ref).replace(/^CB-/, ''), 10);
    if (cbId) {
      try {
        await db.query('update disputa.chargebacks set retenido_en_corte_id=$1 where id=$2', [legacyCorteId, cbId]);
      } catch (_e) { /* schema disputa no listo → ignorar */ }
    }
  }
}

// Backfill idempotente: puebla el ledger desde las filas Pendiente/Aplicado/
// Cancelado que YA existían en `contracargos` y `financiamientos` antes de
// este rediseño. Se llama en cada arranque; usa (origen, origen_ref) para no
// duplicar. Los que ya estaban Aplicado se marcan Aplicado con monto_retenido
// = monto_original (deuda ya saldada históricamente, sin corte_aplicaciones —
// no hace falta poder revertir cortes de antes del rediseño).
async function backfillDesdeLegacy(db) {
  let ccs = [];
  try { ccs = (await db.query('select * from contracargos')).rows; } catch (_e) { /* tabla no lista */ }
  for (const c of ccs) {
    // `ledger_origen` es explícito desde que existe la columna — el prefijo del
    // folio NO es confiable (un folio real de reporte también empieza "CB-",
    // igual que el origen_ref interno del sync de Disputas). Fallback por
    // prefijo solo para filas muy viejas sin la columna poblada.
    const origen = c.ledger_origen || (String(c.origen_folio || '').startsWith('MAN-') ? 'manual' : 'reporte_xlsx');
    const origen_ref = c.origen_folio || ('legacy-cc-' + c.id);
    const existe = (await db.query('select id from comercio_ledger_cargos where origen=$1 and origen_ref=$2', [origen, origen_ref])).rows[0];
    if (existe) continue;
    const monto = round2(c.monto); if (!monto) continue;
    const estatus = c.estatus === 'Aplicado' ? 'Aplicado' : c.estatus === 'Cancelado' ? 'Cancelado' : 'Pendiente';
    await db.query(
      `insert into comercio_ledger_cargos(
         origen, origen_ref, numero_afiliacion, grupo_cliente, bloque, tipo,
         monto_original, monto_retenido, estatus, snapshot_correo, creado_por, creado_at
       ) values ($1,$2,$3,$4,$5,'contracargo',$6,$7,$8,$9,$10,$11)
       on conflict (origen, origen_ref) do nothing`,
      [origen, origen_ref, c.numero_afiliacion, c.grupo_cliente, c.bloque, monto,
       estatus === 'Aplicado' ? monto : 0, estatus,
       JSON.stringify({ grupo: c.grupo_cliente, afil: c.numero_afiliacion, marca: c.marca, monto, motivo: c.categoria, codigo_razon: c.codigo_razon, canal: c.canal }),
       c.creado_por, c.creado_at]
    );
  }

  let fins = [];
  try { fins = (await db.query('select * from financiamientos')).rows; } catch (_e) { /* tabla no lista */ }
  for (const f of fins) {
    const origen = 'financiamiento_legacy';
    const origen_ref = f.folio || ('legacy-fin-' + f.id);
    const existe = (await db.query('select id from comercio_ledger_cargos where origen=$1 and origen_ref=$2', [origen, origen_ref])).rows[0];
    if (existe) continue;
    const monto = round2(f.monto); if (!monto) continue;
    const estatus = f.estatus === 'Aplicado' ? 'Aplicado' : f.estatus === 'Cancelado' ? 'Cancelado' : 'Pendiente';
    const tipo = f.tipo === 'revenue_share' ? 'revenue_share' : 'financiamiento';
    await db.query(
      `insert into comercio_ledger_cargos(
         origen, origen_ref, numero_afiliacion, grupo_cliente, bloque, tipo,
         monto_original, monto_retenido, estatus, fecha_retencion_desde, snapshot_correo, creado_por, creado_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (origen, origen_ref) do nothing`,
      [origen, origen_ref, f.numero_afiliacion, f.grupo_cliente, f.bloque, tipo, monto,
       estatus === 'Aplicado' ? monto : 0, estatus, f.cargado_en_fecha,
       JSON.stringify({ grupo: f.grupo_cliente, afil: f.numero_afiliacion, concepto: f.concepto, tipo, monto }),
       f.creado_por, f.creado_at]
    );
  }
}

// Backlog = cargos Pendiente/Parcial cuyo "piso de cobro" (fecha_retencion_desde,
// o creado_at si no tiene piso) es ANTERIOR a `antesDe`. Se usa para congelar
// de un tajo lo acumulado antes de una fecha de corte, cuando ese backlog se
// va a cobrar por otro medio (ej. manual, vía Retenciones) en vez de dejar
// que el ledger lo aplique de golpe al primer corte con bolsa suficiente.
async function listarBacklog(db, antesDe) {
  const rows = (await db.query(
    `select id, origen, origen_ref, numero_afiliacion, grupo_cliente, bloque, tipo,
            monto_original, monto_retenido, (monto_original - monto_retenido) as monto_pendiente,
            estatus, fecha_retencion_desde::text as fecha_retencion_desde, creado_at
       from comercio_ledger_cargos
      where estatus in ('Pendiente','Parcial')
        and coalesce(fecha_retencion_desde, creado_at::date) < $1::date
      order by numero_afiliacion, creado_at asc`,
    [antesDe]
  )).rows.map(r => ({ ...r, monto_original: Number(r.monto_original), monto_retenido: Number(r.monto_retenido), monto_pendiente: round2(r.monto_pendiente) }));
  return { total: rows.length, total_monto: round2(rows.reduce((s, r) => s + r.monto_pendiente, 0)), filas: rows };
}

// Congela (Cancelado) el saldo pendiente de todo el backlog anterior a
// `antesDe`. Espeja el Cancelado a las tablas legacy para que las vistas
// Contracargos/Retenciones dejen de mostrarlos como accionables. No borra
// nada — el histórico queda intacto, solo deja de ser cobrable vía el ledger.
async function congelarBacklog(db, { antesDe, motivo, actor }) {
  const { filas } = await listarBacklog(db, antesDe);
  let congelados = 0, montoCongelado = 0;
  for (const f of filas) {
    const r = await cancelarCargo(db, { origen: f.origen, origen_ref: f.origen_ref, motivo: motivo || ('Backlog congelado el ' + antesDe + (actor ? ' por ' + actor : '')) });
    if (r.afectados > 0) {
      congelados++;
      montoCongelado += f.monto_pendiente;
      await mirrorLegacyEstatus(db, f.id, null);
    }
  }
  return { congelados, monto_congelado: round2(montoCongelado), revisados: filas.length };
}

// Reactiva cargos previamente congelados (Cancelado) para que el ledger los
// vuelva a cobrar automatico por FIFO a partir de una fecha. Solo toca
// cargos que sigan Cancelado (si ya se aplico o se reprogramo antes con otro
// id, no hace nada). `fecha_retencion_desde` es el piso: no se cobra antes
// de esa fecha, pero nunca expira.
async function reprogramarCargos(db, { ids, fecha_retencion_desde, motivo, actor }) {
  let reprogramados = 0, montoReprogramado = 0;
  for (const id of ids) {
    const row = (await db.query(
      `update comercio_ledger_cargos
          set estatus = case when monto_retenido >= monto_original - 0.004 then 'Aplicado'
                             when monto_retenido > 0.004 then 'Parcial'
                             else 'Pendiente' end,
              fecha_retencion_desde = $1::date,
              motivo_cancelacion = null,
              actualizado_at = now()
        where id = $2 and estatus = 'Cancelado'
        returning id, monto_original, monto_retenido`,
      [fecha_retencion_desde, id]
    )).rows[0];
    if (row) {
      reprogramados++;
      montoReprogramado += round2(Number(row.monto_original) - Number(row.monto_retenido));
      await mirrorLegacyEstatus(db, row.id, null);
    }
  }
  return { reprogramados, monto_reprogramado: round2(montoReprogramado), revisados: ids.length };
}

// Cancela cargos específicos por id (ej. un duplicado detectado entre dos
// orígenes distintos que registraron el mismo contracargo real). Solo toca
// los que sigan Pendiente/Parcial; no afecta lo ya Aplicado.
async function cancelarPorIds(db, { ids, motivo, actor }) {
  let cancelados = 0, montoCancelado = 0;
  for (const id of ids) {
    const cargo = (await db.query(
      `select origen, origen_ref, (monto_original - monto_retenido) as monto_pendiente
         from comercio_ledger_cargos where id = $1 and estatus in ('Pendiente','Parcial')`,
      [id]
    )).rows[0];
    if (!cargo) continue;
    const r = await cancelarCargo(db, { origen: cargo.origen, origen_ref: cargo.origen_ref, motivo: motivo || (actor ? 'Cancelado por ' + actor : null) });
    if (r.afectados > 0) {
      cancelados++;
      montoCancelado += round2(Number(cargo.monto_pendiente));
      await mirrorLegacyEstatus(db, id, null);
    }
  }
  return { cancelados, monto_cancelado: round2(montoCancelado), revisados: ids.length };
}

module.exports = {
  registrarCargo, cancelarCargo, pendientesPorAfilBloque,
  aplicarEnCorte, revertirCorte, mirrorLegacyEstatus, backfillDesdeLegacy,
  listarBacklog, congelarBacklog, reprogramarCargos, cancelarPorIds,
};
