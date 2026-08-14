/* ============================================================================
   scripts/importar-disputas.js — Importa contactos (por grupo) y reason codes
   desde un archivo Excel al módulo Disputas.

   Uso:
     node scripts/importar-disputas.js <ruta.xlsx> [--dry-run]

   Hojas esperadas:
     • "Reason codes"     — columnas: Marca, Código, Categoría, Título,
                            Descripción, Días representación, Evidencia sugerida,
                            Acción de política, Activo.
     • "Contactos grupos" — columnas: Grupo, Grupo activo, Contacto, Email,
                            Rol, Principal, Cc, Notifica.

   Idempotente:
     - Reason codes: upsert por (brand, codigo).
     - Client groups: upsert por nombre.
     - Contacts: dedup por (client_group_id, email_hash); actualiza si existe.
   ========================================================================= */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const XLSX = require('xlsx');
const db = require('../db/index.js');
const C = require('../lib/crypto.js');

const DRY = process.argv.includes('--dry-run');
const XLSX_PATH = process.argv[2] || '';
if (!XLSX_PATH) { console.error('Uso: node scripts/importar-disputas.js <ruta.xlsx> [--dry-run]'); process.exit(1); }
function log(...args) { console.log('[importar-disputas]', ...args); }
const truthy = v => /^(s[ií]|y|yes|true|1)$/i.test(String(v || '').trim());

async function main() {
  C.assertReady();
  await db.initDB();
  if (!db.isReady()) throw new Error('BD no lista');
  log('BD lista:', db.kind());
  log(DRY ? 'DRY-RUN — no se escribirán cambios' : 'ejecución REAL');

  const wb = XLSX.readFile(XLSX_PATH, { cellDates: true });
  const sheetRC = wb.Sheets['Reason codes'];
  const sheetCG = wb.Sheets['Contactos grupos'];
  if (!sheetRC || !sheetCG) throw new Error('Faltan hojas "Reason codes" o "Contactos grupos".');

  /* ---------- REASON CODES ---------- */
  const rcRows = XLSX.utils.sheet_to_json(sheetRC, { defval: '' });
  log(`--- Reason codes: ${rcRows.length} filas ---`);
  let rcNuevos = 0, rcActualizados = 0, rcOmitidos = 0;
  for (const r of rcRows) {
    const brand = String(r['Marca'] || '').trim().toUpperCase();
    const codigo = String(r['Código'] || '').trim();
    if (!brand || !codigo) { rcOmitidos++; continue; }
    const titulo = String(r['Título'] || '').trim();
    const desc = String(r['Descripción'] || '').trim() || titulo;
    const categoria = String(r['Categoría'] || '').trim();
    const dias = Number(r['Días representación']) || 30;
    const evidencia = String(r['Evidencia sugerida'] || '').trim();
    const politica = String(r['Acción de política'] || '').trim();
    const activo = truthy(r['Activo']);
    // Inferir card_presence de la categoría (heurística simple)
    let presence = 'CARD_NOT_PRESENT';
    const catL = categoria.toLowerCase();
    if (/tarjeta presente|presencial|emv|pin/.test(catL)) presence = 'CARD_PRESENT';
    else if (/ambos|mixto/.test(catL)) presence = 'AMBOS';
    if (DRY) { rcActualizados++; continue; }
    const existente = (await db.query('select id from disputa.reason_codes where brand=$1 and codigo=$2', [brand, codigo])).rows[0];
    if (existente) {
      await db.query(
        `update disputa.reason_codes set descripcion=$1, card_presence=$2, plazo_representacion_dias=$3, activo=$4,
         categoria=$5, titulo=$6, evidencia_sugerida=$7, accion_politica=$8, actualizado_at=now()
         where id=$9`,
        [desc, presence, dias, activo, categoria, titulo, evidencia, politica, existente.id]
      );
      rcActualizados++;
    } else {
      await db.query(
        `insert into disputa.reason_codes(brand, codigo, descripcion, card_presence, plazo_comercio_dias, plazo_representacion_dias, representable, activo, categoria, titulo, evidencia_sugerida, accion_politica)
         values($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11)`,
        [brand, codigo, desc, presence, 10, dias, activo, categoria, titulo, evidencia, politica]
      );
      rcNuevos++;
    }
  }
  log(`reason_codes: ${rcNuevos} nuevos · ${rcActualizados} actualizados · ${rcOmitidos} omitidos (sin brand+codigo)`);

  /* ---------- CONTACTOS AGRUPADOS ---------- */
  const cgRows = XLSX.utils.sheet_to_json(sheetCG, { defval: '' });
  log(`--- Contactos por grupo: ${cgRows.length} filas ---`);
  const gruposCache = new Map();  // nombre -> id
  let cgNuevos = 0, cgActualizados = 0, ctNuevos = 0, ctActualizados = 0, ctOmitidos = 0;

  async function upsertGrupo(nombre, activo) {
    if (gruposCache.has(nombre)) return gruposCache.get(nombre);
    const existente = (await db.query('select id from disputa.client_groups where nombre=$1', [nombre])).rows[0];
    if (existente) {
      if (!DRY) await db.query('update disputa.client_groups set activo=$1, actualizado_at=now() where id=$2', [activo, existente.id]);
      cgActualizados++;
      gruposCache.set(nombre, existente.id);
      return existente.id;
    }
    if (DRY) { cgNuevos++; gruposCache.set(nombre, -1); return -1; }
    const r = await db.query('insert into disputa.client_groups(nombre, activo) values($1,$2) returning id', [nombre, activo]);
    cgNuevos++;
    gruposCache.set(nombre, r.rows[0].id);
    return r.rows[0].id;
  }

  for (const r of cgRows) {
    const grupoNom = String(r['Grupo'] || '').trim();
    const email = String(r['Email'] || '').trim().toLowerCase();
    if (!grupoNom || !email) { ctOmitidos++; continue; }
    const grupoActivo = truthy(r['Grupo activo']);
    const contactoNom = String(r['Contacto'] || '').trim();
    const rol = String(r['Rol'] || '').trim();
    const esPrincipal = truthy(r['Principal']);
    const esCc = truthy(r['Cc']);
    const notifica = truthy(r['Notifica']);

    const grupoId = await upsertGrupo(grupoNom, grupoActivo);
    if (DRY) { ctNuevos++; continue; }
    const emailHash = C.hmacEmail(email);
    const existe = (await db.query('select id from disputa.contacts where client_group_id=$1 and email_hash=$2', [grupoId, emailHash])).rows[0];
    if (existe) {
      await db.query(
        `update disputa.contacts set nombre=$1, nombre_cifrado=$2, rol=$3, email=$4, email_cifrado=$5,
         es_principal=$6, es_cc=$7, notifica=$8, activo=true, actualizado_at=now() where id=$9`,
        [contactoNom, C.encrypt(contactoNom), rol, email, C.encrypt(email), esPrincipal, esCc, notifica, existe.id]
      );
      ctActualizados++;
    } else {
      await db.query(
        `insert into disputa.contacts(client_group_id, nombre, nombre_cifrado, rol, email, email_cifrado, email_hash,
         es_principal, es_cc, notifica, activo)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
        [grupoId, contactoNom, C.encrypt(contactoNom), rol, email, C.encrypt(email), emailHash, esPrincipal, esCc, notifica]
      );
      ctNuevos++;
    }
  }
  log(`client_groups: ${cgNuevos} nuevos · ${cgActualizados} actualizados`);
  log(`contacts: ${ctNuevos} nuevos · ${ctActualizados} actualizados · ${ctOmitidos} omitidos`);
  if (DRY) log('DRY-RUN listo. Ejecuta sin --dry-run para aplicar.');
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
