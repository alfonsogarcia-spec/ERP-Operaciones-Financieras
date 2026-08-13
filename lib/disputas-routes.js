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
  const { auth, requiereRol, bit, db, C, D } = deps;

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
};
