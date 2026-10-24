-- ============================================================================
-- Cards (BSO) · Control interno de tesorería: fondeos de Empresas, Unidades de negocio y Tarjetas.
-- Schema aislado `cards` (igual que `disputa` y `cumplimiento`). Idempotente.
--   La empresa manda: fondeo neto + comisión (% del fondeo) + IVA (% de la comisión).
--   Cada entidad tiene una CLABE designada a la que debe llegar su fondeo.
-- ============================================================================
create schema if not exists cards;

-- Estructura: EMPRESA → UN (unidad de negocio) → TARJETA. La tarjeta puede colgar directo de la empresa.
create table if not exists cards.entidades (
  id            serial primary key,
  nivel         text not null check (nivel in ('EMPRESA','UN','TARJETA')),
  parent_id     integer references cards.entidades(id) on delete restrict,
  empresa_id    integer,                                   -- raíz de la rama (la propia empresa se apunta a sí misma)
  nombre        text not null,
  referencia    text,                                      -- RFC (empresa) · clave interna (UN) · últimos 4 / alias (tarjeta)
  clabe         text not null,                             -- CLABE designada para recibir su fondeo
  comision_pct  numeric check (comision_pct is null or (comision_pct >= 0 and comision_pct <= 25)),   -- null = hereda del padre
  iva_pct       numeric check (iva_pct is null or (iva_pct >= 0 and iva_pct <= 25)),
  activo        boolean not null default true,
  notas         text,
  creado_por    text,
  creado_at     timestamptz not null default now(),
  actualizado_at timestamptz not null default now(),
  constraint cards_entidad_clabe_uk unique (clabe),
  constraint cards_entidad_padre_ck check ((nivel = 'EMPRESA' and parent_id is null) or (nivel <> 'EMPRESA' and parent_id is not null))
);
create index if not exists idx_cards_ent_parent on cards.entidades(parent_id);
create index if not exists idx_cards_ent_empresa on cards.entidades(empresa_id);

create sequence if not exists cards.fondeos_folio_seq;

-- Un fondeo = un depósito recibido en la CLABE de una entidad. Las tasas y la CLABE se congelan al registrar.
create table if not exists cards.fondeos (
  id               serial primary key,
  folio            text not null unique,
  entidad_id       integer not null references cards.entidades(id),
  empresa_id       integer not null,
  fecha            date not null,                          -- fecha en que se recibió (según CEP / estado de cuenta)
  monto_recibido   numeric not null check (monto_recibido > 0),
  fondeo           numeric not null,                       -- neto que se abona a la entidad
  comision         numeric not null,
  iva              numeric not null,
  redondeo         numeric not null default 0,             -- centavos que no cuadran en el desglose
  comision_pct     numeric not null,
  iva_pct          numeric not null,
  fondeo_solicitado numeric,                               -- lo que la empresa dijo que iba a fondear (opcional, para detectar diferencias)
  clabe_destino    text not null,
  clave_rastreo    text,
  banco_ordenante  text,
  estatus          text not null default 'REGISTRADO' check (estatus in ('REGISTRADO','VALIDADO','CANCELADO')),
  validado_por     text,
  validado_at      timestamptz,
  nota_validacion  text,
  cancelado_por    text,
  cancelado_at     timestamptz,
  motivo_cancelacion text,
  notas            text,
  creado_por       text,
  creado_at        timestamptz not null default now()
);
create index if not exists idx_cards_fon_fecha on cards.fondeos(fecha desc);
create index if not exists idx_cards_fon_ent on cards.fondeos(entidad_id);
create index if not exists idx_cards_fon_emp on cards.fondeos(empresa_id, fecha);
-- Evita registrar dos veces el mismo SPEI (misma clave de rastreo el mismo día), salvo cancelados.
create unique index if not exists uq_cards_fon_rastreo on cards.fondeos(upper(clave_rastreo), fecha)
  where clave_rastreo is not null and estatus <> 'CANCELADO';

-- CEP (Comprobante Electrónico de Pago): uno o varios archivos por fondeo. Contenido cifrado (AES-GCM), igual que las evidencias de Disputas.
create table if not exists cards.fondeo_ceps (
  id            serial primary key,
  fondeo_id     integer not null references cards.fondeos(id) on delete cascade,
  filename      text not null,
  mime          text,
  bytes_cifrado bytea not null,
  bytes_size    integer,
  sha256_hash   text,
  subido_por    text,
  subido_at     timestamptz not null default now()
);
create index if not exists idx_cards_cep_fon on cards.fondeo_ceps(fondeo_id);

create table if not exists cards.fondeo_eventos (
  id         serial primary key,
  fondeo_id  integer not null references cards.fondeos(id) on delete cascade,
  ts         timestamptz not null default now(),
  actor      text,
  tipo       text not null,          -- alta · edicion · cep_alta · cep_baja · validado · cancelado
  detalle    text
);
create index if not exists idx_cards_evt_fon on cards.fondeo_eventos(fondeo_id, ts);

-- Lectura automática del CEP (clave de rastreo, monto, CLABE, partes…) y quién envió el depósito.
alter table cards.fondeo_ceps add column if not exists datos     jsonb;      -- lo que el CEP dice
alter table cards.fondeo_ceps add column if not exists formato   text;       -- cep_banxico · dispersion_polipay · xml · pdf_generico · consulta_estado_banxico …
alter table cards.fondeo_ceps add column if not exists confianza text;
alter table cards.fondeo_ceps add column if not exists es_cep    boolean;    -- false = el documento dice que NO es un CEP
alter table cards.fondeos add column if not exists ordenante_nombre text;
alter table cards.fondeos add column if not exists ordenante_rfc    text;

-- ===== Ciclo de solicitud → CEP → asignación de saldo (comercial solicita · tesorería asigna) =====
-- SOLICITADO (esperando CEP) → POR_ASIGNAR (CEP aceptado) → ASIGNADO (tesorería confirma) · RECHAZADO · CANCELADO.
-- Una solicitud nace sin fecha ni monto recibido: se llenan con lo que dice el CEP.
alter table cards.fondeos alter column monto_recibido drop not null;
alter table cards.fondeos alter column fecha drop not null;
alter table cards.fondeos add column if not exists origen          text not null default 'MANUAL';   -- SOLICITUD (la pide un comercial) | MANUAL (tesorería registra algo ya recibido)
alter table cards.fondeos add column if not exists monto_esperado  numeric;                          -- total que la empresa debe depositar (fondeo + comisión + IVA), cotizado al solicitar
alter table cards.fondeos add column if not exists solicitante_id     integer;
alter table cards.fondeos add column if not exists solicitante_nombre text;
alter table cards.fondeos add column if not exists solicitado_at   timestamptz;
alter table cards.fondeos add column if not exists rechazado_por   text;
alter table cards.fondeos add column if not exists rechazado_at    timestamptz;
alter table cards.fondeos add column if not exists motivo_rechazo  text;
alter table cards.fondeos drop constraint if exists fondeos_estatus_check;
update cards.fondeos set estatus = case when exists (select 1 from cards.fondeo_ceps c where c.fondeo_id = cards.fondeos.id) then 'POR_ASIGNAR' else 'SOLICITADO' end where estatus = 'REGISTRADO';
update cards.fondeos set estatus = 'ASIGNADO' where estatus = 'VALIDADO';
alter table cards.fondeos add constraint fondeos_estatus_check check (estatus in ('SOLICITADO','POR_ASIGNAR','ASIGNADO','RECHAZADO','CANCELADO'));
alter table cards.fondeos alter column estatus set default 'SOLICITADO';
-- validado_por / validado_at / nota_validacion = quién asignó el saldo (tesorería), cuándo y su nota.
create index if not exists idx_cards_fon_estatus on cards.fondeos(estatus);
create index if not exists idx_cards_fon_solic on cards.fondeos(solicitante_id);
-- Comercial responsable de la empresa (usuarios.id). Solo se llena en EMPRESA.
alter table cards.entidades add column if not exists agente_id integer;

-- ===== CANDADO DE ASIGNACIÓN =====
-- Un fondeo solo puede quedar ASIGNADO si tiene al menos un CEP VALIDADO por el sistema (lo marca `validado` al aceptarlo:
-- es CEP legible, la CLABE beneficiaria es la de la entidad, trae monto y clave de rastreo) y ya tiene monto, fecha y clave de rastreo.
-- Se aplica en la propia base de datos: ninguna ruta, script o consulta directa puede saltárselo. Y una vez asignado, su CEP no se toca.
alter table cards.fondeo_ceps add column if not exists validado boolean not null default false;
-- CEP cargados antes de existir la marca: se validan con la misma regla.
update cards.fondeo_ceps c set validado = true
 where c.validado = false and c.datos is not null and coalesce(c.es_cep, true) and c.formato in ('cep_banxico','xml','dispersion_polipay')
   and (c.datos->>'monto')::numeric > 0 and nullif(c.datos->>'clave_rastreo','') is not null
   and c.datos->'beneficiario'->>'cuenta' = (select f.clabe_destino from cards.fondeos f where f.id = c.fondeo_id);

create or replace function cards.candado_asignacion() returns trigger language plpgsql as $$
begin
  if new.estatus = 'ASIGNADO' and (tg_op = 'INSERT' or old.estatus is distinct from 'ASIGNADO') then
    if new.monto_recibido is null or new.monto_recibido <= 0 or new.fecha is null or new.clave_rastreo is null
       or not exists (select 1 from cards.fondeo_ceps c where c.fondeo_id = new.id and c.validado) then
      raise exception 'Candado de tesorería: no se puede asignar el saldo del fondeo % sin un CEP validado.', new.folio using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_cards_candado on cards.fondeos;
create trigger trg_cards_candado before insert or update of estatus on cards.fondeos
  for each row execute function cards.candado_asignacion();

create or replace function cards.cep_inmutable() returns trigger language plpgsql as $$
declare est text; fid integer;
begin
  fid := case when tg_op = 'DELETE' then old.fondeo_id else new.fondeo_id end;
  select estatus into est from cards.fondeos where id = fid;
  if est = 'ASIGNADO' then
    raise exception 'Candado de tesorería: el CEP de un fondeo asignado no se modifica ni se elimina.' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists trg_cards_cep_inmutable on cards.fondeo_ceps;
create trigger trg_cards_cep_inmutable before update of fondeo_id, filename, bytes_cifrado, sha256_hash, datos, formato or delete on cards.fondeo_ceps
  for each row execute function cards.cep_inmutable();


-- ===== BENEFICIARIO Y BANCO de cada cuenta de fondeo =====
-- Catálogo de bancos de Cards: copia del catálogo "Bancos SPEI" de MCEB (se carga al arrancar, ver lib/cards-bancos.js).
-- `prefijo` = los 3 primeros dígitos de la CLABE de ese banco; con él se identifica el banco al capturar la CLABE.
create table if not exists cards.bancos (
  codigo_spei integer primary key,
  nombre      text not null,
  prefijo     text,
  activo      boolean not null default true
);
create unique index if not exists uq_cards_bancos_nombre on cards.bancos(lower(nombre));
create index if not exists idx_cards_bancos_prefijo on cards.bancos(prefijo);

-- Quién es el titular de la CLABE y en qué banco está; el CEP debe decir lo mismo.
alter table cards.entidades add column if not exists beneficiario text;
alter table cards.entidades add column if not exists banco_codigo integer references cards.bancos(codigo_spei);
-- Igual que la CLABE y las tasas, se congelan en el fondeo al crearlo.
alter table cards.fondeos add column if not exists beneficiario_destino   text;
alter table cards.fondeos add column if not exists banco_destino          text;
alter table cards.fondeos add column if not exists banco_codigo_destino   integer;

-- ===== DESTINATARIOS del aviso de "nueva solicitud" =====
-- Quien registra la solicitud es quien tiene la sesión abierta (solicitante_id / solicitante_nombre). Al registrarla, se avisa por
-- correo a estas personas. Correo y nombre van cifrados (igual que los demás destinatarios del sistema).
create table if not exists cards.destinatarios (
  id             serial primary key,
  email_cifrado  text not null,
  email_hash     text not null unique,
  nombre_cifrado text,
  tipo           text not null default 'to' check (tipo in ('to','cc','bcc')),
  activo         boolean not null default true,
  creado_por     text,
  creado_at      timestamptz not null default now()
);

-- ===== COMPROBANTE DEL SALDO ASIGNADO =====
-- Evidencia que tesorería sube del sistema donde se ve el saldo ya asignado (captura, PDF o Excel). Cifrada igual que el CEP.
create table if not exists cards.fondeo_comprobantes (
  id            serial primary key,
  fondeo_id     integer not null references cards.fondeos(id) on delete cascade,
  filename      text not null,
  mime          text,
  bytes_cifrado bytea not null,
  bytes_size    integer,
  sha256_hash   text,
  subido_por    text,
  subido_at     timestamptz not null default now()
);
create index if not exists idx_cards_comp_fon on cards.fondeo_comprobantes(fondeo_id);

-- ===== DESTINATARIOS POR CORREO =====
-- Cada correo de Cards (nueva solicitud, por asignar, asignado, rechazado, cancelada) tiene sus propios destinatarios:
-- los automáticos (quien solicitó · usuarios con rol Tesorería Cards), configurados en cards.avisos, y los fijos de cards.destinatarios.
alter table cards.destinatarios add column if not exists evento text not null default 'solicitado';
alter table cards.destinatarios drop constraint if exists destinatarios_email_hash_key;
create unique index if not exists uq_cards_dest_evento_email on cards.destinatarios(evento, email_hash);
create table if not exists cards.avisos (
  evento        text primary key,
  activo        boolean not null default true,        -- enviar este correo
  a_solicitante boolean not null default false,       -- recibe quien solicitó
  a_tesoreria   boolean not null default false        -- reciben los usuarios con rol Tesorería Cards
);
insert into cards.avisos(evento, a_solicitante, a_tesoreria) values
  ('solicitado', false, false), ('por_asignar', false, true), ('asignado', true, false), ('rechazado', true, false), ('cancelado', true, false)
on conflict do nothing;

-- ===== HILO DE CORREO =====
-- El primer correo que se envía de un fondeo (normalmente "Nueva solicitud") fija el hilo: su Message-ID y su asunto.
-- Los correos de estatus posteriores salen como respuesta suya ("Re: …") y caen en la misma conversación.
alter table cards.fondeos add column if not exists correo_msgid  text;
alter table cards.fondeos add column if not exists correo_asunto text;
