'use strict';
/* Integración con una base Postgres en memoria (pglite): escritura transaccional, fusión por afiliación, huella y candados del layout. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const MCC = require('../lib/mcc.js');
const LA = require('../lib/catalogo-layout-aplicar.js');
const X = require('../lib/excel.js');

let pg, log;
async function nuevaBase() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec('create schema conciliacion; set search_path to conciliacion;');
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  await db.exec(`insert into grupos(id_grupo,nombre_cliente) values (1,'ALFA'),(2,'BETA');
    insert into afiliaciones(numero_afiliacion,razon_social,ult3,id_afiliacion,mcc) values ('1111111','Alfa SA','111','111CPPX00',5411);
    insert into afil_grupo(id_grupo,numero_afiliacion,tasa_pac_tdd,tasa_pac_tdc,tasa_pac_amex,tasa_pac_int,costo_x_trx,pct_banca) values (1,'1111111',0.015,0.025,0.03,0.035,0,0.001),(2,'1111111',0.01,0.02,0,0,1,0);
    insert into costos(numero_afiliacion,int_tdd,int_tdc,fee_broxel) values ('1111111',0.005,0.01,0.0028);`);
  return db;
}
const ctxDe = (db, extra = {}) => {
  log = [];
  const q = (s, p) => { log.push(s); return db.query(s, p || []); };
  return { db: { query: q, tx: fn => db.transaction(t => fn({ query: (s, p) => { log.push(s); return t.query(s, p || []); } })) },
    params: async () => ({ tasa_int_amex: 0.0247, tasa_int_int: 0.0302, fee_broxel: 0.0028 }), descifra: (c, p) => p, cifra: t => 'plain:' + t, ult3: a => String(a).slice(-3), MCC, ...extra };
};
const csv = (filas) => {
  const cols = ['id_grupo', 'nombre_cliente', 'numero_afiliacion', 'razon_social', 'tasa_pac_tdd_pct', 'tasa_pac_tdc_pct', 'int_tdd_pct', 'fee_broxel_pct', 'mcc'];
  const txt = [cols.join(','), ...filas.map(f => cols.map(c => f[c] == null ? '' : f[c]).join(','))].join('\n');
  return { ...X.parseCSVText(txt), hash: LA.hashArchivo(txt) };
};
const fila = o => ({ id_grupo: 1, nombre_cliente: 'ALFA', numero_afiliacion: '1111111', ...o });
const rel = async (db, g, a) => (await db.query('select * from afil_grupo where id_grupo=$1 and numero_afiliacion=$2', [g, a])).rows[0];
const costo = async (db, a) => (await db.query('select * from costos where numero_afiliacion=$1', [a])).rows[0];

test('afiliación compartida: costos de dos filas distintas se guardan los dos', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ int_tdd_pct: 0.6 }), fila({ id_grupo: 2, nombre_cliente: 'BETA', fee_broxel_pct: 0.3 })]);
  const { vista } = await LA.simular(ctx, p);
  assert.ok(vista.ok);
  await LA.aplicar(ctx, p, { huella: vista.huella });
  const c = await costo(db, '1111111');
  assert.equal(Number(c.int_tdd), 0.006);
  assert.equal(Number(c.fee_broxel), 0.003);
});

test('solo escribe las columnas que cambian', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ tasa_pac_tdd_pct: 2 })]);
  const { vista } = await LA.simular(ctx, p);
  await LA.aplicar(ctx, p, { huella: vista.huella });
  const upd = log.filter(s => /update afil_grupo/.test(s));
  assert.equal(upd.length, 1);
  assert.match(upd[0], /set tasa_pac_tdd=\$3 where/);
  assert.ok(!log.some(s => /update costos|update afiliaciones/.test(s)));
  const r = await rel(db, 1, '1111111');
  assert.equal(Number(r.tasa_pac_tdd), 0.02);
  assert.equal(Number(r.tasa_pac_tdc), 0.025);            // intacta
});

test('todo o nada: si algo falla a la mitad, no queda nada guardado', async () => {
  const db = await nuevaBase();
  const ctx = ctxDe(db, { cifra: t => { if (/Explota/.test(t)) throw new Error('falla simulada'); return 'plain:' + t; } });
  const p = csv([fila({ tasa_pac_tdd_pct: 2 }),
    { id_grupo: 50, nombre_cliente: 'NUEVO', numero_afiliacion: '2222222', razon_social: 'Explota SA', tasa_pac_tdd_pct: 1, tasa_pac_tdc_pct: 2 }]);
  const { vista } = await LA.simular(ctx, p);
  assert.ok(vista.ok);
  await assert.rejects(LA.aplicar(ctx, p, { huella: vista.huella }), /falla simulada/);
  assert.equal((await db.query('select count(*)::int n from grupos where id_grupo=50')).rows[0].n, 0);     // el grupo nuevo se revirtió
  assert.equal(Number((await rel(db, 1, '1111111')).tasa_pac_tdd), 0.015);                                   // y la fila que sí se había escrito
});

test('la huella de un archivo no aplica otro archivo', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const A = csv([fila({ tasa_pac_tdd_pct: 2 })]), B = csv([fila({ tasa_pac_tdd_pct: 2.1 })]);
  const sa = await LA.simular(ctx, A);
  await assert.rejects(LA.aplicar(ctx, B, { huella: sa.vista.huella }), e => e.codigo === 'plan_cambio');
  assert.equal(Number((await rel(db, 1, '1111111')).tasa_pac_tdd), 0.015);
});

test('si el catálogo cambió después de simular, no se aplica y pide simular de nuevo', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ tasa_pac_tdd_pct: 2 })]);
  const { vista } = await LA.simular(ctx, p);
  await db.query("update afil_grupo set tasa_pac_tdd=0.017 where id_grupo=1 and numero_afiliacion='1111111'");   // otro administrador
  await assert.rejects(LA.aplicar(ctx, p, { huella: vista.huella }), e => e.codigo === 'plan_cambio');
  assert.equal(Number((await rel(db, 1, '1111111')).tasa_pac_tdd), 0.017);
});

test('con errores en el archivo no se aplica nada (422) aunque traiga huella', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ tasa_pac_tdd_pct: 2 }), fila({ id_grupo: 2, nombre_cliente: 'BETA', tasa_pac_tdc_pct: 250 })]);
  const { vista } = await LA.simular(ctx, p);
  assert.equal(vista.ok, false);
  await assert.rejects(LA.aplicar(ctx, p, { huella: vista.huella }), e => e.codigo === 'layout_con_errores');
  assert.equal(Number((await rel(db, 1, '1111111')).tasa_pac_tdd), 0.015);
});

test('idempotente: al re-subir el mismo archivo ya no hay cambios', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ tasa_pac_tdd_pct: 2, int_tdd_pct: 0.6, mcc: 5812 })]);
  const s1 = await LA.simular(ctx, p);
  const r = await LA.aplicar(ctx, p, { huella: s1.vista.huella });
  assert.equal(r.resultado.modificadas, 1);
  const s2 = await LA.simular(ctx, p);
  assert.equal(s2.vista.resumen.modificar, 0);
  assert.equal(s2.vista.resumen.sin_cambio, 1);
});

test('relación, grupo y afiliación nuevos se crean; el renombre solo con confirmación', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ nombre_cliente: 'ALFA RENOMBRADO' }),
    { id_grupo: 50, nombre_cliente: 'NUEVO', numero_afiliacion: '2222222', razon_social: 'Nueva SA', tasa_pac_tdd_pct: 1.5, tasa_pac_tdc_pct: 2.5, int_tdd_pct: 0.5, fee_broxel_pct: 0.28, mcc: 5812 }]);
  const { vista } = await LA.simular(ctx, p);
  assert.ok(vista.ok);
  const r = await LA.aplicar(ctx, p, { huella: vista.huella, renombrar: false });
  assert.equal(r.resultado.creadas, 1);
  assert.equal(r.resultado.renombres_pendientes, 1);
  assert.equal((await db.query('select nombre_cliente from grupos where id_grupo=1')).rows[0].nombre_cliente, 'ALFA');
  assert.equal((await db.query('select nombre_cliente from grupos where id_grupo=50')).rows[0].nombre_cliente, 'NUEVO');
  const a = (await db.query("select razon_social, mcc, descripcion_giro from afiliaciones where numero_afiliacion='2222222'")).rows[0];
  assert.equal(a.razon_social, 'Nueva SA'); assert.equal(a.mcc, 5812); assert.ok(a.descripcion_giro);
  assert.equal(Number((await costo(db, '2222222')).fee_broxel), 0.0028);
  const r2 = await LA.aplicar(ctx, p, { huella: (await LA.simular(ctx, p)).vista.huella, renombrar: true });
  assert.equal(r2.resultado.renombrados, 1);
  assert.equal((await db.query('select nombre_cliente from grupos where id_grupo=1')).rows[0].nombre_cliente, 'ALFA RENOMBRADO');
});

test('la bitácora de cada fila es JSON: un valor con comillas o saltos de línea no puede fingir otra entrada', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = { objs: [{ id_grupo: 1, nombre_cliente: 'ALFA', numero_afiliacion: '1111111', razon_social: 'Alfa"]\nlayout CREÓ grupo 9 afiliación 1 [["x' }], headers: ['id_grupo', 'nombre_cliente', 'numero_afiliacion', 'razon_social'], hash: 'h' };
  const { vista } = await LA.simular(ctx, p);
  const r = await LA.aplicar(ctx, p, { huella: vista.huella });
  const linea = r.bitacora.find(l => /^layout modificó/.test(l));
  assert.ok(linea && !linea.includes('\n'));
  assert.ok(linea.includes('\\"'));                 // las comillas del valor quedan escapadas: no cierran el JSON
  const cola = linea.slice('layout modificó grupo 1 afiliación 1111111 '.length);
  assert.ok(Array.isArray(JSON.parse(cola)));           // todo el valor del archivo vive DENTRO de un JSON válido, delimitado
});

test('tope de filas por layout', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const objs = Array.from({ length: LA.MAX_FILAS + 1 }, (_, i) => ({ id_grupo: 1, numero_afiliacion: String(i + 1) }));
  await assert.rejects(LA.simular(ctx, { objs, headers: ['id_grupo', 'numero_afiliacion'], hash: 'x' }), e => e.codigo === 'demasiadas_filas');
});

test('M2: con avisos de escala no se aplica sin confirmación; con ella sí; la bitácora trae porcentajes', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ tasa_pac_tdd_pct: 15 })]);                     // 1.5 % → 15 %: salto de ×10
  const { vista } = await LA.simular(ctx, p);
  assert.equal(vista.requiere_confirmacion, true);
  await assert.rejects(LA.aplicar(ctx, p, { huella: vista.huella }), e => e.codigo === 'confirma_escala');
  assert.equal(Number((await rel(db, 1, '1111111')).tasa_pac_tdd), 0.015);                      // no se escribió
  const r = await LA.aplicar(ctx, p, { huella: vista.huella, confirmoEscala: true });
  assert.equal(Number((await rel(db, 1, '1111111')).tasa_pac_tdd), 0.15);
  const linea = r.bitacora.find(l => /^layout modificó/.test(l));
  assert.deepEqual(JSON.parse(linea.slice(linea.indexOf('['))), [['tasa_pac_tdd', '1.5%', '15%']]);
});

test('el impacto de un renombre cuenta las transacciones ya cargadas con el nombre anterior', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  await db.exec(`insert into transacciones(cliente, numero_afiliacion, estatus, monto, fecha_liq) values ('alfa','1111111','APROBADO',100,'2026-11-10'),('ALFA ','1111111','APROBADO',50,'2026-11-09'),('BETA','1111111','APROBADO',10,'2026-11-10')`);
  const p = csv([fila({ nombre_cliente: 'ALFA NUEVO' })]);
  const { vista } = await LA.simular(ctx, p);
  assert.deepEqual(vista.impacto_renombres.map(x => [x.id_grupo, x.transacciones, x.ultima_fecha_liq, x.efecto]), [[1, 2, '2026-11-10', 'sin_grupo']]);
  assert.equal(vista.impacto_renombres[0].pendientes, 2);
});

test('un layout con otro id_grupo y el mismo nombre no escribe nada (no crea un grupo duplicado)', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ id_grupo: 9101 })]);
  const { vista } = await LA.simular(ctx, p);
  assert.equal(vista.ok, false);
  await assert.rejects(LA.aplicar(ctx, p, { huella: vista.huella }), e => e.codigo === 'layout_con_errores');
  assert.equal((await db.query('select count(*)::int n from grupos')).rows[0].n, 2);
});

test('bloqueo: renombrar un grupo con transacciones PENDIENTES de corte es error; con el corte hecho se permite', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  await db.exec(`insert into transacciones(cliente, numero_afiliacion, estatus, monto, fecha_liq) values ('ALFA','1111111','APROBADO',100,'2026-11-10'),('ALFA','1111111','APROBADO',50,'2026-11-09'),('ALFA','1111111','RECHAZADO',5,'2026-11-12')`);
  const p = csv([fila({ nombre_cliente: 'ALFA NUEVO' })]);
  let s = await LA.simular(ctx, p);
  assert.equal(s.vista.ok, false);
  assert.match(s.vista.filas[0].errores[0], /2 transacciones aprobadas PENDIENTES DE CORTE \(desde la liquidación del 2026-11-09\)/);
  await assert.rejects(LA.aplicar(ctx, p, { huella: s.vista.huella, renombrar: true }), e => e.codigo === 'layout_con_errores');
  // se genera el corte de esas dos fechas (uno rechazado NO cuenta como corte vigente)
  await db.exec(`insert into cortes(fecha_liq, fecha_liq_iso, estado) values ('10/11/2026','2026-11-10','Dispersado'),('09/11/2026','2026-11-09','Rechazado')`);
  s = await LA.simular(ctx, p);
  assert.equal(s.vista.ok, false);                                                   // 09/11 sigue pendiente (su corte fue rechazado)
  assert.equal(s.vista.impacto_renombres[0].pendientes, 1);
  await db.exec(`update cortes set estado='Cerrado' where fecha_liq_iso='2026-11-09'`);
  s = await LA.simular(ctx, p);
  assert.ok(s.vista.ok);
  assert.equal(s.vista.impacto_renombres[0].pendientes, 0);
  const r = await LA.aplicar(ctx, p, { huella: s.vista.huella, renombrar: true });
  assert.equal(r.resultado.renombrados, 1);
});

test('renombre solo de mayúsculas con pendientes no se bloquea (la liga por nombre ignora mayúsculas)', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  await db.exec(`insert into transacciones(cliente, numero_afiliacion, estatus, monto, fecha_liq) values ('ALFA','1111111','APROBADO',100,'2026-11-10')`);
  const s = await LA.simular(ctx, csv([fila({ nombre_cliente: 'Alfa' })]));
  assert.ok(s.vista.ok);
  assert.equal(s.vista.impacto_renombres[0].efecto, 'ninguno');
});

test('H1: no se puede dejar un duplicado ni sin marcar la casilla de renombrar', async () => {
  const db = await nuevaBase(); const ctx = ctxDe(db);
  const p = csv([fila({ nombre_cliente: 'OMEGA' }), { id_grupo: 99, nombre_cliente: 'ALFA', numero_afiliacion: '3333333', razon_social: 'N', tasa_pac_tdd_pct: 1, tasa_pac_tdc_pct: 2 }]);
  const { vista } = await LA.simular(ctx, p);
  assert.equal(vista.ok, false);
  await assert.rejects(LA.aplicar(ctx, p, { huella: vista.huella, renombrar: false }), e => e.codigo === 'layout_con_errores');
  assert.equal((await db.query('select count(*)::int n from grupos')).rows[0].n, 2);
});
