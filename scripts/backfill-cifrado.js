/* ============================================================================
   scripts/backfill-cifrado.js — Backfill de columnas cifradas (Fase 2).

   Uso:
     node scripts/backfill-cifrado.js [--dry-run] [--batch=200]

   Idempotente: solo actualiza filas donde la columna cifrada esté NULL pero la
   columna en claro tenga contenido. Se puede correr N veces sin efectos raros.

   Fuente de conexión: la misma que server.js (db/index.js). Si DATABASE_URL
   está definida, corre contra Supabase; si no, contra pglite local (./.pgdata).

   ATENCIÓN: en prod, correr solo cuando ENCRYPTION_KEY_V1 y HMAC_PEPPER estén
   configuradas en el entorno; si faltan, el script aborta.
   ========================================================================= */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const db = require('../db/index.js');
const C = require('../lib/crypto.js');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const BATCH = parseInt((process.argv.find(a => a.startsWith('--batch=')) || '').split('=')[1] || '200', 10);

function log(...args) { console.log('[backfill]', ...args); }

async function migrate() {
  await db.initDB();
  if (!db.isReady()) throw new Error('BD no lista');
  log('BD lista:', db.kind());
}

async function backfillUsuarios() {
  const rows = (await db.query("select id, email, nombre from usuarios where email_hash is null and email is not null")).rows;
  if (!rows.length) { log('usuarios: nada por cifrar'); return { total: 0, procesadas: 0 }; }
  log(`usuarios: ${rows.length} filas por cifrar`);
  if (DRY) return { total: rows.length, procesadas: 0 };
  let n = 0;
  for (const r of rows) {
    await db.query(
      'update usuarios set email_hash=$2, email_cifrado=$3, nombre_cifrado=$4 where id=$1',
      [r.id, C.hmacEmail(r.email), C.encrypt(r.email), C.encrypt(r.nombre)]
    );
    n++;
    if (n % 50 === 0) log(`  usuarios ${n}/${rows.length}`);
  }
  log(`usuarios: ${n} procesadas`);
  return { total: rows.length, procesadas: n };
}

async function backfillDestinatarios() {
  const rows = (await db.query("select id, email, nombre from destinatarios where email_hash is null and email is not null")).rows;
  if (!rows.length) { log('destinatarios: nada por cifrar'); return { total: 0, procesadas: 0 }; }
  log(`destinatarios: ${rows.length} filas por cifrar`);
  if (DRY) return { total: rows.length, procesadas: 0 };
  let n = 0;
  for (const r of rows) {
    await db.query(
      'update destinatarios set email_hash=$2, email_cifrado=$3, nombre_cifrado=$4 where id=$1',
      [r.id, C.hmacEmail(r.email), C.encrypt(r.email), C.encrypt(r.nombre || '')]
    );
    n++;
  }
  log(`destinatarios: ${n} procesadas`);
  return { total: rows.length, procesadas: n };
}

async function backfillCuentas() {
  // Necesita backfill si CUALQUIERA de las columnas cifradas está NULL y la original tiene valor.
  const rows = (await db.query(`
    select id, clabe, banco, razon_social_beneficiario
    from cuentas
    where (clabe_hash is null and clabe is not null and clabe <> '')
       or (clabe_cifrada is null and clabe is not null and clabe <> '')
       or (banco_cifrado is null and banco is not null)
       or (razon_social_beneficiario_cifrada is null and razon_social_beneficiario is not null)
  `)).rows;
  if (!rows.length) { log('cuentas: nada por cifrar'); return { total: 0, procesadas: 0 }; }
  log(`cuentas: ${rows.length} filas por cifrar`);
  if (DRY) return { total: rows.length, procesadas: 0 };
  let n = 0;
  for (const r of rows) {
    const cl = r.clabe && r.clabe.trim() ? r.clabe : null;
    await db.query(
      'update cuentas set clabe_hash=$2, clabe_cifrada=$3, banco_cifrado=$4, razon_social_beneficiario_cifrada=$5 where id=$1',
      [r.id, cl ? C.hmac(cl) : null, cl ? C.encrypt(cl) : null, C.encrypt(r.banco || ''), C.encrypt(r.razon_social_beneficiario || '')]
    );
    n++;
  }
  log(`cuentas: ${n} procesadas`);
  return { total: rows.length, procesadas: n };
}

async function backfillAfiliaciones() {
  const rows = (await db.query("select numero_afiliacion, razon_social from afiliaciones where razon_social_cifrada is null and razon_social is not null")).rows;
  if (!rows.length) { log('afiliaciones: nada por cifrar'); return { total: 0, procesadas: 0 }; }
  log(`afiliaciones: ${rows.length} filas por cifrar`);
  if (DRY) return { total: rows.length, procesadas: 0 };
  let n = 0;
  for (const r of rows) {
    await db.query('update afiliaciones set razon_social_cifrada=$2 where numero_afiliacion=$1', [r.numero_afiliacion, C.encrypt(r.razon_social)]);
    n++;
  }
  log(`afiliaciones: ${n} procesadas`);
  return { total: rows.length, procesadas: n };
}

async function backfillContracargos() {
  const rows = (await db.query("select id, ultimos_4 from contracargos where ultimos_4_cifrada is null and ultimos_4 is not null")).rows;
  if (!rows.length) { log('contracargos: nada por cifrar'); return { total: 0, procesadas: 0 }; }
  log(`contracargos: ${rows.length} filas por cifrar`);
  if (DRY) return { total: rows.length, procesadas: 0 };
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    for (const r of chunk) {
      await db.query('update contracargos set ultimos_4_cifrada=$2 where id=$1', [r.id, C.encrypt(r.ultimos_4)]);
      n++;
    }
    log(`  contracargos ${n}/${rows.length}`);
  }
  log(`contracargos: ${n} procesadas`);
  return { total: rows.length, procesadas: n };
}

async function backfillContracargosReporte() {
  const rows = (await db.query("select fecha::text as fecha, archivo_bytes from contracargos_reporte_dia where archivo_bytes_cifrado is null and archivo_bytes is not null")).rows;
  if (!rows.length) { log('contracargos_reporte_dia: nada por cifrar'); return { total: 0, procesadas: 0 }; }
  log(`contracargos_reporte_dia: ${rows.length} filas por cifrar`);
  if (DRY) return { total: rows.length, procesadas: 0 };
  let n = 0;
  for (const r of rows) {
    const buf = Buffer.isBuffer(r.archivo_bytes) ? r.archivo_bytes : Buffer.from(r.archivo_bytes);
    const cif = Buffer.from(C.encrypt(buf), 'utf8');
    await db.query('update contracargos_reporte_dia set archivo_bytes_cifrado=$2 where fecha=$1', [r.fecha, cif]);
    n++;
    log(`  reporte ${r.fecha}: ${buf.length} bytes → cifrado ${cif.length} bytes`);
  }
  log(`contracargos_reporte_dia: ${n} procesadas`);
  return { total: rows.length, procesadas: n };
}

async function verify() {
  log('--- verificación post-backfill ---');
  const checks = [
    ['usuarios sin cifrar', "select count(*)::int as n from usuarios where email_hash is null and email is not null"],
    ['destinatarios sin cifrar', "select count(*)::int as n from destinatarios where email_hash is null and email is not null"],
    ['cuentas sin cifrar', "select count(*)::int as n from cuentas where (clabe is not null and clabe<>'' and clabe_hash is null)"],
    ['afiliaciones sin cifrar', "select count(*)::int as n from afiliaciones where razon_social is not null and razon_social_cifrada is null"],
    ['contracargos sin cifrar', "select count(*)::int as n from contracargos where ultimos_4 is not null and ultimos_4_cifrada is null"],
    ['reportes contracargos sin cifrar', "select count(*)::int as n from contracargos_reporte_dia where archivo_bytes is not null and archivo_bytes_cifrado is null"],
  ];
  let all = true;
  for (const [label, q] of checks) {
    const n = (await db.query(q)).rows[0].n;
    log(`  ${label}: ${n}`);
    if (n > 0) all = false;
  }
  return all;
}

(async () => {
  try {
    C.assertReady();
  } catch (e) {
    console.error('ABORT:', e.message, '— configura ENCRYPTION_KEY_V1 y HMAC_PEPPER en el entorno antes de correr.');
    process.exit(1);
  }
  await migrate();
  log(DRY ? 'DRY-RUN — no se harán cambios' : 'ejecución real');
  const t0 = Date.now();
  const r = {
    usuarios: await backfillUsuarios(),
    destinatarios: await backfillDestinatarios(),
    cuentas: await backfillCuentas(),
    afiliaciones: await backfillAfiliaciones(),
    contracargos: await backfillContracargos(),
    reportes: await backfillContracargosReporte(),
  };
  const total = Object.values(r).reduce((s, x) => s + x.procesadas, 0);
  const totalMax = Object.values(r).reduce((s, x) => s + x.total, 0);
  log(`--- resumen: ${total}/${totalMax} filas procesadas en ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
  if (!DRY) {
    const ok = await verify();
    log(ok ? '✓ TODO OK — no quedan filas sin cifrar' : '✗ ATENCIÓN: quedan filas sin cifrar (revisar arriba)');
    process.exit(ok ? 0 : 2);
  } else {
    process.exit(0);
  }
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
