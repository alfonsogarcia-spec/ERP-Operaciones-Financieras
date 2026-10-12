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
