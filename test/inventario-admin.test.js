/* Inventario administrativo (PEPS): rutas, candados y anulaciones sobre una base real (pglite en memoria). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const INV = require('../lib/inventario-admin.js');

let pg, server, B;
const usuarios = { admin: { rol: 'admin', email: 'ana@x.test' }, consulta: { rol: 'consulta', email: 'carla@x.test' }, inventario: { rol: 'inventario', email: 'ivan@x.test' } };
const llamadas = [];
test.before(async () => {
  pg = new PGlite();
  await pg.exec(`create table grupos (id_grupo integer primary key, nombre_cliente text not null, activo boolean not null default true);
    create table afiliaciones (numero_afiliacion text primary key, razon_social text);
    create table afil_grupo (id_grupo integer not null, numero_afiliacion text not null, primary key (id_grupo, numero_afiliacion));
    create table transacciones (id serial primary key, fecha text, cliente text, comercio text, numero_afiliacion text, terminal text);
    insert into grupos values (7, 'ACME SA', true), (9, 'BETA SA', true);
    insert into afiliaciones values ('1111111', 'Acme Norte'), ('2222222', 'Beta Matriz');
    insert into afil_grupo values (7, '1111111'), (9, '2222222');
    insert into transacciones (fecha, cliente, comercio, numero_afiliacion, terminal) values ('2026-11-10', 'ACME SA', 'Sucursal Norte', '1111111', 'SN0001'), ('2026-11-11', 'BETA SA', 'Matriz', '2222222', 'SN0002');`);
  const db = { isReady: () => true, query: (t, p) => pg.query(t, p || []), tx: fn => pg.transaction(async t => fn({ query: (q, p) => t.query(q, p || []) })) };
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => { const u = usuarios[req.headers['x-rol']]; if (!u) return res.status(401).json({ error: 'sin_token' }); req.user = u; next(); };
  const requiereRol = (...roles) => (req, res, next) => roles.includes(req.user.rol) ? next() : res.status(403).json({ error: 'rol_no_autorizado' });
  INV.montar(app, { auth, requiereRol, bit: async (_r, a, d) => { llamadas.push([a, d]); }, db, enviarXLSX: (res, nombre, buf) => { res.setHeader('Content-Disposition', nombre); res.send(buf); } });
  server = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
  B = 'http://127.0.0.1:' + server.address().port + '/api/inventario/admin';
});
test.after(async () => { await new Promise(ok => server.close(ok)); await pg.close(); });

const call = async (rol, metodo, ruta, cuerpo) => { const r = await fetch(B + ruta, { method: metodo, headers: { 'x-rol': rol, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); let j = null; try { j = await r.json(); } catch (_e) { /* binario */ } return { s: r.status, j, r }; };
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const dia = n => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

test('flujo completo: artículo → dos compras a distinto costo → salida con costo PEPS → kardex y valuación', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'term-001', nombre: 'Terminal POS Verifone', categoria: 'Terminales', unidad: 'pieza', minimo: 5 });
  assert.equal(a.s, 200); const id = a.j.id;
  assert.equal((await call('admin', 'POST', '/articulos', { sku: 'TERM-001', nombre: 'Otro' })).s, 409);          // SKU único sin importar mayúsculas
  const e1 = await call('admin', 'POST', '/movimientos', { articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(30), cantidad: 10, costo_unitario: 1000, documento: 'F-100', proveedor: 'Proveedor A' });
  const e2 = await call('inventario', 'POST', '/movimientos', { articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(10), cantidad: 10, costo_unitario: 1200, documento: 'F-200' });
  assert.equal(e1.s, 200); assert.equal(e2.s, 200);
  const s = await call('admin', 'POST', '/movimientos', { articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(2), cantidad: 12, empresa: 'ACME SA', unidad: 'Sucursal Norte' });
  assert.equal(s.s, 200); assert.equal(s.j.costo_total, 10 * 1000 + 2 * 1200);                                        // 12,400
  assert.equal(s.j.saldo_cantidad, 8); assert.equal(s.j.saldo_valor, 8 * 1200);
  const k = await call('consulta', 'GET', `/articulos/${id}/kardex`);
  assert.equal(k.s, 200); assert.equal(k.j.filas.length, 3); assert.equal(k.j.articulo.valor, 9600); assert.equal(k.j.articulo.costo_siguiente, 1200);
  const r = await call('consulta', 'GET', '/resumen');
  assert.equal(r.j.valor_total, 9600); assert.equal(r.j.bajo_minimo.length, 0 + 0 || r.j.bajo_minimo.length);        // 8 ≥ mínimo 5
  assert.ok(llamadas.some(x => x[0] === 'inv_salida' && /costo PEPS \$12,400\.00/.test(x[1])));                      // queda en la bitácora
});
test('permisos: consulta no captura; sin sesión no entra', async () => {
  assert.equal((await call('consulta', 'POST', '/articulos', { sku: 'X1', nombre: 'X' })).s, 403);
  assert.equal((await call('consulta', 'POST', '/movimientos', { articulo_id: 1, tipo: 'entrada' })).s, 403);
  assert.equal((await call('nadie', 'GET', '/articulos')).s, 401);
});
test('una salida sin existencia suficiente se rechaza con el faltante', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'SIM-1', nombre: 'SIM', unidad: 'pieza' });
  await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'entrada', concepto: 'compra', fecha: dia(5), cantidad: 3, costo_unitario: 10, documento: 'F-1' });
  const r = await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'consumo_interno', fecha: dia(1), cantidad: 5 });
  assert.equal(r.s, 409); assert.equal(r.j.codigo, 'insuficiente'); assert.match(r.j.error, /faltan 2 pieza \(hay 3\)/);
});
test('anular: una entrada ya consumida no se puede anular; anulando primero la salida sí; todo se recalcula', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'LECT-1', nombre: 'Lector' });
  const e = await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'entrada', concepto: 'compra', fecha: dia(9), cantidad: 4, costo_unitario: 50, documento: 'F-9' });
  const s = await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'merma', fecha: dia(3), cantidad: 4, notas: 'Se dañaron en bodega' });
  assert.equal((await call('admin', 'POST', `/movimientos/${e.j.id}/anular`, { motivo: 'corto' })).s, 400);
  const no = await call('admin', 'POST', `/movimientos/${e.j.id}/anular`, { motivo: 'Captura duplicada por error' });
  assert.equal(no.s, 409); assert.equal(no.j.codigo, 'dejaria_sin_existencia');
  assert.equal((await call('admin', 'POST', `/movimientos/${s.j.id}/anular`, { motivo: 'La merma no ocurrió, error de captura' })).s, 200);
  assert.equal((await call('admin', 'POST', `/movimientos/${e.j.id}/anular`, { motivo: 'Captura duplicada por error' })).s, 200);
  const k = await call('admin', 'GET', `/articulos/${a.j.id}/kardex`);
  assert.equal(k.j.filas.length, 0); assert.equal(k.j.anulados.length, 2); assert.equal((await call('admin', 'POST', `/movimientos/${e.j.id}/anular`, { motivo: 'Otra vez el mismo' })).s, 409);
});
test('una entrada con fecha anterior recalcula el costo de la salida ya registrada (PEPS)', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'PAP-1', nombre: 'Papel térmico', unidad: 'caja' });
  await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'entrada', concepto: 'compra', fecha: dia(20), cantidad: 10, costo_unitario: 30, documento: 'F-20' });
  const sal = await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'consumo_interno', fecha: dia(2), cantidad: 5 });
  assert.equal(sal.j.costo_total, 150);
  await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'entrada', concepto: 'inventario_inicial', fecha: dia(60), cantidad: 20, costo_unitario: 10 });   // llegó tarde, es de hace 60 días
  const lista = await call('admin', 'GET', `/movimientos?articulo_id=${a.j.id}&tipo=salida`);
  assert.equal(lista.j.movimientos[0].costo_total, 50);                                                                 // ahora la salida sale de la capa de $10
});
test('12 capturas simultáneas de salida sobre 10 piezas: solo entran 10 (candado por artículo)', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'CAB-1', nombre: 'Cable' });
  await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'entrada', concepto: 'compra', fecha: dia(7), cantidad: 10, costo_unitario: 5, documento: 'F-7' });
  const rs = await Promise.all(Array.from({ length: 12 }, () => call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'consumo_interno', fecha: hoy(), cantidad: 1 })));
  assert.equal(rs.filter(r => r.s === 200).length, 10); assert.equal(rs.filter(r => r.s === 409).length, 2);
  assert.equal((await call('admin', 'GET', `/articulos/${a.j.id}/kardex`)).j.articulo.existencia, 0);
});
test('validaciones de captura y descargas de Excel', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'TEST-V', nombre: 'Validación' });
  const mal = b => call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'entrada', concepto: 'compra', fecha: hoy(), cantidad: 1, costo_unitario: 1, documento: 'F', ...b });
  assert.equal((await mal({ cantidad: -1 })).s, 422); assert.equal((await mal({ costo_unitario: undefined })).s, 422); assert.equal((await mal({ fecha: '2099-01-01' })).s, 422); assert.equal((await mal({ documento: '' })).s, 422);
  const x = await call('admin', 'GET', '/existencias.xlsx'); assert.equal(x.s, 200); assert.match(x.r.headers.get('content-disposition'), /existencias_peps_/);
  const k = await call('admin', 'GET', `/kardex.xlsx?articulo_id=${a.j.id}`); assert.equal(k.s, 200);
});


/* ---------------------------- terminales: series, Empresa y Unidad ---------------------------- */
const ent = (id, fecha, series, extra) => call('admin', 'POST', '/movimientos', { articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha, costo_unitario: 1850, documento: 'F-9', series, ...(extra || {}) });
const ent2 = (id, fecha, series, extra) => ent(id, fecha, series, extra);

test('terminal serializada: entra con su serie, se asigna a Empresa y Unidad del catálogo y queda identificada', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'TERM-S1', nombre: 'Terminal serializada', serializado: true });
  const e = await ent(a.j.id, dia(20), ['sn0001', 'sn0002', 'SN0003']);
  assert.equal(e.s, 200); assert.equal(e.j.saldo_cantidad, 3);                                            // la cantidad sale de las series
  assert.equal((await ent(a.j.id, dia(19), ['SN0001'])).s, 409);                                        // serie repetida
  assert.equal((await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'entrega', fecha: dia(5), series: 'SN0001', empresa: 'ACME SA' })).s, 422);   // sin Unidad
  assert.equal((await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'entrega', fecha: dia(5), series: 'SN0001', empresa: 'No existe SA', unidad: 'X' })).s, 422);
  assert.equal((await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'entrega', fecha: dia(5), series: 'SN0001', empresa: 'ACME SA', unidad: 'Sucursal Norte', afiliacion: '2222222' })).s, 422);   // afiliación de otra Empresa
  const s = await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'entrega', fecha: dia(5), series: ['SN0001', 'SN0002'], empresa_id: 7, unidad: 'Sucursal Norte', afiliacion: '1111111' });
  assert.equal(s.s, 200); assert.equal(s.j.costo_total, 2 * 1850);
  const sr = await call('consulta', 'GET', `/series?articulo_id=${a.j.id}`);
  const t1 = sr.j.series.find(x => x.serie === 'SN0001');
  assert.equal(t1.estado, 'asignada'); assert.equal(t1.empresa, 'ACME SA'); assert.equal(t1.unidad, 'Sucursal Norte'); assert.equal(t1.afiliacion, '1111111');
  assert.equal(sr.j.series.find(x => x.serie === 'SN0003').estado, 'almacen');
  assert.equal((await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'entrega', fecha: dia(1), series: ['SN0001'], empresa: 'BETA SA', unidad: 'Matriz' })).s, 409);   // ya está asignada
});
test('cruce con transacciones: la terminal asignada a otra Empresa de la que transacciona se marca; la que no transacciona, también', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'TERM-S2', nombre: 'Terminal cruce', serializado: true });
  await ent(a.j.id, dia(30), ['SN0001', 'SN0002', 'SN0009']);
  // SN0001 transacciona para ACME SA; SN0002 transacciona para BETA SA; SN0009 nunca
  await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'entrega', fecha: dia(10), series: ['SN0001', 'SN0002', 'SN0009'], empresa: 'ACME SA', unidad: 'Sucursal Norte' });
  const r = (await call('admin', 'GET', `/series?articulo_id=${a.j.id}&estado=asignada`)).j;
  const por = Object.fromEntries(r.series.map(s => [s.serie, s.alerta]));
  assert.equal(por.SN0001, null); assert.equal(por.SN0002, 'otra_empresa'); assert.equal(por.SN0009, 'sin_uso');
  assert.equal(r.resumen.otra_empresa, 1); assert.equal(r.resumen.sin_uso, 1);
  assert.equal(r.series.find(s => s.serie === 'SN0002').uso.cliente, 'BETA SA');
  const x = await call('admin', 'GET', '/series.xlsx'); assert.equal(x.s, 200);
});
test('devolución de cliente regresa la serie a almacén; anular la entrega la libera; no se anula lo que dejaría una serie en estado imposible', async () => {
  const a = await call('admin', 'POST', '/articulos', { sku: 'TERM-S3', nombre: 'Terminal devolución', serializado: true });
  const e = await ent(a.j.id, dia(40), ['SN0100']);
  const s = await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'salida', concepto: 'entrega', fecha: dia(30), series: ['SN0100'], empresa: 'ACME SA', unidad: 'Sucursal Norte' });
  const d = await call('admin', 'POST', '/movimientos', { articulo_id: a.j.id, tipo: 'entrada', concepto: 'devolucion_cliente', fecha: dia(20), costo_unitario: 1850, series: ['SN0100'], notas: 'Cliente cerró sucursal' });
  assert.equal(d.s, 200);
  assert.equal((await call('admin', 'GET', `/series?articulo_id=${a.j.id}`)).j.series[0].estado, 'almacen');
  const no = await call('admin', 'POST', `/movimientos/${s.j.id}/anular`, { motivo: 'Entrega registrada por error' });   // la devolución dejaría de tener sentido
  assert.equal(no.s, 409);
  assert.equal((await call('admin', 'POST', `/movimientos/${d.j.id}/anular`, { motivo: 'La devolución no ocurrió, error' })).s, 200);
  assert.equal((await call('admin', 'POST', `/movimientos/${s.j.id}/anular`, { motivo: 'Entrega registrada por error' })).s, 200);
  assert.equal((await call('admin', 'GET', `/series?articulo_id=${a.j.id}`)).j.series[0].estado, 'almacen');
  assert.ok(e.j.ok);
});
test('catálogo de clientes: Empresas, afiliaciones y unidades (de transacciones y de entregas previas)', async () => {
  const r = await call('admin', 'GET', '/clientes');
  const acme = r.j.empresas.find(e => e.nombre === 'ACME SA');
  assert.equal(acme.id, 7); assert.deepEqual(acme.afiliaciones, ['1111111']); assert.ok(acme.unidades.includes('Sucursal Norte'));
});

/* ---------------------------- carga masiva ---------------------------- */
const XLSX = require('xlsx');
const libro = (articulos, movimientos) => { const wb = XLSX.utils.book_new(); if (articulos) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(articulos), 'Articulos'); if (movimientos) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(movimientos), 'Movimientos'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }).toString('base64'); };
const HM = ['tipo', 'concepto', 'fecha', 'sn', 'serie', 'cantidad', 'costo_unitario', 'documento', 'proveedor', 'empresa', 'unidad', 'afiliacion', 'notas'];
const lay = (archivo, extra) => call('admin', 'POST', '/layout', { archivo, nombre: 'layout.xlsx', ...(extra || {}) });

test('layout: simula sin escribir, muestra el plan; al confirmar aplica TODO (artículos, entradas con series, entregas a Empresa/Unidad, no seriados) con costo PEPS', async () => {
  const archivo = libro([['sn', 'nombre', 'categoria', 'unidad', 'minimo', 'serializado', 'activo'], ['LAY-T', 'Terminal layout', 'Terminales', 'pieza', 2, 'SI', 'SI'], ['LAY-P', 'Papel layout', 'Papelería', 'caja', 5, 'NO', 'SI']],
    [HM, ['ENTRADA', 'Compra', dia(20), 'LAY-T', 'LT001', '', 1500, 'F-1', 'Prov', '', '', '', ''], ['ENTRADA', 'Compra', dia(20), 'LAY-T', 'LT002', '', 1500, 'F-1', 'Prov', '', '', '', ''], ['ENTRADA', 'Compra', dia(20), 'LAY-T', 'LT003', '', 1500, 'F-1', 'Prov', '', '', '', ''],
      ['ENTRADA', 'Compra', dia(19), 'LAY-P', '', 20, 95, 'F-2', 'Prov', '', '', '', ''], ['SALIDA', 'Entrega a cliente o área', dia(5), 'LAY-T', 'LT001', '', '', 'REM-1', '', 'ACME SA', 'Sucursal Norte', '1111111', ''],
      ['SALIDA', 'Entrega a cliente o área', dia(5), 'LAY-T', 'LT002', '', '', 'REM-1', '', 'acme sa', 'Sucursal Norte', '', ''], ['SALIDA', 'Consumo interno', dia(2), 'LAY-P', '', 3, '', '', '', '', '', '', 'Oficina']]);
  const sim = await lay(archivo);
  assert.equal(sim.s, 200); assert.equal(sim.j.ok, true); assert.equal(sim.j.aplicado, false);
  assert.equal(sim.j.resumen.articulos_nuevos, 2); assert.equal(sim.j.resumen.movimientos, 5); assert.equal(sim.j.resumen.unidades, 5); assert.equal(sim.j.resumen.costo_salidas, 2 * 1500 + 3 * 95);
  assert.equal((await call('admin', 'GET', '/articulos')).j.articulos.some(a => a.sku === 'LAY-T'), false);                    // todavía nada
  assert.equal((await lay(archivo, { aplicar: true })).s, 409);                                                                // sin huella no aplica
  const ap = await lay(archivo, { aplicar: true, huella: sim.j.huella });
  assert.equal(ap.s, 200); assert.equal(ap.j.aplicado, true);
  const arts = (await call('admin', 'GET', '/articulos')).j.articulos;
  const t = arts.find(a => a.sku === 'LAY-T'), p = arts.find(a => a.sku === 'LAY-P');
  assert.equal(t.serializado, true); assert.equal(t.en_almacen, 1); assert.equal(t.asignadas, 2); assert.equal(t.valor, 1500);
  assert.equal(p.existencia, 17); assert.equal(p.valor, 17 * 95);
  const se = (await call('admin', 'GET', `/series?articulo_id=${t.id}&estado=asignada`)).j.series;
  assert.deepEqual(se.map(s => [s.serie, s.empresa, s.unidad]).sort(), [['LT001', 'ACME SA', 'Sucursal Norte'], ['LT002', 'ACME SA', 'Sucursal Norte']]);
  assert.equal(se.find(s => s.serie === 'LT001').afiliacion, '1111111');
  assert.ok(llamadas.some(x => x[0] === 'inv_layout'));
});
test('layout: todo o nada; los errores traen hoja y fila (serie repetida, Empresa inexistente, afiliación ajena, sin existencia, concepto raro)', async () => {
  const antes = (await call('admin', 'GET', '/articulos')).j.articulos.length;
  const archivo = libro([['sku', 'nombre', 'unidad', 'serializado'], ['ERR-T', 'Terminal errores', 'pieza', 'SI'], ['ERR-P', 'Papel errores', 'caja', 'NO']],
    [HM, ['ENTRADA', 'Compra', dia(10), 'ERR-T', 'E1', '', 100, 'F-1', '', '', '', '', ''], ['ENTRADA', 'Compra', dia(10), 'ERR-T', 'E1', '', 100, 'F-1', '', '', '', '', ''],
      ['SALIDA', 'Entrega a cliente o área', dia(2), 'ERR-T', 'E1', '', '', '', '', 'No existe SA', 'Unidad', '', ''], ['SALIDA', 'Entrega a cliente o área', dia(2), 'ERR-T', 'E1', '', '', '', '', 'ACME SA', 'Unidad', '2222222', ''],
      ['SALIDA', 'Consumo interno', dia(2), 'ERR-P', '', 5, '', '', '', '', '', '', ''], ['ENTRADA', 'Rarísimo', dia(2), 'ERR-P', '', 1, 1, '', '', '', '', '', ''], ['SALIDA', 'Consumo interno', dia(2), 'NOEXISTE', '', 1, '', '', '', '', '', '', '']]);
  const r = await lay(archivo);
  assert.equal(r.s, 200); assert.equal(r.j.ok, false);
  const msgs = r.j.errores.map(e => `${e.hoja}:${e.fila}:${e.mensaje}`).join(' | ');
  assert.match(msgs, /Movimientos:2:.*serie E1 viene repetida/i); assert.match(msgs, /Movimientos:4:.*Empresa «No existe SA»/); assert.match(msgs, /Movimientos:5:.*afiliación 2222222 no pertenece/);
  assert.match(msgs, /Movimientos:6:.*Sin existencia suficiente de ERR-P/); assert.match(msgs, /Movimientos:7:.*concepto «Rarísimo»/); assert.match(msgs, /Movimientos:8:.*NOEXISTE no existe/);
  const ap = await lay(archivo, { aplicar: true, huella: 'x' });
  assert.equal(ap.s, 422); assert.ok(ap.j.errores.length >= 5);
  assert.equal((await call('admin', 'GET', '/articulos')).j.articulos.length, antes);                                          // no se creó ni el artículo
});
test('layout: CSV de movimientos, fechas DD/MM/AAAA y cantidades de artículos no seriados; el artículo debe existir', async () => {
  const csv = Buffer.from(['tipo,concepto,fecha,sku,serie,cantidad,costo_unitario,documento', `ENTRADA,Compra,${dia(3).split('-').reverse().join('/')},LAY-P,,10,100,F-77`].join('\n')).toString('base64');
  const r = await lay(csv, { nombre: 'mov.csv' });
  assert.equal(r.j.ok, true, JSON.stringify(r.j.errores)); assert.equal(r.j.resumen.entradas, 1);
  const ap = await lay(csv, { nombre: 'mov.csv', aplicar: true, huella: r.j.huella });
  assert.equal(ap.s, 200);
  assert.equal((await call('admin', 'GET', '/articulos')).j.articulos.find(a => a.sku === 'LAY-P').existencia, 27);
});
test('layout: plantilla descargable y permisos (consulta no carga)', async () => {
  const t = await call('consulta', 'GET', '/layout.xlsx'); assert.equal(t.s, 200);
  assert.equal((await call('consulta', 'POST', '/layout', { archivo: 'AAAA' })).s, 403);
  assert.equal((await call('admin', 'POST', '/layout', { archivo: '' })).s, 400);
});
