/* lib/mesa/cartera.js — Mesa de control: lectura de la cartera (créditos vigentes con su estado calculado a una fecha). Une la base con lib/mesa/amortiza.js. */
'use strict';
const A = require('./amortiza.js');
const K = require('./core.js');

const S = K.S;
const f10 = v => v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

const mapCredito = r => ({
  ...r, monto: K.num(r.monto), tasa_anual: K.num(r.tasa_anual), tasa_moratoria: K.num(r.tasa_moratoria), comision_apertura: K.num(r.comision_apertura), iva_pct: K.num(r.iva_pct), cat: K.num(r.cat),
  fecha_contrato: f10(r.fecha_contrato), fecha_desembolso: f10(r.fecha_desembolso),
});

/* Créditos con su estado a `fecha` (por omisión hoy). opts: { estados:['vigente'], ids:[...] }. Devuelve [{ credito, solicitante:{nombre,tipo,rfc}, st }]. */
async function cargar(q, fecha, opts) {
  const estados = (opts && opts.estados) || ['vigente'], a = [estados], w = ['c.estado = any($1::text[])'];
  if (opts && opts.ids) { a.push(opts.ids); w.push(`c.id = any($${a.length}::int[])`); }
  const rows = (await q.query(`select c.*, c.fecha_desembolso::text fd, c.fecha_contrato::text fc, s.nombre, s.tipo as tipo_persona, s.rfc_cifrado, p.nombre as producto_nombre
    from ${S}mc_creditos c join ${S}mc_solicitantes s on s.id=c.solicitante_id join ${S}mc_productos p on p.id=c.producto_id where ${w.join(' and ')} order by c.id`, a)).rows;
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const filas = (await q.query(`select credito_id, num, fecha::text fecha, capital, interes, iva, total, saldo from ${S}mc_amortizacion where credito_id = any($1::int[]) order by credito_id, num`, [ids])).rows;
  const pagos = (await q.query(`select id, credito_id, fecha::text fecha, monto from ${S}mc_pagos where estado='registrado' and credito_id = any($1::int[]) order by fecha, id`, [ids])).rows;
  const gf = new Map(), gp = new Map();
  for (const f of filas) { if (!gf.has(f.credito_id)) gf.set(f.credito_id, []); gf.get(f.credito_id).push({ num: f.num, fecha: f.fecha, capital: Number(f.capital), interes: Number(f.interes), iva: Number(f.iva), total: Number(f.total), saldo: Number(f.saldo) }); }
  for (const p of pagos) { if (!gp.has(p.credito_id)) gp.set(p.credito_id, []); gp.get(p.credito_id).push({ id: p.id, fecha: p.fecha, monto: Number(p.monto) }); }
  const hoy = fecha || new Date().toISOString().slice(0, 10);
  return rows.map(r => {
    const c = mapCredito({ ...r, fecha_desembolso: r.fd, fecha_contrato: r.fc });
    const st = A.estado({ filas: gf.get(r.id) || [], tasaMor: c.tasa_moratoria, ivaPct: c.iva_pct, fechaDesembolso: c.fecha_desembolso }, gp.get(r.id) || [], hoy);
    return { credito: c, solicitante: { nombre: r.nombre, tipo: r.tipo_persona, rfc: K.descif(r.rfc_cifrado) }, producto: r.producto_nombre, st };
  });
}

/* Totales de cartera: saldos por bucket, IMOR (capital con atraso mayor al umbral de vencida / capital total) y estimación preventiva. */
function resumen(lista, cfg) {
  const dv = (cfg && cfg.cartera && cfg.cartera.dias_vencida) || 90, est = (cfg && cfg.cartera && cfg.cartera.estimacion) || A.ESTIMACION_DEFAULT;
  const por = Object.fromEntries(A.BUCKETS.map(b => [b, { n: 0, capital: 0, vencido: 0, estimacion: 0 }]));
  let capital = 0, vencida = 0, estimacion = 0, moratorios = 0;
  for (const x of lista) {
    const b = x.st.bucket, cap = x.st.saldoCapital, e = A.estimacion(cap, x.st.diasAtraso, est);
    por[b].n++; por[b].capital = A.r2(por[b].capital + cap); por[b].vencido = A.r2(por[b].vencido + x.st.vencido.total); por[b].estimacion = A.r2(por[b].estimacion + e);
    capital += cap; estimacion += e; moratorios += x.st.moratorios + x.st.ivaMoratorios; if (x.st.diasAtraso >= dv) vencida += cap;
  }
  return { creditos: lista.length, capital: A.r2(capital), vencida: A.r2(vencida), vigente: A.r2(capital - vencida), imor: capital > 0 ? Math.round(vencida / capital * 10000) / 10000 : 0,
    atrasados: lista.filter(x => x.st.diasAtraso > 0).length, moratorios: A.r2(moratorios), estimacion: A.r2(estimacion), icor: capital > 0 ? Math.round(estimacion / capital * 10000) / 10000 : 0, buckets: por, dias_vencida: dv };
}

module.exports = { cargar, resumen, mapCredito, f10 };
