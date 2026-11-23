-- ============================================================================
-- db/schema-mesa.sql — Credit Solvendom · Mesa de control de una SOFOM (núcleo: solicitud, expediente, KYC/PLD, motor de decisión, autorización).
-- Tablas `mc_*` dentro del schema `credit_solvendom`. No toca las tablas `cartera_*` (cartera anterior) ni el sistema anterior en Render.
-- Datos personales sensibles (RFC, CURP, domicilio, teléfono, correo) se guardan cifrados (lib/crypto.js); el RFC además tiene huella para buscar duplicados.
-- La bitácora `mc_bitacora` es inalterable: encadenada con hashes y con triggers que impiden UPDATE y DELETE.
-- ============================================================================
create schema if not exists credit_solvendom;

create table if not exists credit_solvendom.mc_config (
  clave text primary key, valor jsonb not null, actualizado timestamptz not null default now(), actualizado_por text);

create table if not exists credit_solvendom.mc_productos (
  id serial primary key,
  clave text not null unique,
  nombre text not null,
  tipo text not null default 'simple' check (tipo in ('simple','revolvente')),
  activo boolean not null default true,
  monto_min numeric not null default 0, monto_max numeric not null,
  plazo_min int not null default 1, plazo_max int not null,
  tasa_min numeric not null default 0, tasa_max numeric not null, tasa_default numeric not null,
  tasa_moratoria numeric,
  periodicidades text[] not null default array['mensual'],
  comision_apertura numeric not null default 0,
  politica jsonb not null default '{}'::jsonb,           -- umbrales del motor para este producto (completan/sustituyen los generales)
  docs_extra jsonb not null default '[]'::jsonb,         -- documentos adicionales que pide este producto
  version int not null default 1,
  es_ejemplo boolean not null default false,
  creado_at timestamptz not null default now(), actualizado_at timestamptz not null default now(), actualizado_por text);

create table if not exists credit_solvendom.mc_solicitantes (
  id serial primary key,
  tipo text not null check (tipo in ('fisica','moral')),
  nombre text not null,
  rfc_hash text, rfc_cifrado text, curp_cifrado text,
  fecha_nacimiento date,
  nacionalidad text not null default 'MX',
  actividad text,
  domicilio_cifrado text, telefono_cifrado text, email_cifrado text,
  pep boolean not null default false,
  beneficiario_controlador text,
  origen_recursos text,
  es_ejemplo boolean not null default false,
  creado_at timestamptz not null default now(), actualizado_at timestamptz not null default now());
create index if not exists idx_mc_solicitantes_rfc on credit_solvendom.mc_solicitantes(rfc_hash);

create sequence if not exists credit_solvendom.mc_folio_seq;

create table if not exists credit_solvendom.mc_solicitudes (
  id serial primary key,
  folio text not null unique,
  solicitante_id int not null references credit_solvendom.mc_solicitantes(id),
  producto_id int not null references credit_solvendom.mc_productos(id),
  estado text not null default 'borrador' check (estado in ('borrador','devuelta','verificacion','decision','autorizada','rechazada','cancelada')),
  estado_desde timestamptz not null default now(),
  monto numeric not null check (monto > 0),
  plazo_meses int not null check (plazo_meses > 0),
  periodicidad text not null default 'mensual',
  tasa_anual numeric not null,
  destino text,
  ingresos_mensuales numeric, egresos_mensuales numeric, otras_deudas_mensuales numeric,
  antiguedad_meses int, score_buro int,
  garantia text, notas text,
  ejecutivo text not null, ejecutivo_nombre text,
  monto_autorizado numeric, tasa_autorizada numeric, plazo_autorizado int,
  autorizada_en timestamptz, vigencia_hasta date,
  motivo_rechazo text, comentario_cierre text,
  version int not null default 1,
  es_ejemplo boolean not null default false,
  creado_at timestamptz not null default now(), actualizado_at timestamptz not null default now());
create index if not exists idx_mc_sol_estado on credit_solvendom.mc_solicitudes(estado, estado_desde);
create index if not exists idx_mc_sol_ejecutivo on credit_solvendom.mc_solicitudes(ejecutivo);

create table if not exists credit_solvendom.mc_documentos (
  id serial primary key,
  solicitud_id int not null references credit_solvendom.mc_solicitudes(id) on delete cascade,
  tipo text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','recibido','validado','rechazado')),
  archivo_nombre text, archivo_mime text, archivo_tam int, archivo_cifrado text,       -- el archivo se guarda cifrado (lib/crypto.js)
  vigencia date,
  comentario text,
  subido_por text, subido_at timestamptz,
  revisado_por text, revisado_at timestamptz,
  unique (solicitud_id, tipo));

create table if not exists credit_solvendom.mc_listas (
  id serial primary key,
  fuente text not null,
  tipo text not null default 'persona',
  nombre text not null, nombre_norm text,
  rfc text, curp text, notas text,
  vigente boolean not null default true,
  es_ejemplo boolean not null default false,
  cargado_at timestamptz not null default now(), cargado_por text);
create index if not exists idx_mc_listas_vigente on credit_solvendom.mc_listas(vigente);

create table if not exists credit_solvendom.mc_pld_consultas (
  id serial primary key,
  solicitud_id int not null references credit_solvendom.mc_solicitudes(id) on delete cascade,
  huella text not null,                                   -- de los datos consultados: si cambian, la consulta ya no vale
  listas_vigentes int not null default 0,
  coincidencias int not null default 0,
  ejecutada_por text, ejecutada_at timestamptz not null default now());

create table if not exists credit_solvendom.mc_pld_coincidencias (
  id serial primary key,
  consulta_id int not null references credit_solvendom.mc_pld_consultas(id) on delete cascade,
  solicitud_id int not null references credit_solvendom.mc_solicitudes(id) on delete cascade,
  lista_id int, fuente text, nombre text, rfc text,
  score numeric not null, nivel text not null check (nivel in ('alta','posible')), motivo text,
  estado text not null default 'pendiente' check (estado in ('pendiente','descartada','confirmada')),
  revisado_por text, revisado_at timestamptz, comentario text);
create index if not exists idx_mc_coinc_estado on credit_solvendom.mc_pld_coincidencias(estado);

create table if not exists credit_solvendom.mc_evaluaciones (
  id serial primary key,
  solicitud_id int not null references credit_solvendom.mc_solicitudes(id) on delete cascade,
  huella text not null,
  entrada jsonb not null, reglas jsonb not null, politica jsonb not null,
  recomendacion text not null,
  creado_por text, creado_at timestamptz not null default now());

create table if not exists credit_solvendom.mc_decisiones (
  id serial primary key,
  solicitud_id int not null references credit_solvendom.mc_solicitudes(id) on delete cascade,
  nivel text not null check (nivel in ('verificacion','cumplimiento','mesa','comite','rechazo','devolucion','cancelacion')),
  decision text not null check (decision in ('aprueba','rechaza','devuelve','verifica','cancela')),
  comentario text,
  usuario text not null, usuario_nombre text, rol text,
  evaluacion_id int, recomendacion text,
  contra_motor boolean not null default false,
  autoaprobada boolean not null default false,
  monto numeric, tasa numeric, plazo int,
  creado_at timestamptz not null default now());
create index if not exists idx_mc_dec_solicitud on credit_solvendom.mc_decisiones(solicitud_id);

create table if not exists credit_solvendom.mc_bitacora (
  id bigserial primary key,
  ts timestamptz not null,
  usuario text, rol text,
  accion text not null, entidad text not null, entidad_id text,
  resumen text, detalle jsonb,
  prev_hash text, hash text not null);
create index if not exists idx_mc_bit_entidad on credit_solvendom.mc_bitacora(entidad, entidad_id);

create or replace function credit_solvendom.mc_bloquear_cambios() returns trigger language plpgsql as $$
begin
  raise exception 'La bitácora de la mesa de control es inalterable (no se permite % )', tg_op;
end $$;
drop trigger if exists mc_bitacora_sin_update on credit_solvendom.mc_bitacora;
create trigger mc_bitacora_sin_update before update or delete on credit_solvendom.mc_bitacora for each row execute function credit_solvendom.mc_bloquear_cambios();
drop trigger if exists mc_bitacora_sin_truncate on credit_solvendom.mc_bitacora;
create trigger mc_bitacora_sin_truncate before truncate on credit_solvendom.mc_bitacora for each statement execute function credit_solvendom.mc_bloquear_cambios();

-- ============================================================================
-- Ola 2 · Formalización, desembolso, cartera, cobranza, conciliación, fondeo, contabilidad, reportes y UIF
-- ============================================================================
create sequence if not exists credit_solvendom.mc_credito_seq;

create table if not exists credit_solvendom.mc_fondeos (
  id serial primary key,
  nombre text not null, tipo text not null default 'institucional' check (tipo in ('institucional','friends_family','capital_propio','otro')),
  monto_linea numeric not null check (monto_linea > 0), tasa_anual numeric not null default 0,
  revolvente boolean not null default true,                       -- true: lo repagado vuelve a estar disponible
  fecha_inicio date, fecha_vencimiento date,
  estado text not null default 'vigente' check (estado in ('vigente','liquidado','cancelado')),
  notas text, es_ejemplo boolean not null default false,
  creado_por text, creado_at timestamptz not null default now());

create table if not exists credit_solvendom.mc_fondeo_mov (
  id serial primary key,
  fondeo_id int not null references credit_solvendom.mc_fondeos(id) on delete cascade,
  fecha date not null, tipo text not null check (tipo in ('disposicion','pago_capital','pago_interes','comision')),
  monto numeric not null check (monto > 0), referencia text, comentario text,
  registrado_por text, registrado_at timestamptz not null default now());

create table if not exists credit_solvendom.mc_creditos (
  id serial primary key,
  folio text not null unique,
  solicitud_id int not null unique references credit_solvendom.mc_solicitudes(id),
  solicitante_id int not null references credit_solvendom.mc_solicitantes(id),
  producto_id int not null references credit_solvendom.mc_productos(id),
  estado text not null default 'formalizacion' check (estado in ('formalizacion','desembolso','vigente','liquidado','cancelado')),
  estado_desde timestamptz not null default now(),
  monto numeric not null, plazo_meses int not null, periodicidad text not null, tasa_anual numeric not null,
  tasa_moratoria numeric, comision_apertura numeric not null default 0, iva_pct numeric not null default 0.16, cat numeric,
  fecha_contrato date, fecha_desembolso date,
  beneficiario text, clabe_cifrada text, banco_codigo text, banco_nombre text,
  fondeo_id int references credit_solvendom.mc_fondeos(id),
  comentario_cierre text,
  version int not null default 1,
  es_ejemplo boolean not null default false,
  creado_por text, creado_at timestamptz not null default now(), actualizado_at timestamptz not null default now());
create index if not exists idx_mc_creditos_estado on credit_solvendom.mc_creditos(estado);

create table if not exists credit_solvendom.mc_firmas (
  id serial primary key,
  credito_id int not null references credit_solvendom.mc_creditos(id) on delete cascade,
  firmante text not null,
  calidad text not null check (calidad in ('acreditado','representante_legal','aval','obligado_solidario','la_sofom')),
  metodo text not null check (metodo in ('autografa','electronica')),
  fecha date not null, doc_hash text not null,
  archivo_nombre text, archivo_cifrado text,
  registrado_por text, registrado_at timestamptz not null default now());

create table if not exists credit_solvendom.mc_desembolsos (
  id serial primary key,
  credito_id int not null references credit_solvendom.mc_creditos(id) on delete cascade,
  monto numeric not null, comision numeric not null default 0, neto numeric not null,
  estado text not null default 'solicitado' check (estado in ('solicitado','autorizado','enviado','confirmado','cancelado')),
  fecha_prevista date,
  solicitado_por text, solicitado_at timestamptz not null default now(),
  autorizado_por text, autorizado_at timestamptz, autoaprobado boolean not null default false,
  enviado_por text, enviado_at timestamptz,
  referencia text, confirmado_por text, confirmado_at timestamptz, fecha_real date,
  comentario text);

create table if not exists credit_solvendom.mc_amortizacion (
  credito_id int not null references credit_solvendom.mc_creditos(id) on delete cascade,
  num int not null, fecha date not null, capital numeric not null, interes numeric not null, iva numeric not null, total numeric not null, saldo numeric not null,
  primary key (credito_id, num));

create table if not exists credit_solvendom.mc_movimientos_banco (
  id serial primary key,
  lote text not null, fecha date not null, descripcion text, referencia text, monto numeric not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','conciliado','ignorado')),
  pago_id int, nota text,
  importado_por text, importado_at timestamptz not null default now(), resuelto_por text, resuelto_at timestamptz);
create index if not exists idx_mc_mov_estado on credit_solvendom.mc_movimientos_banco(estado);

create table if not exists credit_solvendom.mc_pagos (
  id serial primary key,
  credito_id int not null references credit_solvendom.mc_creditos(id),
  fecha date not null, monto numeric not null check (monto > 0),
  medio text not null default 'spei' check (medio in ('spei','deposito','efectivo','tercero','otro')),
  referencia text,
  estado text not null default 'registrado' check (estado in ('registrado','cancelado')),
  mov_id int, comentario text,
  registrado_por text, registrado_at timestamptz not null default now(),
  cancelado_por text, cancelado_at timestamptz, motivo_cancelacion text);
create unique index if not exists uq_mc_pagos_ref on credit_solvendom.mc_pagos(lower(referencia)) where referencia is not null and estado <> 'cancelado';
create index if not exists idx_mc_pagos_credito on credit_solvendom.mc_pagos(credito_id, fecha);

create table if not exists credit_solvendom.mc_gestiones (
  id serial primary key,
  credito_id int not null references credit_solvendom.mc_creditos(id) on delete cascade,
  fecha date not null, tipo text not null check (tipo in ('llamada','visita','mensaje','correo','promesa','otro')),
  resultado text, comentario text,
  promesa_fecha date, promesa_monto numeric,
  proxima date, usuario text, creado_at timestamptz not null default now());

create table if not exists credit_solvendom.mc_cuentas (
  clave text primary key, nombre text not null, naturaleza text not null check (naturaleza in ('deudora','acreedora')));
insert into credit_solvendom.mc_cuentas(clave,nombre,naturaleza) values
  ('1101','Bancos','deudora'), ('1301','Cartera de crédito vigente','deudora'), ('1302','Cartera de crédito vencida','deudora'),
  ('1303','Intereses devengados por cobrar','deudora'), ('1304','Estimación preventiva para riesgos crediticios','acreedora'),
  ('2101','IVA trasladado','acreedora'), ('2201','Préstamos recibidos (fondeo)','acreedora'), ('2301','Acreedores diversos (saldos a favor)','acreedora'),
  ('4101','Ingresos por intereses','acreedora'), ('4102','Ingresos por comisiones','acreedora'), ('4103','Ingresos por intereses moratorios','acreedora'),
  ('5101','Estimación preventiva para riesgos crediticios (gasto)','deudora')
on conflict (clave) do nothing;

create table if not exists credit_solvendom.mc_periodos (
  periodo text primary key, estado text not null default 'abierto' check (estado in ('abierto','cerrado')),
  cerrado_por text, cerrado_at timestamptz, resumen jsonb, reabierto_por text, reabierto_at timestamptz);
create table if not exists credit_solvendom.mc_polizas (
  id serial primary key, periodo text not null, fecha date not null, tipo text not null, concepto text not null,
  origen text, origen_id text, creado_por text, creado_at timestamptz not null default now());
create index if not exists idx_mc_polizas_periodo on credit_solvendom.mc_polizas(periodo);
create table if not exists credit_solvendom.mc_poliza_lineas (
  poliza_id int not null references credit_solvendom.mc_polizas(id) on delete cascade,
  cuenta text not null references credit_solvendom.mc_cuentas(clave), debe numeric not null default 0, haber numeric not null default 0);

create table if not exists credit_solvendom.mc_uif (
  id serial primary key,
  tipo text not null check (tipo in ('relevante','inusual','interna_preocupante')),
  regla text not null,
  credito_id int references credit_solvendom.mc_creditos(id) on delete cascade, pago_id int,
  fecha date not null, monto numeric, descripcion text,
  estado text not null default 'detectada' check (estado in ('detectada','reportar','no_reportar','reportada')),
  dictamen text, dictaminado_por text, dictaminado_at timestamptz, reportado_at timestamptz, folio_acuse text,
  es_ejemplo boolean not null default false,
  creado_at timestamptz not null default now());
create unique index if not exists uq_mc_uif_regla on credit_solvendom.mc_uif(regla, coalesce(pago_id,0), coalesce(credito_id,0), fecha);

-- ============================================================================
-- Ingresos por facturar: corte semanal de comisiones por apertura e intereses cobrados, enviado por correo a contabilidad (como POS y Cards)
-- ============================================================================
create table if not exists credit_solvendom.mc_cortes_ingreso (
  id serial primary key,
  fecha_corte date not null, hasta date not null,
  origen text not null default 'MANUAL' check (origen in ('MANUAL','AUTOMATICO')),
  estado text not null default 'GENERADO' check (estado in ('GENERADO','ENVIADO')),
  resumen jsonb not null, detalle jsonb not null, totales jsonb not null,
  generado_por text, generado_at timestamptz not null default now(),
  enviado_por text, enviado_at timestamptz, enviado_a text, message_id text,
  es_ejemplo boolean not null default false);
create table if not exists credit_solvendom.mc_corte_items (
  id serial primary key,
  corte_id int references credit_solvendom.mc_cortes_ingreso(id) on delete set null,
  origen text not null check (origen in ('desembolso','pago','ajuste_pago')),
  origen_id int not null,
  tipo text not null check (tipo in ('comision_apertura','interes','moratorio','ajuste')),
  credito_id int not null, fecha date not null,
  base numeric not null, iva numeric not null, nota text,
  creado_at timestamptz not null default now());
create unique index if not exists uq_mc_corte_items on credit_solvendom.mc_corte_items(origen, origen_id, tipo);
create index if not exists idx_mc_corte_items_corte on credit_solvendom.mc_corte_items(corte_id);
create table if not exists credit_solvendom.mc_destinatarios (
  id serial primary key, email_hash text not null unique, email_cifrado text not null, nombre text,
  tipo text not null default 'to' check (tipo in ('to','cc','bcc')), activo boolean not null default true,
  creado_por text, creado_at timestamptz not null default now());
