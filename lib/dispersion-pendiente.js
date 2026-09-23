// Dispersión parcial: montos marcados "NO dispersados" en un corte y que
// siguen pendientes de pagarse en un corte futuro, vía un layout SEPARADO
// (nunca mezclado con el layout normal del día).

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Registra un monto no dispersado (llamar al marcar un bloque como no pagado).
async function registrar(db, p) {
  const row = (await db.query(
    `insert into dispersiones_pendientes(
       origen_corte_id, origen_calculo_id, numero_afiliacion, grupo_cliente,
       id_grupo, bloque, monto, motivo, creado_por
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [p.origen_corte_id, p.origen_calculo_id, String(p.numero_afiliacion), p.grupo_cliente || null,
     p.id_grupo || null, p.bloque, round2(p.monto), p.motivo || null, p.creado_por || null]
  )).rows[0];
  return row.id;
}

// Pendientes (Pendiente) para un conjunto de afiliaciones — usado para
// ofrecer el "layout de pendientes anteriores" en un corte nuevo cuyas
// afiliaciones ya tuvieron actividad.
async function pendientesDeAfiliaciones(db, afiliaciones) {
  if (!afiliaciones || !afiliaciones.length) return [];
  const rows = (await db.query(
    `select id, origen_corte_id, numero_afiliacion, grupo_cliente, id_grupo, bloque,
            monto, motivo, creado_at
       from dispersiones_pendientes
      where estatus='Pendiente' and numero_afiliacion = any($1::text[])
      order by creado_at asc, id asc`,
    [afiliaciones.map(String)]
  )).rows;
  return rows.map(r => ({ ...r, monto: Number(r.monto) }));
}

// Igual que pendientesDeAfiliaciones, pero además incluye las que YA se
// recuperaron (Aplicado) en `corteId` -- se usa para armar el correo y el
// adjunto de recuperación DESPUÉS de confirmar la dispersión, momento en el
// que el pendiente ya dejó de estar en estatus Pendiente.
async function pendientesORecuperadasEnCorte(db, afiliaciones, corteId) {
  if (!afiliaciones || !afiliaciones.length) return [];
  const rows = (await db.query(
    `select id, origen_corte_id, numero_afiliacion, grupo_cliente, id_grupo, bloque,
            monto, motivo, creado_at
       from dispersiones_pendientes
      where numero_afiliacion = any($1::text[])
        and origen_corte_id <> $2
        and (estatus='Pendiente' or aplicado_en_corte_id=$2)
      order by creado_at asc, id asc`,
    [afiliaciones.map(String), corteId]
  )).rows;
  return rows.map(r => ({ ...r, monto: Number(r.monto) }));
}

// Marca una pendiente como pagada en el corte que se está dispersando ahora.
async function marcarAplicado(db, id, corteId) {
  await db.query(
    "update dispersiones_pendientes set estatus='Aplicado', aplicado_en_corte_id=$1 where id=$2 and estatus='Pendiente'",
    [corteId, id]
  );
}

// Al borrar un corte: libera cualquier pendiente que se haya marcado Aplicado
// en él (vuelve a Pendiente, sigue disponible para el siguiente intento).
async function revertirCorte(db, corteId) {
  await db.query(
    "update dispersiones_pendientes set estatus='Pendiente', aplicado_en_corte_id=null where aplicado_en_corte_id=$1",
    [corteId]
  );
}

// Cancela manualmente un pendiente (ej. comercio dado de baja, deuda condonada).
async function cancelar(db, id, motivo) {
  const r = await db.query(
    "update dispersiones_pendientes set estatus='Cancelado', motivo=coalesce($1, motivo) where id=$2 and estatus='Pendiente' returning id",
    [motivo || null, id]
  );
  return r.rows.length > 0;
}

module.exports = { registrar, pendientesDeAfiliaciones, pendientesORecuperadasEnCorte, marcarAplicado, revertirCorte, cancelar };
