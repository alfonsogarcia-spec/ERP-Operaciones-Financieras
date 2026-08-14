/* ============================================================================
   lib/disputas-routes.js — Endpoints REST del módulo Disputas (Sprint 1).

   Se monta desde server.js con:
     require('./lib/disputas-routes.js')(app, { auth, requiereRol, bit, db, C, D });

   Reusa la infraestructura del sistema existente: auth por JWT/Google,
   requiereRol para RBAC, bit() para bitácora con hash-chain, C para cifrado.

   Rutas base: /api/disputa/*
   Roles: reusa 'operador' y 'admin' (según decisión).
     - Lectura: admin | operador | tesoreria | bancos | consulta
     - Escritura: admin | operador
   ========================================================================= */
'use strict';

// Helper: quita undefined / null string vacío para hacer patches limpios.
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

module.exports = function mountDisputasRoutes(app, deps) {
  const { auth, requiereRol, bit, db, C, D, upload, sesEnabled, sendSES, armarNotifDisputaHTML, path, fs } = deps;

  /* ==========================================================================
     PROVIDERS
     ========================================================================= */
  app.get('/api/disputa/providers', auth, async (_req, res) => {
    const rows = (await db.query('select id, nombre, tipo, conector, config, activo, ultima_sync, creado_at from disputa.providers order by nombre')).rows;
    res.json(rows);
  });
  app.post('/api/disputa/providers', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'nombre_requerido' });
    const tipo = ['ACQUIRER', 'PROCESSOR', 'GATEWAY', 'MANUAL'].includes(b.tipo) ? b.tipo : 'MANUAL';
    const conector = String(b.conector || 'manual');
    const config = b.config || {};
    const webhookHash = b.webhook_token ? C.hmac(String(b.webhook_token)) : null;
    if (b.id) {
      await db.query('update disputa.providers set nombre=$1, tipo=$2, conector=$3, config=$4, webhook_token_hash=coalesce($5,webhook_token_hash), activo=$6, actualizado_at=now() where id=$7',
        [nombre, tipo, conector, JSON.stringify(config), webhookHash, b.activo !== false, b.id]);
      await bit(req, 'disputa_provider_editar', `id=${b.id} nombre=${nombre}`, { resource_type: 'disputa_provider', resource_id: b.id });
      return res.json({ ok: true, id: b.id });
    }
    const r = await db.query('insert into disputa.providers(nombre, tipo, conector, config, webhook_token_hash, activo) values($1,$2,$3,$4,$5,$6) returning id',
      [nombre, tipo, conector, JSON.stringify(config), webhookHash, b.activo !== false]);
    await bit(req, 'disputa_provider_alta', `nombre=${nombre} tipo=${tipo}`, { resource_type: 'disputa_provider', resource_id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id });
  });

  /* ==========================================================================
     REASON CODES
     ========================================================================= */
  app.get('/api/disputa/reason-codes', auth, async (_req, res) => {
    const rows = (await db.query('select id, brand, codigo, descripcion, card_presence, plazo_comercio_dias, plazo_representacion_dias, representable, activo from disputa.reason_codes where activo=true order by brand, codigo')).rows;
    res.json(rows);
  });
  app.post('/api/disputa/reason-codes', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const b = req.body || {};
    const brand = String(b.brand || '').toUpperCase();
    const codigo = String(b.codigo || '').trim();
    if (!brand || !codigo) return res.status(400).json({ error: 'brand_y_codigo_requeridos' });
    if (b.id) {
      await db.query('update disputa.reason_codes set brand=$1, codigo=$2, descripcion=$3, card_presence=$4, plazo_comercio_dias=$5, plazo_representacion_dias=$6, representable=$7, activo=$8, actualizado_at=now() where id=$9',
        [brand, codigo, b.descripcion || '', b.card_presence || 'CARD_NOT_PRESENT', Number(b.plazo_comercio_dias) || 10, Number(b.plazo_representacion_dias) || 30, b.representable !== false, b.activo !== false, b.id]);
      await bit(req, 'disputa_rc_editar', `${brand} ${codigo}`, { resource_type: 'disputa_rc', resource_id: b.id });
      return res.json({ ok: true, id: b.id });
    }
    const r = await db.query('insert into disputa.reason_codes(brand, codigo, descripcion, card_presence, plazo_comercio_dias, plazo_representacion_dias, representable) values($1,$2,$3,$4,$5,$6,$7) on conflict(brand, codigo) do update set descripcion=excluded.descripcion, card_presence=excluded.card_presence, plazo_comercio_dias=excluded.plazo_comercio_dias, plazo_representacion_dias=excluded.plazo_representacion_dias, representable=excluded.representable, actualizado_at=now() returning id',
      [brand, codigo, b.descripcion || '', b.card_presence || 'CARD_NOT_PRESENT', Number(b.plazo_comercio_dias) || 10, Number(b.plazo_representacion_dias) || 30, b.representable !== false]);
    await bit(req, 'disputa_rc_alta', `${brand} ${codigo}`, { resource_type: 'disputa_rc', resource_id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id });
  });

  /* ==========================================================================
     CLIENT GROUPS + MERCHANTS + CONTACTS
     ========================================================================= */
  app.get('/api/disputa/client-groups', auth, async (_req, res) => {
    const rows = (await db.query('select id, nombre, descripcion, activo from disputa.client_groups where activo=true order by nombre')).rows;
    res.json(rows);
  });
  app.post('/api/disputa/client-groups', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'nombre_requerido' });
    if (b.id) {
      await db.query('update disputa.client_groups set nombre=$1, descripcion=$2, activo=$3, actualizado_at=now() where id=$4',
        [nombre, b.descripcion || '', b.activo !== false, b.id]);
      return res.json({ ok: true, id: b.id });
    }
    const r = await db.query('insert into disputa.client_groups(nombre, descripcion) values($1,$2) returning id', [nombre, b.descripcion || '']);
    await bit(req, 'disputa_group_alta', `grupo=${nombre}`, { resource_type: 'disputa_group', resource_id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id });
  });

  app.get('/api/disputa/merchants', auth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const groupId = req.query.group_id ? parseInt(req.query.group_id, 10) : null;
    const conds = [], vals = [];
    if (q) { vals.push('%' + q + '%'); conds.push(`(m.nombre ilike $${vals.length} or m.afiliacion ilike $${vals.length})`); }
    if (groupId) { vals.push(groupId); conds.push(`m.client_group_id = $${vals.length}`); }
    const where = conds.length ? ' where ' + conds.join(' and ') : '';
    const rows = (await db.query(`select m.*, cg.nombre as client_group_nombre, (select count(*)::int from disputa.contacts c where c.merchant_id=m.id and c.activo=true) as contactos_activos from disputa.merchants m left join disputa.client_groups cg on m.client_group_id=cg.id ${where} order by m.nombre nulls last limit 500`, vals)).rows;
    const out = rows.map(m => ({
      id: m.id,
      nombre: C.decryptString(m.nombre_cifrado) || m.nombre,
      afiliacion: m.afiliacion,
      external_id: m.external_id,
      provider_id: m.provider_id,
      client_group_id: m.client_group_id,
      client_group_nombre: m.client_group_nombre,
      contactos_activos: m.contactos_activos,
      activo: m.activo,
    }));
    res.json(out);
  });
  app.post('/api/disputa/merchants', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    const afil = String(b.afiliacion || '').replace(/\D/g, '');
    if (!nombre) return res.status(400).json({ error: 'nombre_requerido' });
    const vals = [nombre, C.encrypt(nombre), C.hmac(nombre.toLowerCase()), afil || null, afil ? C.hmac(afil) : null, b.external_id || null, b.provider_id || null, b.client_group_id || null, b.activo !== false];
    if (b.id) {
      await db.query('update disputa.merchants set nombre=$1, nombre_cifrado=$2, nombre_hash=$3, afiliacion=$4, afiliacion_hash=$5, external_id=$6, provider_id=$7, client_group_id=$8, activo=$9, actualizado_at=now() where id=$10', [...vals, b.id]);
      await bit(req, 'disputa_merchant_editar', `id=${b.id}`, { resource_type: 'disputa_merchant', resource_id: b.id });
      return res.json({ ok: true, id: b.id });
    }
    const r = await db.query('insert into disputa.merchants(nombre, nombre_cifrado, nombre_hash, afiliacion, afiliacion_hash, external_id, provider_id, client_group_id, activo) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', vals);
    await bit(req, 'disputa_merchant_alta', `nombre=${nombre} afil=${afil}`, { resource_type: 'disputa_merchant', resource_id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id });
  });

  app.get('/api/disputa/merchants/:id/contacts', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const rows = (await db.query('select * from disputa.contacts where merchant_id=$1 and activo=true order by es_principal desc, id', [id])).rows;
    res.json(rows.map(c => ({
      id: c.id, merchant_id: c.merchant_id, client_group_id: c.client_group_id,
      nombre: C.decryptString(c.nombre_cifrado) || c.nombre,
      email: C.decryptString(c.email_cifrado) || c.email,
      rol: c.rol, es_principal: c.es_principal, activo: c.activo,
    })));
  });
  app.post('/api/disputa/merchants/:id/contacts', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const merchantId = parseInt(req.params.id, 10);
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const nombre = String(b.nombre || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'email_invalido' });
    const vals = [merchantId, nombre, C.encrypt(nombre), b.rol || null, email, C.encrypt(email), C.hmacEmail(email), b.telefono ? C.encrypt(b.telefono) : null, b.es_principal === true];
    const r = await db.query('insert into disputa.contacts(merchant_id, nombre, nombre_cifrado, rol, email, email_cifrado, email_hash, telefono_cifrado, es_principal) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', vals);
    await bit(req, 'disputa_contact_alta', `merchant=${merchantId} email=${email}`, { resource_type: 'disputa_contact', resource_id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id });
  });
  app.delete('/api/disputa/contacts/:id', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await db.query('update disputa.contacts set activo=false, actualizado_at=now() where id=$1', [id]);
    await bit(req, 'disputa_contact_baja', '', { resource_type: 'disputa_contact', resource_id: id });
    res.json({ ok: true });
  });

  /* ==========================================================================
     CHARGEBACKS  — entidad central. CRUD + transición de estado + resumen.
     ========================================================================= */
  app.get('/api/disputa/chargebacks', auth, async (req, res) => {
    const f = req.query || {};
    const conds = [], vals = [];
    if (f.estado) { vals.push(String(f.estado)); conds.push(`status=$${vals.length}`); }
    if (f.ciclo) { vals.push(String(f.ciclo)); conds.push(`cycle=$${vals.length}`); }
    if (f.brand) { vals.push(String(f.brand).toUpperCase()); conds.push(`brand=$${vals.length}`); }
    if (f.merchant_id) { vals.push(parseInt(f.merchant_id, 10)); conds.push(`merchant_id=$${vals.length}`); }
    if (f.desde && /^\d{4}-\d{2}-\d{2}$/.test(f.desde)) { vals.push(f.desde); conds.push(`fecha_evento >= $${vals.length}`); }
    if (f.hasta && /^\d{4}-\d{2}-\d{2}$/.test(f.hasta)) { vals.push(f.hasta); conds.push(`fecha_evento <= $${vals.length}`); }
    if (f.solo_vencidos === 'true') conds.push(`fecha_limite_comercio < current_date and status in ('NEW','NOTIFIED','EVIDENCE_REQUESTED','UNDER_REVIEW')`);
    if (f.q) {
      // Búsqueda por folio (plaintext, ilike) o por hash exacto de folio/arn
      const like = '%' + String(f.q).trim() + '%';
      vals.push(like); conds.push(`(folio ilike $${vals.length})`);
    }
    if (!('archivado' in f) || f.archivado !== 'true') conds.push('archivado = false');
    const where = conds.length ? ' where ' + conds.join(' and ') : '';
    const limit = Math.min(parseInt(f.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
    const total = parseInt((await db.query('select count(*)::int as n from disputa.chargebacks' + where, vals)).rows[0].n, 10);
    const rows = (await db.query('select * from disputa.chargebacks' + where + ' order by id desc limit ' + limit + ' offset ' + offset, vals)).rows;
    res.json({ total, limit, offset, rows: rows.map(r => D.enriquecerCB(r, C)) });
  });

  app.get('/api/disputa/chargebacks/:id', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const cb = (await db.query('select * from disputa.chargebacks where id=$1', [id])).rows[0];
    if (!cb) return res.status(404).json({ error: 'no_existe' });
    const eventos = (await db.query('select id, ts, tipo, estado_anterior, estado_nuevo, actor, detalle, meta from disputa.chargeback_events where chargeback_id=$1 order by ts asc, id asc', [id])).rows;
    const attachments = (await db.query('select id, filename, mime, bytes_size, descripcion, subido_por, subido_at from disputa.attachments where chargeback_id=$1 order by subido_at desc', [id])).rows;
    res.json({ ...D.enriquecerCB(cb, C), eventos, attachments });
  });

  app.post('/api/disputa/chargebacks', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const b = req.body || {};
    const merchant_id = b.merchant_id ? parseInt(b.merchant_id, 10) : null;
    const reason_code_id = b.reason_code_id ? parseInt(b.reason_code_id, 10) : null;
    const provider_id = b.provider_id ? parseInt(b.provider_id, 10) : null;

    const brand = ['VISA', 'MASTERCARD', 'AMEX', 'CARNET', 'NACIONAL', 'INTERNACIONAL', 'OTHER'].includes(b.brand) ? b.brand : 'OTHER';
    const card_presence = ['CARD_PRESENT', 'CARD_NOT_PRESENT'].includes(b.card_presence) ? b.card_presence : 'CARD_NOT_PRESENT';
    const channel = ['POS', 'ECOMMERCE', 'MOTO', 'RECURRING', 'OTHER'].includes(b.channel) ? b.channel : 'OTHER';
    const cycle = ['RETRIEVAL', 'FIRST_CHARGEBACK', 'REPRESENTMENT', 'PRE_ARBITRATION', 'ARBITRATION'].includes(b.cycle) ? b.cycle : 'FIRST_CHARGEBACK';

    // Folio interno secuencial
    const folio = await D.generarFolio(db, 'CB', 'chargebacks');
    const folio_hash = C.hmac(folio);

    const arn = b.arn ? String(b.arn).trim() : null;
    const case_number = b.case_number ? String(b.case_number).trim() : null;
    const amount = b.disputed_amount != null && b.disputed_amount !== '' ? Number(b.disputed_amount) : null;
    const merchant_name = b.merchant_name ? String(b.merchant_name).trim() : null;
    const afil = b.merchant_affiliation ? String(b.merchant_affiliation).replace(/\D/g, '') : null;

    const fecha_evento = b.fecha_evento && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_evento) ? b.fecha_evento : new Date().toISOString().slice(0, 10);
    const fecha_recepcion = b.fecha_recepcion && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_recepcion) ? b.fecha_recepcion : new Date().toISOString().slice(0, 10);
    const fecha_limite_comercio = await D.computarLimiteComercio(db, fecha_recepcion, reason_code_id);
    const fecha_limite_representacion = await D.computarLimiteRepresentacion(db, fecha_recepcion, reason_code_id);

    const external_id = b.external_id ? String(b.external_id).trim() : null;
    const external_id_hash = external_id ? C.hmac(external_id) : null;

    const cols = ['folio', 'folio_hash', 'provider_id', 'merchant_id', 'client_group_id', 'reason_code_id',
      'external_id', 'external_id_hash', 'arn', 'arn_cifrado', 'arn_hash', 'case_number', 'case_number_cifrado',
      'brand', 'card_presence', 'channel', 'cycle', 'status', 'reason_code_raw', 'reason_description',
      'disputed_amount_cifrado', 'currency_code',
      'merchant_name', 'merchant_name_cifrado', 'merchant_affiliation', 'merchant_affiliation_hash',
      'fecha_evento', 'fecha_recepcion', 'fecha_limite_comercio', 'fecha_limite_representacion',
      'origen', 'creado_por'];
    const vals = [folio, folio_hash, provider_id, merchant_id, b.client_group_id || null, reason_code_id,
      external_id, external_id_hash, arn, C.encrypt(arn), arn ? C.hmac(arn) : null, case_number, C.encrypt(case_number),
      brand, card_presence, channel, cycle, 'NEW', b.reason_code_raw || null, b.reason_description || null,
      C.encrypt(amount != null ? String(amount) : null), (b.currency_code || 'MXN').toUpperCase().slice(0, 3),
      merchant_name, C.encrypt(merchant_name), afil, afil ? C.hmac(afil) : null,
      fecha_evento, fecha_recepcion, fecha_limite_comercio, fecha_limite_representacion,
      String(b.origen || 'manual'), req.user.nombre || req.user.email || '—'];
    const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
    const r = await db.query(`insert into disputa.chargebacks(${cols.join(',')}) values(${ph}) returning id, folio`, vals);
    const idNuevo = r.rows[0].id;
    await D.agregarEventoCB(db, idNuevo, { tipo: 'created', estado_nuevo: 'NEW', actor: req.user.nombre, detalle: 'Alta manual' });
    await bit(req, 'disputa_cb_alta', `folio=${folio} brand=${brand}`, { resource_type: 'disputa_cb', resource_id: idNuevo });
    res.json({ ok: true, id: idNuevo, folio: r.rows[0].folio });
  });

  app.patch('/api/disputa/chargebacks/:id', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const cb = (await db.query('select * from disputa.chargebacks where id=$1', [id])).rows[0];
    if (!cb) return res.status(404).json({ error: 'no_existe' });
    if (['WON', 'LOST', 'ACCEPTED', 'EXPIRED', 'CANCELLED'].includes(cb.status)) return res.status(409).json({ error: 'inmutable', mensaje: 'Un CB en estado final no puede editarse.' });
    const b = req.body || {};
    const sets = [], vals = [];
    const set = (col, v) => { sets.push(`${col}=$${vals.push(v)}`); };
    if (b.reason_description !== undefined) set('reason_description', b.reason_description);
    if (b.merchant_id !== undefined) set('merchant_id', b.merchant_id || null);
    if (b.client_group_id !== undefined) set('client_group_id', b.client_group_id || null);
    if (b.reason_code_id !== undefined) {
      set('reason_code_id', b.reason_code_id || null);
      // Recalcular plazos si cambia reason_code
      const nuevaLc = await D.computarLimiteComercio(db, cb.fecha_recepcion ? String(cb.fecha_recepcion).slice(0, 10) : null, b.reason_code_id || null);
      const nuevaLr = await D.computarLimiteRepresentacion(db, cb.fecha_recepcion ? String(cb.fecha_recepcion).slice(0, 10) : null, b.reason_code_id || null);
      set('fecha_limite_comercio', nuevaLc);
      set('fecha_limite_representacion', nuevaLr);
    }
    if (b.retenido !== undefined) set('retenido', !!b.retenido);
    if (!sets.length) return res.status(400).json({ error: 'sin_cambios' });
    sets.push('actualizado_at=now()');
    vals.push(id);
    await db.query(`update disputa.chargebacks set ${sets.join(',')} where id=$${vals.length}`, vals);
    await D.agregarEventoCB(db, id, { tipo: 'patch', actor: req.user.nombre, detalle: 'Edición', meta: b });
    await bit(req, 'disputa_cb_editar', `id=${id}`, { resource_type: 'disputa_cb', resource_id: id });
    res.json({ ok: true });
  });

  app.post('/api/disputa/chargebacks/:id/status', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const nuevo = String((req.body || {}).status || '').toUpperCase();
    const cb = (await db.query('select id, status from disputa.chargebacks where id=$1', [id])).rows[0];
    if (!cb) return res.status(404).json({ error: 'no_existe' });
    if (!D.esTransicionCBValida(cb.status, nuevo)) return res.status(409).json({ error: 'transicion_invalida', desde: cb.status, hacia: nuevo, validos: D.CB_TRANSICIONES[cb.status] || [] });
    const patch = ['status=$1', 'actualizado_at=now()'];
    const pv = [nuevo];
    if (['WON', 'LOST', 'ACCEPTED', 'CANCELLED', 'EXPIRED'].includes(nuevo)) patch.push(`fecha_cierre=current_date`);
    await db.query(`update disputa.chargebacks set ${patch.join(', ')} where id=$${pv.length + 1}`, [...pv, id]);
    await D.agregarEventoCB(db, id, { tipo: 'status_change', estado_anterior: cb.status, estado_nuevo: nuevo, actor: req.user.nombre, detalle: (req.body || {}).nota || null });
    await bit(req, 'disputa_cb_status', `${cb.status}→${nuevo}`, { resource_type: 'disputa_cb', resource_id: id });
    res.json({ ok: true, status: nuevo });
  });

  app.post('/api/disputa/chargebacks/:id/archive', auth, requiereRol('admin'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await db.query('update disputa.chargebacks set archivado=true, actualizado_at=now() where id=$1', [id]);
    await D.agregarEventoCB(db, id, { tipo: 'archivado', actor: req.user.nombre });
    await bit(req, 'disputa_cb_archivo', '', { resource_type: 'disputa_cb', resource_id: id });
    res.json({ ok: true });
  });

  /* ==========================================================================
     REFUNDS
     ========================================================================= */
  app.get('/api/disputa/refunds', auth, async (req, res) => {
    const f = req.query || {};
    const conds = [], vals = [];
    if (f.estado) { vals.push(String(f.estado)); conds.push(`status=$${vals.length}`); }
    if (f.merchant_id) { vals.push(parseInt(f.merchant_id, 10)); conds.push(`merchant_id=$${vals.length}`); }
    const where = conds.length ? ' where ' + conds.join(' and ') : '';
    const rows = (await db.query('select * from disputa.refunds' + where + ' order by id desc limit 500', vals)).rows;
    res.json(rows.map(r => ({
      ...r,
      amount: r.amount_cifrado ? Number(C.decryptString(r.amount_cifrado)) : null,
      fecha_reporte: D.fechaISO(r.fecha_reporte),
      fecha_limite_respuesta: D.fechaISO(r.fecha_limite_respuesta),
      dias_para_vencer: D.diasParaVencer(D.fechaISO(r.fecha_limite_respuesta)),
    })));
  });
  app.post('/api/disputa/refunds', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const b = req.body || {};
    const folio = await D.generarFolio(db, 'REF', 'refunds');
    const merchant_id = b.merchant_id ? parseInt(b.merchant_id, 10) : null;
    const amount = b.amount != null ? Number(b.amount) : null;
    const fecha_reporte = b.fecha_reporte && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_reporte) ? b.fecha_reporte : new Date().toISOString().slice(0, 10);
    const fecha_limite = await D.agregarDiasHabiles(db, fecha_reporte, 3);   // default 3 días hábiles
    const ext = b.external_id ? String(b.external_id).trim() : null;
    const refOrig = b.reference_original ? String(b.reference_original).trim() : null;
    const r = await db.query(
      'insert into disputa.refunds(folio, folio_hash, provider_id, merchant_id, client_group_id, external_id, external_id_hash, reference_original, reference_original_hash, amount_cifrado, currency_code, fecha_reporte, fecha_limite_respuesta, origen, creado_por) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id, folio',
      [folio, C.hmac(folio), b.provider_id || null, merchant_id, b.client_group_id || null, ext, ext ? C.hmac(ext) : null, refOrig, refOrig ? C.hmac(refOrig) : null, C.encrypt(amount != null ? String(amount) : null), (b.currency_code || 'MXN').toUpperCase().slice(0, 3), fecha_reporte, fecha_limite, b.origen || 'manual', req.user.nombre || req.user.email || '—']
    );
    await D.agregarEventoRef(db, r.rows[0].id, { tipo: 'created', estado_nuevo: 'NEW', actor: req.user.nombre });
    await bit(req, 'disputa_ref_alta', `folio=${folio}`, { resource_type: 'disputa_ref', resource_id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id, folio: r.rows[0].folio });
  });
  app.post('/api/disputa/refunds/:id/status', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const nuevo = String((req.body || {}).status || '').toUpperCase();
    const decision = (req.body || {}).decision ? String((req.body || {}).decision).toUpperCase() : null;
    const cur = (await db.query('select id, status from disputa.refunds where id=$1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'no_existe' });
    if (!D.esTransicionRefValida(cur.status, nuevo)) return res.status(409).json({ error: 'transicion_invalida', validos: D.REF_TRANSICIONES[cur.status] || [] });
    const sets = ['status=$1', 'actualizado_at=now()']; const vals = [nuevo];
    if (nuevo === 'ANSWERED' && decision && ['PROCEDE', 'NO_PROCEDE'].includes(decision)) { vals.push(decision); sets.push(`decision=$${vals.length}`); }
    vals.push(id);
    await db.query(`update disputa.refunds set ${sets.join(', ')} where id=$${vals.length}`, vals);
    await D.agregarEventoRef(db, id, { tipo: 'status_change', estado_anterior: cur.status, estado_nuevo: nuevo, actor: req.user.nombre, detalle: decision ? `decision=${decision}` : null });
    await bit(req, 'disputa_ref_status', `${cur.status}→${nuevo}${decision ? '·' + decision : ''}`, { resource_type: 'disputa_ref', resource_id: id });
    res.json({ ok: true });
  });

  /* ==========================================================================
     DUPLICATES
     ========================================================================= */
  app.get('/api/disputa/duplicates', auth, async (req, res) => {
    const f = req.query || {};
    const conds = [], vals = [];
    if (f.estado) { vals.push(String(f.estado)); conds.push(`status=$${vals.length}`); }
    if (f.merchant_id) { vals.push(parseInt(f.merchant_id, 10)); conds.push(`merchant_id=$${vals.length}`); }
    const where = conds.length ? ' where ' + conds.join(' and ') : '';
    const rows = (await db.query('select * from disputa.duplicates' + where + ' order by id desc limit 500', vals)).rows;
    res.json(rows.map(r => ({
      ...r,
      fecha_reporte: D.fechaISO(r.fecha_reporte),
      fecha_limite_respuesta: D.fechaISO(r.fecha_limite_respuesta),
      dias_para_vencer: D.diasParaVencer(D.fechaISO(r.fecha_limite_respuesta)),
    })));
  });
  app.post('/api/disputa/duplicates', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const b = req.body || {};
    const folio = await D.generarFolio(db, 'DUP', 'duplicates');
    const fecha_reporte = b.fecha_reporte && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_reporte) ? b.fecha_reporte : new Date().toISOString().slice(0, 10);
    const fecha_limite = await D.agregarDiasHabiles(db, fecha_reporte, 3);
    const r = await db.query(
      'insert into disputa.duplicates(folio, folio_hash, merchant_id, client_group_id, transaction_a_id, transaction_b_id, campos_coincidentes, diferencia_segundos, fecha_reporte, fecha_limite_respuesta, origen, creado_por) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, folio',
      [folio, C.hmac(folio), b.merchant_id || null, b.client_group_id || null, b.transaction_a_id || null, b.transaction_b_id || null, JSON.stringify(b.campos_coincidentes || []), b.diferencia_segundos || null, fecha_reporte, fecha_limite, b.origen || 'manual', req.user.nombre || req.user.email || '—']
    );
    await D.agregarEventoDup(db, r.rows[0].id, { tipo: 'created', estado_nuevo: 'NEW', actor: req.user.nombre });
    await bit(req, 'disputa_dup_alta', `folio=${folio}`, { resource_type: 'disputa_dup', resource_id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id, folio: r.rows[0].folio });
  });
  app.post('/api/disputa/duplicates/:id/status', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const nuevo = String((req.body || {}).status || '').toUpperCase();
    const decision = (req.body || {}).decision ? String((req.body || {}).decision).toUpperCase() : null;
    const cur = (await db.query('select id, status from disputa.duplicates where id=$1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'no_existe' });
    if (!D.esTransicionDupValida(cur.status, nuevo)) return res.status(409).json({ error: 'transicion_invalida', validos: D.DUP_TRANSICIONES[cur.status] || [] });
    const sets = ['status=$1', 'actualizado_at=now()']; const vals = [nuevo];
    if (nuevo === 'ANSWERED' && decision && ['DUPLICADA', 'NO_DUPLICADA'].includes(decision)) { vals.push(decision); sets.push(`decision=$${vals.length}`); }
    vals.push(id);
    await db.query(`update disputa.duplicates set ${sets.join(', ')} where id=$${vals.length}`, vals);
    await D.agregarEventoDup(db, id, { tipo: 'status_change', estado_anterior: cur.status, estado_nuevo: nuevo, actor: req.user.nombre, detalle: decision ? `decision=${decision}` : null });
    await bit(req, 'disputa_dup_status', `${cur.status}→${nuevo}${decision ? '·' + decision : ''}`, { resource_type: 'disputa_dup', resource_id: id });
    res.json({ ok: true });
  });

  /* ==========================================================================
     DASHBOARD KPIs
     ========================================================================= */
  app.get('/api/disputa/dashboard', auth, async (_req, res) => {
    const q = (sql, params) => db.query(sql, params || []).then(r => r.rows[0]?.n ?? 0);
    const abiertos_cb = await q("select count(*)::int as n from disputa.chargebacks where status in ('NEW','NOTIFIED','EVIDENCE_REQUESTED','UNDER_REVIEW','REPRESENTED','IN_DISPUTE') and archivado=false");
    const abiertos_ref = await q("select count(*)::int as n from disputa.refunds where status in ('NEW','NOTIFIED')");
    const abiertos_dup = await q("select count(*)::int as n from disputa.duplicates where status in ('NEW','NOTIFIED')");
    const por_vencer_cb = await q("select count(*)::int as n from disputa.chargebacks where status not in ('WON','LOST','ACCEPTED','EXPIRED','CANCELLED') and fecha_limite_comercio between current_date and current_date + 3");
    const vencidos_cb = await q("select count(*)::int as n from disputa.chargebacks where status not in ('WON','LOST','ACCEPTED','EXPIRED','CANCELLED') and fecha_limite_comercio < current_date");
    const ganados_mes = await q("select count(*)::int as n from disputa.chargebacks where status='WON' and fecha_cierre >= date_trunc('month', current_date)");
    const ciclos = (await db.query("select cycle, count(*)::int as n from disputa.chargebacks where archivado=false group by cycle order by n desc")).rows;
    res.json({
      abiertos: { chargebacks: abiertos_cb, refunds: abiertos_ref, duplicates: abiertos_dup, total: abiertos_cb + abiertos_ref + abiertos_dup },
      por_vencer: por_vencer_cb,
      vencidos: vencidos_cb,
      ganados_mes,
      distribucion_ciclos: ciclos,
    });
  });

  /* ==========================================================================
     ATTACHMENTS: upload / list / download de evidencia (Sprint 7)
     ========================================================================= */
  const crypto = require('crypto');
  // Whitelist de MIME aceptados como evidencia (pdf, imágenes, xlsx, docx, jpg, png, txt).
  const ATT_OK_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
    'text/plain', 'text/csv', 'application/zip', 'application/octet-stream']);
  function pickForeign(req) {
    // Determina para qué tipo de caso es el upload según la ruta.
    if (req.params.cb_id) return { col: 'chargeback_id', id: parseInt(req.params.cb_id, 10), tabla: 'chargebacks' };
    if (req.params.ref_id) return { col: 'refund_id', id: parseInt(req.params.ref_id, 10), tabla: 'refunds' };
    if (req.params.dup_id) return { col: 'duplicate_id', id: parseInt(req.params.dup_id, 10), tabla: 'duplicates' };
    return null;
  }
  function attachmentsRoute(pathParam) {
    // POST upload de un archivo (multer.single('archivo')).
    app.post('/api/disputa/' + pathParam.tabla + '/:' + pathParam.param + '/attachments', auth, requiereRol('admin', 'operador'), upload.single('archivo'), async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'archivo_requerido' });
      const mime = String(req.file.mimetype || '').toLowerCase();
      if (!ATT_OK_MIMES.has(mime)) return res.status(400).json({ error: 'mime_no_permitido', mensaje: 'Tipo de archivo no aceptado.' });
      if (req.file.size > 15 * 1024 * 1024) return res.status(400).json({ error: 'archivo_muy_grande', mensaje: 'Máximo 15 MB por archivo.' });
      const target = pickForeign(req);
      const bytes = req.file.buffer;
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const cifrado = C.encrypt(bytes);
      const bytesCif = Buffer.from(cifrado, 'utf8');
      const r = await db.query(
        'insert into disputa.attachments(' + target.col + ', filename, mime, bytes_cifrado, bytes_size, sha256_hash, descripcion, subido_por) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',
        [target.id, req.file.originalname || 'evidencia.bin', mime, bytesCif, req.file.size, sha256, req.body?.descripcion || null, req.user.nombre || req.user.email || '—']
      );
      await bit(req, 'disputa_att_alta', `${target.tabla} #${target.id} · ${req.file.originalname} (${req.file.size} B)`, { resource_type: 'disputa_att', resource_id: r.rows[0].id });
      res.status(201).json({ ok: true, id: r.rows[0].id, filename: req.file.originalname, size: req.file.size, sha256 });
    });
  }
  attachmentsRoute({ tabla: 'chargebacks', param: 'cb_id' });
  attachmentsRoute({ tabla: 'refunds', param: 'ref_id' });
  attachmentsRoute({ tabla: 'duplicates', param: 'dup_id' });

  // GET descarga: descifra el bytea y lo entrega.
  app.get('/api/disputa/attachments/:id/download', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const a = (await db.query('select filename, mime, bytes_cifrado, sha256_hash from disputa.attachments where id=$1', [id])).rows[0];
    if (!a) return res.status(404).json({ error: 'no_existe' });
    let buf;
    try {
      const cifStr = (Buffer.isBuffer(a.bytes_cifrado) ? a.bytes_cifrado : Buffer.from(a.bytes_cifrado)).toString('utf8');
      buf = C.decrypt(cifStr);
    } catch (e) { return res.status(500).json({ error: 'descifrado_fallido' }); }
    // Verificación de integridad opcional
    const shaAhora = crypto.createHash('sha256').update(buf).digest('hex');
    if (shaAhora !== a.sha256_hash) return res.status(500).json({ error: 'hash_no_coincide' });
    res.setHeader('Content-Type', a.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + (a.filename || 'evidencia.bin').replace(/[^\w.\- ]+/g, '_') + '"');
    res.send(buf);
  });

  app.delete('/api/disputa/attachments/:id', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await db.query('delete from disputa.attachments where id=$1', [id]);
    await bit(req, 'disputa_att_baja', '', { resource_type: 'disputa_att', resource_id: id });
    res.json({ ok: true });
  });

  /* ==========================================================================
     NOTIFICATIONS: envía SES al comercio + registra en disputa.notifications
     ========================================================================= */
  async function contactosDelCaso(merchant_id, client_group_id) {
    // Trae contactos activos del comercio; si no hay, cae al grupo.
    const conds = []; const vals = [];
    if (merchant_id) { vals.push(merchant_id); conds.push(`merchant_id=$${vals.length}`); }
    if (!conds.length && client_group_id) { vals.push(client_group_id); conds.push(`client_group_id=$${vals.length}`); }
    if (!conds.length) return [];
    const rows = (await db.query('select id, nombre, nombre_cifrado, email, email_cifrado from disputa.contacts where activo=true and (' + conds.join(' or ') + ')', vals)).rows;
    return rows.map(c => ({
      id: c.id,
      nombre: C.decryptString(c.nombre_cifrado) || c.nombre || '',
      email: C.decryptString(c.email_cifrado) || c.email || '',
    })).filter(c => c.email);
  }

  async function enviarNotifCaso(tipo, casoId, req, res) {
    if (!sesEnabled()) return res.status(503).json({ error: 'ses_no_configurado' });
    const tabla = tipo === 'refund' ? 'refunds' : tipo === 'duplicate' ? 'duplicates' : 'chargebacks';
    const caso = (await db.query('select * from disputa.' + tabla + ' where id=$1', [casoId])).rows[0];
    if (!caso) return res.status(404).json({ error: 'no_existe' });
    const contactos = await contactosDelCaso(caso.merchant_id, caso.client_group_id);
    if (!contactos.length) return res.status(400).json({ error: 'sin_contactos', mensaje: 'El comercio o grupo no tiene contactos activos con email.' });
    // Nombre del comercio (descifrar si viene cifrado en el caso, o traer del catálogo).
    let merchantName = null;
    if (caso.merchant_id) {
      const m = (await db.query('select nombre, nombre_cifrado from disputa.merchants where id=$1', [caso.merchant_id])).rows[0];
      if (m) merchantName = C.decryptString(m.nombre_cifrado) || m.nombre;
    } else if (caso.merchant_name_cifrado || caso.merchant_name) {
      merchantName = C.decryptString(caso.merchant_name_cifrado) || caso.merchant_name;
    }
    // Campos comunes del payload del correo.
    const campos = [];
    campos.push(['Folio', caso.folio]);
    if (tipo === 'chargeback') {
      campos.push(['Marca', caso.brand || '—']);
      campos.push(['Canal', caso.channel || '—']);
      campos.push(['ARN', C.decryptString(caso.arn_cifrado) || caso.arn || '—']);
      campos.push(['Case number', C.decryptString(caso.case_number_cifrado) || caso.case_number || '—']);
      const monto = caso.disputed_amount_cifrado ? Number(C.decryptString(caso.disputed_amount_cifrado)) : null;
      campos.push(['Monto', monto != null ? '$' + monto.toFixed(2) + ' ' + (caso.currency_code || '') : '—']);
      campos.push(['Ciclo', caso.cycle]);
      if (caso.reason_code_raw) campos.push(['Reason code', caso.reason_code_raw]);
    } else {
      const monto = caso.amount_cifrado ? Number(C.decryptString(caso.amount_cifrado)) : null;
      if (monto != null) campos.push(['Monto', '$' + monto.toFixed(2) + ' ' + (caso.currency_code || '')]);
      if (tipo === 'refund' && caso.reference_original) campos.push(['Referencia original', caso.reference_original]);
      if (tipo === 'duplicate' && caso.diferencia_segundos != null) campos.push(['Diferencia entre cobros', caso.diferencia_segundos + ' seg']);
    }
    const fechaLim = tipo === 'chargeback' ? caso.fecha_limite_comercio : caso.fecha_limite_respuesta;
    const nAdj = req.body?.mensaje ? String(req.body.mensaje) : null;
    let messageId = null, error = null;
    try {
      const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
      let inlineImages = [];
      try { inlineImages = [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: fs.readFileSync(logoPath) }]; } catch (_e) { }
      // Un solo correo con todos en TO (los contactos suelen compartir área).
      const to = contactos.map(c => c.nombre ? `"${c.nombre}" <${c.email}>` : c.email);
      const contactoPrincipal = contactos[0];
      const { subject, html, textFallback } = armarNotifDisputaHTML({
        tipo, folio: caso.folio, merchant: merchantName,
        destinatario_nombre: contactoPrincipal.nombre || 'contacto',
        fecha_limite_respuesta: D.fechaISO(fechaLim),
        campos, mensaje_extra: nAdj,
      }, {});
      messageId = await sendSES({ to, subject, html, textFallback, inlineImages });
    } catch (e) { error = e.message; }
    // Registrar en notifications 1 fila por contacto para trazabilidad.
    for (const c of contactos) {
      await db.query(
        'insert into disputa.notifications(' + (tipo === 'refund' ? 'refund_id' : tipo === 'duplicate' ? 'duplicate_id' : 'chargeback_id') + ', destinatario_cifrado, destinatario_hash, subject_cifrado, status, message_id, error, enviado_por, enviado_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [casoId, C.encrypt(c.email), C.hmacEmail(c.email), C.encrypt('[' + caso.folio + '] ...'), error ? 'FAILED' : 'SENT', messageId, error, req.user.nombre || req.user.email, new Date()]
      );
    }
    // Cambio de estado NEW → NOTIFIED si aplica.
    if (!error && caso.status === 'NEW') {
      await db.query('update disputa.' + tabla + ' set status=$1, actualizado_at=now() where id=$2', ['NOTIFIED', casoId]);
      const eventFn = tipo === 'refund' ? D.agregarEventoRef : tipo === 'duplicate' ? D.agregarEventoDup : D.agregarEventoCB;
      await eventFn(db, casoId, { tipo: 'notified', estado_anterior: 'NEW', estado_nuevo: 'NOTIFIED', actor: req.user.nombre, detalle: 'Correo enviado a ' + contactos.length + ' contacto(s)' });
    }
    await bit(req, 'disputa_notif', `${tipo} ${caso.folio} → ${contactos.length} contactos ${error ? '· ERROR ' + error : ''}`, { resource_type: 'disputa_' + tipo, resource_id: casoId, success: !error });
    if (error) return res.status(500).json({ error: 'ses_error', mensaje: error });
    res.json({ ok: true, enviados: contactos.length, messageId });
  }
  app.post('/api/disputa/chargebacks/:id/notify', auth, requiereRol('admin', 'operador'), (req, res) => enviarNotifCaso('chargeback', parseInt(req.params.id, 10), req, res));
  app.post('/api/disputa/refunds/:id/notify', auth, requiereRol('admin', 'operador'), (req, res) => enviarNotifCaso('refund', parseInt(req.params.id, 10), req, res));
  app.post('/api/disputa/duplicates/:id/notify', auth, requiereRol('admin', 'operador'), (req, res) => enviarNotifCaso('duplicate', parseInt(req.params.id, 10), req, res));

  // Historial de notificaciones por caso.
  app.get('/api/disputa/:tipo(chargebacks|refunds|duplicates)/:id/notifications', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const col = req.params.tipo === 'refunds' ? 'refund_id' : req.params.tipo === 'duplicates' ? 'duplicate_id' : 'chargeback_id';
    const rows = (await db.query('select id, destinatario_cifrado, status, message_id, error, enviado_por, enviado_at from disputa.notifications where ' + col + '=$1 order by enviado_at desc', [id])).rows;
    res.json(rows.map(n => ({ id: n.id, destinatario: C.decryptString(n.destinatario_cifrado), status: n.status, message_id: n.message_id, error: n.error, enviado_por: n.enviado_por, enviado_at: n.enviado_at })));
  });
};
