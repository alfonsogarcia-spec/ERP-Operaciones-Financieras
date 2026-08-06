-- Esquema normalizado — Conciliación y Liquidación T+1 (BRD-OP-AGR-001)
-- Idempotente (create ... if not exists). Corre en Supabase Postgres y en pglite.

create table if not exists usuarios (
  id            serial primary key,
  email         text unique not null,
  nombre        text not null,
  rol           text not null default 'operador',   -- admin | operador | tesoreria
  password_hash text not null,
  activo        boolean not null default true,
  creado_at     timestamptz default now()
);

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

create table if not exists bitacora (
  id       serial primary key,
  ts       timestamptz default now(),
  usuario  text,
  rol      text,
  accion   text,
  detalle  text
);
