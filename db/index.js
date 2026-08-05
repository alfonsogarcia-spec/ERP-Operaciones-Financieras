/* ============================================================================
   db/index.js — Adaptador de base de datos.
   - Producción: Postgres (Supabase) vía `pg` cuando hay DATABASE_URL.
   - Desarrollo: pglite (Postgres real en proceso, persiste en ./.pgdata) sin
     necesidad de servicio externo.
   Ambos exponen query(text, params) → {rows} y exec(sql) para multi-statement.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL || '';
let backend = null;   // { query, exec, kind }
let ready = false;

// Quita SOLO sslmode de la query, sin tocar usuario:contraseña (cert autofirmado de Supabase).
function limpiarConn(url) {
  const at = url.lastIndexOf('@');
  const q = url.indexOf('?', at === -1 ? 0 : at);
  if (q === -1) return url;
  const base = url.slice(0, q);
  const params = url.slice(q + 1).split('&').filter(p => p && !/^sslmode=/i.test(p));
  return params.length ? base + '?' + params.join('&') : base;
}

async function initDB() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: limpiarConn(DATABASE_URL),
      ssl: { require: true, rejectUnauthorized: false },
      max: 5,
    });
    pool.on('error', e => console.error('PG pool error', e.message));
    await pool.query('select 1');
    setInterval(() => pool.query('select 1').catch(() => {}), 6 * 3600 * 1000); // keep-alive
    backend = {
      kind: 'postgres (supabase)',
      query: (t, p) => pool.query(t, p || []),
      exec: (sql) => pool.query(sql),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(path.join(__dirname, '..', '.pgdata'));
    await db.query('select 1');
    backend = {
      kind: 'pglite (local ./.pgdata)',
      query: (t, p) => db.query(t, p || []),
      exec: (sql) => db.exec(sql),
    };
  }
  await migrate();
  ready = true;
  return backend.kind;
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await backend.exec(sql);
  await seedUsuarios();
}

// Siembra 3 usuarios (admin/operador/tesorería) si no hay ninguno. Password inicial: Polipay2026
async function seedUsuarios() {
  const { rows } = await backend.query('select count(*)::int as n from usuarios', []);
  if (rows[0].n > 0) return;
  const hash = bcrypt.hashSync('Polipay2026', 10);
  const seed = [
    ['alfonso.garcia@polipay.io', 'Alfonso García', 'admin'],
    ['operador@polipay.io', 'Operador Demo', 'operador'],
    ['tesoreria@polipay.io', 'Tesorería Demo', 'tesoreria'],
  ];
  for (const [email, nombre, rol] of seed) {
    await backend.query(
      'insert into usuarios(email,nombre,rol,password_hash) values($1,$2,$3,$4) on conflict(email) do nothing',
      [email, nombre, rol, hash]
    );
  }
  console.log('Usuarios sembrados (password inicial: Polipay2026).');
}

function query(text, params) {
  if (!backend) throw new Error('db_no_inicializada');
  return backend.query(text, params || []);
}
const isReady = () => ready;
const kind = () => (backend ? backend.kind : '—');

module.exports = { initDB, query, isReady, kind };
