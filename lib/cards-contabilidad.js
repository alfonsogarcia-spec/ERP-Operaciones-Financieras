/* ============================================================================
   lib/cards-contabilidad.js — Corte de comisiones de BSO Cards: qué se cobró, con IVA, y a quién facturarlo.

   Funciona como el corte de MCEB: al hacerlo entra TODO lo que ya está guardado (fondeos ASIGNADOS, con su fecha de depósito) y que
   aún no entró a otro corte. Lo que no estaba guardado cae en el siguiente corte. Cada fondeo entra a un solo corte.
   ========================================================================= */
'use strict';
const { round2 } = require('./cards-fondeo.js');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fechaLarga = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}` : '—'; };
const fechaCorta = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; };

/* RFC de persona moral (12) o física (13). */
const rfcValido = v => /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(String(v || '').toUpperCase().replace(/\s/g, ''));

/* Filas por fondeo → resumen por empresa (a quién se factura) + totales + rango de depósitos + datos fiscales que faltan. */
function resumir(detalle) {
  const por = new Map();
  for (const f of detalle) {
    let e = por.get(f.empresa_id);
    if (!e) { e = { empresa_id: f.empresa_id, empresa: f.empresa, razon_social: f.razon_social || null, rfc: f.rfc ? String(f.rfc).toUpperCase().replace(/\s/g, '') : null, fondeos: 0, fondeo: 0, comision: 0, iva: 0 }; por.set(f.empresa_id, e); }
    e.fondeos += 1; e.fondeo += Number(f.fondeo) || 0; e.comision += Number(f.comision) || 0; e.iva += Number(f.iva) || 0;
  }
  const resumen = [...por.values()].map(e => ({
    ...e, fondeo: round2(e.fondeo), comision: round2(e.comision), iva: round2(e.iva), total: round2(e.comision + e.iva),
    falta: [!e.razon_social ? 'razón social' : null, !e.rfc ? 'RFC' : (!rfcValido(e.rfc) ? 'RFC válido' : null)].filter(Boolean),
  })).sort((a, b) => a.empresa.localeCompare(b.empresa, 'es'));
  const t = k => round2(resumen.reduce((s, e) => s + e[k], 0));
  const fechas = detalle.map(f => f.fecha_abono).filter(Boolean).sort();
  return { resumen, totales: { empresas: resumen.length, fondeos: resumen.reduce((s, e) => s + e.fondeos, 0), fondeo: t('fondeo'), comision: t('comision'), iva: t('iva'), total: t('total'), deposito_desde: fechas[0] || null, deposito_hasta: fechas[fechas.length - 1] || null } };
}

/* Lo que está por cortar: fondeos ASIGNADOS, con depósito hasta `hasta` (inclusive), que no han entrado a ningún corte. */
async function pendientes(db, hasta) {
  const rows = (await db.query(
    `select f.id, f.folio, f.fecha::text as fecha_abono, (f.validado_at at time zone 'America/Mexico_City')::date::text as fecha_asignacion,
            f.empresa_id, emp.nombre as empresa, emp.razon_social, emp.referencia as rfc, e.nombre as destino,
            f.fondeo, f.comision, f.iva, f.comision_pct, f.iva_pct, f.monto_recibido
       from cards.fondeos f join cards.entidades emp on emp.id = f.empresa_id join cards.entidades e on e.id = f.entidad_id
      where f.estatus = 'ASIGNADO' and f.corte_comision_id is null and f.fecha <= $1
      order by emp.nombre, f.fecha, f.id`, [hasta])).rows;
  const detalle = rows.map(r => ({ ...r, fondeo: Number(r.fondeo), comision: Number(r.comision), iva: Number(r.iva), comision_pct: Number(r.comision_pct), iva_pct: Number(r.iva_pct), monto_recibido: r.monto_recibido == null ? null : Number(r.monto_recibido) }));
  return { detalle, ...resumir(detalle) };
}

/* Hace el corte: congela lo pendiente en un registro y marca esos fondeos para que no entren a otro. Devuelve el id del corte. */
async function hacerCorte(db, { hasta, hoy, quien, origen, posCorteId }) {
  const p = await pendientes(db, hasta);
  const id = (await db.query(
    `insert into cards.cortes_comision(fecha_corte, depositos_hasta, origen, pos_corte_id, resumen, detalle, totales, generado_por)
     values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8) returning id`,
    [hoy, hasta, origen || 'MANUAL', posCorteId || null, JSON.stringify(p.resumen), JSON.stringify(p.detalle), JSON.stringify(p.totales), quien || 'sistema'])).rows[0].id;
  if (p.detalle.length) {
    // Solo cuenta lo que de verdad se marcó: si otro corte se llevó un fondeo en este instante, no se duplica.
    const marcados = new Set((await db.query('update cards.fondeos set corte_comision_id=$1 where id = any($2::int[]) and corte_comision_id is null returning id', [id, p.detalle.map(f => f.id)])).rows.map(r => r.id));
    if (marcados.size !== p.detalle.length) {
      const detalle = p.detalle.filter(f => marcados.has(f.id)), r = resumir(detalle);
      await db.query('update cards.cortes_comision set resumen=$1::jsonb, detalle=$2::jsonb, totales=$3::jsonb where id=$4', [JSON.stringify(r.resumen), JSON.stringify(detalle), JSON.stringify(r.totales), id]);
    }
  }
  return id;
}

/* Deshace un corte que no se ha enviado: sus fondeos vuelven a estar por cortar. */
async function deshacerCorte(db, id) {
  const c = (await db.query('select estado from cards.cortes_comision where id=$1', [id])).rows[0];
  if (!c) return { error: 'no_existe' };
  if (c.estado === 'ENVIADO') return { error: 'enviado' };
  await db.query('update cards.fondeos set corte_comision_id=null where corte_comision_id=$1', [id]);
  await db.query('delete from cards.cortes_comision where id=$1', [id]);
  return { ok: true };
}

const tituloCorte = c => `Corte al ${fechaLarga(String(c.fecha_corte).slice(0, 10))}`;
const textoDepositos = t => !t || !t.deposito_desde ? 'sin depósitos' : t.deposito_desde === t.deposito_hasta ? `depósitos del ${fechaCorta(t.deposito_desde)}` : `depósitos del ${fechaCorta(t.deposito_desde)} al ${fechaCorta(t.deposito_hasta)}`;

/* Hojas del Excel del corte: lo que se factura por empresa y el detalle por fondeo (con su fecha de depósito). */
function hojasXlsx(corte) {
  const t = corte.totales || {};
  const fact = [[`BSO Cards · Corte de comisiones · ${tituloCorte(corte).toLowerCase()} · ${textoDepositos(t)}`], [], ['Razón social a facturar', 'RFC', 'Empresa', 'Fondeos', 'Fondeo neto', 'Comisión', 'IVA', 'Total a facturar', 'Datos por completar']];
  (corte.resumen || []).forEach(e => fact.push([e.razon_social || '', e.rfc || '', e.empresa, e.fondeos, e.fondeo, e.comision, e.iva, e.total, (e.falta || []).join(', ')]));
  fact.push([], ['TOTAL', '', '', t.fondeos || 0, t.fondeo || 0, t.comision || 0, t.iva || 0, t.total || 0, '']);
  const det = [['Fecha de depósito', 'Empresa', 'Razón social', 'RFC', 'Folio', 'Destino', 'Fecha de asignación', 'Fondeo neto', '% comisión', 'Comisión', '% IVA', 'IVA', 'Total comisión + IVA']];
  (corte.detalle || []).forEach(d => det.push([d.fecha_abono || '', d.empresa, d.razon_social || '', d.rfc || '', d.folio, d.destino, d.fecha_asignacion || '', d.fondeo, d.comision_pct, d.comision, d.iva_pct, d.iva, round2(d.comision + d.iva)]));
  return [
    { name: 'Facturación', aoa: fact, cols: [34, 16, 26, 9, 15, 14, 14, 16, 24].map(w => ({ wch: w })), freeze: { xSplit: 0, ySplit: 3, topLeftCell: 'A4' } },
    { name: 'Detalle', aoa: det, cols: [16, 26, 34, 16, 16, 30, 16, 15, 11, 13, 8, 12, 18].map(w => ({ wch: w })), freeze: { xSplit: 0, ySplit: 1, topLeftCell: 'A2' } },
  ];
}

module.exports = { fechaLarga, fechaCorta, rfcValido, resumir, pendientes, hacerCorte, deshacerCorte, tituloCorte, textoDepositos, hojasXlsx };
