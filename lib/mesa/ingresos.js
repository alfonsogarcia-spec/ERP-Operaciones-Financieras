/* lib/mesa/ingresos.js — Mesa de control · INGRESOS POR FACTURAR: comisiones por apertura cobradas e intereses cobrados (ordinarios y moratorios), con IVA y con la
   razón social y el RFC a quien se factura. Funciona como el corte de Cards: al hacer el corte entra TODO lo cobrado hasta la fecha que aún no entró a otro corte (cada
   cobro entra a un solo corte, así nada se factura dos veces ni se pierde); se manda a contabilidad por correo, cada semana de forma automática o a mano.
   Si un pago que ya salió en un corte se cancela después, queda un ajuste negativo que entra al siguiente corte (para la nota de crédito). */
'use strict';
const A = require('./amortiza.js');
const U = require('./util.js');
const K = require('./core.js');
const CA = require('./cartera.js');
const CFG = require('./config.js');
const B = require('./bitacora.js');
const X = require('../excel.js');

const S = K.S, r2 = A.r2;
const TIPOS = { comision_apertura: 'Comisión por apertura', interes: 'Intereses ordinarios', moratorio: 'Intereses moratorios', ajuste: 'Ajuste por pago cancelado' };
const rfcValido = v => /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(String(v || '').toUpperCase().replace(/\s/g, ''));

/* Todo lo cobrado hasta `hasta` que no está en ningún corte. */
async function pendientes(q, hasta) {
  const ya = new Set((await q.query(`select origen, origen_id, tipo from ${S}mc_corte_items where origen in ('desembolso','pago') and corte_id is not null`)).rows.map(r => `${r.origen}:${r.origen_id}:${r.tipo}`));
  const items = [];
  // 1 · comisión por apertura de los desembolsos confirmados
  const des = (await q.query(`select d.id, d.monto, d.comision, d.fecha_real::text f, c.id credito_id, c.folio, c.comision_apertura, c.solicitante_id, s.nombre, s.rfc_cifrado
    from ${S}mc_desembolsos d join ${S}mc_creditos c on c.id=d.credito_id join ${S}mc_solicitantes s on s.id=c.solicitante_id where d.estado='confirmado' and d.fecha_real <= $1::date order by d.fecha_real, d.id`, [hasta])).rows;
  for (const d of des) {
    if (ya.has(`desembolso:${d.id}:comision_apertura`)) continue;
    const base = r2(Number(d.monto) * Number(d.comision_apertura)), iva = r2(Number(d.comision) - base); if (base <= 0) continue;
    items.push({ origen: 'desembolso', origen_id: d.id, tipo: 'comision_apertura', credito_id: d.credito_id, folio: d.folio, fecha: d.f, base, iva, solicitante_id: d.solicitante_id, acreditado: d.nombre, rfc: K.descif(d.rfc_cifrado) });
  }
  // 2 · intereses cobrados: de cada pago, lo que se aplicó a interés ordinario y a moratorios, con su IVA
  for (const x of await CA.cargar(q, hasta, { estados: ['vigente', 'liquidado'] })) {
    for (const ap of x.st.aplicaciones) {
      if (ap.fecha > hasta) continue;
      const ivaMor = r2(ap.mor * x.credito.iva_pct), ivaInt = r2(ap.iva - ivaMor), base = { origen: 'pago', origen_id: ap.id, credito_id: x.credito.id, folio: x.credito.folio, fecha: ap.fecha, solicitante_id: x.credito.solicitante_id, acreditado: x.solicitante.nombre, rfc: x.solicitante.rfc };
      if (ap.interes > 0.004 && !ya.has(`pago:${ap.id}:interes`)) items.push({ ...base, tipo: 'interes', base: ap.interes, iva: ivaInt });
      if (ap.mor > 0.004 && !ya.has(`pago:${ap.id}:moratorio`)) items.push({ ...base, tipo: 'moratorio', base: ap.mor, iva: ivaMor });
    }
  }
  // 3 · ajustes de pagos cancelados después de entrar a un corte
  const aj = (await q.query(`select i.id, i.origen_id, i.credito_id, i.fecha::text f, i.base, i.iva, i.nota, c.folio, c.solicitante_id, s.nombre, s.rfc_cifrado from ${S}mc_corte_items i join ${S}mc_creditos c on c.id=i.credito_id join ${S}mc_solicitantes s on s.id=c.solicitante_id where i.origen='ajuste_pago' and i.corte_id is null order by i.id`)).rows;
  for (const a of aj) items.push({ item_id: a.id, origen: 'ajuste_pago', origen_id: a.origen_id, tipo: 'ajuste', credito_id: a.credito_id, folio: a.folio, fecha: a.f, base: Number(a.base), iva: Number(a.iva), nota: a.nota, solicitante_id: a.solicitante_id, acreditado: a.nombre, rfc: K.descif(a.rfc_cifrado) });
  return { items, ...resumir(items) };
}

/* Items → resumen por acreditado (a quién se factura) + totales por concepto. */
function resumir(items) {
  const por = new Map();
  for (const i of items) {
    let e = por.get(i.solicitante_id);
    if (!e) { e = { solicitante_id: i.solicitante_id, razon_social: i.acreditado, rfc: i.rfc ? String(i.rfc).toUpperCase().replace(/\s/g, '') : null, comision_apertura: { base: 0, iva: 0 }, interes: { base: 0, iva: 0 }, moratorio: { base: 0, iva: 0 }, ajuste: { base: 0, iva: 0 }, creditos: new Set(), movimientos: 0 }; por.set(i.solicitante_id, e); }
    e[i.tipo].base += i.base; e[i.tipo].iva += i.iva; e.creditos.add(i.folio); e.movimientos++;
  }
  const t0 = () => ({ base: 0, iva: 0, total: 0 }), tot = { comision_apertura: t0(), interes: t0(), moratorio: t0(), ajuste: t0() };
  const resumen = [...por.values()].map(e => {
    for (const k of Object.keys(TIPOS)) { e[k] = { base: r2(e[k].base), iva: r2(e[k].iva) }; tot[k].base += e[k].base; tot[k].iva += e[k].iva; }
    const base = r2(Object.keys(TIPOS).reduce((s, k) => s + e[k].base, 0)), iva = r2(Object.keys(TIPOS).reduce((s, k) => s + e[k].iva, 0));
    return { ...e, creditos: [...e.creditos], base, iva, total: r2(base + iva), falta: [!e.rfc ? 'RFC' : (!rfcValido(e.rfc) ? 'RFC válido' : null)].filter(Boolean) };
  }).sort((a, b) => a.razon_social.localeCompare(b.razon_social, 'es'));
  for (const k of Object.keys(tot)) { tot[k].base = r2(tot[k].base); tot[k].iva = r2(tot[k].iva); tot[k].total = r2(tot[k].base + tot[k].iva); }
  const base = r2(Object.values(tot).reduce((s, x) => s + x.base, 0)), iva = r2(Object.values(tot).reduce((s, x) => s + x.iva, 0)), fechas = items.map(i => i.fecha).sort();
  return { resumen, totales: { ...tot, base, iva, total: r2(base + iva), acreditados: resumen.length, movimientos: items.length, desde: fechas[0] || null, hasta: fechas[fechas.length - 1] || null, sin_rfc: resumen.filter(e => e.falta.length).length } };
}

/* Hace el corte: entra todo lo pendiente hasta `hasta`. Devuelve el id, o null si no había nada. Va dentro de una transacción (t). */
async function hacerCorte(t, { hasta, hoy, quien, origen, esEjemplo }) {
  const p = await pendientes(t, hasta); if (!p.items.length) return null;
  const detalle = p.items.map(i => ({ fecha: i.fecha, folio: i.folio, acreditado: i.acreditado, rfc: i.rfc, tipo: i.tipo, base: i.base, iva: i.iva, nota: i.nota || null }));
  const id = (await t.query(`insert into ${S}mc_cortes_ingreso(fecha_corte,hasta,origen,resumen,detalle,totales,generado_por,es_ejemplo) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [hoy, hasta, origen || 'MANUAL', JSON.stringify(p.resumen), JSON.stringify(detalle), JSON.stringify(p.totales), quien, !!esEjemplo])).rows[0].id;
  for (const i of p.items) {
    if (i.origen === 'ajuste_pago') await t.query(`update ${S}mc_corte_items set corte_id=$1 where id=$2`, [id, i.item_id]);
    else await t.query(`insert into ${S}mc_corte_items(corte_id,origen,origen_id,tipo,credito_id,fecha,base,iva) values($1,$2,$3,$4,$5,$6,$7,$8)`, [id, i.origen, i.origen_id, i.tipo, i.credito_id, i.fecha, i.base, i.iva]);
  }
  return id;
}
/* Deshace un corte que no se ha enviado: sus cobros vuelven a quedar por cortar. */
async function deshacerCorte(t, id) {
  const c = (await t.query(`select estado from ${S}mc_cortes_ingreso where id=$1`, [id])).rows[0];
  if (!c) return { error: 'no_existe' }; if (c.estado === 'ENVIADO') return { error: 'enviado' };
  await t.query(`delete from ${S}mc_corte_items where corte_id=$1 and origen<>'ajuste_pago'`, [id]);
  await t.query(`update ${S}mc_corte_items set corte_id=null where corte_id=$1`, [id]);
  await t.query(`delete from ${S}mc_cortes_ingreso where id=$1`, [id]);
  return { ok: true };
}

const tit = c => `Corte de ingresos #${c.id} · cobros del ${U.fechaLarga(c.totales.desde || c.hasta)} al ${U.fechaLarga(c.hasta)}`;
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

/* Libro de Excel para contabilidad: lo que se factura por acreditado y el detalle de cada cobro. */
function hojasXlsx(c) {
  const R = parse(c.resumen), D = parse(c.detalle), T = parse(c.totales), n = x => Number(x) || 0;
  const cab = ['Razón social (a quien se factura)', 'RFC', 'Comisión por apertura · base', 'IVA comisión', 'Intereses ordinarios · base', 'IVA intereses', 'Moratorios · base', 'IVA moratorios', 'Ajustes (base)', 'Ajustes (IVA)', 'Base total', 'IVA total', 'TOTAL A FACTURAR', 'Datos que faltan'];
  const filas = R.map(e => [e.razon_social, e.rfc || '', e.comision_apertura.base, e.comision_apertura.iva, e.interes.base, e.interes.iva, e.moratorio.base, e.moratorio.iva, e.ajuste.base, e.ajuste.iva, e.base, e.iva, e.total, e.falta.join(', ')]);
  const sum = i => r2(filas.reduce((s, f) => s + n(f[i]), 0));
  return [
    { name: 'Para facturar', aoa: [[`Credit Solvendom · ${tit(c)}`], ['Cada cobro entra a un solo corte. Comisiones por apertura e intereses cobrados, con IVA, como ingreso a facturar.'], [], cab, ...filas, ['TOTAL', '', ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(sum), '']], cols: [{ wch: 38 }, { wch: 16 }, ...Array(11).fill({ wch: 18 }), { wch: 22 }], merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 12 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 12 } }] },
    { name: 'Detalle', aoa: [['Fecha de cobro', 'Crédito', 'Acreditado', 'RFC', 'Concepto', 'Base', 'IVA', 'Total', 'Nota'], ...D.map(d => [d.fecha, d.folio, d.acreditado, d.rfc || '', TIPOS[d.tipo], d.base, d.iva, r2(d.base + d.iva), d.nota || ''])], cols: [{ wch: 14 }, { wch: 14 }, { wch: 38 }, { wch: 16 }, { wch: 26 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 40 }] },
    { name: 'Resumen', aoa: [['Concepto', 'Base', 'IVA', 'Total'], ...Object.keys(TIPOS).map(k => [TIPOS[k], T[k].base, T[k].iva, T[k].total]), ['TOTAL', T.base, T.iva, T.total]], cols: [{ wch: 32 }, { wch: 18 }, { wch: 16 }, { wch: 18 }] },
  ];
}

/* Correo a contabilidad. Devuelve { subject, html, text }. */
function armarCorreo({ corte: c, appUrl, adjunto }) {
  const R = parse(c.resumen), T = parse(c.totales), m = U.mxn, e = U.esc;
  const url = (appUrl || 'https://polipay-conciliacion-liquidacion.onrender.com').replace(/\/$/, '');
  const th = 'padding:7px 10px;border-bottom:1px solid #e3e6ee;font:600 12px/1.3 Arial,sans-serif;color:#5a647c;text-align:left', td = 'padding:7px 10px;border-bottom:1px solid #eef0f5;font:400 13px/1.4 Arial,sans-serif;color:#1c2333', num = td + ';text-align:right;font-variant-numeric:tabular-nums';
  const conc = Object.keys(TIPOS).filter(k => k !== 'ajuste' || T.ajuste.total !== 0).map(k => `<tr><td style="${td}">${e(TIPOS[k])}</td><td style="${num}">${m(T[k].base)}</td><td style="${num}">${m(T[k].iva)}</td><td style="${num}"><b>${m(T[k].total)}</b></td></tr>`).join('');
  const filas = R.map(x => `<tr><td style="${td}"><b>${e(x.razon_social)}</b><br><span style="color:#5a647c;font-size:12px">${x.rfc ? 'RFC ' + e(x.rfc) : '<b style="color:#a81d31">Falta el RFC</b>'}${x.falta.includes('RFC válido') ? ' <b style="color:#a81d31">(no es válido)</b>' : ''} · ${e(x.creditos.join(', '))}</span></td><td style="${num}">${m(x.comision_apertura.base + x.comision_apertura.iva)}</td><td style="${num}">${m(x.interes.base + x.interes.iva + x.moratorio.base + x.moratorio.iva)}</td><td style="${num}">${m(x.base)}</td><td style="${num}">${m(x.iva)}</td><td style="${num}"><b>${m(x.total)}</b></td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f9"><div style="max-width:760px;margin:0 auto;padding:24px"><div style="background:#fff;border-radius:12px;padding:26px 28px;border:1px solid #e3e6ee">
<img src="cid:polipay-logo" alt="Polipay" height="30" style="display:block;margin-bottom:14px">
<div style="font:700 19px/1.3 Arial,sans-serif;color:#1c2333">Ingresos por facturar · Credit Solvendom</div>
<div style="font:400 13px/1.5 Arial,sans-serif;color:#5a647c;margin:4px 0 16px">${e(tit(c))}. Comisiones por apertura e intereses cobrados, con IVA, para facturar como ingreso${adjunto ? '. Va adjunto el detalle en Excel' : ''}.</div>
<table style="width:100%;border-collapse:collapse;margin-bottom:18px"><tr><th style="${th}">Concepto cobrado</th><th style="${th};text-align:right">Base</th><th style="${th};text-align:right">IVA</th><th style="${th};text-align:right">Total</th></tr>${conc}
<tr><td style="${td}"><b>Total a facturar</b></td><td style="${num}"><b>${m(T.base)}</b></td><td style="${num}"><b>${m(T.iva)}</b></td><td style="${num}"><b>${m(T.total)}</b></td></tr></table>
${T.sin_rfc ? `<div style="background:#fbf4e4;border:1px solid #c9a25c;border-radius:8px;padding:10px 14px;font:400 13px/1.5 Arial,sans-serif;color:#1c2333;margin-bottom:16px"><b>${T.sin_rfc} acreditado(s) sin RFC válido.</b> No se puede facturar hasta tener sus datos fiscales: pídeselos a la mesa de control.</div>` : ''}
<div style="font:600 14px Arial,sans-serif;color:#1c2333;margin:0 0 8px">A quién se factura</div>
<table style="width:100%;border-collapse:collapse"><tr><th style="${th}">Razón social</th><th style="${th};text-align:right">Comisión apertura</th><th style="${th};text-align:right">Intereses</th><th style="${th};text-align:right">Base</th><th style="${th};text-align:right">IVA</th><th style="${th};text-align:right">Total</th></tr>${filas}</table>
<div style="font:400 12px/1.5 Arial,sans-serif;color:#5a647c;margin-top:16px">Cada cobro entra a un solo corte. Si un pago ya incluido se cancela después, aparece como ajuste negativo en el siguiente corte. Detalle y descarga: <a href="${url}" style="color:#1166db">${e(url.replace(/^https?:\/\//, ''))}</a> → Credit Solvendom → Contabilidad.</div>
</div></div></body></html>`;
  const text = `Ingresos por facturar · Credit Solvendom\n${tit(c)}\n\n` + Object.keys(TIPOS).map(k => `${TIPOS[k]}: base ${m(T[k].base)} + IVA ${m(T[k].iva)} = ${m(T[k].total)}`).join('\n') + `\n\nTOTAL A FACTURAR: base ${m(T.base)} + IVA ${m(T.iva)} = ${m(T.total)}\n\n` + R.map(x => `${x.razon_social} (${x.rfc || 'SIN RFC'}): ${m(x.total)}`).join('\n');
  return { subject: `Polipay · Credit Solvendom · Ingresos por facturar · corte #${c.id} (${m(T.total)})`, html, text };
}

/* Destinatarios del correo (tabla propia de la mesa), listos para SES. */
async function destinatarios(q) {
  const filas = (await q.query(`select email_cifrado, nombre, tipo from ${S}mc_destinatarios where activo order by id`)).rows;
  const dir = r => { const em = K.descif(r.email_cifrado); return em ? (r.nombre ? `${String(r.nombre).replace(/["<>\r\n,;]/g, ' ')} <${em}>` : em) : null; };
  const por = t => filas.filter(r => r.tipo === t).map(dir).filter(Boolean);
  return { to: por('to'), cc: por('cc'), bcc: por('bcc'), total: filas.length };
}

/* Envía (o reenvía) un corte. `correo` = { activo(), enviar({to,cc,bcc,subject,html,text,attachments}) } que pone el servidor. */
async function enviarCorte(db, correo, id, quien) {
  const c = (await db.query(`select id, fecha_corte::text fecha_corte, hasta::text hasta, resumen, detalle, totales, estado from ${S}mc_cortes_ingreso where id=$1`, [id])).rows[0];
  if (!c) return { error: 'no_existe', mensaje: 'No existe ese corte.' };
  const d = await destinatarios(db);
  if (!d.to.length) return { error: 'sin_destinatarios', mensaje: 'Falta al menos un destinatario «Para» del corte: agrégalo en «Destinatarios del correo».' };
  if (!correo || !correo.activo()) return { error: 'ses_no_configurado', mensaje: 'El correo no está configurado en este servidor.' };
  const m = armarCorreo({ corte: c, adjunto: true });
  const adj = [{ filename: `ingresos_por_facturar_${c.fecha_corte}_${c.id}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: X.buildXLSX(hojasXlsx(c)) }];
  const msgId = await Promise.race([correo.enviar({ to: d.to, cc: d.cc, bcc: d.bcc, subject: m.subject, html: m.html, text: m.text, attachments: adj }), new Promise((_r, rej) => setTimeout(() => rej(new Error('tiempo de espera agotado')), 15000))]);
  await db.tx(async t => {
    await t.query(`update ${S}mc_cortes_ingreso set estado='ENVIADO', enviado_at=now(), enviado_por=$1, enviado_a=$2, message_id=$3 where id=$4`, [quien, [...d.to, ...d.cc].join(', '), String(msgId || ''), id]);
    await B.anotar(t, { usuario: quien, rol: quien.startsWith('sistema') ? 'sistema' : null, accion: 'ingresos_enviar', entidad: 'contabilidad', entidad_id: `corte-${id}`, resumen: `Envió a contabilidad el corte de ingresos #${id} por ${U.mxn(parse(c.totales).total)} a ${d.to.length + d.cc.length} destinatario(s)`, detalle: { corte: id, destinatarios: d.to.length + d.cc.length } });
  });
  return { ok: true, destinatarios: d.to.length + d.cc.length + d.bcc.length };
}

/* Revisión periódica (cada hora): el día configurado de la semana se hace el corte de lo cobrado hasta el día anterior y se manda; si el envío falló, se reintenta el mismo día. */
async function envioAutomatico(db, correo) {
  const cfg = await CFG.cargar(db), c = cfg.contabilidad || {};
  if (!c.envio_activo) return { omitido: 'apagado' };
  const hoy = U.hoyMx(), dow = new Date(hoy + 'T12:00:00Z').getUTCDay();
  if (dow !== Number(c.dia_semana)) return { omitido: 'no_es_el_dia' };
  let corte = (await db.query(`select id, estado from ${S}mc_cortes_ingreso where origen='AUTOMATICO' and fecha_corte=$1 order by id desc limit 1`, [hoy])).rows[0];
  if (corte && corte.estado === 'ENVIADO') return { omitido: 'ya_enviado' };
  const hasta = new Date(Date.parse(hoy + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  if (!corte) {
    const id = await db.tx(async t => { const i = await hacerCorte(t, { hasta, hoy, quien: 'sistema (automático)', origen: 'AUTOMATICO' }); if (i) await B.anotar(t, { usuario: 'sistema (automático)', rol: 'sistema', accion: 'ingresos_corte', entidad: 'contabilidad', entidad_id: `corte-${i}`, resumen: `Hizo el corte semanal automático de ingresos #${i} (cobros hasta ${hasta})`, detalle: { corte: i, hasta } }); return i; });
    if (!id) return { omitido: 'sin_movimientos' };
    corte = { id };
  }
  return { corte: corte.id, envio: await enviarCorte(db, correo, corte.id, 'sistema (automático)') };
}

module.exports = { TIPOS, pendientes, resumir, hacerCorte, deshacerCorte, hojasXlsx, armarCorreo, destinatarios, enviarCorte, envioAutomatico };
