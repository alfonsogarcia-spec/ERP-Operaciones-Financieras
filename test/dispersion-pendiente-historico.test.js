/* Layout de recuperación histórico: para un corte ya dispersado solo cuenta lo que se recuperó EN ese corte. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DP = require('../lib/dispersion-pendiente.js');

test('pendientesORecuperadasEnCorte: soloAplicadas ignora los pendientes que siguen abiertos', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(`create table dispersiones_pendientes (id serial primary key, origen_corte_id int, numero_afiliacion text, grupo_cliente text, id_grupo int,
      bloque text, monto numeric, motivo text, estatus text default 'Pendiente', aplicado_en_corte_id int, creado_at timestamptz default now());
    insert into dispersiones_pendientes (origen_corte_id, numero_afiliacion, id_grupo, bloque, monto, estatus, aplicado_en_corte_id) values
      (10, '357', 3, 'DOM', 100.5, 'Aplicado', 12),   -- recuperado en el corte 12
      (10, '357', 3, 'AMEX', 40,   'Pendiente', null), -- sigue abierto hoy
      (12, '357', 3, 'DOM', 7,     'Aplicado', 12),   -- se originó en el propio corte 12: no es recuperación de ese corte
      (10, '357', 3, 'DOM', 9,     'Aplicado', 13);   -- recuperado en otro corte`);
  const db = { query: (t, p) => pg.query(t, p) };
  const hist = await DP.pendientesORecuperadasEnCorte(db, ['357'], 12, { soloAplicadas: true });
  assert.deepEqual(hist.map(p => p.monto), [100.5]);
  const vivo = await DP.pendientesORecuperadasEnCorte(db, ['357'], 12);                                   // comportamiento de siempre: abiertos + aplicados en el corte
  assert.deepEqual(vivo.map(p => p.monto).sort((a, b) => a - b), [40, 100.5]);
  await pg.close();
});
