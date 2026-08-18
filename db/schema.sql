-- Esquema normalizado — Polipay POS Settlement (BRD-OP-AGR-001)
-- Idempotente (create ... if not exists). Corre en Supabase Postgres y en pglite.

create table if not exists usuarios (
  id            serial primary key,
  email         text unique not null,
  nombre        text not null,
  rol           text not null default 'operador',   -- admin | operador | tesoreria | consulta
  password_hash text,                                -- NULL desde v0.6 (login por Google)
  activo        boolean not null default true,
  creado_at     timestamptz default now()
);
-- v0.6: login por Google — password ya no es obligatoria. Trazabilidad de acceso.
alter table usuarios alter column password_hash drop not null;
alter table usuarios add column if not exists ultimo_login_at timestamptz;
alter table usuarios add column if not exists creado_por      text;
alter table usuarios add column if not exists foto_url        text;

create table if not exists grupos (
  id_grupo      integer primary key,
  nombre_cliente text not null,
  activo        boolean not null default true
);

create table if not exists afiliaciones (
  numero_afiliacion text primary key,
  razon_social  text,
  tipo          text,
  mcc           integer,
  descripcion_giro text,
  ult3          text,
  id_afiliacion text
);

create table if not exists afil_grupo (
  id_grupo          integer not null,
  numero_afiliacion text not null,
  tasa_pac_tdd  numeric default 0,
  tasa_pac_tdc  numeric default 0,
  tasa_pac_amex numeric default 0,
  tasa_pac_int  numeric default 0,
  costo_x_trx   numeric default 0,
  pct_banca     numeric default 0,
  primary key (id_grupo, numero_afiliacion)
);

create table if not exists costos (
  numero_afiliacion text primary key,
  int_tdd   numeric default 0,
  int_tdc   numeric default 0,
  int_amex  numeric,     -- null → usa el default de params
  int_int   numeric,
  fee_broxel numeric
);

create table if not exists bancos (
  nombre      text primary key,
  codigo_spei integer
);

create table if not exists cuentas (
  id            serial primary key,
  id_grupo      integer not null,
  numero_afiliacion text default '',
  nombre_comercial text,
  razon_social_beneficiario text,
  banco         text,
  clabe         text,
  codigo_banco  integer
);

create table if not exists feriados (
  fecha date primary key
);

create table if not exists params (
  id            integer primary key default 1,
  iva           numeric not null default 0.16,
  tasa_int_amex numeric not null default 0.0247,
  tasa_int_int  numeric not null default 0.0302,
  fee_broxel    numeric not null default 0.0028,
  prodparams    jsonb not null default '{"nacional":{"n":1,"corte":"23:00"},"amex":{"n":3,"corte":"23:00"}}'
);
insert into params (id) values (1) on conflict (id) do nothing;

create table if not exists transacciones (
  id            serial primary key,
  fecha         text,
  hora          text,
  cliente       text,
  comercio      text,
  numero_afiliacion text,
  estatus       text,
  metodo        text,
  producto      text,
  monto         numeric default 0,
  folio         text,
  referencia    text,
  autorizacion  text,
  terminal      text,
  fecha_liq     date,
  cancelacion   boolean default false,
  invalida      boolean default false,
  creado_at     timestamptz default now()
);
create index if not exists idx_tx_liq on transacciones(fecha_liq, estatus);

-- Trazabilidad de la carga (lote) al que pertenece cada transacción.
alter table transacciones add column if not exists ingesta_id text;
alter table transacciones add column if not exists ingesta_fecha timestamptz;
alter table transacciones add column if not exists archivo_origen text;
alter table transacciones add column if not exists cargado_por text;
create index if not exists idx_tx_ingesta on transacciones(ingesta_id);

create table if not exists cortes (
  id_corte      serial primary key,
  fecha_liq     text,
  fecha_liq_iso date,
  estado        text not null default 'Borrador',   -- Borrador | Validado | Dispersado | Cerrado
  creado_por    text,
  validado_por  text,
  dispersado_por text,
  creado_at     timestamptz default now(),
  total_monto   numeric,
  total_comp    numeric,
  total_disp    numeric,
  n_trx         integer,
  cuadra        boolean,
  bloqueos      integer,
  obsoleto      boolean not null default false      -- se marca si se borra un lote de trx que lo alimentaba
);
alter table cortes add column if not exists obsoleto boolean not null default false;

create table if not exists calculos (
  id          serial primary key,
  corte_id    integer not null references cortes(id_corte) on delete cascade,
  cliente     text,
  afil        text,
  id_grupo    integer,
  razon       text,
  concepto    text,
  clabe       text,
  codigo_banco integer,
  banco       text,
  beneficiario text,
  calc        jsonb not null,
  faltantes   jsonb,
  ajustes     jsonb,
  contracargos_ids jsonb           -- ids de conciliacion.contracargos aplicados a esta fila
);
alter table calculos add column if not exists contracargos_ids jsonb;
create index if not exists idx_calc_corte on calculos(corte_id);

create table if not exists contracargos (
  id                    serial primary key,
  origen_folio          text unique,                 -- Col A "Folio" (CB-2026-000030) para dedup
  cargado_en_fecha      date not null,               -- LA CLAVE: la fecha del reporte
  fecha_registro        text,                        -- Col B (informativo)
  numero_afiliacion     text not null,               -- Col C
  comercio              text,                        -- Col D
  grupo_cliente         text not null,               -- Col E sin prefijo "Grupo "
  marca                 text not null,               -- Col F (VISA/MASTERCARD/AMEX/CARNET)
  bloque                text not null,               -- derivado: 'AMEX' o 'DOM'
  canal                 text,                        -- Col G
  codigo_razon          text,                        -- Col H
  categoria             text,                        -- Col I
  monto                 numeric not null,            -- Col J "Monto a retener"
  moneda                text,                        -- Col K
  ticket                text,                        -- Col L
  autorizacion          text,                        -- Col M
  ultimos_4             text,                        -- Col N
  caso_arn              text,                        -- Col O
  fecha_cbk             text,                        -- Col P
  limite_representment  text,                        -- Col Q
  estado_origen         text,                        -- Col R
  estatus               text not null default 'Pendiente',   -- Pendiente | Aplicado | Cancelado
  aplicado_en_corte_id  integer references cortes(id_corte) on delete set null,
  archivo_origen        text,                        -- nombre del xlsx subido (auditoría)
  creado_at             timestamptz default now(),
  creado_por            text
);
create index if not exists idx_cc_fecha on contracargos(cargado_en_fecha, estatus);
create index if not exists idx_cc_afil on contracargos(numero_afiliacion, cargado_en_fecha);

-- Constancia de carga diaria: al menos 1 fila por cada día que se opera un corte.
-- Aunque el reporte venga con 0 contracargos, la constancia queda (n_contracargos=0).
create table if not exists contracargos_reporte_dia (
  fecha              date primary key,
  n_contracargos     integer not null default 0,
  monto_total        numeric not null default 0,
  archivo_origen     text,
  cargado_por        text,
  cargado_at         timestamptz default now()
);
alter table contracargos_reporte_dia add column if not exists archivo_bytes       bytea;
alter table contracargos_reporte_dia add column if not exists archivo_mime        text;

-- Destinatarios del correo de notificación del corte (aviso automático).
create table if not exists destinatarios (
  id          serial primary key,
  email       text not null unique,
  nombre      text,
  tipo        text not null default 'to',      -- 'to' | 'cc' | 'bcc'
  activo      boolean not null default true,
  creado_at   timestamptz default now(),
  creado_por  text
);
alter table destinatarios add column if not exists tipo text not null default 'to';

-- Cortes contables semanales (contabilidad).
-- Se generan 4 por mes: 1-10, 11-17, 18-24, 25-fin.
create table if not exists cortes_contables (
  id                serial primary key,
  anio              integer not null,
  mes               integer not null,
  semana            integer not null,          -- 1..4
  periodo_desde     date not null,
  periodo_hasta     date not null,
  com_mceb          numeric not null default 0,
  iva_com_mceb      numeric not null default 0,
  banca_telematic   numeric not null default 0,
  iva_banca         numeric not null default 0,
  disp_total        numeric not null default 0,
  total_facturar    numeric not null default 0,
  estado            text    not null default 'Pendiente',  -- Pendiente | Enviado
  enviado_at        timestamptz,
  enviado_por       text,
  message_id        text,
  creado_at         timestamptz default now(),
  unique(anio, mes, semana)
);

-- Destinatarios que reciben el registro contable (semanal + mensual).
create table if not exists destinatarios_contabilidad (
  id             serial primary key,
  email          text,
  email_cifrado  text,
  email_hash     text,
  nombre         text,
  nombre_cifrado text,
  tipo           text not null default 'to',   -- 'to' | 'cc' | 'bcc'
  activo         boolean not null default true,
  creado_at      timestamptz default now(),
  creado_por     text,
  unique(email_hash)
);

-- Destinatarios por grupo de cliente: reciben el detalle transaccional de SU
-- grupo cuando se dispara "Notificar clientes" en un corte. Independientes de
-- los destinatarios generales del corte (la tabla anterior).
create table if not exists destinatarios_cliente (
  id           serial primary key,
  id_grupo     integer not null references grupos(id_grupo) on delete cascade,
  email        text,
  email_cifrado text,
  email_hash   text,
  nombre       text,
  nombre_cifrado text,
  tipo         text not null default 'to',   -- 'to' | 'cc' | 'bcc'
  activo       boolean not null default true,
  creado_at    timestamptz default now(),
  creado_por   text,
  unique(id_grupo, email_hash)
);
create index if not exists idx_destcli_grupo on destinatarios_cliente(id_grupo);

create table if not exists bitacora (
  id       serial primary key,
  ts       timestamptz default now(),
  usuario  text,
  rol      text,
  accion   text,
  detalle  text
);
-- Fase 3 · Auditoría enriquecida + hash-chain (append-only con detección de tampering).
-- Cada fila calcula hash = sha256(prev_hash || id || ts || usuario || rol || accion || detalle || ip || ...).
-- Si alguien altera una fila ex post, la cadena se rompe y verificar-integridad lo detecta.
alter table bitacora add column if not exists ip            text;
alter table bitacora add column if not exists user_agent    text;
alter table bitacora add column if not exists session_jti   text;
alter table bitacora add column if not exists resource_type text;
alter table bitacora add column if not exists resource_id   text;
alter table bitacora add column if not exists success       boolean default true;
alter table bitacora add column if not exists prev_hash     text;
alter table bitacora add column if not exists row_hash      text;
create index if not exists idx_bitacora_ts on bitacora(ts desc);
create index if not exists idx_bitacora_usuario on bitacora(usuario, ts desc);
create index if not exists idx_bitacora_accion on bitacora(accion, ts desc);
create index if not exists idx_bitacora_recurso on bitacora(resource_type, resource_id, ts desc);
create index if not exists idx_bitacora_ip_accion on bitacora(ip, accion, ts desc);

-- Fase 3 · Deduplicación de alertas por SES. Evita que el mismo evento
-- (login_fail_ip, corte_baja_final, etc.) envíe correos repetidos dentro
-- de la ventana definida por la regla.
create table if not exists alertas_dedup (
  id          serial primary key,
  regla_id    text not null,
  clave       text not null,
  emitida_at  timestamptz default now()
);
create index if not exists idx_alertas_dedup on alertas_dedup(regla_id, clave, emitida_at desc);

-- Fase 3.3 · Snapshots WORM de la bitácora. Un registro por día: qué se
-- envió, hash del contenido, timestamp. Impide re-enviar el mismo día.
create table if not exists worm_snapshots (
  fecha         date primary key,
  n_registros   integer not null,
  hash_sha256   text not null,
  bytes_cifrado integer not null,
  enviado_a     text,                       -- lista de emails destino
  message_id    text,
  enviado_at    timestamptz default now(),
  origen        text default 'auto'         -- 'auto' | 'manual'
);

-- ============================================================================
-- Fase 2 · Cifrado en reposo (columnas paralelas). Todas nullable durante la
-- migración dual-write; el cutover posterior las hará source-of-truth y
-- eliminará las columnas viejas en plaintext.
-- Formatos: '_cifrada/_cifrado' = AES-256-GCM ("v1:iv:ct:tag").
--           '_hash'              = HMAC-SHA256 con pepper ("hm1:hexdigest").
-- ============================================================================
alter table usuarios       add column if not exists email_cifrado  text;
alter table usuarios       add column if not exists email_hash     text;
alter table usuarios       add column if not exists nombre_cifrado text;
create unique index if not exists ux_usuarios_email_hash on usuarios(email_hash);

alter table destinatarios  add column if not exists email_cifrado  text;
alter table destinatarios  add column if not exists email_hash     text;
alter table destinatarios  add column if not exists nombre_cifrado text;
create unique index if not exists ux_destinatarios_email_hash on destinatarios(email_hash);

alter table cuentas        add column if not exists clabe_cifrada                     text;
alter table cuentas        add column if not exists clabe_hash                        text;
alter table cuentas        add column if not exists razon_social_beneficiario_cifrada text;
alter table cuentas        add column if not exists banco_cifrado                     text;
create index if not exists idx_cuentas_clabe_hash on cuentas(clabe_hash);

alter table afiliaciones   add column if not exists razon_social_cifrada text;

alter table contracargos   add column if not exists ultimos_4_cifrada text;

alter table contracargos_reporte_dia add column if not exists archivo_bytes_cifrado bytea;

-- ============================================================================
-- MÓDULO TAREAS DE OPERACIONES (fase 4)
-- Microsistema aislado: tickets con 5 tipos (diaria/semanal/mensual/única/entregable).
-- Comparte auth y SES con el sistema principal; nada más.
-- ============================================================================

-- Rutinas: definición de tareas recurrentes que generan instancias automáticamente.
create table if not exists tareas_rutinas (
  id             serial primary key,
  titulo         text not null,
  descripcion    text,
  producto       text not null default 'agregador'
                 check (producto in ('emisor','spei','agregador','contabilidad','sistema','transversal')),
  tipo           text not null
                 check (tipo in ('diaria','semanal','mensual')),
  hora_objetivo  text,                            -- 'HH:MM' local MX
  dias_semana    text,                            -- 'lun,mar,mie,jue,vie' para diarias/semanales
  dia_mes        integer,                         -- 1..31 para mensuales
  n_dia_habil    integer,                         -- alternativa: N-ésimo día hábil
  salta_feriados boolean not null default true,
  responsable_id integer references usuarios(id) on delete set null,
  etiquetas      jsonb not null default '[]',
  activo         boolean not null default true,
  creado_at      timestamptz default now(),
  creado_por     text
);

-- Tickets: unidades de trabajo. Pueden ser instancias de rutinas o únicos/entregables.
create table if not exists tareas_tickets (
  id             serial primary key,
  folio          text unique not null,           -- TSK-YYYY-NNNNNN
  titulo         text not null,
  descripcion    text,
  producto       text not null default 'agregador'
                 check (producto in ('emisor','spei','agregador','contabilidad','sistema','transversal')),
  tipo           text not null default 'unica'
                 check (tipo in ('diaria','semanal','mensual','unica','entregable')),
  rutina_id      integer references tareas_rutinas(id) on delete set null,
  prioridad      text not null default 'media'
                 check (prioridad in ('baja','media','alta','urgente')),
  estado         text not null default 'backlog'
                 check (estado in ('backlog','por_hacer','en_curso','en_revision','bloqueado','terminado','cancelado')),
  responsable_id integer references usuarios(id) on delete set null,
  solicitante_id integer references usuarios(id) on delete set null,
  fecha_inicio   date,
  fecha_limite   date,
  hora_limite    text,                            -- para rutinas diarias
  fecha_cierre   timestamptz,
  etiquetas      jsonb not null default '[]',
  bloqueada_por  integer references tareas_tickets(id) on delete set null,
  -- Entregable
  aprobador_id      integer references usuarios(id) on delete set null,
  estado_aprobacion text check (estado_aprobacion is null or estado_aprobacion in ('pendiente','aprobado','rechazado')),
  archivo_final     text,                         -- nombre del archivo entregado
  archivo_final_ver integer default 1,
  -- Auditoría
  creado_por     text,
  creado_at      timestamptz default now(),
  actualizado_at timestamptz default now(),
  archivado      boolean not null default false
);
create index if not exists idx_tk_producto on tareas_tickets(producto, estado) where archivado=false;
create index if not exists idx_tk_responsable on tareas_tickets(responsable_id, estado) where archivado=false;
create index if not exists idx_tk_rutina on tareas_tickets(rutina_id, fecha_inicio) where rutina_id is not null;

-- Subtareas: checklist dentro de un ticket.
create table if not exists tareas_subtareas (
  id         serial primary key,
  ticket_id  integer not null references tareas_tickets(id) on delete cascade,
  texto      text not null,
  done       boolean not null default false,
  orden      integer default 0,
  creado_at  timestamptz default now()
);

-- Actividad: historial + comentarios de un ticket.
create table if not exists tareas_actividad (
  id         serial primary key,
  ticket_id  integer not null references tareas_tickets(id) on delete cascade,
  ts         timestamptz default now(),
  actor      text,                                -- nombre/email del usuario
  tipo       text not null,                       -- created/comment/status_change/assign/subtask/attach/edit
  estado_ant text,
  estado_nvo text,
  detalle    text,
  meta       jsonb
);
create index if not exists idx_act_ticket on tareas_actividad(ticket_id, ts desc);

-- Miembros del workspace de Tareas (rol dentro del microsistema).
create table if not exists tareas_miembros (
  usuario_id integer primary key references usuarios(id) on delete cascade,
  rol_tareas text not null default 'operador'
             check (rol_tareas in ('direccion','coordinacion','operador','consulta')),
  productos  jsonb not null default '[]',        -- ['agregador','spei','emisor']
  activo     boolean not null default true,
  agregado_at timestamptz default now()
);

-- ============================================================================
-- RETENCIONES POR FINANCIAMIENTO / REVENUE SHARE
-- Gemelo de "contracargos": se sube un layout por día con las retenciones que
-- van a debitarse del monto a dispersar del grupo/afiliación en el corte.
-- Cada fila indica su bloque (DOM o AMEX) para saber de qué dispersión resta.
-- No es constancia obligatoria: el corte se puede generar sin layout.
-- ============================================================================
create table if not exists financiamientos (
  id                    serial primary key,
  folio                 text unique,                 -- FIN-YYYY-NNNNNN (interno)
  cargado_en_fecha      date not null,               -- fecha del corte al que aplica
  numero_afiliacion     text not null,
  grupo_cliente         text not null,               -- sin prefijo "Grupo "
  tipo                  text not null default 'financiamiento'
                        check (tipo in ('financiamiento','revenue_share')),
  concepto              text,
  bloque                text not null default 'DOM'
                        check (bloque in ('DOM','AMEX')),
  monto                 numeric not null,
  moneda                text default 'MXN',
  estatus               text not null default 'Pendiente'
                        check (estatus in ('Pendiente','Aplicado','Cancelado')),
  aplicado_en_corte_id  integer references cortes(id_corte) on delete set null,
  archivo_origen        text,
  creado_at             timestamptz default now(),
  creado_por            text
);
create index if not exists idx_fin_fecha on financiamientos(cargado_en_fecha, estatus);
create index if not exists idx_fin_afil  on financiamientos(numero_afiliacion, cargado_en_fecha);

-- ============================================================================
-- ENTREGABLES · Portal de solicitudes internas hacia Operaciones (fase 5)
-- Áreas externas (Comercial, RH, Legal…) envían solicitudes a Operaciones
-- basadas en procedimientos POL-OP-P##. Cada tipo tiene un formato POL-OP-F##
-- (esquema del formulario en JSON) + plantilla descargable + bitácora POL-OP-R##.
-- ============================================================================
create table if not exists entregables_tipos (
  id            serial primary key,
  codigo        text unique not null,           -- POL-OP-P03
  producto      text not null default 'agregador'
                check (producto in ('emisor','spei','agregador','transversal')),
  nombre        text not null,
  descripcion   text,
  form_schema   jsonb not null default '{}'::jsonb,
  sla_dias      integer default 3,
  plantilla_nombre text,
  plantilla_bytes bytea,
  plantilla_mime  text,
  activo        boolean not null default true,
  creado_at     timestamptz default now()
);

create table if not exists entregables_solicitudes (
  id             serial primary key,
  folio          text unique not null,           -- ENT-YYYY-NNNNNN
  tipo_id        integer not null references entregables_tipos(id),
  producto       text not null,
  titulo         text not null,
  datos          jsonb not null default '{}'::jsonb,  -- valores del formulario
  solicitante_id integer references usuarios(id) on delete set null,
  solicitante_area text,                          -- Comercial, Legal, etc.
  ejecutor_id    integer references usuarios(id) on delete set null,
  aprobador_id   integer references usuarios(id) on delete set null,
  estado         text not null default 'nueva'
                 check (estado in ('nueva','aceptada','en_ejecucion','requiere_info','validacion','aprobada','rechazada','cancelada')),
  prioridad      text not null default 'media',
  fecha_limite   date,
  fecha_cierre   timestamptz,
  creado_at      timestamptz default now(),
  actualizado_at timestamptz default now()
);
create index if not exists idx_ent_producto on entregables_solicitudes(producto, estado);
create index if not exists idx_ent_solicitante on entregables_solicitudes(solicitante_id);

create table if not exists entregables_adjuntos (
  id             serial primary key,
  solicitud_id   integer not null references entregables_solicitudes(id) on delete cascade,
  filename       text not null,
  mime           text,
  bytes_size     integer,
  bytes_cifrado  bytea,                          -- cifrado en reposo con la llave del sistema
  descripcion    text,
  subido_por     text,
  subido_at      timestamptz default now()
);

create table if not exists entregables_actividad (
  id             serial primary key,
  solicitud_id   integer not null references entregables_solicitudes(id) on delete cascade,
  ts             timestamptz default now(),
  actor          text,
  tipo           text not null,                  -- created / status_change / comment / attach / edit
  estado_ant     text,
  estado_nvo     text,
  detalle        text,
  meta           jsonb
);
create index if not exists idx_ent_act on entregables_actividad(solicitud_id, ts desc);
