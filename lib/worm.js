/* ============================================================================
   lib/worm.js — Snapshot diario de la bitácora enviado por correo cifrado.
   Sprint 3.3 (variante sin AWS).

   Cada día (auto o manual): serializa la bitácora del día en JSONL,
   calcula SHA-256 del texto plano, cifra con AES-256-GCM (misma llave
   que el resto del sistema) y adjunta al correo enviado a los admins.

   El adjunto es un archivo binario:
     • Nombre: bitacora_YYYY-MM-DD.jsonl.enc
     • Formato: bytes brutos de encrypt() (versionado v1:iv:ct:tag).
     • Para leerlo, un admin necesita ENCRYPTION_KEY_V1 + la utilería
       node -e (documentado en el correo).

   No re-envía el mismo día (checa worm_snapshots.fecha).
   ========================================================================= */
'use strict';
const crypto = require('crypto');

function toJsonl(rows) {
  return rows.map(r => JSON.stringify(r)).join('\n');
}
function isoDia(d) { return d.toISOString().slice(0, 10); }
function ayerUTC() { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d; }

// dep: { db, C }
async function armarSnapshot(dep, fechaISO) {
  const rows = (await dep.db.query('select id, ts, usuario, rol, accion, detalle, ip, user_agent, session_jti, resource_type, resource_id, success, prev_hash, row_hash from bitacora where ts >= $1 and ts < ($1::date + interval \'1 day\') order by id asc', [fechaISO])).rows;
  // Si el día no tuvo actividad, guardamos un marcador explícito (evita cifrar cadena vacía y deja constancia del día).
  const jsonl = rows.length ? toJsonl(rows) : JSON.stringify({ marker: 'sin_eventos', fecha: fechaISO, generado_at: new Date().toISOString() });
  const hash = crypto.createHash('sha256').update(jsonl, 'utf8').digest('hex');
  const cifrado = dep.C.encrypt(jsonl);            // string "v1:iv:ct:tag"
  const bytes = Buffer.from(cifrado, 'utf8');       // adjunto binario
  return { fecha: fechaISO, n_registros: rows.length, hash, bytes };
}

// dep: { db, C, adminEmails, sendSES, armarWormHTML, inlineImages }
async function ejecutar(dep, fechaISO, origen) {
  origen = origen || 'auto';
  // Ya se envió este día?
  const ya = (await dep.db.query('select fecha from worm_snapshots where fecha=$1', [fechaISO])).rows[0];
  if (ya) return { ok: false, motivo: 'ya_enviado', fecha: fechaISO };
  const snap = await armarSnapshot(dep, fechaISO);
  const to = await dep.adminEmails();
  if (!to.length) return { ok: false, motivo: 'sin_admins' };
  const { subject, html, textFallback } = dep.armarWormHTML({
    fecha: fechaISO,
    n_registros: snap.n_registros,
    hash: snap.hash,
    bytes: snap.bytes.length,
    origen,
  });
  const messageId = await dep.sendSES({
    to,
    subject,
    html,
    textFallback,
    inlineImages: dep.inlineImages,
    attachments: [{ filename: `bitacora_${fechaISO}.jsonl.enc`, contentType: 'application/octet-stream', content: snap.bytes }],
  });
  await dep.db.query(
    'insert into worm_snapshots(fecha, n_registros, hash_sha256, bytes_cifrado, enviado_a, message_id, origen) values($1,$2,$3,$4,$5,$6,$7)',
    [fechaISO, snap.n_registros, snap.hash, snap.bytes.length, to.join(', '), messageId, origen]
  );
  return { ok: true, fecha: fechaISO, n_registros: snap.n_registros, bytes: snap.bytes.length, hash: snap.hash, messageId, enviados_a: to.length };
}

// Al arrancar server, agenda un check cada 15 min. Si ya son ≥03:00 UTC y
// no hay snapshot de ayer, ejecuta uno.
function agendar(dep) {
  const HABILITADO = String(process.env.WORM_HABILITADO || 'true').toLowerCase() !== 'false';
  if (!HABILITADO) return;
  const revisar = async () => {
    try {
      const now = new Date();
      if (now.getUTCHours() < 3) return;   // esperar hasta 3am UTC
      const ayerISO = isoDia(ayerUTC());
      const ya = (await dep.db.query('select fecha from worm_snapshots where fecha=$1', [ayerISO])).rows[0];
      if (ya) return;
      const r = await ejecutar(dep, ayerISO, 'auto');
      if (r.ok) console.log(`[worm] snapshot ${ayerISO} enviado: ${r.n_registros} registros, ${r.bytes} bytes`);
    } catch (_e) { /* silencioso; se reintentará en el siguiente tick */ }
  };
  // primer intento a los 60s, después cada 15 min
  setTimeout(revisar, 60 * 1000);
  setInterval(revisar, 15 * 60 * 1000);
}

module.exports = { armarSnapshot, ejecutar, agendar, isoDia, ayerUTC };
