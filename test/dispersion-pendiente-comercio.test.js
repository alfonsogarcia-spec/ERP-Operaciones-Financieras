/* Pendiente por cuenta (reparto por comercio): se registra con su comercio y las consultas lo devuelven. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DP = require('../lib/dispersion-pendiente.js');

test('registrar guarda el comercio y las consultas lo devuelven; sin comercio queda vacío (cuenta general)', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(`create table dispersiones_pendientes (id serial primary key, origen_corte_id int, origen_calculo_id int, numero_afiliacion text, grupo_cliente text, id_grupo int,
      bloque text, monto numeric, motivo text, estatus text default 'Pendiente', aplicado_en_corte_id int, creado_at timestamptz default now(), creado_por text, origen text, origen_ref text, comercio text);`);
  const db = { query: (t, p) => pg.query(t, p) };
  const base = { origen_corte_id: 10, origen_calculo_id: 1, numero_afiliacion: '357', grupo_cliente: 'G', id_grupo: 3, bloque: 'DOM' };
  await DP.registrar(db, { ...base, monto: 3437.68, comercio: 'Sucursal X' });
  await DP.registrar(db, { ...base, monto: 176564.62 });
  const ab = await DP.pendientesDeAfiliaciones(db, ['357']);
  assert.deepEqual(ab.map(p => [p.monto, p.comercio]), [[3437.68, 'Sucursal X'], [176564.62, null]]);
  assert.equal(ab[0].origen_calculo_id, 1);
  const rec = await DP.pendientesORecuperadasEnCorte(db, ['357'], 12);
  assert.deepEqual(rec.map(p => p.comercio), ['Sucursal X', null]);
  await pg.close();
});
