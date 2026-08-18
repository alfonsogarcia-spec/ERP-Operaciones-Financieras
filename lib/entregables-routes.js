/* ============================================================================
   lib/entregables-routes.js — Portal de solicitudes internas.
   Otras áreas envían solicitudes basadas en procedimientos POL-OP-P##
   con formatos POL-OP-F##. Operaciones ejecuta y aprueba.
   ========================================================================= */
'use strict';

function mountEntregablesRoutes(app, deps) {
  const { auth, requiereRol, bit, db, C, upload } = deps;
  const { CATALOGO } = require('./entregables-catalogo.js');

  // Seed: garantiza que los tipos del catálogo existen en BD.
  async function seedTipos() {
    try {
      for (const t of CATALOGO) {
        const existe = (await db.query('select id from entregables_tipos where codigo=$1', [t.codigo])).rows[0];
        if (existe) {
          await db.query('update entregables_tipos set nombre=$1, descripcion=$2, form_schema=$3, sla_dias=$4 where id=$5',
            [t.nombre, t.descripcion || null, JSON.stringify(t.form_schema || {}), t.sla_dias || 3, existe.id]);
        } else {
          await db.query(
            `insert into entregables_tipos(codigo, producto, nombre, descripcion, form_schema, sla_dias, activo)
             values($1, 'agregador', $2, $3, $4, $5, true)`,
            [t.codigo, t.nombre, t.descripcion || null, JSON.stringify(t.form_schema || {}), t.sla_dias || 3]
          );
        }
      }
    } catch (e) { console.warn('[entregables] seed error:', e.message); }
  }
  // Corre el seed diferido para que la BD esté ya inicializada.
  // Reintenta cada 3s hasta lograrlo (best-effort, no bloqueante).
  let intentos = 0;
  const tryseed = async () => {
    try {
      if (!db.isReady || !db.isReady()) { if (++intentos < 20) return setTimeout(tryseed, 3000); }
      await seedTipos();
    } catch (e) { if (++intentos < 20) setTimeout(tryseed, 3000); }
  };
  setTimeout(tryseed, 2000);

  async function folio() {
    const y = new Date().getFullYear();
    const r = await db.query("select coalesce(max(cast(substring(folio from 10) as integer)),0) as m from entregables_solicitudes where folio like $1", [`ENT-${y}-%`]);
    return 'ENT-' + y + '-' + String((r.rows[0].m || 0) + 1).padStart(6, '0');
  }

  /* -------------------------- CATÁLOGO DE TIPOS ------------------------- */
  app.get('/api/entregables/tipos', auth, async (req, res) => {
    const producto = req.query.producto;
    const conds = ['activo=true'], vals = [];
    if (producto) { vals.push(String(producto)); conds.push(`producto=$${vals.length}`); }
    const rows = (await db.query('select id, codigo, producto, nombre, descripcion, form_schema, sla_dias, plantilla_nombre from entregables_tipos where ' + conds.join(' and ') + ' order by codigo', vals)).rows;
    res.json(rows);
  });

  app.get('/api/entregables/tipos/:id', auth, async (req, res) => {
    const t = (await db.query('select id, codigo, producto, nombre, descripcion, form_schema, sla_dias, plantilla_nombre from entregables_tipos where id=$1', [parseInt(req.params.id, 10)])).rows[0];
    if (!t) return res.status(404).json({ error: 'no_existe' });
    res.json(t);
  });

  // Descargar plantilla original (docx/pdf) del tipo, si existe.
  app.get('/api/entregables/tipos/:id/plantilla', auth, async (req, res) => {
    const t = (await db.query('select plantilla_nombre, plantilla_bytes, plantilla_mime from entregables_tipos where id=$1', [parseInt(req.params.id, 10)])).rows[0];
    if (!t || !t.plantilla_bytes) return res.status(404).json({ error: 'sin_plantilla' });
    res.setHeader('Content-Type', t.plantilla_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + (t.plantilla_nombre || 'plantilla') + '"');
    res.end(Buffer.isBuffer(t.plantilla_bytes) ? t.plantilla_bytes : Buffer.from(t.plantilla_bytes));
  });

  /* -------------------------- SOLICITUDES ------------------------------- */
  app.get('/api/entregables/solicitudes', auth, async (req, res) => {
    const f = req.query || {};
    const conds = [], vals = [];
    if (f.producto)   { vals.push(String(f.producto));   conds.push(`producto=$${vals.length}`); }
    if (f.estado)     { vals.push(String(f.estado));     conds.push(`estado=$${vals.length}`); }
    if (f.tipo_id)    { vals.push(parseInt(f.tipo_id,10)); conds.push(`tipo_id=$${vals.length}`); }
    if (f.mias === 'true' && req.user.id) { vals.push(req.user.id); conds.push(`solicitante_id=$${vals.length}`); }
    const where = conds.length ? ' where ' + conds.join(' and ') : '';
    const rows = (await db.query(
      `select s.id, s.folio, s.tipo_id, s.producto, s.titulo, s.estado, s.prioridad, s.fecha_limite::text as fecha_limite, s.fecha_cierre, s.creado_at,
              s.solicitante_area, u1.nombre as solicitante_nombre, u2.nombre as ejecutor_nombre, t.codigo as tipo_codigo, t.nombre as tipo_nombre
         from entregables_solicitudes s
         left join usuarios u1 on u1.id = s.solicitante_id
         left join usuarios u2 on u2.id = s.ejecutor_id
         left join entregables_tipos t on t.id = s.tipo_id
        ${where}
        order by s.id desc limit 500`, vals)).rows;
    res.json(rows);
  });

  app.get('/api/entregables/solicitudes/:id', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const s = (await db.query(
      `select s.*, s.fecha_limite::text as fecha_limite, u1.nombre as solicitante_nombre, u2.nombre as ejecutor_nombre, u3.nombre as aprobador_nombre,
              t.codigo as tipo_codigo, t.nombre as tipo_nombre, t.form_schema as tipo_form_schema
         from entregables_solicitudes s
         left join usuarios u1 on u1.id = s.solicitante_id
         left join usuarios u2 on u2.id = s.ejecutor_id
         left join usuarios u3 on u3.id = s.aprobador_id
         left join entregables_tipos t on t.id = s.tipo_id
        where s.id=$1`, [id])).rows[0];
    if (!s) return res.status(404).json({ error: 'no_existe' });
    const adj = (await db.query('select id, filename, mime, bytes_size, descripcion, subido_por, subido_at from entregables_adjuntos where solicitud_id=$1 order by subido_at desc', [id])).rows;
    const act = (await db.query('select id, ts, actor, tipo, estado_ant, estado_nvo, detalle from entregables_actividad where solicitud_id=$1 order by ts asc, id asc', [id])).rows;
    res.json({ ...s, adjuntos: adj, actividad: act });
  });

  app.post('/api/entregables/solicitudes', auth, async (req, res) => {
    const b = req.body || {};
    const tipo_id = parseInt(b.tipo_id, 10);
    if (!tipo_id) return res.status(400).json({ error: 'tipo_id_requerido' });
    const t = (await db.query('select codigo, producto, nombre, sla_dias from entregables_tipos where id=$1', [tipo_id])).rows[0];
    if (!t) return res.status(400).json({ error: 'tipo_no_existe' });
    const titulo = String(b.titulo || t.nombre).slice(0, 200);
    const datos = b.datos && typeof b.datos === 'object' ? b.datos : {};
    const prioridad = ['baja','media','alta','urgente'].includes(b.prioridad) ? b.prioridad : 'media';
    const fol = await folio();
    // Fecha límite = SLA días desde hoy
    const flim = new Date(); flim.setDate(flim.getDate() + (t.sla_dias || 3));
    const r = await db.query(
      `insert into entregables_solicitudes(folio, tipo_id, producto, titulo, datos, solicitante_id, solicitante_area, estado, prioridad, fecha_limite)
       values($1,$2,$3,$4,$5,$6,$7,'nueva',$8,$9) returning id`,
      [fol, tipo_id, t.producto, titulo, JSON.stringify(datos), req.user.id || null, b.solicitante_area || null, prioridad, flim.toISOString().slice(0, 10)]
    );
    const id = r.rows[0].id;
    await db.query("insert into entregables_actividad(solicitud_id, actor, tipo, estado_nvo, detalle) values($1,$2,'created','nueva',$3)",
      [id, req.user.nombre, 'Solicitud creada · ' + t.codigo]);
    await bit(req, 'entregable_alta', `folio=${fol} tipo=${t.codigo}`, { resource_type: 'entregable', resource_id: id });
    res.json({ ok: true, id, folio: fol });
  });

  app.post('/api/entregables/solicitudes/:id/status', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const s = (await db.query('select estado from entregables_solicitudes where id=$1', [id])).rows[0];
    if (!s) return res.status(404).json({ error: 'no_existe' });
    const validos = ['nueva','aceptada','en_ejecucion','requiere_info','validacion','aprobada','rechazada','cancelada'];
    const nuevo = String((req.body || {}).estado || '').toLowerCase();
    if (!validos.includes(nuevo)) return res.status(400).json({ error: 'estado_invalido' });
    const fecha_cierre = ['aprobada','rechazada','cancelada'].includes(nuevo) ? new Date() : null;
    // Cuando pasa a "aceptada" o "en_ejecucion" y no hay ejecutor asignado, se asigna al usuario actual.
    const asignar = ['aceptada','en_ejecucion'].includes(nuevo) ? req.user.id : null;
    await db.query(
      `update entregables_solicitudes set estado=$1, fecha_cierre=coalesce($2, fecha_cierre), ejecutor_id=coalesce($3, ejecutor_id), actualizado_at=now() where id=$4`,
      [nuevo, fecha_cierre, asignar, id]
    );
    await db.query("insert into entregables_actividad(solicitud_id, actor, tipo, estado_ant, estado_nvo, detalle) values($1,$2,'status_change',$3,$4,$5)",
      [id, req.user.nombre, s.estado, nuevo, (req.body || {}).nota || null]);
    await bit(req, 'entregable_status', `${s.estado}→${nuevo}`, { resource_type: 'entregable', resource_id: id });
    res.json({ ok: true, estado: nuevo });
  });

  app.post('/api/entregables/solicitudes/:id/comentario', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const texto = String((req.body || {}).texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'texto' });
    await db.query("insert into entregables_actividad(solicitud_id, actor, tipo, detalle) values($1,$2,'comment',$3)",
      [id, req.user.nombre, texto]);
    res.json({ ok: true });
  });

  /* -------------------------- ADJUNTOS ---------------------------------- */
  app.post('/api/entregables/solicitudes/:id/adjuntos', auth, upload.single('archivo'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!req.file) return res.status(400).json({ error: 'sin_archivo' });
    const cifrado = C && C.encrypt ? C.encrypt(req.file.buffer.toString('base64')) : req.file.buffer.toString('base64');
    await db.query(
      'insert into entregables_adjuntos(solicitud_id, filename, mime, bytes_size, bytes_cifrado, descripcion, subido_por) values($1,$2,$3,$4,$5,$6,$7)',
      [id, req.file.originalname, req.file.mimetype, req.file.size, Buffer.from(cifrado), (req.body || {}).descripcion || null, req.user.nombre]
    );
    await db.query("insert into entregables_actividad(solicitud_id, actor, tipo, detalle) values($1,$2,'attach',$3)",
      [id, req.user.nombre, 'Adjuntó ' + req.file.originalname]);
    res.json({ ok: true });
  });

  app.get('/api/entregables/adjuntos/:id/download', auth, async (req, res) => {
    const a = (await db.query('select filename, mime, bytes_cifrado from entregables_adjuntos where id=$1', [parseInt(req.params.id, 10)])).rows[0];
    if (!a) return res.status(404).json({ error: 'no_existe' });
    let buf;
    try {
      const raw = Buffer.isBuffer(a.bytes_cifrado) ? a.bytes_cifrado.toString('utf8') : String(a.bytes_cifrado);
      const b64 = C && C.decrypt ? C.decrypt(raw).toString() : raw;
      buf = Buffer.from(b64, 'base64');
    } catch (e) { return res.status(500).json({ error: 'descifrado_fallo' }); }
    res.setHeader('Content-Type', a.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + (a.filename || 'adjunto') + '"');
    res.end(buf);
  });

  /* -------------------------- KPIS -------------------------------------- */
  app.get('/api/entregables/kpis', auth, async (req, res) => {
    const q = async sql => (await db.query(sql)).rows[0];
    const nuevas = await q("select count(*)::int as n from entregables_solicitudes where estado='nueva'");
    const en_curso = await q("select count(*)::int as n from entregables_solicitudes where estado in ('aceptada','en_ejecucion','requiere_info','validacion')");
    const mias = req.user.id ? await q("select count(*)::int as n from entregables_solicitudes where solicitante_id=" + parseInt(req.user.id,10)) : { n: 0 };
    const vencidas = await q("select count(*)::int as n from entregables_solicitudes where estado not in ('aprobada','rechazada','cancelada') and fecha_limite < current_date");
    res.json({ nuevas: nuevas.n, en_curso: en_curso.n, mias: mias.n, vencidas: vencidas.n });
  });
}

module.exports = { mountEntregablesRoutes };
