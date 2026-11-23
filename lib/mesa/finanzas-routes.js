/* lib/mesa/finanzas-routes.js — Mesa de control · fondeo, contabilidad (pólizas y cierre de periodo), reportes (cartera, buró borrador, comisiones) y UIF.
   API bajo /api/cartera/mc/*. */
'use strict';
const A = require('./amortiza.js');
const U = require('./util.js');
const K = require('./core.js');
const CFG = require('./config.js');
const RL = require('./roles.js');
const CA = require('./cartera.js');
const CT = require('./contabilidad.js');
const UIF = require('./uif.js');
const IN = require('./ingresos.js');
const X = require('../excel.js');
const CR = require('../crypto.js');
const { fondeoDisponible } = require('./creditos-routes.js');

const S = K.S;
const ISO = /^\d{4}-\d{2}-\d{2}$/, PER = /^\d{4}-\d{2}$/;

function montar(app, H) {
  const { db, ruta, E, quien, rolDe, asiento, txt, numOpt, correo } = H;
  const P_ = (req, p) => RL.puede(rolDe(req), p);
  const minCom = (com, n, que) => { if (!com || com.length < n) throw E(400, `${que} (mínimo ${n} caracteres).`); };
  const enviarCsv = (res, nombre, filas) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`); res.send(U.csv(filas)); };
  const fechaQ = q => ISO.test(q.fecha || '') ? q.fecha : U.hoyMx();

  /* ============================ FONDEO ============================ */
  const validarFondeo = b => {
    const f = { nombre: txt(b.nombre, 150), tipo: ['institucional', 'friends_family', 'capital_propio', 'otro'].includes(b.tipo) ? b.tipo : 'institucional', monto_linea: numOpt(b.monto_linea, 'El monto de la línea', 1, 1e12), tasa_anual: numOpt(b.tasa_anual, 'La tasa', 0, 5) ?? 0,
      revolvente: b.revolvente !== false, fecha_inicio: b.fecha_inicio ? String(b.fecha_inicio).slice(0, 10) : null, fecha_vencimiento: b.fecha_vencimiento ? String(b.fecha_vencimiento).slice(0, 10) : null, notas: txt(b.notas, 500), estado: ['vigente', 'liquidado', 'cancelado'].includes(b.estado) ? b.estado : 'vigente' };
    if (!f.nombre) throw E(400, 'Escribe el nombre de la línea o fuente de fondeo.'); if (!f.monto_linea) throw E(400, 'Captura el monto de la línea.');
    for (const k of ['fecha_inicio', 'fecha_vencimiento']) if (f[k] && !ISO.test(f[k])) throw E(400, 'Hay una fecha que no es válida.');
    if (f.fecha_inicio && f.fecha_vencimiento && f.fecha_vencimiento < f.fecha_inicio) throw E(400, 'El vencimiento no puede ser anterior al inicio.');
    return f;
  };
  ruta('get', '/api/cartera/mc/fondeos', ['ver_todas'], async (req, res) => {
    const fs = (await db.query(`select *, fecha_inicio::text fi, fecha_vencimiento::text fv from ${S}mc_fondeos order by estado, nombre`)).rows, out = [];
    for (const f of fs) {
      const d = await fondeoDisponible(db, f.id), m = (await db.query(`select tipo, coalesce(sum(monto),0) m from ${S}mc_fondeo_mov where fondeo_id=$1 group by tipo`, [f.id])).rows.reduce((o, r) => (o[r.tipo] = Number(r.m), o), {});
      const deuda = A.r2((m.disposicion || 0) - (m.pago_capital || 0));
      out.push({ id: f.id, nombre: f.nombre, tipo: f.tipo, estado: f.estado, monto_linea: Number(f.monto_linea), tasa_anual: Number(f.tasa_anual), revolvente: f.revolvente, fecha_inicio: f.fi, fecha_vencimiento: f.fv, notas: f.notas, es_ejemplo: f.es_ejemplo,
        colocado: d.usado, en_tramite: d.tramite, disponible: d.disponible, dispuesto: m.disposicion || 0, pagado_capital: m.pago_capital || 0, pagado_interes: m.pago_interes || 0, deuda, descalce: A.r2(deuda - d.usado) });
    }
    res.json(out);
  });
  ruta('post', '/api/cartera/mc/fondeos', ['fondeo'], async (req, res) => {
    const f = validarFondeo(req.body || {}); let id;
    await db.tx(async t => { id = (await t.query(`insert into ${S}mc_fondeos(nombre,tipo,monto_linea,tasa_anual,revolvente,fecha_inicio,fecha_vencimiento,estado,notas,creado_por) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [f.nombre, f.tipo, f.monto_linea, f.tasa_anual, f.revolvente, f.fecha_inicio, f.fecha_vencimiento, f.estado, f.notas, quien(req).usuario])).rows[0].id; await asiento(t, req, 'fondeo_alta', 'fondeo', id, `Dio de alta la línea de fondeo ${f.nombre} por ${U.mxn(f.monto_linea)}`, f); });
    res.status(201).json({ ok: true, id });
  });
  ruta('put', '/api/cartera/mc/fondeos/:id', ['fondeo'], async (req, res) => {
    const id = Number(req.params.id), f = validarFondeo(req.body || {});
    await db.tx(async t => {
      const a = (await t.query(`select * from ${S}mc_fondeos where id=$1`, [id])).rows[0]; if (!a) throw E(404, 'No existe esa línea.');
      await t.query(`update ${S}mc_fondeos set nombre=$2,tipo=$3,monto_linea=$4,tasa_anual=$5,revolvente=$6,fecha_inicio=$7,fecha_vencimiento=$8,estado=$9,notas=$10 where id=$1`, [id, f.nombre, f.tipo, f.monto_linea, f.tasa_anual, f.revolvente, f.fecha_inicio, f.fecha_vencimiento, f.estado, f.notas]);
      await asiento(t, req, 'fondeo_editar', 'fondeo', id, `Editó la línea de fondeo ${f.nombre}`, { antes: { monto_linea: Number(a.monto_linea), estado: a.estado, tasa: Number(a.tasa_anual) }, despues: f });
    });
    res.json({ ok: true });
  });
  ruta('get', '/api/cartera/mc/fondeos/:id/movimientos', ['ver_todas'], async (req, res) => {
    const rows = (await db.query(`select id, fecha::text fecha, tipo, monto, referencia, comentario, registrado_por from ${S}mc_fondeo_mov where fondeo_id=$1 order by fecha desc, id desc`, [Number(req.params.id)])).rows.map(r => ({ ...r, monto: Number(r.monto) }));
    const cr = (await db.query(`select id, folio, estado, monto from ${S}mc_creditos where fondeo_id=$1 order by id desc`, [Number(req.params.id)])).rows.map(r => ({ ...r, monto: Number(r.monto) }));
    res.json({ movimientos: rows, creditos: cr });
  });
  ruta('post', '/api/cartera/mc/fondeos/:id/movimientos', ['fondeo'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, tipo = String(b.tipo || ''), monto = numOpt(b.monto, 'El monto', 0.01, 1e12), fecha = String(b.fecha || U.hoyMx()).slice(0, 10), ref = txt(b.referencia, 80);
    if (!['disposicion', 'pago_capital', 'pago_interes', 'comision'].includes(tipo)) throw E(400, 'Elige el tipo de movimiento.'); if (!monto) throw E(400, 'Captura el monto.'); if (!ISO.test(fecha) || fecha > U.hoyMx()) throw E(400, 'La fecha no es válida.');
    await db.tx(async t => {
      const f = (await t.query(`select * from ${S}mc_fondeos where id=$1`, [id])).rows[0]; if (!f) throw E(404, 'No existe esa línea.'); if (f.estado !== 'vigente') throw E(409, 'La línea ya no está vigente.');
      const m = (await t.query(`select tipo, coalesce(sum(monto),0) m from ${S}mc_fondeo_mov where fondeo_id=$1 group by tipo`, [id])).rows.reduce((o, r) => (o[r.tipo] = Number(r.m), o), {});
      if (tipo === 'disposicion' && (m.disposicion || 0) - (m.pago_capital || 0) + monto > Number(f.monto_linea) + 0.005) throw E(409, 'La disposición excede el monto de la línea.');
      if (tipo === 'pago_capital' && monto > (m.disposicion || 0) - (m.pago_capital || 0) + 0.005) throw E(409, 'El pago de capital excede lo dispuesto.');
      await t.query(`insert into ${S}mc_fondeo_mov(fondeo_id,fecha,tipo,monto,referencia,comentario,registrado_por) values($1,$2,$3,$4,$5,$6,$7)`, [id, fecha, tipo, monto, ref, txt(b.comentario, 300), quien(req).usuario]);
      await asiento(t, req, 'fondeo_movimiento', 'fondeo', id, `Registró ${tipo.replace('_', ' ')} de ${U.mxn(monto)} en la línea ${f.nombre}${ref ? ' (ref. ' + ref + ')' : ''}`, { tipo, monto, fecha });
    });
    res.status(201).json({ ok: true });
  });

  /* ============================ CONTABILIDAD ============================ */
  const periodosConActividad = async (q) => {
    const r = (await (q || db).query(`select min(fecha_real)::text f from ${S}mc_desembolsos where estado='confirmado'`)).rows[0];
    if (!r || !r.f) return [];
    const out = []; let [y, m] = r.f.slice(0, 7).split('-').map(Number); const [hy, hm] = U.hoyMx().slice(0, 7).split('-').map(Number);
    while (y < hy || (y === hy && m <= hm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
    return out;
  };
  const previoDe = async (q, periodo) => {
    const r = (await q.query(`select resumen from ${S}mc_periodos where estado='cerrado' and periodo < $1 order by periodo desc limit 1`, [periodo])).rows[0];
    return r && r.resumen ? (typeof r.resumen === 'string' ? JSON.parse(r.resumen) : r.resumen) : {};
  };
  ruta('get', '/api/cartera/mc/contabilidad/periodos', ['contabilidad', 'reportes', 'ver_todas'], async (req, res) => {
    const todos = await periodosConActividad(), guard = new Map((await db.query(`select p.*, (select count(*)::int from ${S}mc_polizas z where z.periodo=p.periodo) polizas from ${S}mc_periodos p`)).rows.map(r => [r.periodo, r]));
    const hoyP = U.hoyMx().slice(0, 7);
    res.json(todos.map(p => { const g = guard.get(p); return { periodo: p, estado: g ? g.estado : 'abierto', cerrado_por: g && g.cerrado_por, cerrado_at: g && g.cerrado_at, polizas: g ? g.polizas : 0, resumen: g && g.resumen ? (typeof g.resumen === 'string' ? JSON.parse(g.resumen) : g.resumen) : null, en_curso: p === hoyP }; }).reverse());
  });
  const polizasGuardadas = async periodo => {
    const ps = (await db.query(`select id, fecha::text fecha, tipo, concepto, origen, origen_id from ${S}mc_polizas where periodo=$1 order by fecha, id`, [periodo])).rows;
    if (!ps.length) return [];
    const ls = (await db.query(`select poliza_id, cuenta, debe, haber from ${S}mc_poliza_lineas where poliza_id = any($1::int[]) order by poliza_id`, [ps.map(p => p.id)])).rows;
    return ps.map(p => ({ ...p, lineas: ls.filter(l => l.poliza_id === p.id).map(l => ({ cuenta: l.cuenta, debe: Number(l.debe), haber: Number(l.haber) })) }));
  };
  ruta('get', '/api/cartera/mc/contabilidad/polizas', ['contabilidad', 'reportes'], async (req, res) => {
    const periodo = String(req.query.periodo || ''); if (!PER.test(periodo)) throw E(400, 'Indica el periodo (AAAA-MM).');
    const g = (await db.query(`select estado from ${S}mc_periodos where periodo=$1`, [periodo])).rows[0], cuentas = (await db.query(`select clave, nombre, naturaleza from ${S}mc_cuentas order by clave`)).rows;
    let polizas, resumen = null, vista = false;
    if (g && g.estado === 'cerrado') polizas = await polizasGuardadas(periodo);
    else { const x = await CT.generar(db, periodo, await CFG.cargar(db), await previoDe(db, periodo)); polizas = x.polizas; resumen = x.resumen; vista = true; }
    const tot = CT.sumaLineas(polizas.flatMap(p => p.lineas));
    res.json({ periodo, vista_previa: vista, cerrado: !vista, polizas, resumen, totales: tot, cuentas });
  });
  ruta('get', '/api/cartera/mc/contabilidad/polizas.csv', ['contabilidad', 'reportes'], async (req, res) => {
    const periodo = String(req.query.periodo || ''); if (!PER.test(periodo)) throw E(400, 'Indica el periodo (AAAA-MM).');
    const g = (await db.query(`select estado from ${S}mc_periodos where periodo=$1`, [periodo])).rows[0];
    const polizas = g && g.estado === 'cerrado' ? await polizasGuardadas(periodo) : (await CT.generar(db, periodo, await CFG.cargar(db), await previoDe(db, periodo))).polizas;
    const nom = new Map((await db.query(`select clave, nombre from ${S}mc_cuentas`)).rows.map(c => [c.clave, c.nombre]));
    enviarCsv(res, `polizas_${periodo}${g && g.estado === 'cerrado' ? '' : '_VISTA_PREVIA'}.csv`, [['Periodo', 'Póliza', 'Fecha', 'Tipo', 'Concepto', 'Cuenta', 'Nombre de la cuenta', 'Debe', 'Haber'], ...polizas.flatMap((p, i) => p.lineas.map(l => [periodo, p.id || i + 1, p.fecha, p.tipo, p.concepto, l.cuenta, nom.get(l.cuenta) || '', l.debe, l.haber]))]);
  });
  ruta('get', '/api/cartera/mc/contabilidad/balanza', ['contabilidad', 'reportes'], async (req, res) => {
    const periodo = String(req.query.periodo || ''); if (!PER.test(periodo)) throw E(400, 'Indica el periodo (AAAA-MM).');
    const rows = (await db.query(`select c.clave, c.nombre, c.naturaleza, coalesce(sum(l.debe),0) debe, coalesce(sum(l.haber),0) haber from ${S}mc_cuentas c left join ${S}mc_poliza_lineas l on l.cuenta=c.clave left join ${S}mc_polizas p on p.id=l.poliza_id and p.periodo <= $1 where (p.id is not null or l.poliza_id is null) group by c.clave, c.nombre, c.naturaleza order by c.clave`, [periodo])).rows
      .map(r => ({ clave: r.clave, nombre: r.nombre, naturaleza: r.naturaleza, debe: Number(r.debe), haber: Number(r.haber), saldo: A.r2(r.naturaleza === 'deudora' ? Number(r.debe) - Number(r.haber) : Number(r.haber) - Number(r.debe)) }));
    res.json({ periodo, cuentas: rows, cuadra: A.r2(rows.reduce((s, r) => s + r.debe, 0)) === A.r2(rows.reduce((s, r) => s + r.haber, 0)) });
  });
  ruta('post', '/api/cartera/mc/contabilidad/periodos/:p/cerrar', ['contabilidad'], async (req, res) => {
    const periodo = req.params.p; if (!PER.test(periodo)) throw E(400, 'Periodo no válido.');
    const cfg = await CFG.cargar(db); let out;
    await db.tx(async t => {
      if (U.finDePeriodo(periodo) >= U.hoyMx()) throw E(409, 'El periodo aún no termina: se cierra cuando ya pasó su último día.');
      const g = (await t.query(`select estado from ${S}mc_periodos where periodo=$1`, [periodo])).rows[0]; if (g && g.estado === 'cerrado') throw E(409, 'Ese periodo ya está cerrado.');
      const todos = await periodosConActividad(t), antes = todos.filter(p => p < periodo);
      for (const p of antes) { const e = (await t.query(`select estado from ${S}mc_periodos where periodo=$1`, [p])).rows[0]; if (!e || e.estado !== 'cerrado') throw E(409, `Primero hay que cerrar ${p}: los periodos se cierran en orden.`); }
      const x = await CT.generar(t, periodo, cfg, await previoDe(t, periodo));
      for (const p of x.polizas) { const s = CT.sumaLineas(p.lineas); if (s.debe !== s.haber) throw E(500, `La póliza «${p.concepto}» no cuadra (${s.debe} contra ${s.haber}): no se cierra.`); }
      for (const p of x.polizas) {
        const pid = (await t.query(`insert into ${S}mc_polizas(periodo,fecha,tipo,concepto,origen,origen_id,creado_por) values($1,$2,$3,$4,$5,$6,$7) returning id`, [periodo, p.fecha, p.tipo, p.concepto, p.origen, p.origen_id, quien(req).usuario])).rows[0].id;
        for (const l of p.lineas) await t.query(`insert into ${S}mc_poliza_lineas(poliza_id,cuenta,debe,haber) values($1,$2,$3,$4)`, [pid, l.cuenta, l.debe, l.haber]);
      }
      await t.query(`insert into ${S}mc_periodos(periodo,estado,cerrado_por,cerrado_at,resumen) values($1,'cerrado',$2,now(),$3) on conflict (periodo) do update set estado='cerrado', cerrado_por=$2, cerrado_at=now(), resumen=$3`, [periodo, quien(req).usuario, JSON.stringify(x.resumen)]);
      await asiento(t, req, 'periodo_cerrar', 'contabilidad', periodo, `Cerró el periodo ${periodo}: ${x.polizas.length} póliza(s); cartera ${U.mxn(x.resumen.capital)}, vencida ${U.mxn(x.resumen.vencida_saldo)}, estimación ${U.mxn(x.resumen.estimacion)}`, x.resumen);
      out = { polizas: x.polizas.length, resumen: x.resumen };
    });
    res.json({ ok: true, ...out });
  });
  ruta('post', '/api/cartera/mc/contabilidad/periodos/:p/reabrir', ['administrar'], async (req, res) => {
    const periodo = req.params.p, com = txt((req.body || {}).comentario, 500); minCom(com, 20, 'Explica por qué se reabre el periodo');
    await db.tx(async t => {
      const g = (await t.query(`select estado from ${S}mc_periodos where periodo=$1`, [periodo])).rows[0]; if (!g || g.estado !== 'cerrado') throw E(409, 'Ese periodo no está cerrado.');
      if ((await t.query(`select 1 from ${S}mc_periodos where estado='cerrado' and periodo > $1`, [periodo])).rows.length) throw E(409, 'Solo se reabre el último periodo cerrado: hay periodos posteriores cerrados.');
      await t.query(`delete from ${S}mc_polizas where periodo=$1`, [periodo]);
      await t.query(`update ${S}mc_periodos set estado='abierto', reabierto_por=$2, reabierto_at=now() where periodo=$1`, [periodo, quien(req).usuario]);
      await asiento(t, req, 'periodo_reabrir', 'contabilidad', periodo, `Reabrió el periodo ${periodo}: ${com}`, { comentario: com });
    });
    res.json({ ok: true });
  });

  /* ============================ INGRESOS POR FACTURAR (corte semanal a contabilidad) ============================ */
  const ING_VER = ['contabilidad', 'reportes'], P_ING = x => ({ ...x, totales: typeof x.totales === 'string' ? JSON.parse(x.totales) : x.totales });
  const cargarCorteIng = async id => (await db.query(`select id, fecha_corte::text fecha_corte, hasta::text hasta, origen, estado, resumen, detalle, totales, generado_por, generado_at, enviado_por, enviado_at, enviado_a from ${S}mc_cortes_ingreso where id=$1`, [id])).rows[0] || null;
  ruta('get', '/api/cartera/mc/contabilidad/ingresos', ING_VER, async (req, res) => {
    const hoy = U.hoyMx(), pend = await IN.pendientes(db, hoy), cfg = await CFG.cargar(db), d = await IN.destinatarios(db);
    const cortes = (await db.query(`select id, fecha_corte::text fecha_corte, hasta::text hasta, origen, estado, totales, generado_por, generado_at, enviado_at, enviado_a, es_ejemplo from ${S}mc_cortes_ingreso order by id desc limit 30`)).rows.map(P_ING);
    res.json({ hoy, pendiente: { resumen: pend.resumen, totales: pend.totales }, cortes, tipos: IN.TIPOS,
      envio: { activo: cfg.contabilidad.envio_activo, dia_semana: cfg.contabilidad.dia_semana, destinatarios: d.to.length, total: d.total, correo: !!(correo && correo.activo()) }, puede: P_(req, 'contabilidad') });
  });
  ruta('post', '/api/cartera/mc/contabilidad/ingresos/cortes', ['contabilidad'], async (req, res) => {
    const b = req.body || {}, hoy = U.hoyMx(), hasta = b.hasta ? String(b.hasta).slice(0, 10) : hoy;
    if (!ISO.test(hasta) || hasta > hoy) throw E(400, 'Elige la fecha hasta la que entran los cobros (hoy o antes).');
    const id = await db.tx(async t => { const i = await IN.hacerCorte(t, { hasta, hoy, quien: quien(req).usuario, origen: 'MANUAL' }); if (i) { const c = P_ING((await t.query(`select totales from ${S}mc_cortes_ingreso where id=$1`, [i])).rows[0]); await asiento(t, req, 'ingresos_corte', 'contabilidad', `corte-${i}`, `Hizo el corte de ingresos por facturar #${i} (cobros hasta ${hasta}) por ${U.mxn(c.totales.total)}`, { corte: i, hasta, total: c.totales.total }); } return i; });
    if (!id) throw E(409, 'No hay cobros nuevos por cortar: todo lo cobrado hasta esa fecha ya entró a un corte.');
    let envio = null;
    if (b.enviar) { try { envio = await IN.enviarCorte(db, correo, id, quien(req).usuario); } catch (e) { envio = { error: 'envio_fallido', mensaje: 'No se pudo enviar el correo: ' + String(e.message).slice(0, 120) }; } }
    res.status(201).json({ ok: true, id, envio });
  });
  ruta('get', '/api/cartera/mc/contabilidad/ingresos/cortes/:id', ING_VER, async (req, res) => {
    const c = await cargarCorteIng(Number(req.params.id)); if (!c) throw E(404, 'No existe ese corte.');
    res.json({ ...P_ING(c), resumen: typeof c.resumen === 'string' ? JSON.parse(c.resumen) : c.resumen, detalle: typeof c.detalle === 'string' ? JSON.parse(c.detalle) : c.detalle });
  });
  ruta('get', '/api/cartera/mc/contabilidad/ingresos/cortes/:id/excel', ING_VER, async (req, res) => {
    const c = await cargarCorteIng(Number(req.params.id)); if (!c) throw E(404, 'No existe ese corte.');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="ingresos_por_facturar_${c.fecha_corte}_${c.id}.xlsx"`); res.send(X.buildXLSX(IN.hojasXlsx(c)));
  });
  ruta('post', '/api/cartera/mc/contabilidad/ingresos/cortes/:id/enviar', ['contabilidad'], async (req, res) => {
    let r; try { r = await IN.enviarCorte(db, correo, Number(req.params.id), quien(req).usuario); } catch (e) { throw E(502, 'No se pudo enviar el correo: ' + String(e.message).slice(0, 120)); }
    if (r.error) throw E(r.error === 'no_existe' ? 404 : 409, r.mensaje);
    res.json(r);
  });
  ruta('delete', '/api/cartera/mc/contabilidad/ingresos/cortes/:id', ['contabilidad'], async (req, res) => {
    const id = Number(req.params.id);
    await db.tx(async t => {
      const r = await IN.deshacerCorte(t, id); if (r.error === 'no_existe') throw E(404, 'No existe ese corte.'); if (r.error === 'enviado') throw E(409, 'Ese corte ya se envió a contabilidad: no se puede deshacer.');
      await asiento(t, req, 'ingresos_deshacer', 'contabilidad', `corte-${id}`, `Deshizo el corte de ingresos #${id}: sus cobros vuelven a quedar por cortar`, { corte: id });
    });
    res.json({ ok: true });
  });
  ruta('get', '/api/cartera/mc/contabilidad/ingresos/destinatarios', ['contabilidad'], async (req, res) => {
    res.json((await db.query(`select id, email_cifrado, nombre, tipo, activo from ${S}mc_destinatarios order by activo desc, id`)).rows.map(r => ({ id: r.id, email: K.descif(r.email_cifrado), nombre: r.nombre, tipo: r.tipo, activo: r.activo })));
  });
  ruta('post', '/api/cartera/mc/contabilidad/ingresos/destinatarios', ['contabilidad'], async (req, res) => {
    const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), tipo = ['to', 'cc', 'bcc'].includes(b.tipo) ? b.tipo : 'to';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw E(400, 'El correo no es válido.');
    await db.tx(async t => {
      await t.query(`insert into ${S}mc_destinatarios(email_hash,email_cifrado,nombre,tipo,activo,creado_por) values($1,$2,$3,$4,$5,$6) on conflict (email_hash) do update set nombre=$3, tipo=$4, activo=$5`, [CR.hmacEmail(email), CR.encrypt(email), txt(b.nombre, 120), tipo, b.activo !== false, quien(req).usuario]);
      await asiento(t, req, 'ingresos_destinatario', 'contabilidad', 'destinatarios', `Guardó el destinatario ${email} (${tipo}) del correo de ingresos por facturar`, { tipo, activo: b.activo !== false });
    });
    res.status(201).json({ ok: true });
  });
  ruta('delete', '/api/cartera/mc/contabilidad/ingresos/destinatarios/:id', ['contabilidad'], async (req, res) => {
    await db.tx(async t => { const r = await t.query(`delete from ${S}mc_destinatarios where id=$1 returning email_cifrado`, [Number(req.params.id)]); if (!r.rows.length) throw E(404, 'No existe ese destinatario.'); await asiento(t, req, 'ingresos_destinatario', 'contabilidad', 'destinatarios', `Quitó el destinatario ${K.descif(r.rows[0].email_cifrado)} del correo de ingresos por facturar`, {}); });
    res.json({ ok: true });
  });
  ruta('put', '/api/cartera/mc/contabilidad/ingresos/envio', ['contabilidad'], async (req, res) => {
    const v = CFG.validar({ contabilidad: req.body || {} }); if (!v.ok) throw E(400, v.error);
    await db.tx(async t => {
      const a = (await t.query(`select valor from ${S}mc_config where clave='general'`)).rows[0], base = a ? (typeof a.valor === 'string' ? JSON.parse(a.valor) : a.valor) : {};
      await t.query(`insert into ${S}mc_config(clave,valor,actualizado,actualizado_por) values('general',$1,now(),$2) on conflict (clave) do update set valor=$1, actualizado=now(), actualizado_por=$2`, [JSON.stringify(CFG.mezcla(base, v.cfg)), quien(req).usuario]);
      await asiento(t, req, 'ingresos_envio', 'contabilidad', 'envio', `Cambió el envío semanal de ingresos por facturar: ${v.cfg.contabilidad.envio_activo ? 'activo' : 'apagado'}, día ${v.cfg.contabilidad.dia_semana}`, v.cfg.contabilidad);
    });
    res.json({ ok: true });
  });

  /* ============================ REPORTES ============================ */
  const MOP = d => d <= 0 ? '01' : d < 30 ? '02' : d < 60 ? '03' : d < 90 ? '04' : d < 120 ? '05' : d < 150 ? '06' : '07';
  ruta('get', '/api/cartera/mc/reportes/cartera', ['reportes'], async (req, res) => {
    const cfg = await CFG.cargar(db), fecha = fechaQ(req.query), lista = await CA.cargar(db, fecha, { estados: ['vigente'] });
    const filas = lista.map(x => ({ id: x.credito.id, folio: x.credito.folio, nombre: x.solicitante.nombre, producto: x.producto, monto: x.credito.monto, saldo: x.st.saldoCapital, dias: x.st.diasAtraso, bucket: x.st.bucket, vencido: x.st.vencido.total, moratorios: A.r2(x.st.moratorios + x.st.ivaMoratorios), estimacion: A.estimacion(x.st.saldoCapital, x.st.diasAtraso, cfg.cartera.estimacion), proximo: x.st.proximo }));
    res.json({ fecha, resumen: CA.resumen(lista, cfg), filas });
  });
  ruta('get', '/api/cartera/mc/reportes/cartera.csv', ['reportes'], async (req, res) => {
    const cfg = await CFG.cargar(db), fecha = fechaQ(req.query), lista = await CA.cargar(db, fecha, { estados: ['vigente'] });
    enviarCsv(res, `cartera_${fecha}.csv`, [['Crédito', 'Acreditado', 'Producto', 'Monto original', 'Saldo de capital', 'Días de atraso', 'Tramo', 'Vencido', 'Moratorios con IVA', 'Estimación preventiva', 'Próximo pago', 'Monto próximo pago'],
      ...lista.map(x => [x.credito.folio, x.solicitante.nombre, x.producto, x.credito.monto, x.st.saldoCapital, x.st.diasAtraso, x.st.bucket, x.st.vencido.total, A.r2(x.st.moratorios + x.st.ivaMoratorios), A.estimacion(x.st.saldoCapital, x.st.diasAtraso, cfg.cartera.estimacion), x.st.proximo ? x.st.proximo.fecha : '', x.st.proximo ? x.st.proximo.monto : ''])]);
  });
  ruta('get', '/api/cartera/mc/reportes/buro.csv', ['reportes'], async (req, res) => {
    const fecha = fechaQ(req.query), lista = await CA.cargar(db, fecha, { estados: ['vigente', 'liquidado'] });
    const ult = new Map((await db.query(`select credito_id, max(fecha)::text f from ${S}mc_pagos where estado='registrado' group by credito_id`)).rows.map(r => [r.credito_id, r.f]));
    enviarCsv(res, `borrador_buro_${fecha}.csv`, [['BORRADOR: ajustar al layout de intercambio de la sociedad de información crediticia contratada (MOP aproximada)'],
      ['RFC', 'Nombre', 'Folio del crédito', 'Fecha de apertura', 'Monto original', 'Saldo actual', 'Saldo vencido', 'Pago periódico', 'Días de atraso', 'MOP (aproximada)', 'Fecha del último pago', 'Situación'],
      ...lista.map(x => [x.solicitante.rfc || '', x.solicitante.nombre, x.credito.folio, x.credito.fecha_desembolso, x.credito.monto, x.st.saldoCapital, x.st.vencido.total, x.st.proximo ? x.st.proximo.monto : 0, x.st.diasAtraso, x.st.liquidado ? '00' : MOP(x.st.diasAtraso), ult.get(x.credito.id) || '', x.st.liquidado ? 'Cerrada' : 'Abierta'])]);
  });
  ruta('get', '/api/cartera/mc/reportes/comisiones', ['reportes'], async (req, res) => {
    const desde = ISO.test(req.query.desde || '') ? req.query.desde : U.hoyMx().slice(0, 8) + '01', hasta = ISO.test(req.query.hasta || '') ? req.query.hasta : U.hoyMx();
    const des = (await db.query(`select d.fecha_real::text f, c.folio, d.monto, d.comision, c.comision_apertura from ${S}mc_desembolsos d join ${S}mc_creditos c on c.id=d.credito_id where d.estado='confirmado' and d.fecha_real between $1::date and $2::date order by d.fecha_real`, [desde, hasta])).rows
      .map(r => { const base = A.r2(Number(r.monto) * Number(r.comision_apertura)); return { fecha: r.f, folio: r.folio, concepto: 'Comisión por apertura', base, iva: A.r2(Number(r.comision) - base), total: Number(r.comision) }; });
    const lista = await CA.cargar(db, hasta, { estados: ['vigente', 'liquidado'] }), mor = [];
    for (const x of lista) for (const ap of x.st.aplicaciones.filter(a => a.fecha >= desde && a.fecha <= hasta && a.mor > 0)) mor.push({ fecha: ap.fecha, folio: x.credito.folio, concepto: 'Intereses moratorios cobrados', base: ap.mor, iva: A.r2(ap.mor * x.credito.iva_pct), total: A.r2(ap.mor * (1 + x.credito.iva_pct)) });
    const filas = [...des, ...mor].sort((a, b) => a.fecha < b.fecha ? -1 : 1), s = k => A.r2(filas.reduce((n, f) => n + f[k], 0));
    if (req.query.csv === '1') return enviarCsv(res, `comisiones_${desde}_${hasta}.csv`, [['Fecha', 'Crédito', 'Concepto', 'Base', 'IVA', 'Total'], ...filas.map(f => [f.fecha, f.folio, f.concepto, f.base, f.iva, f.total]), ['', '', 'TOTAL', s('base'), s('iva'), s('total')]]);
    res.json({ desde, hasta, filas, totales: { base: s('base'), iva: s('iva'), total: s('total') } });
  });

  /* ============================ UIF ============================ */
  ruta('get', '/api/cartera/mc/uif', ['uif', 'reportes'], async (req, res) => {
    const est = ['detectada', 'reportar', 'no_reportar', 'reportada'].includes(req.query.estado) ? req.query.estado : null, off = Math.max(0, Number(req.query.pag) || 0) * 25, a = est ? [est] : [];
    const w = est ? 'where u.estado=$1' : '', total = Number((await db.query(`select count(*)::int n from ${S}mc_uif u ${w}`, a)).rows[0].n);
    const filas = (await db.query(`select u.id, u.tipo, u.regla, u.fecha::text fecha, u.monto, u.descripcion, u.estado, u.dictamen, u.dictaminado_por, u.dictaminado_at, u.reportado_at, u.folio_acuse, u.es_ejemplo, c.folio from ${S}mc_uif u left join ${S}mc_creditos c on c.id=u.credito_id ${w} order by (u.estado='detectada') desc, u.fecha desc, u.id desc limit 25 offset ${off}`, a)).rows.map(r => ({ ...r, monto: K.num(r.monto) }));
    const resumen = (await db.query(`select estado, count(*)::int n from ${S}mc_uif group by estado`)).rows;
    res.json({ total, pag: Math.floor(off / 25), por_pag: 25, filas, resumen, puede_dictaminar: P_(req, 'uif') });
  });
  ruta('post', '/api/cartera/mc/uif/:id/dictamen', ['uif'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, estado = b.estado, com = txt(b.dictamen, 800);
    if (!['reportar', 'no_reportar'].includes(estado)) throw E(400, 'El dictamen es «reportar» o «no reportar».'); minCom(com, 20, 'Fundamenta el dictamen');
    await db.tx(async t => {
      const u = (await t.query(`select * from ${S}mc_uif where id=$1`, [id])).rows[0]; if (!u) throw E(404, 'No existe esa operación.'); if (u.estado !== 'detectada') throw E(409, 'Esa operación ya tiene dictamen.');
      await t.query(`update ${S}mc_uif set estado=$2, dictamen=$3, dictaminado_por=$4, dictaminado_at=now() where id=$1`, [id, estado, com, quien(req).usuario]);
      await asiento(t, req, 'uif_dictamen', 'uif', id, `Dictaminó la operación ${u.tipo} (${u.regla}): ${estado === 'reportar' ? 'SE REPORTA' : 'no se reporta'} — ${com}`, { estado, regla: u.regla });
    });
    res.json({ ok: true });
  });
  ruta('post', '/api/cartera/mc/uif/:id/reportada', ['uif'], async (req, res) => {
    const id = Number(req.params.id), folio = txt((req.body || {}).folio_acuse, 80); if (!folio) throw E(400, 'Captura el folio del acuse de la autoridad.');
    await db.tx(async t => {
      const r = await t.query(`update ${S}mc_uif set estado='reportada', reportado_at=now(), folio_acuse=$2 where id=$1 and estado='reportar' returning regla`, [id, folio]); if (!r.rows.length) throw E(409, 'Solo se marca como reportada una operación dictaminada para reportar.');
      await asiento(t, req, 'uif_reportada', 'uif', id, `Marcó como reportada la operación (${r.rows[0].regla}) con acuse ${folio}`, { folio });
    });
    res.json({ ok: true });
  });
  ruta('get', '/api/cartera/mc/uif.csv', ['uif'], async (req, res) => {
    const rows = (await db.query(`select u.id, u.tipo, u.regla, u.fecha::text fecha, u.monto, u.descripcion, u.estado, u.dictamen, u.folio_acuse, c.folio from ${S}mc_uif u left join ${S}mc_creditos c on c.id=u.credito_id order by u.fecha, u.id`)).rows;
    enviarCsv(res, `uif_${U.hoyMx()}.csv`, [['Id', 'Tipo', 'Regla', 'Fecha', 'Crédito', 'Monto', 'Descripción', 'Estado', 'Dictamen', 'Folio de acuse'], ...rows.map(r => [r.id, r.tipo, r.regla, r.fecha, r.folio || '', r.monto == null ? '' : Number(r.monto), r.descripcion, r.estado, r.dictamen || '', r.folio_acuse || ''])]);
  });
  ruta('post', '/api/cartera/mc/uif/detectar', ['uif'], async (req, res) => {
    const cfg = await CFG.cargar(db); let n = 0;
    await db.tx(async t => {
      const antes = Number((await t.query(`select count(*)::int n from ${S}mc_uif`)).rows[0].n);
      const pagos = (await t.query(`select p.id, p.fecha::text fecha, p.monto, p.medio, p.credito_id from ${S}mc_pagos p where p.estado='registrado' order by p.fecha, p.id`)).rows;
      const cs = new Map((await CA.cargar(t, U.hoyMx(), { estados: ['vigente', 'liquidado'] })).map(x => [x.credito.id, x]));
      for (const p of pagos) { const x = cs.get(p.credito_id); if (x) await UIF.detectarPago(t, { credito: x.credito, pago: { id: p.id, fecha: p.fecha, monto: Number(p.monto), medio: p.medio }, cfg, liquidado: x.st.liquidado && p.fecha === x.st.aplicaciones.slice(-1)[0].fecha }); }
      n = Number((await t.query(`select count(*)::int n from ${S}mc_uif`)).rows[0].n) - antes;
      await asiento(t, req, 'uif_detectar', 'uif', 'barrido', `Revisó ${pagos.length} pago(s) buscando operaciones relevantes e inusuales: ${n} nueva(s)`, { pagos: pagos.length, nuevas: n });
    });
    res.json({ ok: true, nuevas: n });
  });

  /* ============================ PANEL DE CARTERA ============================ */
  ruta('get', '/api/cartera/mc/panel-cartera', ['ver_todas'], async (req, res) => {
    const cfg = await CFG.cargar(db), lista = await CA.cargar(db, U.hoyMx(), { estados: ['vigente'] });
    const c = async (sql) => Number((await db.query(sql)).rows[0].n);
    const pendientes = { formalizar: await c(`select count(*)::int n from ${S}mc_creditos where estado='formalizacion'`), por_desembolsar: await c(`select count(*)::int n from ${S}mc_creditos where estado='desembolso'`),
      desembolso_autorizar: await c(`select count(*)::int n from ${S}mc_desembolsos where estado='solicitado'`), desembolso_enviar: await c(`select count(*)::int n from ${S}mc_desembolsos where estado in ('autorizado','enviado')`),
      conciliar: await c(`select count(*)::int n from ${S}mc_movimientos_banco where estado='pendiente'`), pagos_sin_conciliar: await c(`select count(*)::int n from ${S}mc_pagos where estado='registrado' and mov_id is null and medio in ('spei','deposito')`),
      uif: await c(`select count(*)::int n from ${S}mc_uif where estado in ('detectada','reportar')`), autorizadas_sin_credito: await c(`select count(*)::int n from ${S}mc_solicitudes s where estado='autorizada' and not exists (select 1 from ${S}mc_creditos c where c.solicitud_id=s.id)`) };
    const prox = lista.filter(x => x.st.proximo && x.st.proximo.fecha <= A.iso(A.parse(U.hoyMx()) + 7 * 864e5)).length;
    res.json({ resumen: CA.resumen(lista, cfg), pendientes, vencen_7_dias: prox, hoy: U.hoyMx() });
  });
}

module.exports = { montar };
