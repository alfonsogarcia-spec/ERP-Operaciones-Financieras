'use strict';
/* Conexión a la BD.
   - Producción: el MISMO Supabase de ERP-Operaciones, aislado en el schema OFICINA_SCHEMA (default "oficina").
   - Desarrollo: pglite (Postgres en proceso, persiste en ./.pgdata) cuando no hay DATABASE_URL. */
const fs = require('fs');
const path = require('path');

const SCHEMA = (process.env.OFICINA_SCHEMA || 'oficina').replace(/[^a-zA-Z0-9_]/g, '') || 'oficina';
let backend = null;

// Quita SOLO sslmode de la query, sin tocar usuario:contraseña (cert autofirmado de Supabase).
function limpiarConn(url) {
  const at = url.lastIndexOf('@');
  const q = url.indexOf('?', at === -1 ? 0 : at);
  if (q === -1) return url;
  const params = url.slice(q + 1).split('&').filter(p => p && !/^sslmode=/i.test(p));
  return params.length ? url.slice(0, q) + '?' + params.join('&') : url.slice(0, q);
}

async function initDB() {
  const URL = process.env.DATABASE_URL || '';
  if (URL) {
    const { Pool } = require('pg');
    // 1) crear el schema con una conexión sin search_path
    const boot = new Pool({ connectionString: limpiarConn(URL), ssl: { require: true, rejectUnauthorized: false }, max: 1 });
    await boot.query(`create schema if not exists ${SCHEMA}`);
    await boot.end();
    // 2) pool definitivo: TODO va a SCHEMA, jamás a public
    const pool = new Pool({ connectionString: limpiarConn(URL), ssl: { require: true, rejectUnauthorized: false }, max: 4, options: '-c search_path=' + SCHEMA });
    pool.on('error', e => console.error('PG pool error', e.message));
    backend = { kind: `postgres (supabase) · schema "${SCHEMA}"`, query: (t, p) => pool.query(t, p || []), exec: sql => pool.query(sql) };
  } else {
    if (process.env.RENDER || process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL no configurada. En producción no se arranca la BD local.');
    }
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(path.join(__dirname, '..', '.pgdata'));
    await db.exec(`create schema if not exists ${SCHEMA}; set search_path to ${SCHEMA};`);
    backend = { kind: `pglite local · schema "${SCHEMA}"`, query: (t, p) => db.query(t, p || []), exec: sql => db.exec(sql) };
  }
  await backend.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return backend.kind;
}

module.exports = { initDB, q: (t, p) => backend.query(t, p), SCHEMA };
