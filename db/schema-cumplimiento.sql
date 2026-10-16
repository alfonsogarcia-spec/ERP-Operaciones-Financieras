-- ============================================================================
-- Esquema `cumplimiento`: base de transacciones PROPIA de PLD / antifraude.
-- Independiente de `conciliacion.transacciones` (liquidación): aquí se guardan
-- TODAS las operaciones del gateway, sea cual sea su estatus (aprobadas,
-- rechazadas, canceladas, devoluciones), con la fecha/hora real de la operación
-- y los datos de tarjeta. La liquidación nunca lee de aquí ni viceversa.
-- Todos los nombres van calificados para no depender del search_path.
-- NUNCA se guarda el número completo de tarjeta: solo BIN + últimos 4 y una
-- huella HMAC (BIN6|últimos4).
-- ============================================================================
create schema if not exists cumplimiento;

create table if not exists cumplimiento.transacciones (
  id                  bigserial primary key,
  llave               text not null,          -- anti-duplicados: 'gw:<ID del gateway>' o 'h:<hash de la fila>'
  id_gateway          text,
  fecha               date not null,          -- fecha LOCAL de la operación
  hora                text,
  fecha_utc           text,
  cliente             text,
  comercio            text,
  numero_afiliacion   text,
  estatus             text,                   -- APROBADO / RECHAZADO / CANCELADO ... (mayúsculas)
  estatus_fin         text,
  tipo_trans          text,
  producto            text,
  metodo              text,
  monto               numeric not null default 0,
  propina             numeric,
  cashback            numeric,
  meses               integer,
  folio               text,
  referencia          text,
  referencia_anterior text,
  autorizacion        text,
  terminal            text,
  bin                 text,
  ultimos4            text,
  tarjeta_key         text,
  emisor              text,
  agregador           text,
  banco_adq           text,
  modo_entrada        text,
  lote_id             text,
  cargado_at          timestamptz not null default now(),
  constraint transacciones_llave_uk unique (llave)
);
create index if not exists idx_cump_tx_fecha   on cumplimiento.transacciones(fecha);
create index if not exists idx_cump_tx_afil    on cumplimiento.transacciones(numero_afiliacion, fecha);
create index if not exists idx_cump_tx_tarjeta on cumplimiento.transacciones(tarjeta_key, fecha);
create index if not exists idx_cump_tx_bin     on cumplimiento.transacciones(bin);
create index if not exists idx_cump_tx_lote    on cumplimiento.transacciones(lote_id);

-- Bitácora de cargas: una fila por archivo, con el cuadre contra el archivo.
create table if not exists cumplimiento.cargas (
  lote_id        text primary key,
  archivo        text,
  cargado_por    text,
  cargado_at     timestamptz not null default now(),
  filas_archivo  integer not null default 0,
  validas        integer not null default 0,
  invalidas      integer not null default 0,
  insertadas     integer not null default 0,
  duplicadas     integer not null default 0,
  desde          date,
  hasta          date,
  por_estatus    jsonb not null default '{}'::jsonb
);

-- Umbrales del antifraude por tarjeta / BIN (una sola fila). Propios de Cumplimiento: no usan
-- la tabla `params` de liquidación. Editables en Sistema → Parametrización de umbrales.
create table if not exists cumplimiento.config (
  id                       integer primary key default 1,
  tarjeta_ops_dia          integer not null default 5,    -- misma tarjeta: operaciones en un día (cualquier estatus)
  tarjeta_rechazos_dia     integer not null default 3,    -- misma tarjeta: rechazos en un día (posible prueba de tarjeta)
  tarjeta_afiliaciones_dia integer not null default 3,    -- misma tarjeta en N afiliaciones distintas el mismo día
  bin_rechazos_dia         integer not null default 10,   -- un BIN con N rechazos en un día (ataque por BIN)
  tasa_rechazo_pct         numeric not null default 30,   -- afiliación con tasa de rechazo >= %
  min_ops_tasa             integer not null default 20,   -- mínimo de operaciones para evaluar la tasa de rechazo
  constraint config_una_fila check (id = 1)
);
insert into cumplimiento.config (id) values (1) on conflict (id) do nothing;

-- ============================================================================
-- Alertas y bloqueo por operativa inusual (POL-CUM-FOR-006 v1.0)
-- ============================================================================
-- Motivo de rechazo del gateway (fondos insuficientes, tarjeta robada/perdida…), si el archivo lo trae.
alter table cumplimiento.transacciones add column if not exists motivo text;
-- Parámetros de las reglas (JSON; los valores por defecto viven en lib/pld-alertas.js).
alter table cumplimiento.config add column if not exists reglas jsonb not null default '{}'::jsonb;

create table if not exists cumplimiento.alertas (
  id                bigserial primary key,
  clave             text not null,                 -- anti-duplicados: regla|alcance|fecha|inicio
  regla             text not null,                 -- AV-1, RT-3, BL-2…
  nivel             text not null check (nivel in ('AVISO','SUSPENDER','BLOQUEO')),
  fecha             date not null,
  hora_ini          text,
  hora_fin          text,
  terminal          text,
  comercio          text,
  cliente           text,
  numero_afiliacion text,
  bin               text,
  tarjeta           text,                          -- BIN •••• últimos 4 (nunca el número completo)
  monto             numeric not null default 0,
  n_ops             integer not null default 0,
  detalle           text,
  evidencia         jsonb not null default '[]'::jsonb,   -- hasta 25 operaciones (folio, hora, monto, estatus)
  estatus           text not null default 'NUEVA' check (estatus in ('NUEVA','EN_REVISION','MEDIDA_APLICADA','FALSO_POSITIVO','CERRADA')),
  medida            text,                          -- qué se hizo (aviso atendido, terminal suspendida, tarjeta/BIN bloqueado…)
  nota              text,
  revisado_por      text,
  revisado_at       timestamptz,
  creada_at         timestamptz not null default now(),
  constraint alertas_clave_uk unique (clave)
);
create index if not exists idx_cump_alertas_fecha on cumplimiento.alertas(fecha desc);
create index if not exists idx_cump_alertas_estatus on cumplimiento.alertas(estatus, nivel);

-- Correo de alertas: destinatarios configurables y control de envío (no repetir el aviso de una alerta).
alter table cumplimiento.alertas add column if not exists notificada_at timestamptz;
alter table cumplimiento.alertas add column if not exists correo_estado text;     -- enviada | omitida (antigua) | error
create table if not exists cumplimiento.alerta_destinatarios (
  id             serial primary key,
  nombre         text,
  email          text not null,
  email_cifrado  text,
  email_hash     text,
  niveles        text[] not null default '{AVISO,SUSPENDER,BLOQUEO}',   -- niveles de alerta que recibe
  tipo           text not null default 'to' check (tipo in ('to','cc')),
  activo         boolean not null default true,
  creado_por     text,
  creado_at      timestamptz not null default now(),
  constraint alerta_dest_hash_uk unique (email_hash)
);
