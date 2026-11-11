-- Oficina Virtual Polipay — todo vive en el schema dedicado (search_path fijado por la conexión).
-- No guarda CLABEs, datos de tarjetahabientes ni KYC: solo agentes, tareas, sesiones y actividad.

create table if not exists agentes (
  id            text primary key,
  rol           text not null,
  rol_id        text not null,
  linea         text not null,
  linea_nombre  text not null,
  tipo          text not null,
  actualizado   timestamptz not null default now()
);

create sequence if not exists tareas_folio_seq;
create table if not exists tareas (
  folio        text primary key,
  titulo       text not null,
  solicitante  text not null,
  agentes      jsonb not null default '[]',
  tipo         text not null default 'tarea',
  estado       text not null default 'pendiente',
  entregable   text,
  notas        jsonb not null default '[]',
  proyecto     text,
  usuario      text,
  creada       timestamptz not null default now(),
  actualizada  timestamptz not null default now()
);
create index if not exists tareas_estado_idx on tareas (estado, actualizada desc);

create table if not exists sesiones (
  sesion         text primary key,
  proyecto       text,
  usuario        text,
  maquina        text,
  estado         text not null default 'libre',
  prompt         text,
  inicio_turno   timestamptz,
  ultimo_evento  timestamptz not null default now(),
  ultima_duracion_s integer
);
create index if not exists sesiones_ultimo_idx on sesiones (ultimo_evento desc);

create table if not exists actividad (
  id           bigserial primary key,
  sesion       text not null,
  clave        text not null,
  agente       text not null,
  descripcion  text,
  proyecto     text,
  usuario      text,
  maquina      text,
  inicio       timestamptz not null default now(),
  fin          timestamptz,
  duracion_s   integer,
  unique (sesion, clave)
);
create index if not exists actividad_abierta_idx on actividad (fin, inicio desc);

create table if not exists tokens (
  id          bigserial primary key,
  hash        text not null unique,
  usuario     text not null,
  etiqueta    text not null,
  creado_por  text not null,
  creado      timestamptz not null default now(),
  ultimo_uso  timestamptz,
  revocado    timestamptz
);
