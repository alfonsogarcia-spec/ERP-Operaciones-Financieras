-- ============================================================================
-- db/schema-solicitudes.sql — Portal de solicitudes de clientes (POS): alta de sub afiliados y de afiliaciones, usuarios de Suite, cambios de datos,
-- condiciones y CLABE. Tablas `sc_*` en el mismo schema que POS Settlement (usan sus grupos de cliente, afiliaciones, cuentas y bancos). Idempotente.
-- Cada solicitud conserva la huella completa de quién hizo qué y cuándo (sc_eventos es inalterable y va encadenada con hashes por solicitud).
-- ============================================================================

-- Rol dentro del portal de solicitudes (independiente de los demás): admin | dir_comercial | comercial | operacion | coordinacion | direccion | consulta | cliente.
-- NULL = sin acceso. Quien solo entra al portal (un cliente) tiene además usuarios.rol = 'cliente'.
alter table usuarios add column if not exists rol_solicitudes text;
-- «Gerencia» pasó a llamarse «Coordinación»: se migran los usuarios que ya tenían el rol anterior.
update usuarios set rol_solicitudes = 'coordinacion' where rol_solicitudes = 'gerencia';

-- Un cliente = un grupo de cliente de POS (grupos.id_grupo). Aquí se activa su acceso al portal y se le asigna su Ejecutivo Comercial.
create table if not exists sc_clientes (
  id_grupo      integer primary key,
  ejecutivo_id  integer references usuarios(id) on delete set null,
  activo        boolean not null default true,
  notas         text,
  creado_por    text,
  creado_at     timestamptz not null default now(),
  actualizado_at timestamptz not null default now()
);

-- Personas del cliente que entran al portal (cada una es un usuario con rol 'cliente').
create table if not exists sc_contactos (
  usuario_id    integer not null references usuarios(id) on delete cascade,
  id_grupo      integer not null,
  puesto        text,
  telefono      text,
  activo        boolean not null default true,
  creado_por    text,
  creado_at     timestamptz not null default now(),
  primary key (usuario_id, id_grupo)
);
-- tipo: 'cliente' (persona del cliente, usuario con rol 'cliente') o 'account_manager' (uso interno: persona de Polipay que pide a nombre de la unidad de negocio).
alter table sc_contactos add column if not exists tipo text not null default 'cliente';
create index if not exists idx_sc_contactos_grupo on sc_contactos(id_grupo);

create sequence if not exists sc_folio_seq;

create table if not exists sc_solicitudes (
  id            serial primary key,
  folio         text unique not null,                      -- SC-2026-000123
  tipo          text not null,                             -- ver lib/solicitudes/catalogo.js
  id_grupo      integer not null,
  estado        text not null default 'borrador',
  titulo        text,
  datos         jsonb not null default '{}'::jsonb,        -- Parte 1: lo que captura el cliente
  datos_comercial jsonb not null default '{}'::jsonb,      -- condiciones y verificaciones del Ejecutivo Comercial
  datos_operacion jsonb not null default '{}'::jsonb,      -- Parte 2: lo que registra Operación POS
  referencia_pos jsonb not null default '{}'::jsonb,       -- lo que POS tenía al enviar/liberar (afiliación, tasas, CLABE) para poder auditarlo
  afiliacion    text,                                      -- número de afiliación principal sobre la que opera
  solicitante   text,                                      -- correo de quien la creó
  solicitante_nombre text,
  capturada_por_comercial boolean not null default false,
  ejecutivo     text,                                      -- correo del Ejecutivo Comercial responsable al momento de crearla
  liberada_por  text,
  ejecutada_por text,
  validada_por  text,
  direccion_por text,
  requiere_direccion boolean not null default false,
  motivo_direccion text,
  alertas       jsonb not null default '[]'::jsonb,        -- avisos que ve el personal (p. ej. «el titular no coincide»)
  version       integer not null default 1,
  motivo        text,                                      -- motivo de rechazo o cancelación
  estado_desde  timestamptz not null default now(),
  enviada_at    timestamptz,
  liberada_at   timestamptz,
  ejecutada_at  timestamptz,
  cerrada_at    timestamptz,
  vence_at      timestamptz,
  devoluciones  integer not null default 0,
  creado_at     timestamptz not null default now(),
  actualizado_at timestamptz not null default now()
);
create index if not exists idx_sc_sol_estado on sc_solicitudes(estado, tipo);
create index if not exists idx_sc_sol_grupo on sc_solicitudes(id_grupo, creado_at desc);

create table if not exists sc_adjuntos (
  id            serial primary key,
  solicitud_id  integer not null references sc_solicitudes(id) on delete cascade,
  doc_id        text,                                      -- documento del checklist al que corresponde (null = adjunto libre)
  nombre        text not null,
  mime          text,
  tam           integer,
  archivo_cifrado text,
  visible_cliente boolean not null default true,
  subido_por    text,
  subido_at     timestamptz not null default now(),
  retirado      boolean not null default false
);
create index if not exists idx_sc_adj_sol on sc_adjuntos(solicitud_id);

-- Bitácora de la solicitud: todo lo que pasa, quién y cuándo. Inalterable y encadenada.
create table if not exists sc_eventos (
  id            bigserial primary key,
  solicitud_id  integer not null references sc_solicitudes(id) on delete cascade,
  ts            timestamptz not null default now(),
  actor         text,
  actor_nombre  text,
  actor_rol     text,
  accion        text not null,
  estado_ant    text,
  estado_nvo    text,
  detalle       text,
  visible_cliente boolean not null default false,
  meta          jsonb,
  prev_hash     text,
  hash          text not null
);
create index if not exists idx_sc_ev_sol on sc_eventos(solicitud_id, id);

create or replace function sc_bloquear_cambios() returns trigger language plpgsql as $$
begin
  raise exception 'La bitácora de solicitudes es inalterable (no se permite % )', tg_op;
end $$;
drop trigger if exists sc_eventos_sin_cambios on sc_eventos;
create trigger sc_eventos_sin_cambios before update on sc_eventos for each row execute function sc_bloquear_cambios();
-- (el borrado solo ocurre en cascada al eliminar una solicitud de pruebas; la API nunca borra eventos)

-- Estructura del cliente: sus unidades de negocio (con las afiliaciones y comercios de POS que agrupan). Un contacto puede tener acceso a todo el cliente
-- (sin renglones en sc_contacto_unidades) o solo a unas unidades; sus solicitudes salen ya con esas unidades predefinidas.
create table if not exists sc_unidades (
  id            serial primary key,
  id_grupo      integer not null,
  nombre        text not null,
  afiliaciones  text[] not null default '{}',
  comercios     text[] not null default '{}',
  activo        boolean not null default true,
  creado_por    text,
  creado_at     timestamptz not null default now(),
  unique (id_grupo, nombre)
);
create index if not exists idx_sc_unidades_grupo on sc_unidades(id_grupo);
create table if not exists sc_contacto_unidades (
  usuario_id    integer not null,
  id_grupo      integer not null,
  unidad_id     integer not null references sc_unidades(id) on delete cascade,
  primary key (usuario_id, id_grupo, unidad_id)
);
