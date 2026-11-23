/* lib/mesa/uif.js — Mesa de control: detección de operaciones relevantes e inusuales (apoyo a PLD/UIF).
   Detecta y deja registro para que Cumplimiento dictamine y lleve el control del reporte; NO presenta avisos ante la autoridad (eso se hace en el portal oficial
   con el archivo que se exporta). Las reglas y umbrales son configurables en «Facultades y política». */
'use strict';
const K = require('./core.js');
const S = K.S;

async function registrar(t, x) {
  await t.query(`insert into ${S}mc_uif(tipo,regla,credito_id,pago_id,fecha,monto,descripcion,es_ejemplo)
    select $1,$2,$3,$4,$5,$6,$7,$8 where not exists (select 1 from ${S}mc_uif where regla=$2 and coalesce(pago_id,0)=coalesce($4::int,0) and coalesce(credito_id,0)=coalesce($3::int,0) and fecha=$5)`,
  [x.tipo, x.regla, x.credito_id || null, x.pago_id || null, x.fecha, x.monto == null ? null : x.monto, x.descripcion, !!x.es_ejemplo]);
}

/* Reglas que se evalúan al registrar un pago.
   · relevante_efectivo: pago en efectivo igual o mayor al umbral.
   · estructuracion: varios pagos en efectivo en pocos días que juntos llegan al umbral (fraccionar para no llegar al umbral).
   · pago_tercero: pago hecho por una persona distinta del acreditado.
   · liquidacion_anticipada: el crédito se liquida muy pronto después del desembolso. */
async function detectarPago(t, { credito, pago, cfg, liquidado }) {
  const u = (cfg && cfg.uif) || { umbral_relevante: 150000, ventana_dias: 7, min_pagos_estructuracion: 3, meses_liquidacion_anticipada: 3 };
  const base = { credito_id: credito.id, pago_id: pago.id, fecha: pago.fecha, es_ejemplo: credito.es_ejemplo };
  if (pago.medio === 'efectivo' && pago.monto >= u.umbral_relevante)
    await registrar(t, { ...base, tipo: 'relevante', regla: 'relevante_efectivo', monto: pago.monto, descripcion: `Pago en efectivo de ${pago.monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} al crédito ${credito.folio} (umbral ${u.umbral_relevante.toLocaleString('es-MX')})` });
  if (pago.medio === 'efectivo') {
    const r = (await t.query(`select count(*)::int n, coalesce(sum(monto),0) m from ${S}mc_pagos where credito_id=$1 and estado='registrado' and medio='efectivo' and fecha <= $2::date and fecha > ($2::date - $3::int)`, [credito.id, pago.fecha, u.ventana_dias])).rows[0];
    if (r.n >= u.min_pagos_estructuracion && Number(r.m) >= u.umbral_relevante && pago.monto < u.umbral_relevante)
      await registrar(t, { ...base, tipo: 'inusual', regla: 'estructuracion', monto: Number(r.m), descripcion: `${r.n} pagos en efectivo en ${u.ventana_dias} días suman ${Number(r.m).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} al crédito ${credito.folio}: posible fraccionamiento` });
  }
  if (pago.medio === 'tercero') await registrar(t, { ...base, tipo: 'inusual', regla: 'pago_tercero', monto: pago.monto, descripcion: `Pago de un tercero por ${pago.monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} al crédito ${credito.folio}` });
  if (liquidado && credito.fecha_desembolso) {
    const meses = (new Date(pago.fecha) - new Date(credito.fecha_desembolso)) / (30.4375 * 864e5);
    if (meses <= u.meses_liquidacion_anticipada) await registrar(t, { ...base, tipo: 'inusual', regla: 'liquidacion_anticipada', monto: pago.monto, descripcion: `El crédito ${credito.folio} se liquidó a los ${meses.toFixed(1)} meses de su desembolso` });
  }
}

module.exports = { detectarPago, registrar };
