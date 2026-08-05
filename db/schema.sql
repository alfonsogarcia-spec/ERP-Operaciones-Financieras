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
  bloqueos      integer
);

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
  ajustes     jsonb
);
create index if not exists idx_calc_corte on calculos(corte_id);

create table if not exists bitacora (
  id       serial primary key,
  ts       timestamptz default now(),
  usuario  text,
  rol      text,
  accion   text,
  detalle  text
);
