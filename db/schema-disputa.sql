-- ============================================================================
-- Módulo Disputas (Contracargos + Refunds + Duplicates)
-- Portado desde el sistema Python de Contracargos.
-- Schema aislado 'disputa' — no toca 'conciliacion' ni 'public'.
--
-- Convenciones:
-- • Cifrado app-layer: columnas con sufijo _cifrado guardan v1:iv:ct:tag (AES-256-GCM).
-- • Hash determinístico: columnas _hash guardan hm1:hexdigest (HMAC-SHA256).
-- • timestamps: creado_at / actualizado_at.
-- • Estados como TEXT con CHECK (más flexibles que enums al agregar valores).
-- • FKs con ON DELETE de acuerdo al ciclo de vida.
-- ============================================================================

create schema if not exists disputa;
set search_path to disputa;

-- ---------------------------------------------------------------------------
-- Proveedores (adquirente / gateway / manual). Cada uno tiene un conector.
-- ---------------------------------------------------------------------------
create table if not exists disputa.providers (
  id             serial primary key,
  nombre         text not null,
  tipo           text not null default 'MANUAL'   -- ACQUIRER | PROCESSOR | GATEWAY | MANUAL
    check (tipo in ('ACQUIRER','PROCESSOR','GATEWAY','MANUAL')),
  conector       text default 'manual',            -- 'broxel' | 'generic_rest' | 'manual'
  config         jsonb not null default '{}',      -- URLs, headers, params del conector
  webhook_token_hash text,                         -- HMAC del token del webhook (auth ingesta)
  activo         boolean not null default true,
  ultima_sync    timestamptz,
  creado_at      timestamptz default now(),
  actualizado_at timestamptz default now()
);
create index if not exists idx_providers_webhook_hash on disputa.providers(webhook_token_hash);

-- ---------------------------------------------------------------------------
-- Comercios / merchants (agrupables por client_group).
-- Datos sensibles cifrados; nombre_hash para búsqueda por igualdad.
-- ---------------------------------------------------------------------------
create table if not exists disputa.merchants (
  id                    serial primary key,
  nombre                text,                        -- plaintext (búsqueda LIKE en front)
  nombre_cifrado        text,                        -- cifrado (fuente de verdad tras cutover)
  nombre_hash           text,                        -- hash para dedup por igualdad
  afiliacion            text,                        -- número de afiliación (dedup)
  afiliacion_hash       text,
  external_id           text,                        -- id externo del proveedor
  provider_id           integer references disputa.providers(id) on delete set null,
  client_group_id       integer,                     -- FK a client_groups (definido abajo)
  activo                boolean not null default true,
  creado_at             timestamptz default now(),
  actualizado_at        timestamptz default now()
);
create unique index if not exists ux_merchants_afil_hash on disputa.merchants(afiliacion_hash) where afiliacion_hash is not null;
create index if not exists idx_merchants_group on disputa.merchants(client_group_id);
create index if not exists idx_merchants_provider on disputa.merchants(provider_id);

-- ---------------------------------------------------------------------------
-- Client groups: agrupa comercios bajo el mismo contacto responsable.
-- ---------------------------------------------------------------------------
create table if not exists disputa.client_groups (
  id            serial primary key,
  nombre        text not null,
  descripcion   text,
  activo        boolean not null default true,
  creado_at     timestamptz default now(),
  actualizado_at timestamptz default now()
);
do $$ begin
  alter table disputa.merchants
    add constraint fk_merchant_group foreign key (client_group_id)
    references disputa.client_groups(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Contactos por comercio / grupo — email cifrado + hash para lookup.
-- ---------------------------------------------------------------------------
create table if not exists disputa.contacts (
  id                serial primary key,
  merchant_id       integer references disputa.merchants(id) on delete cascade,
  client_group_id   integer references disputa.client_groups(id) on delete cascade,
  nombre            text,
  nombre_cifrado    text,
  rol               text,                            -- Disputas / Operaciones / etc.
  email             text,
  email_cifrado     text,
  email_hash        text,                            -- para dedup por email
  telefono_cifrado  text,
  es_principal      boolean not null default false,
  activo            boolean not null default true,
  creado_at         timestamptz default now(),
  actualizado_at    timestamptz default now(),
  check (merchant_id is not null or client_group_id is not null)
);
-- Campos adicionales del catálogo interno de contactos (canal de aviso).
alter table disputa.contacts add column if not exists es_cc     boolean not null default false;
alter table disputa.contacts add column if not exists notifica  boolean not null default true;
create index if not exists idx_contacts_merchant on disputa.contacts(merchant_id);
create index if not exists idx_contacts_group on disputa.contacts(client_group_id);
create index if not exists idx_contacts_email_hash on disputa.contacts(email_hash);

-- ---------------------------------------------------------------------------
-- Reason codes: catálogo por red (Visa/MC/AMEX/CID) con plazos editables.
-- ---------------------------------------------------------------------------
create table if not exists disputa.reason_codes (
  id                       serial primary key,
  brand                    text not null,                -- VISA | MASTERCARD | AMEX | CID
  codigo                   text not null,                -- "10.4", "4837", "C08", "2001"
  descripcion              text not null,
  card_presence            text default 'CARD_NOT_PRESENT',  -- CARD_PRESENT | CARD_NOT_PRESENT | AMBOS
  plazo_comercio_dias      integer default 10,           -- días para responder el comercio
  plazo_representacion_dias integer default 30,          -- días para representar
  representable            boolean not null default true,
  activo                   boolean not null default true,
  creado_at                timestamptz default now(),
  actualizado_at           timestamptz default now(),
  unique(brand, codigo)
);
create index if not exists idx_reason_brand on disputa.reason_codes(brand);
-- Campos ricos importados del catálogo interno (categoría de reason, evidencia
-- sugerida y acción de política) para ayudar al operador en la disputa.
alter table disputa.reason_codes add column if not exists categoria         text;
alter table disputa.reason_codes add column if not exists titulo            text;
alter table disputa.reason_codes add column if not exists evidencia_sugerida text;
alter table disputa.reason_codes add column if not exists accion_politica   text;

-- ---------------------------------------------------------------------------
-- Transacciones vinculables (para asociar el CB con la venta original).
-- ---------------------------------------------------------------------------
create table if not exists disputa.transactions (
  id                serial primary key,
  merchant_id       integer references disputa.merchants(id) on delete set null,
  external_id       text,                          -- ID en el sistema del proveedor
  external_id_hash  text,                          -- dedup en ingesta
  reference         text,                          -- referencia de venta
  reference_hash    text,
  fecha             date,
  hora              text,
  brand             text,                          -- VISA/MC/AMEX/etc.
  channel           text default 'OTHER',          -- POS/ECOMMERCE/MOTO/RECURRING/OTHER
  card_last4_cifrada text,                         -- últimos 4 cifrados
  amount_cifrado    text,                          -- monto cifrado
  currency_code     text default 'MXN',
  authorization_code      text,
  authorization_code_hash text,
  creado_at         timestamptz default now()
);
create index if not exists idx_tx_merchant on disputa.transactions(merchant_id);
create index if not exists idx_tx_external_hash on disputa.transactions(external_id_hash);
create index if not exists idx_tx_reference_hash on disputa.transactions(reference_hash);

-- ---------------------------------------------------------------------------
-- CHARGEBACKS: la entidad central. Ciclo completo de disputa.
-- ---------------------------------------------------------------------------
create table if not exists disputa.chargebacks (
  id                        serial primary key,
  folio                     text not null unique,               -- CB-YYYY-NNNNNN (interno legible)
  folio_hash                text,                               -- para búsqueda determinística
  provider_id               integer references disputa.providers(id) on delete set null,
  merchant_id               integer references disputa.merchants(id) on delete set null,
  client_group_id           integer references disputa.client_groups(id) on delete set null,
  transaction_id            integer references disputa.transactions(id) on delete set null,
  reason_code_id            integer references disputa.reason_codes(id) on delete set null,

  external_id               text,                                -- ID en el sistema del proveedor
  external_id_hash          text,                                -- dedup en ingesta
  arn                       text,                                -- Acquirer Reference Number
  arn_cifrado               text,
  arn_hash                  text,
  case_number               text,
  case_number_cifrado       text,

  brand                     text default 'OTHER',
  card_presence             text default 'CARD_NOT_PRESENT',
  channel                   text default 'OTHER',
  cycle                     text default 'FIRST_CHARGEBACK'      -- RETRIEVAL/FIRST_CHARGEBACK/REPRESENTMENT/PRE_ARBITRATION/ARBITRATION
    check (cycle in ('RETRIEVAL','FIRST_CHARGEBACK','REPRESENTMENT','PRE_ARBITRATION','ARBITRATION')),
  status                    text not null default 'NEW'
    check (status in ('NEW','NOTIFIED','EVIDENCE_REQUESTED','UNDER_REVIEW','REPRESENTED','IN_DISPUTE','WON','LOST','ACCEPTED','EXPIRED','CANCELLED')),

  reason_code_raw           text,                                -- código "crudo" del proveedor
  reason_description        text,

  disputed_amount_cifrado   text,                                -- monto cifrado
  currency_code             text default 'MXN',

  merchant_name             text,                                -- fallback si no hay merchant_id
  merchant_name_cifrado     text,
  merchant_affiliation      text,
  merchant_affiliation_hash text,

  fecha_evento              date,                                -- fecha del contracargo en la red
  fecha_recepcion           date default current_date,           -- cuándo lo recibimos
  fecha_limite_comercio     date,                                -- plazo para respuesta del comercio
  fecha_limite_representacion date,                              -- plazo para representar
  fecha_cierre              date,                                -- cuando se resolvió

  origen                    text default 'manual',               -- 'manual' | 'api' | 'webhook'
  archivado                 boolean not null default false,
  retenido                  boolean not null default false,      -- descontado del comercio
  creado_por                text,
  creado_at                 timestamptz default now(),
  actualizado_at            timestamptz default now(),
  unique (provider_id, external_id)                              -- dedup por proveedor
);
create index if not exists idx_cb_status on disputa.chargebacks(status);
create index if not exists idx_cb_cycle on disputa.chargebacks(cycle);
create index if not exists idx_cb_merchant on disputa.chargebacks(merchant_id);
create index if not exists idx_cb_group on disputa.chargebacks(client_group_id);
create index if not exists idx_cb_reason on disputa.chargebacks(reason_code_id);
create index if not exists idx_cb_fecha_evento on disputa.chargebacks(fecha_evento desc);
create index if not exists idx_cb_limite_com on disputa.chargebacks(fecha_limite_comercio) where status not in ('WON','LOST','ACCEPTED','EXPIRED','CANCELLED');
create index if not exists idx_cb_folio_hash on disputa.chargebacks(folio_hash);
create index if not exists idx_cb_arn_hash on disputa.chargebacks(arn_hash);

-- Campos del formulario "Registrar contracargo" (SS oficial): notas operativas
-- y datos de la transacción original (para reconciliación y evidencia).
alter table disputa.chargebacks add column if not exists notas                     text;
alter table disputa.chargebacks add column if not exists tx_fecha                  date;
alter table disputa.chargebacks add column if not exists tx_referencia             text;
alter table disputa.chargebacks add column if not exists tx_referencia_hash        text;
alter table disputa.chargebacks add column if not exists tx_autorizacion_cifrada   text;
alter table disputa.chargebacks add column if not exists tx_autorizacion_hash      text;
alter table disputa.chargebacks add column if not exists tx_last4_cifrada          text;
alter table disputa.chargebacks add column if not exists tx_monto_cifrado          text;
alter table disputa.chargebacks add column if not exists tx_tipo_tarjeta           text;
alter table disputa.chargebacks add column if not exists tx_banco_emisor           text;

-- Bitácora de eventos del ciclo de vida del chargeback.
create table if not exists disputa.chargeback_events (
  id                serial primary key,
  chargeback_id     integer not null references disputa.chargebacks(id) on delete cascade,
  ts                timestamptz default now(),
  tipo              text not null,                     -- status_change | notified | note | evidence_added | representation | resolution
  estado_anterior   text,
  estado_nuevo      text,
  actor             text,                              -- 'sistema' | usuario
  detalle           text,
  detalle_cifrado   text,                              -- si el detalle contiene PII sensible
  meta              jsonb                              -- payload opcional (ej. fields cambiados)
);
create index if not exists idx_cb_events_cb on disputa.chargeback_events(chargeback_id, ts desc);

-- ---------------------------------------------------------------------------
-- REFUNDS SOSPECHOSAS: devoluciones que el adquirente reporta y necesitan
-- confirmación del comercio.
-- ---------------------------------------------------------------------------
create table if not exists disputa.refunds (
  id                        serial primary key,
  folio                     text not null unique,      -- REF-YYYY-NNNNNN
  folio_hash                text,
  provider_id               integer references disputa.providers(id) on delete set null,
  merchant_id               integer references disputa.merchants(id) on delete set null,
  client_group_id           integer references disputa.client_groups(id) on delete set null,

  external_id               text,
  external_id_hash          text,
  reference_original        text,                       -- referencia de la venta original
  reference_original_hash   text,

  amount_cifrado            text,
  currency_code             text default 'MXN',
  fecha_reporte             date default current_date,
  fecha_limite_respuesta    date,                       -- 3 días hábiles por default

  status                    text not null default 'NEW'
    check (status in ('NEW','NOTIFIED','ANSWERED','EXPIRED','CANCELLED')),
  decision                  text                        -- PROCEDE | NO_PROCEDE (cuando answered)
    check (decision is null or decision in ('PROCEDE','NO_PROCEDE')),

  origen                    text default 'manual',
  creado_por                text,
  creado_at                 timestamptz default now(),
  actualizado_at            timestamptz default now()
);
create index if not exists idx_ref_status on disputa.refunds(status);
create index if not exists idx_ref_merchant on disputa.refunds(merchant_id);
create index if not exists idx_ref_limite on disputa.refunds(fecha_limite_respuesta) where status in ('NEW','NOTIFIED');

create table if not exists disputa.refund_events (
  id                serial primary key,
  refund_id         integer not null references disputa.refunds(id) on delete cascade,
  ts                timestamptz default now(),
  tipo              text not null,
  estado_anterior   text,
  estado_nuevo      text,
  actor             text,
  detalle           text,
  meta              jsonb
);
create index if not exists idx_ref_events_ref on disputa.refund_events(refund_id, ts desc);

-- ---------------------------------------------------------------------------
-- DUPLICATES: transacciones sospechosas de doble cobro.
-- ---------------------------------------------------------------------------
create table if not exists disputa.duplicates (
  id                        serial primary key,
  folio                     text not null unique,      -- DUP-YYYY-NNNNNN
  folio_hash                text,
  merchant_id               integer references disputa.merchants(id) on delete set null,
  client_group_id           integer references disputa.client_groups(id) on delete set null,

  transaction_a_id          integer references disputa.transactions(id) on delete set null,
  transaction_b_id          integer references disputa.transactions(id) on delete set null,
  campos_coincidentes       jsonb,                     -- lista de campos que dieron match
  diferencia_segundos       integer,                   -- diferencia de tiempo entre A y B

  status                    text not null default 'NEW'
    check (status in ('NEW','NOTIFIED','ANSWERED','EXPIRED','CANCELLED')),
  decision                  text
    check (decision is null or decision in ('DUPLICADA','NO_DUPLICADA')),

  fecha_reporte             date default current_date,
  fecha_limite_respuesta    date,

  origen                    text default 'manual',
  creado_por                text,
  creado_at                 timestamptz default now(),
  actualizado_at            timestamptz default now()
);
create index if not exists idx_dup_status on disputa.duplicates(status);
create index if not exists idx_dup_merchant on disputa.duplicates(merchant_id);
create index if not exists idx_dup_limite on disputa.duplicates(fecha_limite_respuesta) where status in ('NEW','NOTIFIED');

create table if not exists disputa.duplicate_events (
  id                serial primary key,
  duplicate_id      integer not null references disputa.duplicates(id) on delete cascade,
  ts                timestamptz default now(),
  tipo              text not null,
  estado_anterior   text,
  estado_nuevo      text,
  actor             text,
  detalle           text,
  meta              jsonb
);
create index if not exists idx_dup_events_dup on disputa.duplicate_events(duplicate_id, ts desc);

-- ---------------------------------------------------------------------------
-- Attachments (evidencia por chargeback / refund / duplicate).
-- Se guarda bytea cifrado; el nombre + mime queda en claro para listado.
-- ---------------------------------------------------------------------------
create table if not exists disputa.attachments (
  id             serial primary key,
  chargeback_id  integer references disputa.chargebacks(id) on delete cascade,
  refund_id      integer references disputa.refunds(id) on delete cascade,
  duplicate_id   integer references disputa.duplicates(id) on delete cascade,
  filename       text not null,
  mime           text,
  bytes_cifrado  bytea not null,                       -- contenido cifrado con C.encrypt(buf)
  bytes_size     integer,                              -- tamaño ORIGINAL en bytes (info)
  sha256_hash    text,                                 -- hash del plaintext (integridad)
  descripcion    text,
  subido_por     text,
  subido_at      timestamptz default now(),
  check (chargeback_id is not null or refund_id is not null or duplicate_id is not null)
);
create index if not exists idx_att_cb on disputa.attachments(chargeback_id);
create index if not exists idx_att_ref on disputa.attachments(refund_id);
create index if not exists idx_att_dup on disputa.attachments(duplicate_id);

-- ---------------------------------------------------------------------------
-- Notifications: registro de correos SES enviados por caso.
-- ---------------------------------------------------------------------------
create table if not exists disputa.notifications (
  id             serial primary key,
  chargeback_id  integer references disputa.chargebacks(id) on delete cascade,
  refund_id      integer references disputa.refunds(id) on delete cascade,
  duplicate_id   integer references disputa.duplicates(id) on delete cascade,
  destinatario_cifrado text not null,                  -- correo destino cifrado
  destinatario_hash    text not null,                  -- hash para búsqueda
  subject_cifrado text,
  status         text not null default 'PENDING'
    check (status in ('PENDING','SENT','FAILED')),
  message_id     text,                                  -- Message-ID de SES
  error          text,
  enviado_por    text,
  enviado_at     timestamptz,
  creado_at      timestamptz default now()
);
create index if not exists idx_notif_cb on disputa.notifications(chargeback_id);
create index if not exists idx_notif_ref on disputa.notifications(refund_id);
create index if not exists idx_notif_dup on disputa.notifications(duplicate_id);
create index if not exists idx_notif_hash on disputa.notifications(destinatario_hash);

-- ---------------------------------------------------------------------------
-- Email settings del módulo (remitente, plantillas, footer específico de disputas).
-- Un registro por instancia. Simple key/value.
-- ---------------------------------------------------------------------------
create table if not exists disputa.email_settings (
  id             integer primary key default 1,
  from_email     text default 'ops.agregador@polipay.io',
  from_name      text default 'Polipay · Operaciones · MCEB',
  reply_to       text,
  footer_html    text,
  actualizado_por text,
  actualizado_at timestamptz default now()
);
insert into disputa.email_settings(id) values(1) on conflict(id) do nothing;

-- Volver al search_path por defecto para no afectar otras migraciones.
set search_path to public;
