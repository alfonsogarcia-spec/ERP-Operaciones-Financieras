/* ============================================================================
   lib/tareas-routes.js — Endpoints del microsistema de Tareas de Operaciones.
   Se monta desde server.js con mountTareasRoutes(app, deps).
   deps: { auth, requiereRol, bit, db }
   ========================================================================= */
'use strict';

function folioTSK(anio, n) {
  return 'TSK-' + anio + '-' + String(n).padStart(6, '0');
}

async function siguienteFolio(db) {
  const y = new Date().getFullYear();
  const r = await db.query("select coalesce(max(cast(substring(folio from 10) as integer)), 0) as m from tareas_tickets where folio like $1", [`TSK-${y}-%`]);
  return folioTSK(y, (r.rows[0].m || 0) + 1);
}

async function enriquecerTicket(row, db) {
  const t = { ...row };
  if (row.responsable_id) {
    const u = (await db.query('select nombre, email from usuarios where id=$1', [row.responsable_id])).rows[0];
    if (u) { t.responsable_nombre = u.nombre; t.responsable_email = u.email; }
  }
  if (row.solicitante_id) {
    const u = (await db.query('select nombre from usuarios where id=$1', [row.solicitante_id])).rows[0];
    if (u) t.solicitante_nombre = u.nombre;
  }
  if (row.aprobador_id) {
    const u = (await db.query('select nombre from usuarios where id=$1', [row.aprobador_id])).rows[0];
    if (u) t.aprobador_nombre = u.nombre;
  }
  return t;
}

function mountTareasRoutes(app, deps) {
  const { auth, requiereRol, bit, db, X } = deps;

  /* ------------------------------- LISTA -------------------------------- */
  app.get('/api/tareas/tickets', auth, async (req, res) => {
    const f = req.query || {};
    const conds = ['archivado=false'], vals = [];
    if (f.producto)      { vals.push(String(f.producto)); conds.push(`producto=$${vals.length}`); }
    if (f.tipo)          { vals.push(String(f.tipo));     conds.push(`tipo=$${vals.length}`); }
    if (f.estado)        { vals.push(String(f.estado));   conds.push(`estado=$${vals.length}`); }
    if (f.responsable_id){ vals.push(parseInt(f.responsable_id, 10)); conds.push(`responsable_id=$${vals.length}`); }
    if (f.mias === 'true' && req.user && req.user.id) { vals.push(req.user.id); conds.push(`responsable_id=$${vals.length}`); }
    if (f.q)             { vals.push('%' + String(f.q).trim() + '%'); conds.push(`(folio ilike $${vals.length} or titulo ilike $${vals.length})`); }
    const where = ' where ' + conds.join(' and ');
    const rows = (await db.query('select * from tareas_tickets' + where + ' order by fecha_limite nulls last, id desc limit 500', vals)).rows;
    const out = [];
    for (const r of rows) out.push(await enriquecerTicket(r, db));
    res.json(out);
  });

  /* --------------------------- DETALLE ---------------------------------- */
  app.get('/api/tareas/tickets/:id', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = (await db.query('select * from tareas_tickets where id=$1', [id])).rows[0];
    if (!t) return res.status(404).json({ error: 'no_existe' });
    const subtareas = (await db.query('select * from tareas_subtareas where ticket_id=$1 order by orden, id', [id])).rows;
    const actividad = (await db.query('select * from tareas_actividad where ticket_id=$1 order by ts asc, id asc', [id])).rows;
    const det = await enriquecerTicket(t, db);
    res.json({ ...det, subtareas, actividad });
  });

  /* ---------------------------- ALTA ------------------------------------ */
  app.post('/api/tareas/tickets', auth, async (req, res) => {
    const b = req.body || {};
    if (!b.titulo) return res.status(400).json({ error: 'titulo_requerido' });
    const folio = await siguienteFolio(db);
    const productos = ['emisor','spei','agregador','contabilidad','sistema','transversal'];
    const producto = productos.includes(b.producto) ? b.producto : 'agregador';
    const tipos = ['diaria','semanal','mensual','unica','entregable'];
    const tipo = tipos.includes(b.tipo) ? b.tipo : 'unica';
    const prioridades = ['baja','media','alta','urgente'];
    const prioridad = prioridades.includes(b.prioridad) ? b.prioridad : 'media';
    const responsable_id = b.responsable_id ? parseInt(b.responsable_id, 10) : null;
    const aprobador_id   = b.aprobador_id   ? parseInt(b.aprobador_id, 10)   : null;
    const fecha_inicio = b.fecha_inicio && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_inicio) ? b.fecha_inicio : null;
    const fecha_limite = b.fecha_limite && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_limite) ? b.fecha_limite : null;
    const etiquetas = Array.isArray(b.etiquetas) ? b.etiquetas : [];
    const r = await db.query(
      `insert into tareas_tickets(folio, titulo, descripcion, producto, tipo, prioridad, estado,
         responsable_id, solicitante_id, fecha_inicio, fecha_limite, hora_limite,
         aprobador_id, estado_aprobacion, etiquetas, creado_por)
       values($1,$2,$3,$4,$5,$6,'backlog',$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [folio, String(b.titulo).trim(), b.descripcion || null, producto, tipo, prioridad,
       responsable_id, req.user.id || null, fecha_inicio, fecha_limite, b.hora_limite || null,
       aprobador_id, tipo === 'entregable' ? 'pendiente' : null, JSON.stringify(etiquetas), req.user.nombre]
    );
    const id = r.rows[0].id;
    await db.query("insert into tareas_actividad(ticket_id, actor, tipo, estado_nvo, detalle) values($1,$2,'created','backlog',$3)",
      [id, req.user.nombre, 'Ticket creado']);
    await bit(req, 'tarea_alta', `folio=${folio}`, { resource_type: 'tarea', resource_id: id });
    res.json({ ok: true, id, folio });
  });

  /* -------------------------- CAMBIO DE ESTADO -------------------------- */
  app.post('/api/tareas/tickets/:id/status', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = (await db.query('select estado from tareas_tickets where id=$1', [id])).rows[0];
    if (!t) return res.status(404).json({ error: 'no_existe' });
    const validos = ['backlog','por_hacer','en_curso','en_revision','bloqueado','terminado','cancelado'];
    const nuevo = String((req.body || {}).estado || '').toLowerCase();
    if (!validos.includes(nuevo)) return res.status(400).json({ error: 'estado_invalido' });
    const fecha_cierre = ['terminado','cancelado'].includes(nuevo) ? new Date() : null;
    await db.query('update tareas_tickets set estado=$1, fecha_cierre=coalesce($2, fecha_cierre), actualizado_at=now() where id=$3',
      [nuevo, fecha_cierre, id]);
    await db.query("insert into tareas_actividad(ticket_id, actor, tipo, estado_ant, estado_nvo) values($1,$2,'status_change',$3,$4)",
      [id, req.user.nombre, t.estado, nuevo]);
    await bit(req, 'tarea_status', `${t.estado}→${nuevo}`, { resource_type: 'tarea', resource_id: id });
    res.json({ ok: true, estado: nuevo });
  });

  /* --------------------------- COMENTARIO ------------------------------- */
  app.post('/api/tareas/tickets/:id/comentario', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const texto = String((req.body || {}).texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'texto' });
    await db.query("insert into tareas_actividad(ticket_id, actor, tipo, detalle) values($1,$2,'comment',$3)",
      [id, req.user.nombre, texto]);
    res.json({ ok: true });
  });

  /* --------------------------- SUBTAREAS -------------------------------- */
  app.post('/api/tareas/tickets/:id/subtareas', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const texto = String((req.body || {}).texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'texto' });
    const orden = ((await db.query('select coalesce(max(orden),0)+1 as o from tareas_subtareas where ticket_id=$1', [id])).rows[0].o) || 1;
    const r = await db.query('insert into tareas_subtareas(ticket_id, texto, orden) values($1,$2,$3) returning id', [id, texto, orden]);
    res.json({ ok: true, id: r.rows[0].id });
  });
  app.patch('/api/tareas/subtareas/:id', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    if (typeof b.done === 'boolean') await db.query('update tareas_subtareas set done=$1 where id=$2', [b.done, id]);
    if (typeof b.texto === 'string') await db.query('update tareas_subtareas set texto=$1 where id=$2', [b.texto, id]);
    res.json({ ok: true });
  });

  /* --------------------------- KPIS DEL PANEL --------------------------- */
  app.get('/api/tareas/kpis', auth, async (req, res) => {
    const producto = req.query.producto;
    const cond = producto ? " and producto='" + String(producto).replace(/'/g,'') + "'" : '';
    const abiertas = (await db.query("select count(*)::int as n from tareas_tickets where archivado=false and estado not in ('terminado','cancelado')" + cond)).rows[0].n;
    const vencidas = (await db.query("select count(*)::int as n from tareas_tickets where archivado=false and estado not in ('terminado','cancelado') and fecha_limite < current_date" + cond)).rows[0].n;
    const por_vencer = (await db.query("select count(*)::int as n from tareas_tickets where archivado=false and estado not in ('terminado','cancelado') and fecha_limite between current_date and current_date+7" + cond)).rows[0].n;
    const cerradas_mes = (await db.query("select count(*)::int as n from tareas_tickets where fecha_cierre >= date_trunc('month', current_date)" + cond)).rows[0].n;
    res.json({ abiertas, vencidas, por_vencer, cerradas_mes });
  });

  /* --------------------------- SEED DE DEMO ----------------------------- */
  // Da de alta 7 rutinas + 6 tickets únicos/entregables demo para probar.
  // Idempotente: si ya hay tickets, no toca nada.
  app.post('/api/tareas/seed-demo', auth, requiereRol('admin'), async (req, res) => {
    const yaHay = (await db.query('select count(*)::int as n from tareas_tickets')).rows[0].n;
    if (yaHay > 0) return res.json({ ok: false, motivo: 'ya_hay_tickets', total: yaHay });
    const uid = req.user.id;
    const hoyISO = new Date().toISOString().slice(0, 10);
    const en = (dias) => { const d = new Date(); d.setDate(d.getDate() + dias); return d.toISOString().slice(0, 10); };
    const y = new Date().getFullYear();
    const insTk = async (folio, titulo, tipo, producto, prioridad, estado, fecha_limite, hora_limite, descripcion) => {
      await db.query(
        `insert into tareas_tickets(folio, titulo, descripcion, producto, tipo, prioridad, estado, responsable_id, solicitante_id, fecha_limite, hora_limite, creado_por)
         values($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)`,
        [folio, titulo, descripcion || null, producto, tipo, prioridad, estado, uid, fecha_limite, hora_limite, req.user.nombre]);
    };
    let n = 1;
    // Rutinas diarias del día (instancias del día)
    await insTk(folioTSK(y, n++), 'Cargar reporte de contracargos', 'diaria', 'agregador', 'alta', 'terminado', hoyISO, '06:00', 'Rutina 06:00');
    await insTk(folioTSK(y, n++), 'Revisar bandeja de disputas',  'diaria', 'agregador', 'media', 'terminado', hoyISO, '08:00', null);
    await insTk(folioTSK(y, n++), 'Generar corte del día anterior','diaria', 'agregador', 'alta', 'terminado', hoyISO, '09:00', null);
    await insTk(folioTSK(y, n++), 'Validar cuadre de corte',       'diaria', 'agregador', 'media', 'terminado', hoyISO, '10:00', null);
    await insTk(folioTSK(y, n++), 'Dispersar layout SPEI',         'diaria', 'agregador', 'urgente','en_curso', hoyISO, '11:00', 'Vencía a las 11:00');
    await insTk(folioTSK(y, n++), 'Notificar corte a clientes',    'diaria', 'agregador', 'media', 'por_hacer', hoyISO, '13:00', null);
    await insTk(folioTSK(y, n++), 'Cierre semanal contabilidad · sem. 33', 'semanal', 'contabilidad', 'media', 'por_hacer', hoyISO, null, null);
    // Únicas / entregables
    await insTk(folioTSK(y, n++), 'Corte extraordinario para Grupo SFI', 'unica', 'agregador', 'alta', 'por_hacer', en(3), null, 'Solicitud de Dirección: movimiento retroactivo.');
    await insTk(folioTSK(y, n++), 'Investigar 3 devoluciones sospechosas vencidas', 'unica', 'agregador', 'urgente', 'en_curso', en(1), null, null);
    await insTk(folioTSK(y, n++), 'Informe mensual SLA de contracargos', 'entregable', 'agregador', 'alta', 'en_curso', en(8), null, 'Consolidado mensual del cumplimiento SLA por marca, ciclo y motivo.');
    await insTk(folioTSK(y, n++), 'Informe dispersión julio 2026', 'entregable', 'agregador', 'alta', 'en_revision', en(5), null, null);
    await insTk(folioTSK(y, n++), 'Alta de nuevo grupo cliente "Copacabana"', 'unica', 'agregador', 'media', 'bloqueado', en(10), null, 'Bloqueado: esperando comprobante fiscal.');
    await insTk(folioTSK(y, n++), 'Facturación mensual · agosto', 'mensual', 'contabilidad', 'alta', 'backlog', en(15), null, null);
    res.json({ ok: true, creados: n - 1 });
  });

  /* ============================================================================
     MIEMBROS · gestión de usuarios del workspace de Tareas Ops (rol + productos)
     ============================================================================ */
  const PRODUCTOS_VALIDOS = ['emisor', 'spei', 'agregador', 'contabilidad', 'sistema', 'transversal'];
  const ROLES_TAREAS      = ['direccion', 'coordinacion', 'operador', 'consulta'];

  app.get('/api/tareas/miembros', auth, async (_req, res) => {
    const rows = (await db.query(
      `select m.usuario_id, m.rol_tareas, m.productos, m.activo, m.agregado_at,
              u.nombre, u.email, u.rol as rol_sistema
         from tareas_miembros m
         join usuarios u on u.id = m.usuario_id
        order by m.activo desc, u.nombre`
    )).rows;
    res.json(rows);
  });

  // Lista de candidatos por producto (para selectores de ejecutor/aprobador).
  //   /api/tareas/miembros/producto/agregador?capacidad=ejecutor|aprobador
  app.get('/api/tareas/miembros/producto/:producto', auth, async (req, res) => {
    const producto = String(req.params.producto || '').toLowerCase();
    if (!PRODUCTOS_VALIDOS.includes(producto)) return res.status(400).json({ error: 'producto_invalido' });
    const cap = req.query.capacidad === 'aprobador' ? 'aprobador' : 'ejecutor';
    const roles = cap === 'aprobador' ? ['direccion', 'coordinacion'] : ['direccion', 'coordinacion', 'operador'];
    const rows = (await db.query(
      `select m.usuario_id as id, u.nombre, u.email, m.rol_tareas
         from tareas_miembros m
         join usuarios u on u.id = m.usuario_id
        where m.activo = true
          and u.activo = true
          and (m.productos ? $1 or m.productos ? 'transversal')
          and m.rol_tareas = any($2::text[])
        order by u.nombre`,
      [producto, roles]
    )).rows;
    res.json(rows);
  });

  app.post('/api/tareas/miembros', auth, requiereRol('admin'), async (req, res) => {
    const b = req.body || {};
    const usuario_id = parseInt(b.usuario_id, 10);
    if (!usuario_id) return res.status(400).json({ error: 'usuario_id_requerido' });
    const rol = ROLES_TAREAS.includes(b.rol_tareas) ? b.rol_tareas : 'operador';
    const productos = Array.isArray(b.productos)
      ? b.productos.filter(p => PRODUCTOS_VALIDOS.includes(p))
      : [];
    const activo = b.activo === false ? false : true;
    const u = (await db.query('select id, nombre from usuarios where id=$1', [usuario_id])).rows[0];
    if (!u) return res.status(404).json({ error: 'usuario_no_existe' });
    await db.query(
      `insert into tareas_miembros(usuario_id, rol_tareas, productos, activo)
         values($1, $2, $3::jsonb, $4)
       on conflict (usuario_id) do update
         set rol_tareas = excluded.rol_tareas,
             productos  = excluded.productos,
             activo     = excluded.activo`,
      [usuario_id, rol, JSON.stringify(productos), activo]
    );
    if (bit) await bit(req, 'miembro.upsert', { usuario_id, rol, productos, activo });
    res.json({ ok: true });
  });

  app.delete('/api/tareas/miembros/:usuario_id', auth, requiereRol('admin'), async (req, res) => {
    const id = parseInt(req.params.usuario_id, 10);
    if (!id) return res.status(400).json({ error: 'id_invalido' });
    await db.query('delete from tareas_miembros where usuario_id=$1', [id]);
    if (bit) await bit(req, 'miembro.delete', { usuario_id: id });
    res.json({ ok: true });
  });

  /* ============================================================================
     REPORTES · KPIs de cumplimiento por producto (Sprint D)
     ============================================================================ */
  async function computarReporte(producto, desde, hasta) {

    // WHEREs parametrizados para no romper el pool ni escapar mal.
    const wTk = [], vTk = [];
    if (producto) { vTk.push(producto); wTk.push(`producto=$${vTk.length}`); }
    if (desde)    { vTk.push(desde);    wTk.push(`fecha_limite >= $${vTk.length}`); }
    if (hasta)    { vTk.push(hasta);    wTk.push(`fecha_limite <= $${vTk.length}`); }
    const whereTk = wTk.length ? ' where ' + wTk.join(' and ') : '';
    const wEn = [], vEn = [];
    if (producto) { vEn.push(producto); wEn.push(`s.producto=$${vEn.length}`); }
    if (desde)    { vEn.push(desde);    wEn.push(`s.creado_at::date >= $${vEn.length}`); }
    if (hasta)    { vEn.push(hasta);    wEn.push(`s.creado_at::date <= $${vEn.length}`); }
    const whereEn = wEn.length ? ' where ' + wEn.join(' and ') : '';

    // Rutinas / tareas
    const tk = (await db.query(
      `select count(*)::int as total,
              coalesce(sum(case when estado='hecho' then 1 else 0 end),0)::int as hechas,
              coalesce(sum(case when estado in ('por_hacer','backlog') then 1 else 0 end),0)::int as por_hacer,
              coalesce(sum(case when estado in ('en_curso','en_revision') then 1 else 0 end),0)::int as en_curso,
              coalesce(sum(case when estado='bloqueado' then 1 else 0 end),0)::int as bloqueadas,
              coalesce(sum(case when estado not in ('hecho') and fecha_limite is not null and fecha_limite < current_date then 1 else 0 end),0)::int as vencidas
         from tareas_tickets` + whereTk, vTk
    )).rows[0];

    // Entregables
    const en = (await db.query(
      `select count(*)::int as total,
              coalesce(sum(case when s.estado='aprobada' then 1 else 0 end),0)::int as aprobadas,
              coalesce(sum(case when s.estado='rechazada' then 1 else 0 end),0)::int as rechazadas,
              coalesce(sum(case when s.estado in ('nueva','aceptada','en_ejecucion','requiere_info','validacion') then 1 else 0 end),0)::int as en_curso,
              coalesce(sum(case when s.estado='cancelada' then 1 else 0 end),0)::int as canceladas,
              coalesce(sum(case when s.estado not in ('aprobada','rechazada','cancelada') and s.fecha_limite < current_date then 1 else 0 end),0)::int as vencidas,
              coalesce(sum(case when s.estado='aprobada' and s.fecha_cierre::date <= s.fecha_limite then 1 else 0 end),0)::int as sla_cumplido
         from entregables_solicitudes s` + whereEn, vEn
    )).rows[0];

    // Aprobación en primera vuelta = aprobadas cuyo historial NO tocó requiere_info/rechazada.
    const primeraVuelta = (await db.query(
      `select count(*)::int as n
         from entregables_solicitudes s
        where s.estado='aprobada'
          ${whereEn ? 'and ' + whereEn.replace(/^ where /, '') : ''}
          and not exists (
            select 1 from entregables_actividad a
             where a.solicitud_id = s.id
               and a.tipo='status_change'
               and (a.estado_nvo='requiere_info' or a.estado_nvo='rechazada')
          )`, vEn
    )).rows[0];

    // Top ejecutores (por entregables cerrados)
    const topEj = (await db.query(
      `select u.nombre, u.email, count(*)::int as n
         from entregables_solicitudes s
         join usuarios u on u.id = s.ejecutor_id
        ${whereEn} ${whereEn ? 'and' : 'where'} s.ejecutor_id is not null
        group by u.nombre, u.email
        order by n desc, u.nombre
        limit 5`, vEn
    )).rows;

    // Top áreas solicitantes
    const topAr = (await db.query(
      `select coalesce(nullif(s.solicitante_area,''),'—') as area, count(*)::int as n
         from entregables_solicitudes s
        ${whereEn}
        group by 1 order by n desc limit 5`, vEn
    )).rows;

    // Distribución de rutinas por producto (para gráfico rápido)
    const porProducto = (await db.query(
      `select producto, count(*)::int as n
         from tareas_tickets` + (desde || hasta ? whereTk : '') + `
        group by producto order by n desc`, (desde || hasta) ? vTk : []
    )).rows;

    const slaPct = en.total > 0 ? Math.round((en.sla_cumplido / en.total) * 100) : null;
    const pvPct  = en.aprobadas > 0 ? Math.round((primeraVuelta.n / en.aprobadas) * 100) : null;

    return {
      producto, desde, hasta,
      rutinas: tk,
      entregables: { ...en, primera_vuelta: primeraVuelta.n, sla_pct: slaPct, primera_vuelta_pct: pvPct },
      top_ejecutores: topEj,
      top_areas: topAr,
      por_producto: porProducto,
    };
  }

  app.get('/api/tareas/reportes', auth, async (req, res) => {
    const producto = req.query.producto ? String(req.query.producto) : null;
    const desde = req.query.desde ? String(req.query.desde) : null;
    const hasta = req.query.hasta ? String(req.query.hasta) : null;
    const data = await computarReporte(producto, desde, hasta);
    res.json(data);
  });

  app.get('/api/tareas/reportes.xlsx', auth, async (req, res) => {
    if (!X || !X.buildXLSX) return res.status(500).json({ error: 'excel_no_disponible' });
    const producto = req.query.producto ? String(req.query.producto) : null;
    const desde = req.query.desde ? String(req.query.desde) : null;
    const hasta = req.query.hasta ? String(req.query.hasta) : null;
    const d = await computarReporte(producto, desde, hasta);
    const pct = v => v == null ? '—' : (v + '%');
    const filtroTxt = `${producto || 'Todos los productos'} · ${desde || 'sin inicio'} → ${hasta || 'sin fin'}`;

    // Sheet 1 — Resumen
    const resumen = [
      ['REPORTE DE OPERACIONES · KPIs'],
      ['Filtro', filtroTxt],
      ['Generado', new Date().toISOString().replace('T',' ').slice(0,19) + ' UTC'],
      [],
      ['Rutinas y tareas'],
      ['Métrica', 'Valor'],
      ['Total',        d.rutinas.total],
      ['Hechas',       d.rutinas.hechas],
      ['Por hacer',    d.rutinas.por_hacer],
      ['En curso',     d.rutinas.en_curso],
      ['Bloqueadas',   d.rutinas.bloqueadas],
      ['Vencidas',     d.rutinas.vencidas],
      [],
      ['Entregables'],
      ['Métrica', 'Valor'],
      ['Total',              d.entregables.total],
      ['Aprobadas',          d.entregables.aprobadas],
      ['Rechazadas',         d.entregables.rechazadas],
      ['En curso',           d.entregables.en_curso],
      ['Canceladas',         d.entregables.canceladas],
      ['Vencidas',           d.entregables.vencidas],
      ['SLA cumplido',       d.entregables.sla_cumplido],
      ['% cumplimiento SLA', pct(d.entregables.sla_pct)],
      ['Aprobación 1ª vuelta', d.entregables.primera_vuelta],
      ['% aprobación 1ª vuelta', pct(d.entregables.primera_vuelta_pct)],
    ];

    // Sheet 2 — Top ejecutores
    const topEj = [['Nombre', 'Correo', 'Entregables']];
    (d.top_ejecutores || []).forEach(u => topEj.push([u.nombre || '', u.email || '', u.n]));

    // Sheet 3 — Top áreas
    const topAr = [['Área', 'Solicitudes']];
    (d.top_areas || []).forEach(a => topAr.push([a.area, a.n]));

    // Sheet 4 — Rutinas por producto
    const porProd = [['Producto', 'Rutinas']];
    (d.por_producto || []).forEach(x => porProd.push([x.producto || '—', x.n]));

    const buf = X.buildXLSX([
      { name: 'Resumen',          aoa: resumen, cols: [{ wch: 30 }, { wch: 30 }] },
      { name: 'Top ejecutores',   aoa: topEj,   cols: [{ wch: 30 }, { wch: 32 }, { wch: 14 }] },
      { name: 'Áreas',            aoa: topAr,   cols: [{ wch: 30 }, { wch: 14 }] },
      { name: 'Por producto',     aoa: porProd, cols: [{ wch: 20 }, { wch: 14 }] },
    ]);
    const nombre = `reporte-tareas-ops_${desde || 'inicio'}_${hasta || 'fin'}${producto ? '_' + producto : ''}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '"');
    res.end(buf);
  });
}

module.exports = { mountTareasRoutes };
