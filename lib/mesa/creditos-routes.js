/* lib/mesa/creditos-routes.js — Mesa de control · del crédito autorizado al crédito cobrado: formalización (contrato y firmas), desembolso con doble control,
   cartera (pagos, moratorios, atraso), cobranza y conciliación bancaria. API bajo /api/cartera/mc/*. Los saldos nunca se guardan: se recalculan desde la
   tabla congelada al desembolsar y los pagos registrados (lib/mesa/amortiza.js). */
'use strict';
const A = require('./amortiza.js');
const U = require('./util.js');
const D = require('./contrato.js');
const K = require('./core.js');
const CFG = require('./config.js');
const RL = require('./roles.js');
const CA = require('./cartera.js');
const CR = require('../crypto.js');
const X = require('../excel.js');
const UIF = require('./uif.js');

const S = K.S;
const MEDIOS = ['spei', 'deposito', 'efectivo', 'tercero', 'otro'];
const CALIDADES = ['acreditado', 'representante_legal', 'aval', 'obligado_solidario', 'la_sofom'];
const HEAD_LAYOUT = ['Concepto', 'Cuenta clabe del beneficiario', 'Código del banco del beneficiario', 'Nombre del beneficiario', 'RFC o CURP del beneficiario', 'Cantidad', 'Referencia numérica', 'Fecha de pago (Opcional, solo para transacciones futuras) Formato YYYY-mm-dd HH:mm'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* Disponible de una línea de fondeo: línea − lo colocado (saldo de capital si es revolvente; lo desembolsado si no) − desembolsos en trámite. */
async function fondeoDisponible(q, fondeoId) {
  const f = (await q.query(`select * from ${S}mc_fondeos where id=$1`, [fondeoId])).rows[0]; if (!f) return null;
  const hoy = U.hoyMx();
  const lista = (await CA.cargar(q, hoy, { estados: ['vigente'] })).filter(x => x.credito.fondeo_id === fondeoId);
  let usado = f.revolvente ? lista.reduce((s, x) => s + x.st.saldoCapital, 0) : Number((await q.query(`select coalesce(sum(monto),0) m from ${S}mc_creditos where fondeo_id=$1 and estado in ('vigente','liquidado')`, [fondeoId])).rows[0].m);
  const tramite = Number((await q.query(`select coalesce(sum(d.monto),0) m from ${S}mc_desembolsos d join ${S}mc_creditos c on c.id=d.credito_id where c.fondeo_id=$1 and d.estado in ('solicitado','autorizado','enviado')`, [fondeoId])).rows[0].m);
  const linea = Number(f.monto_linea);
  return { fondeo: f, linea, usado: A.r2(usado), tramite: A.r2(tramite), disponible: A.r2(linea - usado - tramite) };
}

function montar(app, H) {
  const { db, ruta, E, quien, rolDe, asiento, upl, txt, numOpt, adminsActivos } = H;
  const P_ = (req, p) => RL.puede(rolDe(req), p);
  const sinPermiso = (req, p, msg) => { if (!P_(req, p)) throw E(403, msg || 'Tu rol no tiene permiso para esta acción.'); };
  const periodoCerrado = async (q, fecha) => { const r = (await q.query(`select estado from ${S}mc_periodos where periodo=$1`, [U.periodoDe(fecha)])).rows[0]; return !!(r && r.estado === 'cerrado'); };
  const noCerrado = async (q, fecha, que) => { if (await periodoCerrado(q, fecha)) throw E(409, `El periodo contable ${U.periodoDe(fecha)} está cerrado: ${que || 'no se puede registrar nada con fecha en ese periodo'}. Pide al contador que lo reabra.`); };
  const cambiarEstadoCredito = (t, id, estado, extra) => {
    const sets = ['estado=$2', 'estado_desde=now()', 'version=version+1', 'actualizado_at=now()'], args = [id, estado];
    for (const [k, v] of Object.entries(extra || {})) { args.push(v); sets.push(`${k}=$${args.length}`); }
    return t.query(`update ${S}mc_creditos set ${sets.join(', ')} where id=$1`, args);
  };
  const minCom = (com, n, que) => { if (!com || com.length < n) throw E(400, `${que} (mínimo ${n} caracteres).`); };
  /* Segregación: si la misma persona ya participó en el paso anterior, solo el único administrador activo puede seguir, con comentario ≥ 20. */
  const conflicto = async (req, t, mismo, com, que) => {
    if (!mismo) return false;
    if (!(rolDe(req) === 'admin' && (await adminsActivos(t)) <= 1)) throw E(403, `${que} Debe hacerlo otra persona.`);
    minCom(com, 20, 'Eres el único administrador y ya participaste en el paso anterior: justifica'); return true;
  };

  /* ---------- carga de un crédito completo ---------- */
  async function cargarCredito(q, id, fecha) {
    const r = (await q.query(`select c.*, c.fecha_desembolso::text fd, c.fecha_contrato::text fc from ${S}mc_creditos c where id=$1`, [id])).rows[0];
    if (!r) throw E(404, 'No existe ese crédito.');
    const c = CA.mapCredito({ ...r, fecha_desembolso: r.fd, fecha_contrato: r.fc });
    const clabe = K.descif(r.clabe_cifrada); delete c.clabe_cifrada; c.tiene_clabe = !!clabe; c.clabe_mascara = clabe ? '•'.repeat(14) + clabe.slice(-4) : null;
    const solicitante = K.mapSolicitante((await q.query(`select * from ${S}mc_solicitantes where id=$1`, [c.solicitante_id])).rows[0]);
    const producto = K.mapProducto((await q.query(`select * from ${S}mc_productos where id=$1`, [c.producto_id])).rows[0]);
    const sol = (await q.query(`select id, folio, ejecutivo, ejecutivo_nombre from ${S}mc_solicitudes where id=$1`, [c.solicitud_id])).rows[0];
    const guardada = (await q.query(`select num, fecha::text fecha, capital, interes, iva, total, saldo from ${S}mc_amortizacion where credito_id=$1 order by num`, [id])).rows.map(x => ({ num: x.num, fecha: x.fecha, capital: Number(x.capital), interes: Number(x.interes), iva: Number(x.iva), total: Number(x.total), saldo: Number(x.saldo) }));
    const pagos = (await q.query(`select id, fecha::text fecha, monto, medio, referencia, estado, mov_id, comentario, registrado_por, registrado_at, cancelado_por, cancelado_at, motivo_cancelacion from ${S}mc_pagos where credito_id=$1 order by fecha desc, id desc`, [id])).rows.map(p => ({ ...p, monto: Number(p.monto) }));
    const firmas = (await q.query(`select id, firmante, calidad, metodo, fecha::text fecha, doc_hash, archivo_nombre, (archivo_cifrado is not null) tiene_archivo, registrado_por, registrado_at from ${S}mc_firmas where credito_id=$1 order by id`, [id])).rows;
    const desembolsos = (await q.query(`select id, monto, comision, neto, estado, fecha_prevista::text fecha_prevista, solicitado_por, solicitado_at, autorizado_por, autorizado_at, autoaprobado, enviado_por, enviado_at, referencia, confirmado_por, confirmado_at, fecha_real::text fecha_real, comentario from ${S}mc_desembolsos where credito_id=$1 order by id desc`, [id])).rows.map(d => ({ ...d, monto: Number(d.monto), comision: Number(d.comision), neto: Number(d.neto) }));
    const gestiones = (await q.query(`select id, fecha::text fecha, tipo, resultado, comentario, promesa_fecha::text promesa_fecha, promesa_monto, proxima::text proxima, usuario, creado_at from ${S}mc_gestiones where credito_id=$1 order by fecha desc, id desc limit 100`, [id])).rows.map(g => ({ ...g, promesa_monto: K.num(g.promesa_monto) }));
    const hoy = fecha || U.hoyMx();
    const vigente = ['vigente', 'liquidado'].includes(c.estado);
    const filas = vigente ? guardada : A.tabla({ monto: c.monto, tasaAnual: c.tasa_anual, plazoMeses: c.plazo_meses, periodicidad: c.periodicidad, fechaDesembolso: c.fecha_desembolso || hoy, ivaPct: c.iva_pct });
    const st = vigente ? A.estado({ filas, tasaMor: c.tasa_moratoria, ivaPct: c.iva_pct, fechaDesembolso: c.fecha_desembolso }, pagos.filter(p => p.estado === 'registrado'), hoy) : null;
    return { c, clabe, solicitante, producto, sol, filas, pagos, firmas, desembolsos, gestiones, st, hoy };
  }
  const contratoDe = (cc, cfg) => D.contrato({ credito: { ...cc.c, fecha_contrato: cc.c.fecha_contrato }, solicitante: cc.solicitante, producto: cc.producto, filas: cc.filas, sofom: cfg.sofom });
  const catDe = (c, filas, fecha) => A.cat(c.monto, A.r2(c.monto * c.comision_apertura), filas, fecha);

  /* ---------- formalización ---------- */
  ruta('post', '/api/cartera/mc/solicitudes/:id/credito', ['formalizar'], async (req, res) => {
    const id = Number(req.params.id), cfg = await CFG.cargar(db), y = quien(req); let out;
    await db.tx(async t => {
      const s = (await t.query(`select * from ${S}mc_solicitudes where id=$1`, [id])).rows[0]; if (!s) throw E(404, 'No existe esa solicitud.');
      if (s.estado !== 'autorizada') throw E(409, 'Solo se formaliza una solicitud autorizada.');
      if (s.vigencia_hasta && String(s.vigencia_hasta instanceof Date ? s.vigencia_hasta.toISOString() : s.vigencia_hasta).slice(0, 10) < U.hoyMx()) throw E(409, 'La autorización venció: hay que volver a autorizarla.');
      if ((await t.query(`select 1 from ${S}mc_creditos where solicitud_id=$1`, [id])).rows.length) throw E(409, 'Esa solicitud ya tiene crédito.');
      const p = K.mapProducto((await t.query(`select * from ${S}mc_productos where id=$1`, [s.producto_id])).rows[0]);
      const monto = Number(s.monto_autorizado), plazo = s.plazo_autorizado, tasa = Number(s.tasa_autorizada), hoy = U.hoyMx(), iva = cfg.cartera.iva;
      const filas = A.tabla({ monto, tasaAnual: tasa, plazoMeses: plazo, periodicidad: s.periodicidad, fechaDesembolso: hoy, ivaPct: iva });
      const cat = A.cat(monto, A.r2(monto * p.comision_apertura), filas, hoy);
      const n = Number((await t.query(`select nextval('${S}mc_credito_seq') n`)).rows[0].n), folio = `CR-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`;
      const cid = (await t.query(`insert into ${S}mc_creditos(folio,solicitud_id,solicitante_id,producto_id,monto,plazo_meses,periodicidad,tasa_anual,tasa_moratoria,comision_apertura,iva_pct,cat,fecha_desembolso,creado_por,es_ejemplo)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`, [folio, id, s.solicitante_id, s.producto_id, monto, plazo, s.periodicidad, tasa, p.tasa_moratoria, p.comision_apertura, iva, cat, hoy, y.usuario, !!s.es_ejemplo])).rows[0].id;
      await asiento(t, req, 'credito_alta', 'credito', cid, `Abrió el crédito ${folio} desde ${s.folio} por ${monto} a ${plazo} meses (CAT ${cat == null ? '—' : (cat * 100).toFixed(1) + '%'})`, { solicitud: s.folio, monto, plazo, tasa, cat });
      await asiento(t, req, 'credito_alta', 'solicitud', id, `La solicitud ${s.folio} pasó a formalización como ${folio}`, { credito: folio });
      out = { id: cid, folio };
    });
    res.status(201).json({ ok: true, ...out });
  });

  ruta('get', '/api/cartera/mc/catalogo/bancos', null, async (req, res) => {
    let b = []; try { b = (await db.query('select nombre, codigo_spei from bancos where codigo_spei is not null order by nombre')).rows; } catch (_e) { b = []; }
    const fondeos = (await db.query(`select id, nombre, tipo from ${S}mc_fondeos where estado='vigente' order by nombre`)).rows;
    res.json({ bancos: b, fondeos });
  });

  /* ---------- listado y detalle ---------- */
  ruta('get', '/api/cartera/mc/creditos', ['ver_todas'], async (req, res) => {
    const q = req.query, a = [], w = [], hoy = U.hoyMx();
    if (q.estado) { a.push(String(q.estado)); w.push(`c.estado=$${a.length}`); }
    if (q.q) { a.push('%' + String(q.q).toLowerCase() + '%'); w.push(`(lower(c.folio) like $${a.length} or lower(s.nombre) like $${a.length})`); }
    const rows = (await db.query(`select c.id, c.folio, c.estado, c.estado_desde, c.monto, c.fecha_desembolso::text fd, c.es_ejemplo, s.nombre, p.nombre producto from ${S}mc_creditos c join ${S}mc_solicitantes s on s.id=c.solicitante_id join ${S}mc_productos p on p.id=c.producto_id ${w.length ? 'where ' + w.join(' and ') : ''} order by c.id desc`, a)).rows;
    const calc = new Map((await CA.cargar(db, hoy, { estados: ['vigente'], ids: rows.filter(r => r.estado === 'vigente').map(r => r.id) })).map(x => [x.credito.id, x.st]));
    let filas = rows.map(r => { const st = calc.get(r.id); return { id: r.id, folio: r.folio, estado: r.estado, nombre: r.nombre, producto: r.producto, monto: Number(r.monto), es_ejemplo: r.es_ejemplo, desembolso: r.fd, saldo: st ? st.saldoCapital : null, dias: st ? st.diasAtraso : null, bucket: st ? st.bucket : null, vencido: st ? st.vencido.total : null, proximo: st ? st.proximo : null }; });
    if (q.bucket) filas = filas.filter(f => f.bucket === q.bucket);
    const total = filas.length, off = Math.max(0, Number(q.pag) || 0) * 10;
    res.json({ total, pag: Math.floor(off / 10), por_pag: 10, filas: filas.slice(off, off + 10) });
  });

  ruta('get', '/api/cartera/mc/creditos/:id', ['ver_todas'], async (req, res) => {
    const cfg = await CFG.cargar(db), cc = await cargarCredito(db, Number(req.params.id), ISO.test(req.query.fecha || '') ? req.query.fecha : null);
    const pr = (await db.query(`select * from ${S}mc_creditos where id=$1`, [cc.c.id])).rows[0];
    const hash = U.sha256(contratoDe(cc, cfg)), firmasVigentes = cc.firmas.filter(f => f.doc_hash === hash);
    const tieneAcred = firmasVigentes.some(f => ['acreditado', 'representante_legal'].includes(f.calidad)), tieneSofom = firmasVigentes.some(f => f.calidad === 'la_sofom');
    const desAbierto = cc.desembolsos.find(d => ['solicitado', 'autorizado', 'enviado'].includes(d.estado));
    const hist = await db.query(`select ts, usuario, rol, accion, resumen from ${S}mc_bitacora where entidad='credito' and entidad_id=$1 order by id desc limit 200`, [String(cc.c.id)]);
    const fond = cc.c.fondeo_id ? await fondeoDisponible(db, cc.c.fondeo_id) : null;
    res.json({
      credito: { ...cc.c, version: pr.version }, solicitante: cc.solicitante, producto: cc.producto, solicitud: cc.sol, filas: cc.filas, st: cc.st, pagos: cc.pagos, firmas: cc.firmas, gestiones: cc.gestiones, desembolsos: cc.desembolsos, fecha: cc.hoy,
      contrato: { hash, firmas_vigentes: firmasVigentes.length, firmado_acreditado: tieneAcred, firmado_sofom: tieneSofom, listo: tieneAcred && tieneSofom }, fondeo: fond ? { nombre: fond.fondeo.nombre, disponible: fond.disponible, linea: fond.linea } : null,
      acciones: {
        editar: P_(req, 'formalizar') && ['formalizacion', 'desembolso'].includes(cc.c.estado) && !(desAbierto && ['enviado'].includes(desAbierto.estado)),
        firmar: P_(req, 'formalizar') && cc.c.estado === 'formalizacion', formalizar: P_(req, 'formalizar') && cc.c.estado === 'formalizacion',
        cancelar: P_(req, 'formalizar') && ['formalizacion', 'desembolso'].includes(cc.c.estado) && !desAbierto,
        solicitar_desembolso: P_(req, 'desembolso_solicitar') && cc.c.estado === 'desembolso' && !desAbierto, desembolso: desAbierto || null,
        pagar: P_(req, 'cobrar') && cc.c.estado === 'vigente', gestionar: P_(req, 'cobrar') && cc.c.estado === 'vigente', cancelar_pago: P_(req, 'administrar'),
      },
      linea: hist.rows,
    });
  });

  ruta('put', '/api/cartera/mc/creditos/:id', ['formalizar', 'desembolso_solicitar'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}; const cfg = await CFG.cargar(db);
    await db.tx(async t => {
      const cc = await cargarCredito(t, id);
      if (!['formalizacion', 'desembolso'].includes(cc.c.estado)) throw E(409, 'Este crédito ya no admite cambios.');
      if (Number(b._v) !== (await t.query(`select version from ${S}mc_creditos where id=$1`, [id])).rows[0].version) throw E(409, 'Alguien más cambió este crédito. Recárgalo.', { codigo: 'version' });
      if (cc.desembolsos.some(d => d.estado === 'enviado')) throw E(409, 'El desembolso ya se envió al banco: no se puede cambiar el crédito.');
      const sets = [], args = [id]; const add = (col, v) => { args.push(v); sets.push(`${col}=$${args.length}`); };
      if (b.fecha_desembolso !== undefined) { const f = String(b.fecha_desembolso || '').slice(0, 10); if (!ISO.test(f)) throw E(400, 'La fecha de desembolso no es válida.'); if (f < U.hoyMx()) throw E(400, 'La fecha de desembolso no puede ser anterior a hoy.'); add('fecha_desembolso', f); }
      if (b.clabe !== undefined && String(b.clabe).trim() !== '') { const cl = String(b.clabe).replace(/\s+/g, ''); if (!U.clabeValida(cl)) throw E(400, 'La CLABE no es válida (18 dígitos con dígito verificador correcto).'); add('clabe_cifrada', K.cif(cl)); }
      if (b.beneficiario !== undefined) add('beneficiario', txt(b.beneficiario, 200));
      if (b.banco_codigo !== undefined) add('banco_codigo', txt(b.banco_codigo, 10));
      if (b.banco_nombre !== undefined) add('banco_nombre', txt(b.banco_nombre, 120));
      if (b.fondeo_id !== undefined) { const fid = b.fondeo_id ? Number(b.fondeo_id) : null; if (fid && !(await t.query(`select 1 from ${S}mc_fondeos where id=$1 and estado='vigente'`, [fid])).rows.length) throw E(400, 'Esa línea de fondeo no existe o ya no está vigente.'); add('fondeo_id', fid); }
      if (!sets.length) throw E(400, 'No hay nada que cambiar.');
      await t.query(`update ${S}mc_creditos set ${sets.join(', ')}, version=version+1, actualizado_at=now() where id=$1`, args);
      const nuevo = await cargarCredito(t, id); const cat = catDe(nuevo.c, nuevo.filas, nuevo.c.fecha_desembolso || U.hoyMx());
      await t.query(`update ${S}mc_creditos set cat=$2 where id=$1`, [id, cat]);
      await asiento(t, req, 'credito_editar', 'credito', id, `Editó el crédito ${cc.c.folio}: ${Object.keys(b).filter(k => !k.startsWith('_') && k !== 'clabe').join(', ')}${b.clabe ? ', cuenta CLABE' : ''}`, { campos: Object.keys(b).filter(k => k !== 'clabe' && !k.startsWith('_')), clabe_cambiada: !!b.clabe });
    });
    void cfg; res.json({ ok: true });
  });

  ruta('get', '/api/cartera/mc/creditos/:id/contrato', ['ver_todas'], async (req, res) => {
    const cfg = await CFG.cargar(db), cc = await cargarCredito(db, Number(req.params.id)); const html = contratoDe(cc, cfg);
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="contrato_${cc.c.folio}.html"`); res.send(html);
  });
  ruta('get', '/api/cartera/mc/creditos/:id/estado-cuenta', ['ver_todas'], async (req, res) => {
    const cc = await cargarCredito(db, Number(req.params.id), ISO.test(req.query.fecha || '') ? req.query.fecha : null);
    if (!cc.st) throw E(409, 'El crédito aún no se desembolsa: no tiene estado de cuenta.');
    const html = D.estadoCuenta({ credito: cc.c, solicitante: cc.solicitante, estado: cc.st, pagos: cc.pagos.filter(p => p.estado === 'registrado'), fecha: cc.hoy });
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="estado_cuenta_${cc.c.folio}.html"`); res.send(html);
  });

  ruta('post', '/api/cartera/mc/creditos/:id/firmas', ['formalizar'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, cfg = await CFG.cargar(db);
    const firmante = txt(b.firmante, 200), calidad = String(b.calidad || ''), metodo = String(b.metodo || ''), fecha = String(b.fecha || U.hoyMx()).slice(0, 10);
    if (!firmante) throw E(400, 'Escribe el nombre de quien firma.'); if (!CALIDADES.includes(calidad)) throw E(400, 'Elige la calidad con la que firma.');
    if (!['autografa', 'electronica'].includes(metodo)) throw E(400, 'Indica si la firma es autógrafa o electrónica.'); if (!ISO.test(fecha) || fecha > U.hoyMx()) throw E(400, 'La fecha de firma no es válida.');
    if (metodo === 'autografa' && calidad !== 'la_sofom' && !req.file) throw E(400, 'Sube el contrato firmado (escaneo) como evidencia de la firma autógrafa.');
    if (req.file && !['application/pdf', 'image/jpeg', 'image/png'].includes(req.file.mimetype)) throw E(400, 'Solo se aceptan PDF, JPG o PNG.');
    await db.tx(async t => {
      const cc = await cargarCredito(t, id); if (cc.c.estado !== 'formalizacion') throw E(409, 'Las firmas se registran mientras el crédito está en formalización.');
      if (!cc.c.tiene_clabe) throw E(409, 'Antes de firmar captura la cuenta de depósito del crédito: el contrato la incluye.');
      const hash = U.sha256(contratoDe(cc, cfg));
      await t.query(`insert into ${S}mc_firmas(credito_id,firmante,calidad,metodo,fecha,doc_hash,archivo_nombre,archivo_cifrado,registrado_por) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, firmante, calidad, metodo, fecha, hash, req.file ? String(req.file.originalname || 'contrato').slice(0, 200) : null, req.file ? K.cifArchivo(req.file.buffer) : null, quien(req).usuario]);
      await asiento(t, req, 'credito_firma', 'credito', id, `Registró la firma de ${firmante} (${calidad.replace(/_/g, ' ')}, ${metodo}) en el contrato de ${cc.c.folio}`, { calidad, metodo, doc_hash: hash.slice(0, 16), evidencia: !!req.file });
    });
    res.status(201).json({ ok: true });
  }, upl('archivo'));

  ruta('post', '/api/cartera/mc/creditos/:id/accion', ['formalizar'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, accion = String(b.accion || ''), com = txt(b.comentario, 1000), cfg = await CFG.cargar(db);
    if (!['formalizar', 'cancelar'].includes(accion)) throw E(400, 'Acción desconocida.');
    await db.tx(async t => {
      const cc = await cargarCredito(t, id), ver = (await t.query(`select version from ${S}mc_creditos where id=$1`, [id])).rows[0].version;
      if (Number(b._v) !== ver) throw E(409, 'Alguien más cambió este crédito. Recárgalo.', { codigo: 'version' });
      if (accion === 'cancelar') {
        if (!['formalizacion', 'desembolso'].includes(cc.c.estado)) throw E(409, 'Solo se cancela un crédito antes del desembolso.');
        if (cc.desembolsos.some(d => ['solicitado', 'autorizado', 'enviado'].includes(d.estado))) throw E(409, 'Cancela primero el desembolso en trámite.');
        minCom(com, 10, 'Escribe el motivo de la cancelación');
        await cambiarEstadoCredito(t, id, 'cancelado', { comentario_cierre: com });
        await asiento(t, req, 'credito_cancelar', 'credito', id, `Canceló el crédito ${cc.c.folio}: ${com}`, {});
      } else {
        if (cc.c.estado !== 'formalizacion') throw E(409, 'Este crédito ya se formalizó.');
        if (!cc.c.tiene_clabe || !cc.c.beneficiario) throw E(409, 'Captura el beneficiario y la CLABE de depósito antes de formalizar.');
        const hash = U.sha256(contratoDe(cc, cfg)), vig = cc.firmas.filter(f => f.doc_hash === hash);
        if (!vig.some(f => ['acreditado', 'representante_legal'].includes(f.calidad))) throw E(409, 'Falta la firma del acreditado (o de su representante legal) sobre la versión actual del contrato. Si cambiaste condiciones después de firmar, hay que firmar de nuevo.');
        if (!vig.some(f => f.calidad === 'la_sofom')) throw E(409, 'Falta la firma de la SOFOM sobre la versión actual del contrato.');
        await cambiarEstadoCredito(t, id, 'desembolso', { fecha_contrato: U.hoyMx() });
        await asiento(t, req, 'credito_formalizar', 'credito', id, `Formalizó el crédito ${cc.c.folio}: contrato firmado por ${vig.map(f => f.firmante).join(', ')}`, { firmas: vig.length, doc_hash: hash.slice(0, 16) });
      }
    });
    res.json({ ok: true });
  });

  /* ---------- desembolso ---------- */
  ruta('post', '/api/cartera/mc/creditos/:id/desembolsos', ['desembolso_solicitar'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}; let out;
    await db.tx(async t => {
      const cc = await cargarCredito(t, id);
      if (cc.c.estado !== 'desembolso') throw E(409, 'El crédito debe estar formalizado y sin desembolsar.');
      if (cc.desembolsos.some(d => ['solicitado', 'autorizado', 'enviado'].includes(d.estado))) throw E(409, 'Ya hay un desembolso en trámite.');
      if (!cc.c.tiene_clabe || !cc.c.beneficiario || !cc.c.banco_codigo) throw E(409, 'Faltan beneficiario, CLABE o código de banco de la cuenta de depósito.');
      const prevista = String(b.fecha_prevista || cc.c.fecha_desembolso || U.hoyMx()).slice(0, 10); if (!ISO.test(prevista) || prevista < U.hoyMx()) throw E(400, 'La fecha prevista no es válida.');
      await noCerrado(t, prevista, 'el desembolso caería en un periodo cerrado');
      if (cc.c.fondeo_id) { const f = await fondeoDisponible(t, cc.c.fondeo_id); if (f.disponible < cc.c.monto) throw E(409, `La línea de fondeo «${f.fondeo.nombre}» solo tiene ${U.mxn(f.disponible)} disponibles.`); }
      const comision = A.r2(cc.c.monto * cc.c.comision_apertura * (1 + cc.c.iva_pct)), neto = A.r2(cc.c.monto - comision);
      const did = (await t.query(`insert into ${S}mc_desembolsos(credito_id,monto,comision,neto,fecha_prevista,solicitado_por) values($1,$2,$3,$4,$5,$6) returning id`, [id, cc.c.monto, comision, neto, prevista, quien(req).usuario])).rows[0].id;
      await asiento(t, req, 'desembolso_solicitar', 'credito', id, `Solicitó el desembolso de ${cc.c.folio} por ${U.mxn(cc.c.monto)} (neto ${U.mxn(neto)}) para el ${prevista}`, { desembolso: did, monto: cc.c.monto, neto });
      out = { id: did, neto };
    });
    res.status(201).json({ ok: true, ...out });
  });

  ruta('post', '/api/cartera/mc/desembolsos/:id/accion', null, async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, accion = String(b.accion || ''), com = txt(b.comentario, 500), y = quien(req), cfg = await CFG.cargar(db);
    if (!['autorizar', 'enviar', 'confirmar', 'cancelar'].includes(accion)) throw E(400, 'Acción desconocida.');
    await db.tx(async t => {
      const d = (await t.query(`select * from ${S}mc_desembolsos where id=$1`, [id])).rows[0]; if (!d) throw E(404, 'No existe ese desembolso.');
      const cc = await cargarCredito(t, d.credito_id), id_c = cc.c.id;
      if (accion === 'autorizar') {
        sinPermiso(req, 'desembolso_autorizar'); if (d.estado !== 'solicitado') throw E(409, 'Ese desembolso ya no está por autorizar.');
        const auto = await conflicto(req, t, d.solicitado_por === y.usuario, com, 'Quien solicitó el desembolso no puede autorizarlo.');
        await t.query(`update ${S}mc_desembolsos set estado='autorizado', autorizado_por=$2, autorizado_at=now(), autoaprobado=$3, comentario=coalesce($4,comentario) where id=$1`, [id, y.usuario, auto, com]);
        await asiento(t, req, 'desembolso_autorizar', 'credito', id_c, `Autorizó el desembolso de ${cc.c.folio} por ${U.mxn(d.monto)}${auto ? ' (AUTOAPROBADO)' : ''}`, { desembolso: id, auto });
      } else if (accion === 'enviar') {
        sinPermiso(req, 'desembolso_solicitar'); if (d.estado !== 'autorizado') throw E(409, 'Solo se envía un desembolso autorizado.');
        await t.query(`update ${S}mc_desembolsos set estado='enviado', enviado_por=$2, enviado_at=now() where id=$1`, [id, y.usuario]);
        await asiento(t, req, 'desembolso_enviar', 'credito', id_c, `Marcó como enviado al banco el desembolso de ${cc.c.folio} por ${U.mxn(d.neto)}`, { desembolso: id });
      } else if (accion === 'confirmar') {
        sinPermiso(req, 'desembolso_solicitar'); if (d.estado !== 'enviado') throw E(409, 'Solo se confirma un desembolso ya enviado al banco.');
        const ref = txt(b.referencia, 60); if (!ref) throw E(400, 'Captura la clave de rastreo o referencia del SPEI.');
        const fecha = String(b.fecha_real || U.hoyMx()).slice(0, 10); if (!ISO.test(fecha) || fecha > U.hoyMx()) throw E(400, 'La fecha del desembolso no es válida.');
        await noCerrado(t, fecha, 'el desembolso caería en un periodo cerrado');
        const auto = await conflicto(req, t, d.autorizado_por === y.usuario, com, 'Quien autorizó el desembolso no puede confirmarlo.');
        const filas = A.tabla({ monto: cc.c.monto, tasaAnual: cc.c.tasa_anual, plazoMeses: cc.c.plazo_meses, periodicidad: cc.c.periodicidad, fechaDesembolso: fecha, ivaPct: cc.c.iva_pct });
        for (const f of filas) await t.query(`insert into ${S}mc_amortizacion(credito_id,num,fecha,capital,interes,iva,total,saldo) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (credito_id,num) do update set fecha=$3,capital=$4,interes=$5,iva=$6,total=$7,saldo=$8`, [id_c, f.num, f.fecha, f.capital, f.interes, f.iva, f.total, f.saldo]);
        const cat = A.cat(cc.c.monto, A.r2(cc.c.monto * cc.c.comision_apertura), filas, fecha);
        await t.query(`update ${S}mc_desembolsos set estado='confirmado', confirmado_por=$2, confirmado_at=now(), referencia=$3, fecha_real=$4, comentario=coalesce($5,comentario) where id=$1`, [id, y.usuario, ref, fecha, com]);
        await cambiarEstadoCredito(t, id_c, 'vigente', { fecha_desembolso: fecha, cat });
        await asiento(t, req, 'desembolso_confirmar', 'credito', id_c, `Confirmó el desembolso de ${cc.c.folio} (ref. ${ref}) el ${fecha}: crédito vigente con ${filas.length} pagos${auto ? ' (AUTOAPROBADO)' : ''}`, { desembolso: id, referencia: ref, fecha, pagos: filas.length, auto });
      } else {
        if (!(P_(req, 'desembolso_solicitar') || P_(req, 'desembolso_autorizar'))) throw E(403, 'Tu rol no puede cancelar desembolsos.');
        if (!['solicitado', 'autorizado', 'enviado'].includes(d.estado)) throw E(409, 'Ese desembolso ya no se puede cancelar.');
        minCom(com, 10, 'Escribe el motivo de la cancelación');
        await t.query(`update ${S}mc_desembolsos set estado='cancelado', comentario=$2 where id=$1`, [id, com]);
        await asiento(t, req, 'desembolso_cancelar', 'credito', id_c, `Canceló el desembolso de ${cc.c.folio}: ${com}`, { desembolso: id, estaba: d.estado });
      }
    });
    void cfg; res.json({ ok: true });
  });

  ruta('get', '/api/cartera/mc/desembolsos/:id/layout.xlsx', ['desembolso_solicitar', 'desembolso_autorizar'], async (req, res) => {
    const d = (await db.query(`select * from ${S}mc_desembolsos where id=$1`, [Number(req.params.id)])).rows[0]; if (!d) throw E(404, 'No existe ese desembolso.');
    if (!['autorizado', 'enviado'].includes(d.estado)) throw E(409, 'El layout se genera cuando el desembolso está autorizado.');
    const r = (await db.query(`select c.folio, c.beneficiario, c.clabe_cifrada, c.banco_codigo, s.rfc_cifrado from ${S}mc_creditos c join ${S}mc_solicitantes s on s.id=c.solicitante_id where c.id=$1`, [d.credito_id])).rows[0];
    const clabe = K.descif(r.clabe_cifrada); if (!clabe || !U.clabeValida(clabe) || !r.banco_codigo) throw E(409, 'Falta una CLABE válida o el código de banco.');
    const p = U.hoyMx().split('-'), ref = Number('1' + p[2] + p[1] + p[0].slice(2));
    const buf = X.buildXLSX([{ name: 'DESEMBOLSO', aoa: [HEAD_LAYOUT, [`DESEMBOLSO ${r.folio}`, clabe, Number(r.banco_codigo) || r.banco_codigo, r.beneficiario, K.descif(r.rfc_cifrado) || '', Number(d.neto), ref, '']], cols: [{ wch: 26 }, { wch: 24 }, { wch: 20 }, { wch: 32 }, { wch: 22 }, { wch: 16 }, { wch: 20 }, { wch: 40 }] }]);
    await db.tx(async t => asiento(t, req, 'desembolso_layout', 'credito', d.credito_id, `Descargó el layout SPEI del desembolso de ${r.folio} por ${U.mxn(d.neto)}`, { desembolso: d.id }));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="layout_desembolso_${r.folio}.xlsx"`); res.send(buf);
  });

  /* ---------- pagos ---------- */
  async function registrarPago(t, req, cc, b, movId) {
    const y = quien(req), cfg = await CFG.cargar(t);
    if (cc.c.estado !== 'vigente') throw E(409, 'Solo se registran pagos a un crédito vigente.');
    const monto = numOpt(b.monto, 'El monto', 0.01, 1e10), fecha = String(b.fecha || U.hoyMx()).slice(0, 10), medio = String(b.medio || 'spei'), ref = txt(b.referencia, 80);
    if (!monto) throw E(400, 'Captura el monto del pago.'); if (!ISO.test(fecha) || fecha > U.hoyMx()) throw E(400, 'La fecha del pago no es válida (no puede ser futura).');
    if (fecha < cc.c.fecha_desembolso) throw E(400, 'El pago no puede ser anterior al desembolso.'); if (!MEDIOS.includes(medio)) throw E(400, 'Medio de pago no válido.');
    if (medio !== 'efectivo' && !ref) throw E(400, 'Captura la referencia o clave de rastreo (obligatoria salvo efectivo).');
    await noCerrado(t, fecha, 'el pago tiene fecha de un periodo cerrado');
    let pid; try { pid = (await t.query(`insert into ${S}mc_pagos(credito_id,fecha,monto,medio,referencia,mov_id,comentario,registrado_por) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [cc.c.id, fecha, monto, medio, ref, movId || null, txt(b.comentario, 300), y.usuario])).rows[0].id; }
    catch (e) { if (e.code === '23505' || /uq_mc_pagos_ref|duplicate key/i.test(e.message)) throw E(409, 'Ya existe un pago con esa referencia: no se registra dos veces.'); throw e; }
    const pagos = [...cc.pagos.filter(p => p.estado === 'registrado'), { id: pid, fecha, monto }];
    const st = A.estado({ filas: cc.filas, tasaMor: cc.c.tasa_moratoria, ivaPct: cc.c.iva_pct, fechaDesembolso: cc.c.fecha_desembolso }, pagos, U.hoyMx()), ap = st.aplicaciones.find(x => x.id === pid);
    if (st.liquidado) await cambiarEstadoCredito(t, cc.c.id, 'liquidado');
    await asiento(t, req, 'pago_registrar', 'credito', cc.c.id, `Registró un pago de ${U.mxn(monto)} (${medio}${ref ? ', ref. ' + ref : ''}) a ${cc.c.folio}: moratorios ${U.mxn(ap.mor)}, interés ${U.mxn(ap.interes)}, IVA ${U.mxn(ap.iva)}, capital ${U.mxn(ap.capital)}${ap.exceso ? ', saldo a favor ' + U.mxn(ap.exceso) : ''}${st.liquidado ? ' · CRÉDITO LIQUIDADO' : ''}`, { pago: pid, monto, medio, aplicacion: ap });
    await UIF.detectarPago(t, { credito: cc.c, pago: { id: pid, fecha, monto, medio }, cfg, liquidado: st.liquidado });
    return { id: pid, aplicacion: ap, liquidado: st.liquidado };
  }
  ruta('post', '/api/cartera/mc/creditos/:id/pagos', ['cobrar'], async (req, res) => {
    let out; await db.tx(async t => { const cc = await cargarCredito(t, Number(req.params.id)); out = await registrarPago(t, req, cc, req.body || {}, null); });
    res.status(201).json({ ok: true, ...out });
  });
  ruta('post', '/api/cartera/mc/pagos/:id/cancelar', ['administrar'], async (req, res) => {
    const id = Number(req.params.id), com = txt((req.body || {}).comentario, 500); minCom(com, 15, 'Explica por qué se cancela el pago');
    await db.tx(async t => {
      const p = (await t.query(`select *, fecha::text f from ${S}mc_pagos where id=$1`, [id])).rows[0]; if (!p) throw E(404, 'No existe ese pago.'); if (p.estado === 'cancelado') throw E(409, 'Ese pago ya está cancelado.');
      await noCerrado(t, p.f, 'no se cancela un pago de un periodo cerrado');
      await t.query(`update ${S}mc_pagos set estado='cancelado', cancelado_por=$2, cancelado_at=now(), motivo_cancelacion=$3 where id=$1`, [id, quien(req).usuario, com]);
      if (p.mov_id) await t.query(`update ${S}mc_movimientos_banco set estado='pendiente', pago_id=null where id=$1`, [p.mov_id]);
      // Si ese pago ya salió en un corte de ingresos por facturar, queda un ajuste negativo que entra al siguiente corte (nota de crédito).
      for (const it of (await t.query(`select i.id, i.tipo, i.base, i.iva, i.corte_id from ${S}mc_corte_items i where i.origen='pago' and i.origen_id=$1 and i.corte_id is not null`, [id])).rows)
        await t.query(`insert into ${S}mc_corte_items(corte_id,origen,origen_id,tipo,credito_id,fecha,base,iva,nota) values(null,'ajuste_pago',$1,'ajuste',$2,$3,$4,$5,$6) on conflict do nothing`, [it.id, p.credito_id, U.hoyMx(), -Number(it.base), -Number(it.iva), `Cancelación del pago ${id}: ${it.tipo} del corte #${it.corte_id}`]);
      const c = (await t.query(`select folio, estado from ${S}mc_creditos where id=$1`, [p.credito_id])).rows[0];
      if (c.estado === 'liquidado') await cambiarEstadoCredito(t, p.credito_id, 'vigente');
      await asiento(t, req, 'pago_cancelar', 'credito', p.credito_id, `Canceló el pago de ${U.mxn(p.monto)} (ref. ${p.referencia || '—'}) de ${c.folio}: ${com}`, { pago: id, monto: Number(p.monto) });
    });
    res.json({ ok: true });
  });

  /* ---------- cobranza ---------- */
  ruta('get', '/api/cartera/mc/cobranza', ['ver_todas'], async (req, res) => {
    const cfg = await CFG.cargar(db), hoy = U.hoyMx(), lista = await CA.cargar(db, hoy, { estados: ['vigente'] });
    const ids = lista.map(x => x.credito.id);
    const gest = ids.length ? (await db.query(`select id, credito_id, fecha::text fecha, tipo, resultado, comentario, promesa_fecha::text pf, promesa_monto pm, proxima::text proxima, usuario from ${S}mc_gestiones where credito_id = any($1::int[]) order by fecha desc, id desc`, [ids])).rows : [];
    const pagos = ids.length ? (await db.query(`select credito_id, fecha::text fecha, monto from ${S}mc_pagos where estado='registrado' and credito_id = any($1::int[])`, [ids])).rows : [];
    const q = req.query, filas = lista.filter(x => x.st.diasAtraso > 0 || (q.todos === '1')).map(x => {
      const g = gest.filter(z => z.credito_id === x.credito.id), ult = g[0] || null;
      const prom = g.find(z => z.pf);
      let promesa = null;
      if (prom) { const pagado = pagos.filter(p => p.credito_id === x.credito.id && p.fecha >= prom.fecha && p.fecha <= prom.pf).reduce((s, p) => s + Number(p.monto), 0); promesa = { fecha: prom.pf, monto: K.num(prom.pm), estado: pagado >= (K.num(prom.pm) || 0) * 0.99 ? 'cumplida' : prom.pf < hoy ? 'incumplida' : 'pendiente' }; }
      return { id: x.credito.id, folio: x.credito.folio, nombre: x.solicitante.nombre, dias: x.st.diasAtraso, bucket: x.st.bucket, cuotas: x.st.cuotasVencidas, vencido: x.st.vencido.total, saldo: x.st.saldoCapital, proximo: x.st.proximo,
        ultima: ult ? { fecha: ult.fecha, tipo: ult.tipo, resultado: ult.resultado, usuario: ult.usuario } : null, proxima: ult && ult.proxima || null, promesa };
    }).sort((a, b) => b.dias - a.dias);
    const buckets = A.BUCKETS.map(b => ({ bucket: b, n: filas.filter(f => f.bucket === b).length, vencido: A.r2(filas.filter(f => f.bucket === b).reduce((s, f) => s + f.vencido, 0)) }));
    res.json({ filas: q.bucket ? filas.filter(f => f.bucket === q.bucket) : filas, buckets, resumen: CA.resumen(lista, cfg), hoy });
  });
  ruta('post', '/api/cartera/mc/creditos/:id/gestiones', ['cobrar'], async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, tipo = String(b.tipo || '');
    if (!['llamada', 'visita', 'mensaje', 'correo', 'promesa', 'otro'].includes(tipo)) throw E(400, 'Elige el tipo de gestión.');
    const com = txt(b.comentario, 600); if (!com || com.length < 5) throw E(400, 'Escribe qué pasó en la gestión.');
    const fecha = String(b.fecha || U.hoyMx()).slice(0, 10), pf = b.promesa_fecha ? String(b.promesa_fecha).slice(0, 10) : null, pm = b.promesa_monto === '' || b.promesa_monto == null ? null : Number(b.promesa_monto), prox = b.proxima ? String(b.proxima).slice(0, 10) : null;
    if (!ISO.test(fecha) || fecha > U.hoyMx()) throw E(400, 'La fecha de la gestión no es válida.'); if (pf && (!ISO.test(pf) || pf < fecha)) throw E(400, 'La fecha de la promesa no es válida.');
    if ((pf && !(pm > 0)) || (!pf && pm)) throw E(400, 'Una promesa de pago lleva fecha y monto.'); if (prox && !ISO.test(prox)) throw E(400, 'La próxima gestión no es una fecha válida.');
    await db.tx(async t => {
      const c = (await t.query(`select folio, estado from ${S}mc_creditos where id=$1`, [id])).rows[0]; if (!c || c.estado !== 'vigente') throw E(409, 'Solo se gestiona un crédito vigente.');
      await t.query(`insert into ${S}mc_gestiones(credito_id,fecha,tipo,resultado,comentario,promesa_fecha,promesa_monto,proxima,usuario) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, fecha, tipo, txt(b.resultado, 80), com, pf, pm, prox, quien(req).usuario]);
      await asiento(t, req, 'gestion', 'credito', id, `Gestión de cobranza (${tipo}) en ${c.folio}: ${com}${pf ? ` · promesa de ${U.mxn(pm)} para el ${pf}` : ''}`, { tipo, promesa: pf ? { fecha: pf, monto: pm } : null });
    });
    res.status(201).json({ ok: true });
  });

  /* ---------- conciliación bancaria ---------- */
  ruta('post', '/api/cartera/mc/conciliacion/importar', ['conciliar'], async (req, res) => {
    if (!req.file) throw E(400, 'Sube el estado de cuenta del banco (.xlsx o .csv) con fecha, descripción, referencia y monto.');
    const XLSX = require('xlsx'); let aoa;
    try { const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true, raw: true }); aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }); } catch (_e) { throw E(400, 'No se pudo leer el archivo.'); }
    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
    const hi = aoa.findIndex(r => (r || []).some(c => norm(c) === 'fecha') && (r || []).some(c => ['monto', 'abono', 'importe'].includes(norm(c)))); if (hi < 0) throw E(400, 'No encontré las columnas «fecha» y «monto» (o «abono»).');
    const cab = aoa[hi].map(norm), col = (...n) => cab.findIndex(c => n.includes(c));
    const iF = col('fecha'), iD = col('descripcion', 'concepto', 'detalle'), iR = col('referencia', 'clave de rastreo', 'rastreo'), iM = col('monto', 'abono', 'importe');
    const fechaDe = v => { if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10); const s = String(v || '').trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
    const num = v => { const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
    const lote = 'L' + Date.now(), nuevos = [], omit = []; let cargos = 0;
    aoa.slice(hi + 1).forEach((r, i) => { const f = fechaDe(r[iF]), m = num(r[iM]); if (!f || m == null) { if ((r || []).some(c => String(c).trim())) omit.push(hi + i + 2); return; } if (m <= 0) { cargos++; return; } nuevos.push({ f, d: txt(r[iD], 300), r: txt(r[iR], 80), m: A.r2(m) }); });
    if (!nuevos.length) throw E(400, 'El archivo no trae abonos con fecha y monto válidos.', { omitidas: omit.slice(0, 20) });
    let out;
    await db.tx(async t => {
      let ins = 0, dup = 0, conc = 0;
      for (const n of nuevos) {
        if ((await t.query(`select 1 from ${S}mc_movimientos_banco where fecha=$1 and monto=$2 and coalesce(referencia,'')=coalesce($3,'') and estado<>'ignorado'`, [n.f, n.m, n.r])).rows.length) { dup++; continue; }
        const mid = (await t.query(`insert into ${S}mc_movimientos_banco(lote,fecha,descripcion,referencia,monto,importado_por) values($1,$2,$3,$4,$5,$6) returning id`, [lote, n.f, n.d, n.r, n.m, quien(req).usuario])).rows[0].id; ins++;
        const p = n.r ? (await t.query(`select id from ${S}mc_pagos where estado='registrado' and mov_id is null and lower(referencia)=lower($1) and monto=$2 limit 1`, [n.r, n.m])).rows[0] : null;
        if (p) { await t.query(`update ${S}mc_pagos set mov_id=$2 where id=$1`, [p.id, mid]); await t.query(`update ${S}mc_movimientos_banco set estado='conciliado', pago_id=$2, resuelto_por=$3, resuelto_at=now(), nota='Conciliado automáticamente por referencia y monto' where id=$1`, [mid, p.id, quien(req).usuario]); conc++; }
      }
      await asiento(t, req, 'conciliacion_importar', 'conciliacion', lote, `Importó el estado de cuenta ${req.file.originalname}: ${ins} abono(s) nuevos, ${conc} conciliado(s) automáticamente, ${dup} repetido(s), ${cargos} cargo(s) omitido(s)`, { lote, ins, conc, dup, cargos, omitidas: omit.length });
      out = { lote, importados: ins, conciliados: conc, repetidos: dup, cargos_omitidos: cargos, filas_omitidas: omit.length };
    });
    res.json({ ok: true, ...out });
  }, upl('archivo'));

  ruta('get', '/api/cartera/mc/conciliacion', ['conciliar', 'cobrar', 'contabilidad'], async (req, res) => {
    const off = Math.max(0, Number(req.query.pag) || 0) * 25, est = ['pendiente', 'conciliado', 'ignorado'].includes(req.query.estado) ? req.query.estado : 'pendiente';
    const total = Number((await db.query(`select count(*)::int n from ${S}mc_movimientos_banco where estado=$1`, [est])).rows[0].n);
    const creditos = (await db.query(`select id, folio from ${S}mc_creditos where estado='vigente'`)).rows;
    const filas = (await db.query(`select id, fecha::text fecha, descripcion, referencia, monto, estado, pago_id, nota from ${S}mc_movimientos_banco where estado=$1 order by fecha desc, id desc limit 25 offset ${off}`, [est])).rows.map(m => {
      const hit = creditos.find(c => new RegExp(c.folio.replace(/[-]/g, '[-\\s]?'), 'i').test(`${m.referencia || ''} ${m.descripcion || ''}`));
      return { ...m, monto: Number(m.monto), sugerido: hit ? { id: hit.id, folio: hit.folio } : null };
    });
    const resumen = (await db.query(`select estado, count(*)::int n, coalesce(sum(monto),0) m from ${S}mc_movimientos_banco group by estado`)).rows.map(r => ({ estado: r.estado, n: r.n, monto: Number(r.m) }));
    const sinConc = (await db.query(`select p.id, p.fecha::text fecha, p.monto, p.medio, p.referencia, c.folio from ${S}mc_pagos p join ${S}mc_creditos c on c.id=p.credito_id where p.estado='registrado' and p.mov_id is null and p.medio in ('spei','deposito') order by p.fecha desc limit 50`)).rows.map(p => ({ ...p, monto: Number(p.monto) }));
    res.json({ total, pag: Math.floor(off / 25), por_pag: 25, filas, resumen, pagos_sin_conciliar: sinConc });
  });
  ruta('post', '/api/cartera/mc/conciliacion/:id/pago', ['conciliar'], async (req, res) => {
    const mid = Number(req.params.id), cid = Number((req.body || {}).credito_id); let out;
    await db.tx(async t => {
      const m = (await t.query(`select *, fecha::text f from ${S}mc_movimientos_banco where id=$1`, [mid])).rows[0]; if (!m) throw E(404, 'No existe ese movimiento.'); if (m.estado !== 'pendiente') throw E(409, 'Ese movimiento ya se resolvió.');
      const cc = await cargarCredito(t, cid);
      out = await registrarPago(t, req, cc, { fecha: m.f, monto: Number(m.monto), medio: 'spei', referencia: m.referencia || `MOV-${mid}`, comentario: 'Registrado desde la conciliación bancaria' }, mid);
      await t.query(`update ${S}mc_movimientos_banco set estado='conciliado', pago_id=$2, resuelto_por=$3, resuelto_at=now() where id=$1`, [mid, out.id, quien(req).usuario]);
    });
    res.json({ ok: true, ...out });
  });
  ruta('post', '/api/cartera/mc/conciliacion/:id/ignorar', ['conciliar'], async (req, res) => {
    const mid = Number(req.params.id), nota = txt((req.body || {}).nota, 300); minCom(nota, 10, 'Explica por qué se ignora el movimiento');
    await db.tx(async t => {
      const r = await t.query(`update ${S}mc_movimientos_banco set estado='ignorado', nota=$2, resuelto_por=$3, resuelto_at=now() where id=$1 and estado='pendiente' returning monto, referencia`, [mid, nota, quien(req).usuario]);
      if (!r.rows.length) throw E(409, 'Ese movimiento ya se resolvió o no existe.');
      await asiento(t, req, 'conciliacion_ignorar', 'conciliacion', mid, `Ignoró el movimiento bancario de ${U.mxn(r.rows[0].monto)} (${r.rows[0].referencia || 'sin referencia'}): ${nota}`, { movimiento: mid });
    });
    res.json({ ok: true });
  });
}

module.exports = { montar, fondeoDisponible };
