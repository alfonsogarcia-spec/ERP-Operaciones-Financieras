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
  const { auth, requiereRol, bit, db, C, D, upload, sesEnabled, sendSES, armarNotifDisputaHTML, path, fs, X, enviarXLSX } = deps;

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

  // Contactos por client_group (agnóstico de merchant).
  app.get('/api/disputa/client-groups/:id/contacts', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const rows = (await db.query('select * from disputa.contacts where client_group_id=$1 order by es_principal desc, id', [id])).rows;
    res.json(rows.map(c => ({
      id: c.id, client_group_id: c.client_group_id,
      nombre: C.decryptString(c.nombre_cifrado) || c.nombre,
      email: C.decryptString(c.email_cifrado) || c.email,
      rol: c.rol, es_principal: c.es_principal,
      es_cc: c.es_cc, notifica: c.notifica, activo: c.activo,
    })));
  });
  app.post('/api/disputa/client-groups/:id/contacts', auth, requiereRol('admin', 'operador'), async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const nombre = String(b.nombre || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'email_invalido' });
    const emailHash = C.hmacEmail(email);
    // Upsert por (group_id, email_hash)
    const existe = (await db.query('select id from disputa.contacts where client_group_id=$1 and email_hash=$2', [groupId, emailHash])).rows[0];
    if (existe && b.id !== existe.id) {
      // Actualizar el existente en lugar de duplicar
      await db.query(
        'update disputa.contacts set nombre=$1, nombre_cifrado=$2, rol=$3, email=$4, email_cifrado=$5, es_principal=$6, es_cc=$7, notifica=$8, activo=true, actualizado_at=now() where id=$9',
        [nombre, C.encrypt(nombre), b.rol || null, email, C.encrypt(email), !!b.es_principal, !!b.es_cc, b.notifica !== false, existe.id]
      );
      await bit(req, 'disputa_contact_editar', `grupo=${groupId} email=${email}`, { resource_type: 'disputa_contact', resource_id: existe.id });
      return res.json({ ok: true, id: existe.id });
    }
    if (b.id) {
      await db.query(
        'update disputa.contacts set nombre=$1, nombre_cifrado=$2, rol=$3, email=$4, email_cifrado=$5, email_hash=$6, es_principal=$7, es_cc=$8, notifica=$9, actualizado_at=now() where id=$10',
        [nombre, C.encrypt(nombre), b.rol || null, email, C.encrypt(email), emailHash, !!b.es_principal, !!b.es_cc, b.notifica !== false, b.id]
      );
      await bit(req, 'disputa_contact_editar', `id=${b.id}`, { resource_type: 'disputa_contact', resource_id: b.id });
      return res.json({ ok: true, id: b.id });
    }
    const r = await db.query(
      'insert into disputa.contacts(client_group_id, nombre, nombre_cifrado, rol, email, email_cifrado, email_hash, es_principal, es_cc, notifica) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
      [groupId, nombre, C.encrypt(nombre), b.rol || null, email, C.encrypt(email), emailHash, !!b.es_principal, !!b.es_cc, b.notifica !== false]
    );
    await bit(req, 'disputa_contact_alta', `grupo=${groupId} email=${email}`, { resource_type: 'disputa_contact', resource_id: r.rows[0].id });
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

    // Fecha límite: si viene en el body la usamos; si no, la calcula el reason_code.
    const fechaLimComercio = b.fecha_limite_comercio && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_limite_comercio) ? b.fecha_limite_comercio : fecha_limite_comercio;
    // Datos de la transacción original.
    const tx_fecha = b.tx_fecha && /^\d{4}-\d{2}-\d{2}$/.test(b.tx_fecha) ? b.tx_fecha : null;
    const tx_ref = b.tx_referencia ? String(b.tx_referencia).trim() : null;
    const tx_aut = b.tx_autorizacion ? String(b.tx_autorizacion).trim() : null;
    const tx_last4 = b.tx_last4 ? String(b.tx_last4).replace(/\D/g, '').slice(0, 4) : null;
    const tx_monto = b.tx_monto != null && b.tx_monto !== '' ? Number(b.tx_monto) : null;
    const tx_tipo = b.tx_tipo_tarjeta ? String(b.tx_tipo_tarjeta).trim() : null;
    const tx_banco = b.tx_banco_emisor ? String(b.tx_banco_emisor).trim() : null;
    const notas = b.notas ? String(b.notas).trim() : null;
    const client_group_id = b.client_group_id ? parseInt(b.client_group_id, 10) : null;

    const cols = ['folio', 'folio_hash', 'provider_id', 'merchant_id', 'client_group_id', 'reason_code_id',
      'external_id', 'external_id_hash', 'arn', 'arn_cifrado', 'arn_hash', 'case_number', 'case_number_cifrado',
      'brand', 'card_presence', 'channel', 'cycle', 'status', 'reason_code_raw', 'reason_description',
      'disputed_amount_cifrado', 'currency_code',
      'merchant_name', 'merchant_name_cifrado', 'merchant_affiliation', 'merchant_affiliation_hash',
      'fecha_evento', 'fecha_recepcion', 'fecha_limite_comercio', 'fecha_limite_representacion',
      'origen', 'creado_por',
      'notas', 'tx_fecha', 'tx_referencia', 'tx_referencia_hash', 'tx_autorizacion_cifrada', 'tx_autorizacion_hash',
      'tx_last4_cifrada', 'tx_monto_cifrado', 'tx_tipo_tarjeta', 'tx_banco_emisor'];
    const vals = [folio, folio_hash, provider_id, merchant_id, client_group_id, reason_code_id,
      external_id, external_id_hash, arn, C.encrypt(arn), arn ? C.hmac(arn) : null, case_number, C.encrypt(case_number),
      brand, card_presence, channel, cycle, 'NEW', b.reason_code_raw || null, b.reason_description || null,
      C.encrypt(amount != null ? String(amount) : null), (b.currency_code || 'MXN').toUpperCase().slice(0, 3),
      merchant_name, C.encrypt(merchant_name), afil, afil ? C.hmac(afil) : null,
      fecha_evento, fecha_recepcion, fechaLimComercio, fecha_limite_representacion,
      String(b.origen || 'manual'), req.user.nombre || req.user.email || '—',
      notas, tx_fecha, tx_ref, tx_ref ? C.hmac(tx_ref) : null, C.encrypt(tx_aut), tx_aut ? C.hmac(tx_aut) : null,
      C.encrypt(tx_last4), C.encrypt(tx_monto != null ? String(tx_monto) : null), tx_tipo, tx_banco];
    const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
    const r = await db.query(`insert into disputa.chargebacks(${cols.join(',')}) values(${ph}) returning id, folio`, vals);
    const idNuevo = r.rows[0].id;
    await D.agregarEventoCB(db, idNuevo, { tipo: 'created', estado_nuevo: 'NEW', actor: req.user.nombre, detalle: 'Alta manual' });
    await bit(req, 'disputa_cb_alta', `folio=${folio} brand=${brand}`, { resource_type: 'disputa_cb', resource_id: idNuevo });

    // Si el checkbox "Notificar al comercio por email" viene marcado, dispara envío best-effort.
    let mail = null;
    if (b.notificar === true && sesEnabled()) {
      try {
        const req2 = { ...req, body: {} };
        // Simular request para enviarNotifCaso: usamos res-stub que captura la respuesta.
        const stubRes = { status: () => stubRes, json: (x) => { mail = x; return stubRes; } };
        await (async function () {
          const casoId = idNuevo;
          const caso = (await db.query('select * from disputa.chargebacks where id=$1', [casoId])).rows[0];
          const contactosBase = client_group_id
            ? (await db.query('select id, nombre, nombre_cifrado, email, email_cifrado from disputa.contacts where activo=true and notifica=true and client_group_id=$1', [client_group_id])).rows
            : (await db.query('select id, nombre, nombre_cifrado, email, email_cifrado from disputa.contacts where activo=true and notifica=true and merchant_id=$1', [merchant_id])).rows;
          const contactos = contactosBase.map(c => ({ nombre: C.decryptString(c.nombre_cifrado) || c.nombre || '', email: C.decryptString(c.email_cifrado) || c.email || '' })).filter(c => c.email);
          if (!contactos.length) { mail = { ok: false, motivo: 'sin_contactos' }; return; }
          const to = contactos.map(c => c.nombre ? `"${c.nombre}" <${c.email}>` : c.email);
          // Grupo
          let grupoNom = merchant_name || 'cliente';
          if (client_group_id) { const g = (await db.query('select nombre from disputa.client_groups where id=$1', [client_group_id])).rows[0]; if (g) grupoNom = g.nombre; }
          // Reason code para Motivo + Documentos + fraude
          let motivoTxt = null, documentos = [], marcarFraude = false;
          if (reason_code_id) {
            const rc = (await db.query('select titulo, descripcion, categoria, evidencia_sugerida from disputa.reason_codes where id=$1', [reason_code_id])).rows[0];
            if (rc) { motivoTxt = rc.titulo || rc.descripcion; marcarFraude = /fraude/i.test(rc.categoria || ''); if (rc.evidencia_sugerida) documentos = String(rc.evidencia_sugerida).split(/[;\n]/).map(s => s.trim()).filter(Boolean); }
          }
          const fmtFechaMX = v => { const iso = D.fechaISO(v); if (!iso) return null; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
          const diasRest = (() => { const iso = D.fechaISO(fechaLimComercio); if (!iso) return null; return Math.round((new Date(iso + 'T00:00:00Z') - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86400000); })();
          const fechaLimTxt = fmtFechaMX(fechaLimComercio) ? `${fmtFechaMX(fechaLimComercio)}${diasRest != null ? ` (${diasRest} día(s) restantes)` : ''}` : '—';
          const modalidad = card_presence === 'CARD_PRESENT' ? 'Tarjeta presente' : 'Tarjeta no presente';
          const canalMap = { POS: 'Terminal (POS)', ECOMMERCE: 'E-commerce', MOTO: 'MOTO / Link de pago', RECURRING: 'Cargo recurrente', OTHER: 'Otro' };
          const filas = [
            ['Folio', caso.folio],
            ['Comercio', merchant_name || '—'],
            ['Afiliación', afil || '—'],
            ['Marca', brand],
            ['Modalidad', modalidad],
            ['Canal', canalMap[channel] || channel],
            ['Ciclo', cycle],
            ['Código de razón', b.reason_code_raw || '—'],
            ['Motivo', motivoTxt || '—', marcarFraude ? '★' : null],
            ['Monto en disputa', amount != null ? amount.toFixed(2) + ' ' + (caso.currency_code || 'MXN') : '—'],
            ['Fecha de la transacción', fmtFechaMX(tx_fecha) || '—'],
            ['No. de autorización', tx_aut || '—'],
            ['No. de ticket / referencia', tx_ref || '—'],
            ['Tarjeta (últimos 4)', tx_last4 ? '**** ' + tx_last4 : '—'],
            ['Banco emisor', tx_banco || '—'],
            ['No. de caso', case_number || '—'],
            ['Fecha límite para enviar evidencia', fechaLimTxt],
          ];
          const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
          let inlineImages = [];
          try { inlineImages = [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: fs.readFileSync(logoPath) }]; } catch (_e) { }
          const { subject, html, textFallback } = armarNotifDisputaHTML({
            tipo: 'chargeback', folio: caso.folio, merchant: merchant_name,
            grupo_nombre: grupoNom,
            fecha_limite_respuesta: fmtFechaMX(fechaLimComercio),
            filas, documentos, mensaje_extra: notas,
          }, {});
          const messageId = await sendSES({ to, subject, html, textFallback, inlineImages });
          for (const c of contactos) {
            await db.query(
              'insert into disputa.notifications(chargeback_id, destinatario_cifrado, destinatario_hash, subject_cifrado, status, message_id, enviado_por, enviado_at) values($1,$2,$3,$4,$5,$6,$7,$8)',
              [casoId, C.encrypt(c.email), C.hmacEmail(c.email), C.encrypt(subject), 'SENT', messageId, req.user.nombre || req.user.email, new Date()]
            );
          }
          await db.query("update disputa.chargebacks set status='NOTIFIED', actualizado_at=now() where id=$1", [casoId]);
          await D.agregarEventoCB(db, casoId, { tipo: 'notified', estado_anterior: 'NEW', estado_nuevo: 'NOTIFIED', actor: req.user.nombre, detalle: 'Correo al alta a ' + contactos.length + ' contacto(s)' });
          mail = { ok: true, enviados: contactos.length, messageId };
        })();
      } catch (e) { mail = { ok: false, motivo: 'ses_error', error: e.message }; }
    }
    res.json({ ok: true, id: idNuevo, folio: r.rows[0].folio, mail });
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
    // Nombre del grupo cliente (para el saludo "Estimado <GRUPO>,").
    let grupoNombre = null;
    if (caso.client_group_id) {
      const g = (await db.query('select nombre from disputa.client_groups where id=$1', [caso.client_group_id])).rows[0];
      if (g) grupoNombre = g.nombre;
    }
    if (!grupoNombre) grupoNombre = merchantName || (contactos[0] && contactos[0].nombre) || 'cliente';
    // Trae el reason_code para "Motivo" + "Documentos requeridos".
    let motivoTxt = null, documentos = [], marcarFraude = false;
    if (caso.reason_code_id) {
      const rc = (await db.query('select brand, codigo, titulo, descripcion, categoria, evidencia_sugerida from disputa.reason_codes where id=$1', [caso.reason_code_id])).rows[0];
      if (rc) {
        motivoTxt = rc.titulo || rc.descripcion || null;
        marcarFraude = /fraude/i.test(rc.categoria || '');
        if (rc.evidencia_sugerida) documentos = String(rc.evidencia_sugerida).split(/[;\n]/).map(s => s.trim()).filter(Boolean);
      }
    }
    const fechaLim = tipo === 'chargeback' ? caso.fecha_limite_comercio : caso.fecha_limite_respuesta;
    // Formateadores locales
    const fmtFechaMX = v => { const iso = D.fechaISO(v); if (!iso) return null; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
    const diasRestantes = (() => { const iso = D.fechaISO(fechaLim); if (!iso) return null; const t = new Date(iso + 'T00:00:00Z').getTime() - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime(); return Math.round(t / (1000 * 60 * 60 * 24)); })();
    const fechaLimTxt = fmtFechaMX(fechaLim) ? `${fmtFechaMX(fechaLim)}${diasRestantes != null ? ` (${diasRestantes} día(s) restantes)` : ''}` : '—';
    const modalidad = caso.card_presence === 'CARD_PRESENT' ? 'Tarjeta presente' : caso.card_presence === 'AMBOS' ? 'Ambos' : 'Tarjeta no presente';
    const canalMap = { POS: 'Terminal (POS)', ECOMMERCE: 'E-commerce', MOTO: 'MOTO / Link de pago', RECURRING: 'Cargo recurrente', OTHER: 'Otro' };
    const canalTxt = canalMap[caso.channel] || caso.channel || '—';
    const brand = caso.brand || '—';
    const afil = caso.merchant_affiliation || (caso.merchant_id ? (await db.query('select afiliacion from disputa.merchants where id=$1', [caso.merchant_id])).rows[0]?.afiliacion : null) || '—';
    const arn = C.decryptString(caso.arn_cifrado) || caso.arn || '—';
    const caseNumber = C.decryptString(caso.case_number_cifrado) || caso.case_number || '—';
    const monto = caso.disputed_amount_cifrado ? Number(C.decryptString(caso.disputed_amount_cifrado)) : (caso.amount_cifrado ? Number(C.decryptString(caso.amount_cifrado)) : null);
    const currency = (caso.currency_code || 'MXN').toUpperCase();
    // Datos de la transacción original (si están)
    const txFecha = fmtFechaMX(caso.tx_fecha);
    const txAut = C.decryptString(caso.tx_autorizacion_cifrada) || '—';
    const txRef = caso.tx_referencia || '—';
    const txLast4 = C.decryptString(caso.tx_last4_cifrada);
    const txBanco = caso.tx_banco_emisor || '—';
    // Filas de la tabla del correo (mismo orden que el SS).
    const filas = [];
    if (tipo === 'chargeback') {
      filas.push(['Folio', caso.folio]);
      filas.push(['Comercio', merchantName || '—']);
      filas.push(['Afiliación', afil]);
      filas.push(['Marca', brand]);
      filas.push(['Modalidad', modalidad]);
      filas.push(['Canal', canalTxt]);
      filas.push(['Ciclo', caso.cycle]);
      filas.push(['Código de razón', caso.reason_code_raw || '—']);
      filas.push(['Motivo', motivoTxt || '—', marcarFraude ? '★' : null]);
      filas.push(['Monto en disputa', monto != null ? monto.toFixed(2) + ' ' + currency : '—']);
      filas.push(['Fecha de la transacción', txFecha || '—']);
      filas.push(['No. de autorización', txAut]);
      filas.push(['No. de ticket / referencia', txRef]);
      filas.push(['Tarjeta (últimos 4)', txLast4 ? '**** ' + txLast4 : '—']);
      filas.push(['Banco emisor', txBanco]);
      filas.push(['No. de caso', caseNumber]);
      filas.push(['Fecha límite para enviar evidencia', fechaLimTxt]);
    } else {
      filas.push(['Folio', caso.folio]);
      filas.push(['Comercio', merchantName || '—']);
      filas.push(['Afiliación', afil]);
      filas.push(['Monto', monto != null ? monto.toFixed(2) + ' ' + currency : '—']);
      if (tipo === 'refund' && caso.reference_original) filas.push(['Referencia original', caso.reference_original]);
      if (tipo === 'duplicate' && caso.diferencia_segundos != null) filas.push(['Diferencia entre cobros', caso.diferencia_segundos + ' seg']);
      filas.push(['Fecha límite para respuesta', fechaLimTxt]);
    }
    const nAdj = req.body?.mensaje ? String(req.body.mensaje) : null;
    let messageId = null, error = null;
    try {
      const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
      let inlineImages = [];
      try { inlineImages = [{ cid: 'polipay-logo', filename: 'polipay-logo.png', contentType: 'image/png', content: fs.readFileSync(logoPath) }]; } catch (_e) { }
      // Un solo correo con todos en TO (los contactos suelen compartir área).
      const to = contactos.map(c => c.nombre ? `"${c.nombre}" <${c.email}>` : c.email);
      const { subject, html, textFallback } = armarNotifDisputaHTML({
        tipo, folio: caso.folio, merchant: merchantName,
        grupo_nombre: grupoNombre,
        fecha_limite_respuesta: fmtFechaMX(fechaLim),
        filas, documentos, mensaje_extra: nAdj,
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

  /* ==========================================================================
     REPORTES (Sprint 8) — formato=csv (default) | xlsx. Filtros: desde, hasta,
     merchant_id. Requiere rol de lectura (auth cualquier rol autenticado).
     ========================================================================= */
  function csvCell(v) { const s = v == null ? '' : String(v); return /["\n,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function csvResponse(res, filename, headers, rows) {
    const lines = [headers.join(',')].concat(rows.map(r => r.map(csvCell).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + lines.join('\n'));  // BOM UTF-8 para Excel
  }
  function xlsxResponse(res, filename, sheetName, headers, rows) {
    const aoa = [headers, ...rows];
    const buf = X.buildXLSX([{ name: sheetName.slice(0, 31), aoa, cols: headers.map(() => ({ wch: 16 })) }]);
    enviarXLSX(res, filename, buf);
  }
  // Enriquece filas de CB con: descifrado + días para vencer, para reportes.
  function condsCB(f) {
    const conds = ['archivado = false'], vals = [];
    if (f.desde && /^\d{4}-\d{2}-\d{2}$/.test(f.desde)) { vals.push(f.desde); conds.push(`fecha_evento >= $${vals.length}`); }
    if (f.hasta && /^\d{4}-\d{2}-\d{2}$/.test(f.hasta)) { vals.push(f.hasta); conds.push(`fecha_evento <= $${vals.length}`); }
    if (f.merchant_id) { vals.push(parseInt(f.merchant_id, 10)); conds.push(`merchant_id=$${vals.length}`); }
    return { where: ' where ' + conds.join(' and '), vals };
  }

  // 1) Contracargos por rango.
  app.get('/api/disputa/reports/rango', auth, async (req, res) => {
    const f = req.query || {};
    const { where, vals } = condsCB(f);
    const rows = (await db.query('select cb.*, m.nombre as merchant_nombre_plain, m.nombre_cifrado as merchant_nombre_cif, rc.brand as rc_brand, rc.codigo as rc_codigo from disputa.chargebacks cb left join disputa.merchants m on cb.merchant_id=m.id left join disputa.reason_codes rc on cb.reason_code_id=rc.id' + where + ' order by cb.fecha_evento desc, cb.id desc limit 10000', vals)).rows;
    const headers = ['Folio', 'Fecha evento', 'Recepción', 'Marca', 'Canal', 'Ciclo', 'Estado', 'Reason', 'Comercio', 'Afiliación', 'ARN', 'Case number', 'Monto', 'Moneda', 'Vence comercio', 'Vence representación', 'Cerrado', 'Origen', 'Creado por'];
    const data = rows.map(r => [
      r.folio, D.fechaISO(r.fecha_evento), D.fechaISO(r.fecha_recepcion), r.brand, r.channel, r.cycle, r.status,
      (r.rc_brand ? r.rc_brand + ' ' + r.rc_codigo : (r.reason_code_raw || '')),
      C.decryptString(r.merchant_nombre_cif) || r.merchant_nombre_plain || C.decryptString(r.merchant_name_cifrado) || r.merchant_name || '',
      r.merchant_affiliation || '',
      C.decryptString(r.arn_cifrado) || r.arn || '',
      C.decryptString(r.case_number_cifrado) || r.case_number || '',
      r.disputed_amount_cifrado ? Number(C.decryptString(r.disputed_amount_cifrado)) : '',
      r.currency_code || '', D.fechaISO(r.fecha_limite_comercio), D.fechaISO(r.fecha_limite_representacion),
      D.fechaISO(r.fecha_cierre), r.origen, r.creado_por,
    ]);
    const fname = `disputas_cb_rango_${new Date().toISOString().slice(0, 10)}`;
    if ((f.formato || 'csv') === 'xlsx') return xlsxResponse(res, fname + '.xlsx', 'CB por rango', headers, data);
    csvResponse(res, fname + '.csv', headers, data);
  });

  // 2) CB por comercio (agrupado).
  app.get('/api/disputa/reports/por-comercio', auth, async (req, res) => {
    const f = req.query || {};
    const { where, vals } = condsCB(f);
    const q = `
      select cb.merchant_id as mid, m.nombre as mnom, m.nombre_cifrado as mnomcif, m.afiliacion as mafil,
             count(*)::int as total,
             sum(case when cb.status='WON' then 1 else 0 end)::int as ganados,
             sum(case when cb.status='LOST' then 1 else 0 end)::int as perdidos,
             sum(case when cb.status in ('NEW','NOTIFIED','EVIDENCE_REQUESTED','UNDER_REVIEW','REPRESENTED','IN_DISPUTE') then 1 else 0 end)::int as abiertos,
             sum(case when cb.status='EXPIRED' then 1 else 0 end)::int as vencidos
      from disputa.chargebacks cb
      left join disputa.merchants m on cb.merchant_id=m.id
      ${where}
      group by cb.merchant_id, m.nombre, m.nombre_cifrado, m.afiliacion
      order by total desc`;
    const rows = (await db.query(q, vals)).rows;
    const headers = ['Comercio', 'Afiliación', 'Total CB', 'Abiertos', 'Ganados', 'Perdidos', 'Vencidos', 'Ratio ganancia'];
    const data = rows.map(r => {
      const rel = r.ganados + r.perdidos;
      const ratio = rel ? Math.round((r.ganados / rel) * 100) : null;
      return [C.decryptString(r.mnomcif) || r.mnom || (r.mid ? '#' + r.mid : '(sin comercio)'), r.mafil || '', r.total, r.abiertos, r.ganados, r.perdidos, r.vencidos, ratio != null ? ratio + '%' : ''];
    });
    const fname = `disputas_por_comercio_${new Date().toISOString().slice(0, 10)}`;
    if ((f.formato || 'csv') === 'xlsx') return xlsxResponse(res, fname + '.xlsx', 'CB por comercio', headers, data);
    csvResponse(res, fname + '.csv', headers, data);
  });

  // 3) CB por reason code.
  app.get('/api/disputa/reports/por-reason', auth, async (req, res) => {
    const f = req.query || {};
    const { where, vals } = condsCB(f);
    const q = `
      select coalesce(rc.brand, 'SIN_RED') as brand, coalesce(rc.codigo, cb.reason_code_raw, 'SIN_CODIGO') as codigo,
             coalesce(rc.descripcion, '') as descripcion,
             count(*)::int as total,
             sum(case when cb.status='WON' then 1 else 0 end)::int as ganados,
             sum(case when cb.status='LOST' then 1 else 0 end)::int as perdidos
      from disputa.chargebacks cb
      left join disputa.reason_codes rc on cb.reason_code_id=rc.id
      ${where}
      group by rc.brand, rc.codigo, cb.reason_code_raw, rc.descripcion
      order by total desc`;
    const rows = (await db.query(q, vals)).rows;
    const headers = ['Red', 'Código', 'Descripción', 'Total', 'Ganados', 'Perdidos', '% del total'];
    const total = rows.reduce((s, r) => s + r.total, 0) || 1;
    const data = rows.map(r => [r.brand, r.codigo, r.descripcion, r.total, r.ganados, r.perdidos, Math.round((r.total / total) * 100) + '%']);
    const fname = `disputas_por_reason_${new Date().toISOString().slice(0, 10)}`;
    if ((f.formato || 'csv') === 'xlsx') return xlsxResponse(res, fname + '.xlsx', 'CB por reason', headers, data);
    csvResponse(res, fname + '.csv', headers, data);
  });

  // 4) Refunds + Duplicates combinados.
  app.get('/api/disputa/reports/refunds-dup', auth, async (req, res) => {
    const f = req.query || {};
    const conds = [], vals = [];
    if (f.desde && /^\d{4}-\d{2}-\d{2}$/.test(f.desde)) { vals.push(f.desde); conds.push(`fecha_reporte >= $${vals.length}`); }
    if (f.hasta && /^\d{4}-\d{2}-\d{2}$/.test(f.hasta)) { vals.push(f.hasta); conds.push(`fecha_reporte <= $${vals.length}`); }
    const where = conds.length ? ' where ' + conds.join(' and ') : '';
    const refs = (await db.query('select folio, fecha_reporte, amount_cifrado, currency_code, status, decision, fecha_limite_respuesta, merchant_id from disputa.refunds' + where + ' order by fecha_reporte desc limit 5000', vals)).rows;
    const dups = (await db.query('select folio, fecha_reporte, diferencia_segundos, status, decision, fecha_limite_respuesta, merchant_id from disputa.duplicates' + where + ' order by fecha_reporte desc limit 5000', vals)).rows;
    const headers = ['Tipo', 'Folio', 'Fecha reporte', 'Monto / Diferencia', 'Merchant', 'Estado', 'Decisión', 'Vence'];
    const data = [
      ...refs.map(r => ['REFUND', r.folio, D.fechaISO(r.fecha_reporte), r.amount_cifrado ? Number(C.decryptString(r.amount_cifrado)) + ' ' + (r.currency_code || '') : '', r.merchant_id || '', r.status, r.decision || '', D.fechaISO(r.fecha_limite_respuesta)]),
      ...dups.map(r => ['DUPLICATE', r.folio, D.fechaISO(r.fecha_reporte), r.diferencia_segundos != null ? r.diferencia_segundos + ' seg' : '', r.merchant_id || '', r.status, r.decision || '', D.fechaISO(r.fecha_limite_respuesta)]),
    ];
    const fname = `disputas_refunds_dup_${new Date().toISOString().slice(0, 10)}`;
    if ((f.formato || 'csv') === 'xlsx') return xlsxResponse(res, fname + '.xlsx', 'Refunds + Dup', headers, data);
    csvResponse(res, fname + '.csv', headers, data);
  });

  // 5) Casos vencidos: CB + refunds + duplicates.
  app.get('/api/disputa/reports/vencidos', auth, async (req, res) => {
    const f = req.query || {};
    const cbs = (await db.query("select folio, brand, cycle, status, fecha_limite_comercio from disputa.chargebacks where status not in ('WON','LOST','ACCEPTED','EXPIRED','CANCELLED') and fecha_limite_comercio < current_date and archivado=false order by fecha_limite_comercio asc limit 5000")).rows;
    const refs = (await db.query("select folio, fecha_limite_respuesta from disputa.refunds where status in ('NEW','NOTIFIED') and fecha_limite_respuesta < current_date order by fecha_limite_respuesta asc limit 5000")).rows;
    const dups = (await db.query("select folio, fecha_limite_respuesta from disputa.duplicates where status in ('NEW','NOTIFIED') and fecha_limite_respuesta < current_date order by fecha_limite_respuesta asc limit 5000")).rows;
    const headers = ['Tipo', 'Folio', 'Fecha límite', 'Estado', 'Marca', 'Ciclo'];
    const data = [
      ...cbs.map(r => ['CB', r.folio, D.fechaISO(r.fecha_limite_comercio), r.status, r.brand, r.cycle]),
      ...refs.map(r => ['REFUND', r.folio, D.fechaISO(r.fecha_limite_respuesta), 'NOTIFIED', '', '']),
      ...dups.map(r => ['DUPLICATE', r.folio, D.fechaISO(r.fecha_limite_respuesta), 'NOTIFIED', '', '']),
    ];
    const fname = `disputas_vencidos_${new Date().toISOString().slice(0, 10)}`;
    if ((f.formato || 'csv') === 'xlsx') return xlsxResponse(res, fname + '.xlsx', 'Vencidos', headers, data);
    csvResponse(res, fname + '.csv', headers, data);
  });

  // 6) Ratio de ganancia (por comercio, por red).
  app.get('/api/disputa/reports/ratio', auth, async (req, res) => {
    const f = req.query || {};
    const { where, vals } = condsCB(f);
    const q = `
      select coalesce(m.nombre, '(sin comercio)') as mnom, m.nombre_cifrado as mnomcif, coalesce(cb.brand, 'OTHER') as brand,
             count(*)::int as total,
             sum(case when cb.status='WON' then 1 else 0 end)::int as ganados,
             sum(case when cb.status='LOST' then 1 else 0 end)::int as perdidos
      from disputa.chargebacks cb
      left join disputa.merchants m on cb.merchant_id=m.id
      ${where}
      group by m.nombre, m.nombre_cifrado, cb.brand
      order by ganados desc, total desc`;
    const rows = (await db.query(q, vals)).rows;
    const headers = ['Comercio', 'Marca', 'Total', 'Ganados', 'Perdidos', 'Ratio ganancia'];
    const data = rows.map(r => {
      const rel = r.ganados + r.perdidos;
      const ratio = rel ? Math.round((r.ganados / rel) * 100) : null;
      return [C.decryptString(r.mnomcif) || r.mnom, r.brand, r.total, r.ganados, r.perdidos, ratio != null ? ratio + '%' : 'sin resueltos'];
    });
    const fname = `disputas_ratio_${new Date().toISOString().slice(0, 10)}`;
    if ((f.formato || 'csv') === 'xlsx') return xlsxResponse(res, fname + '.xlsx', 'Ratio ganancia', headers, data);
    csvResponse(res, fname + '.csv', headers, data);
  });
};
