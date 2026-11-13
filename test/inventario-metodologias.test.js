/* Inventario administrativo · metodologías: serialización unitaria (S/N · IMEI · TID), PEPS físico, PCI PTS, ABC, punto de reorden y conteo cíclico. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const XLSX = require('xlsx');
const { PGlite } = require('@electric-sql/pglite');
const INV = require('../lib/inventario-admin.js');

let pg, server, B;
const usuarios = { admin: { rol: 'admin', email: 'ana@x.test' }, consulta: { rol: 'consulta', email: 'carla@x.test' } };
const bitacora = [];
test.before(async () => {
  pg = new PGlite();
  await pg.exec(`create table grupos (id_grupo integer primary key, nombre_cliente text not null, activo boolean not null default true);
    create table transacciones (id serial primary key, fecha text, cliente text, comercio text, numero_afiliacion text, terminal text);
    insert into grupos values (7, 'ACME SA', true), (9, 'BETA SA', true);`);
  const db = { isReady: () => true, query: (t, p) => pg.query(t, p || []), tx: fn => pg.transaction(async t => fn({ query: (q, p) => t.query(q, p || []) })) };
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => { const u = usuarios[req.headers['x-rol']]; if (!u) return res.status(401).json({ error: 'sin_token' }); req.user = u; next(); };
  const requiereRol = (...roles) => (req, res, next) => roles.includes(req.user.rol) ? next() : res.status(403).json({ error: 'rol_no_autorizado' });
  INV.montar(app, { auth, requiereRol, bit: async (_r, a, d) => { bitacora.push([a, d]); }, db, enviarXLSX: (res, nombre, buf) => { res.setHeader('Content-Disposition', nombre); res.send(buf); } });
  server = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
  B = 'http://127.0.0.1:' + server.address().port + '/api/inventario/admin';
});
test.after(async () => { await new Promise(ok => server.close(ok)); await pg.close(); });

const call = async (rol, metodo, ruta, cuerpo) => { const r = await fetch(B + ruta, { method: metodo, headers: { 'x-rol': rol, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); let j = null; try { j = await r.json(); } catch (_e) { /* binario */ } return { s: r.status, j, r }; };
const dia = n => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const mas = n => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const art = async (b) => (await call('admin', 'POST', '/articulos', b)).j.id;
const mov = (b) => call('admin', 'POST', '/movimientos', b);
const arts = async () => (await call('admin', 'GET', '/articulos')).j.articulos;

test('serialización unitaria: S/N, IMEI y TID por equipo; no se repiten; ficha con historial de fallas', async () => {
  const id = await art({ sku: 'TERM-A', nombre: 'Terminal A', serializado: true });
  const ok = await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(40), costo_unitario: 1000, documento: 'F-1', series: 'A001,350000000000001,TIDA01\nA002,350000000000002\nA003' });
  assert.equal(ok.s, 200, JSON.stringify(ok.j));
  assert.equal((await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(39), costo_unitario: 1000, documento: 'F-2', series: 'A010,35000000000000' })).j.codigo, 'series');             // IMEI de 14 dígitos
  const rep = await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(39), costo_unitario: 1000, documento: 'F-2', series: 'A010,350000000000001' });
  assert.equal(rep.s, 409); assert.equal(rep.j.codigo, 'imei'); assert.match(rep.j.error, /A001/);                                            // IMEI ya en otro equipo
  assert.equal((await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(39), costo_unitario: 1000, documento: 'F-2', series: 'A010,,TIDA01' })).j.codigo, 'tid');
  assert.equal((await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(39), costo_unitario: 1000, documento: 'F-2', series: 'A011,350000000000009\nA012,350000000000009' })).j.codigo, 'imei');   // repetido en la misma captura
  // la búsqueda encuentra por IMEI o por TID
  assert.deepEqual((await call('admin', 'GET', '/series?q=350000000000002')).j.series.map(s => s.serie), ['A002']);
  assert.deepEqual((await call('admin', 'GET', '/series?q=tida01')).j.series.map(s => s.serie), ['A001']);
  // se completa un identificador faltante y no se puede repetir el de otro
  assert.equal((await call('admin', 'PUT', '/unidades', { articulo_id: id, serie: 'A003', imei: '350000000000003', tid: 'TIDA03' })).s, 200);
  assert.equal((await call('admin', 'PUT', '/unidades', { articulo_id: id, serie: 'A003', imei: '350000000000003', tid: 'TIDA01' })).s, 409);
  // historial de fallas
  assert.equal((await call('admin', 'POST', '/unidades/eventos', { articulo_id: id, serie: 'A001', fecha: dia(5), tipo: 'falla', descripcion: 'No enciende, batería hinchada' })).s, 200);
  assert.equal((await call('admin', 'POST', '/unidades/eventos', { articulo_id: id, serie: 'A001', tipo: 'inventado', descripcion: 'xxxxxx' })).s, 400);
  assert.equal((await call('admin', 'POST', '/unidades/eventos', { articulo_id: id, serie: 'NOEXISTE', tipo: 'falla', descripcion: 'no existe esta serie' })).s, 404);
  assert.equal((await call('consulta', 'POST', '/unidades/eventos', { articulo_id: id, serie: 'A001', tipo: 'falla', descripcion: 'no debería poder' })).s, 403);
  const f = await call('consulta', 'GET', `/unidades/${id}/A001`);
  assert.equal(f.s, 200); assert.equal(f.j.unidad.imei, '350000000000001'); assert.equal(f.j.unidad.tid, 'TIDA01'); assert.equal(f.j.eventos.length, 1); assert.equal(f.j.eventos[0].tipo, 'falla');
  assert.equal((await call('admin', 'GET', '/series?con_fallas=1')).j.series.length, 1);
  // la entrega ya trae el equipo ligado a su Empresa y Unidad (y puede fijar el TID al instalarse)
  const e = await mov({ articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(1), series: 'A002,,TIDA02', empresa: 'ACME SA', unidad: 'Sucursal Norte' });
  assert.equal(e.s, 200, JSON.stringify(e.j));
  const f2 = (await call('admin', 'GET', `/unidades/${id}/A002`)).j.unidad;
  assert.equal(f2.estado, 'asignada'); assert.equal(f2.empresa, 'ACME SA'); assert.equal(f2.unidad, 'Sucursal Norte'); assert.equal(f2.tid, 'TIDA02'); assert.equal(f2.imei, '350000000000002');
});

test('PEPS físico: no sale primero un equipo nuevo habiendo más viejos; se permite con justificación y queda marcado', async () => {
  const id = await art({ sku: 'TERM-F', nombre: 'Terminal F', serializado: true });
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(90), costo_unitario: 900, documento: 'F-10', series: 'F001\nF002' });
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(5), costo_unitario: 1000, documento: 'F-11', series: 'F003' });
  const mal = await mov({ articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(1), series: 'F003', empresa: 'ACME SA', unidad: 'Norte' });
  assert.equal(mal.s, 409); assert.equal(mal.j.codigo, 'fifo'); assert.deepEqual(mal.j.sugeridas, ['F001']); assert.equal(mal.j.infracciones[0].serie, 'F003');
  assert.equal((await mov({ articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(1), series: 'F003', empresa: 'ACME SA', unidad: 'Norte', fifo_justificacion: 'corto' })).s, 409);   // justificación muy corta
  const bien = await mov({ articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(1), series: 'F001', empresa: 'ACME SA', unidad: 'Norte' });
  assert.equal(bien.s, 200); assert.equal(bien.j.fifo_excepcion, false);
  const exc = await mov({ articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(1), series: 'F003', empresa: 'BETA SA', unidad: 'Matriz', fifo_justificacion: 'El cliente pidió el modelo con la versión nueva de firmware' });
  assert.equal(exc.s, 200); assert.equal(exc.j.fifo_excepcion, true);
  const k = (await call('admin', 'GET', `/articulos/${id}/kardex`)).j;
  assert.ok(k.filas.find(x => x.id === exc.j.id).notas.startsWith('[Excepción PEPS físico]'));
  assert.ok(bitacora.some(b => /EXCEPCIÓN PEPS físico/.test(b[1])));
  // el kardex muestra cuánto lleva cada equipo en almacén (el más viejo primero)
  assert.deepEqual(k.series.filter(s => s.estado === 'almacen').map(s => [s.serie, s.dias_almacen]), [['F002', 90]]);
  assert.equal((await call('admin', 'GET', '/tablero')).j.fifo_excepciones_30d >= 1, true);
  // una merma (baja) no obliga a respetar el orden
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(2), costo_unitario: 1000, documento: 'F-12', series: 'F004' });
  assert.equal((await mov({ articulo_id: id, tipo: 'salida', concepto: 'merma', fecha: dia(1), series: 'F004', notas: 'Pantalla rota en bodega' })).s, 200);
});

test('antigüedad en almacén: el máximo de días del modelo marca los equipos que se están envejeciendo', async () => {
  const id = await art({ sku: 'TERM-E', nombre: 'Terminal E', serializado: true, max_dias_almacen: 120 });
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(200), costo_unitario: 800, documento: 'E-1', series: 'E001' });
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(10), costo_unitario: 800, documento: 'E-2', series: 'E002' });
  const a = (await arts()).find(x => x.id === id);
  assert.equal(a.max_dias_almacen, 120); assert.equal(a.dias_max_almacen, 200); assert.equal(a.sobre_limite, 1);
  assert.deepEqual((await call('admin', 'GET', '/series?sobre_limite=1')).j.series.map(s => s.serie), ['E001']);
  const t = (await call('admin', 'GET', '/tablero')).j;
  assert.ok(t.antiguedad.sobre_limite >= 1); assert.ok(t.antiguedad.tramos.some(x => x.etiqueta === '181–365 días' && x.n >= 1));
});

test('PCI PTS: con la certificación vencida no se entrega; por vencer avisa; al renovarla se puede entregar', async () => {
  const id = await art({ sku: 'TERM-P', nombre: 'Terminal P', serializado: true, pci_pts_vence: dia(3), pci_pts_folio: '4-12345' });
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(20), costo_unitario: 1000, documento: 'P-1', series: 'P001\nP002' });
  const v = await mov({ articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(0), series: 'P001', empresa: 'ACME SA', unidad: 'Norte' });
  assert.equal(v.s, 409); assert.equal(v.j.codigo, 'pci_vencida');
  const t = (await call('admin', 'GET', '/tablero')).j;
  assert.ok(t.pci.some(x => x.sku === 'TERM-P' && x.estado === 'vencida'));
  assert.equal((await call('admin', 'POST', '/articulos', { id, sku: 'TERM-P', nombre: 'Terminal P', pci_pts_vence: 'no-es-fecha' })).s, 400);
  assert.equal((await call('admin', 'POST', '/articulos', { id, sku: 'TERM-P', nombre: 'Terminal P', pci_pts_vence: mas(30), pci_pts_folio: '4-12345' })).s, 200);
  const ok = await mov({ articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(0), series: 'P001', empresa: 'ACME SA', unidad: 'Norte' });
  assert.equal(ok.s, 200); assert.equal(ok.j.avisos.length, 1); assert.match(ok.j.avisos[0], /PCI PTS/);                                            // vence en 30 días → aviso
  assert.equal((await arts()).find(x => x.id === id).pci.estado, 'por_vencer');
  // editar otros datos del artículo no borra la vigencia
  await call('admin', 'POST', '/articulos', { id, sku: 'TERM-P', nombre: 'Terminal P v2' });
  assert.equal((await arts()).find(x => x.id === id).pci_pts_vence, mas(30));
});

test('ABC + punto de reorden: la clase sale del consumo valuado; el ROP suma el tiempo del proveedor y el de configuración', async () => {
  const caro = await art({ sku: 'LEC-1', nombre: 'Lector chip', unidad: 'pieza', tiempo_entrega_dias: 20, tiempo_config_dias: 5, cobertura_dias: 30 });
  const barato = await art({ sku: 'PAP-1', nombre: 'Papel térmico', unidad: 'caja' });
  const quieto = await art({ sku: 'ETI-1', nombre: 'Etiquetas', unidad: 'caja', minimo: 3 });
  await mov({ articulo_id: caro, tipo: 'entrada', concepto: 'compra', fecha: dia(80), cantidad: 100, costo_unitario: 500, documento: 'L-1' });
  await mov({ articulo_id: barato, tipo: 'entrada', concepto: 'compra', fecha: dia(80), cantidad: 100, costo_unitario: 5, documento: 'L-2' });
  await mov({ articulo_id: quieto, tipo: 'entrada', concepto: 'compra', fecha: dia(80), cantidad: 10, costo_unitario: 20, documento: 'L-3' });
  for (const d of [60, 45, 30, 15, 5]) { await mov({ articulo_id: caro, tipo: 'salida', concepto: 'consumo_interno', fecha: dia(d), cantidad: 16 }); await mov({ articulo_id: barato, tipo: 'salida', concepto: 'consumo_interno', fecha: dia(d), cantidad: 2 }); }
  const l = await arts();
  const c = l.find(x => x.id === caro), b = l.find(x => x.id === barato), q = l.find(x => x.id === quieto);
  assert.equal(c.clase, 'A'); assert.equal(q.clase, 'C');
  assert.equal(c.existencia, 20); assert.equal(c.demanda_90d, 80);
  assert.equal(c.reorden.lead_dias, 25);                                                                                                              // 20 de proveedor + 5 de configuración
  assert.equal(c.reorden.punto_reorden, Math.ceil(c.reorden.demanda_diaria * 25 + c.reorden.stock_seguridad));
  assert.ok(c.reorden.stock_seguridad > 0 && c.reorden.ss_manual === false);
  assert.ok(['reordenar', 'urgente'].includes(c.reorden.estado)); assert.ok(c.reorden.sugerido > 0);                                                 // 20 piezas con ~0.9/día y 25 días de espera: ya hay que pedir
  assert.equal(q.reorden.estado, 'ok'); assert.equal(q.reorden.ss_manual, true); assert.equal(q.reorden.stock_seguridad, 3);    // el mínimo capturado manda como stock de seguridad
  assert.equal(b.reorden.estado, 'ok');
  const r = await call('consulta', 'GET', '/reorden');
  assert.equal(r.s, 200); assert.equal(r.j.articulos[0].sku, 'LEC-1'); assert.ok(r.j.resumen.urgente + r.j.resumen.reordenar >= 1);
  const x = await call('consulta', 'GET', '/reorden.xlsx'); assert.equal(x.s, 200);
  const t = (await call('consulta', 'GET', '/tablero')).j;
  assert.ok(t.reorden.some(z => z.sku === 'LEC-1')); assert.ok(t.abc.A.n >= 1 && t.abc.A.consumo >= 8000);
  assert.equal((await call('admin', 'POST', '/articulos', { sku: 'MAL-1', nombre: 'Mal', tiempo_entrega_dias: -2 })).s, 400);
  assert.equal((await call('admin', 'POST', '/articulos', { sku: 'MAL-2', nombre: 'Mal', tiempo_config_dias: 1.5 })).s, 400);
});

test('conteo cíclico: propone por clase, compara lo contado con lo esperado, exige decisión y motivo, ajusta con movimientos y no cierra si hubo cambios', async () => {
  const id = await art({ sku: 'CC-1', nombre: 'Cable USB', unidad: 'pieza' });
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(30), cantidad: 50, costo_unitario: 10, documento: 'C-1' });
  await mov({ articulo_id: id, tipo: 'salida', concepto: 'consumo_interno', fecha: dia(10), cantidad: 5 });
  const p = await call('admin', 'GET', '/conteos/propuesta?limite=50');
  assert.equal(p.s, 200); assert.ok(p.j.propuesta.some(x => x.id === id)); assert.deepEqual(p.j.frecuencias, { A: 30, B: 90, C: 180 });
  const ab = await call('admin', 'POST', '/conteos', { articulo_ids: [id], nota: 'Conteo semanal' });
  assert.equal(ab.s, 200); const cid = ab.j.id;
  assert.equal((await call('admin', 'POST', '/conteos', { articulo_ids: [id] })).j.codigo, 'abierto');                                                   // solo uno abierto a la vez
  assert.equal((await call('consulta', 'POST', `/conteos/${cid}/contar`, { articulo_id: id, contada: 40 })).s, 403);
  assert.equal((await call('admin', 'POST', `/conteos/${cid}/contar`, { articulo_id: id, contada: '' })).s, 422);
  const ct = await call('admin', 'POST', `/conteos/${cid}/contar`, { articulo_id: id, contada: 43 });
  assert.equal(ct.s, 200); assert.equal(ct.j.resultado.esperado, 45); assert.equal(ct.j.resultado.diferencia, -2);
  // sin decisión o sin motivo no cierra
  assert.equal((await call('admin', 'POST', `/conteos/${cid}/cerrar`, {})).j.codigo, 'decision');
  assert.equal((await call('admin', 'POST', `/conteos/${cid}/cerrar`, { decisiones: [{ articulo_id: id, accion: 'ajustar', motivo: 'corto' }] })).j.codigo, 'motivo');
  // si hubo movimientos desde el conteo, hay que volver a contar
  await mov({ articulo_id: id, tipo: 'salida', concepto: 'consumo_interno', fecha: dia(0), cantidad: 1 });
  const cam = await call('admin', 'POST', `/conteos/${cid}/cerrar`, { decisiones: [{ articulo_id: id, accion: 'ajustar', motivo: 'Faltaron 2 en bodega' }] });
  assert.equal(cam.s, 409); assert.equal(cam.j.codigo, 'cambio');
  await call('admin', 'POST', `/conteos/${cid}/contar`, { articulo_id: id, contada: 42 });                                                              // recuento: esperado 44 → diferencia -2
  const ci = await call('admin', 'POST', `/conteos/${cid}/cerrar`, { decisiones: [{ articulo_id: id, accion: 'ajustar', motivo: 'Faltaron 2 en bodega' }] });
  assert.equal(ci.s, 200, JSON.stringify(ci.j)); assert.equal(ci.j.ajustes, 1);
  const a = (await arts()).find(x => x.id === id);
  assert.equal(a.existencia, 42); assert.equal(a.ultimo_conteo, dia(0)); assert.equal(a.toca_conteo, false);
  const k = (await call('admin', 'GET', `/articulos/${id}/kardex`)).j.filas.at(-1);
  assert.equal(k.concepto, 'ajuste_negativo'); assert.match(k.notas, /Conteo cíclico #\d+: Faltaron 2 en bodega/);                                       // el ajuste es un movimiento con su folio y su motivo
  assert.equal((await call('admin', 'POST', `/conteos/${cid}/cerrar`, {})).j.codigo, 'cerrado');
  const det = (await call('admin', 'GET', `/conteos/${cid}`)).j;
  assert.equal(det.estado, 'cerrado'); assert.equal(det.lineas[0].diferencia, -2); assert.ok(det.lineas[0].ajuste_movimiento_id); assert.match(det.lineas[0].ajuste_motivo, /^Ajustado/);
  assert.equal((await call('admin', 'GET', '/conteos')).j.conteos[0].con_diferencia, 1);
  // una diferencia puede quedarse pendiente (sin ajustar) con motivo
  const c2 = (await call('admin', 'POST', '/conteos', { articulo_ids: [id] })).j.id;
  await call('admin', 'POST', `/conteos/${c2}/contar`, { articulo_id: id, contada: 41 });
  const pe = await call('admin', 'POST', `/conteos/${c2}/cerrar`, { decisiones: [{ articulo_id: id, accion: 'pendiente', motivo: 'Se investigará con almacén' }] });
  assert.equal(pe.s, 200); assert.equal(pe.j.pendientes, 1); assert.equal((await arts()).find(x => x.id === id).existencia, 42);
});

test('conteo cíclico de terminales: faltantes se dan de baja, sobrantes desconocidos se dan de alta y los que el sistema tiene asignados se señalan', async () => {
  const id = await art({ sku: 'CC-T', nombre: 'Terminal conteo', serializado: true });
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'compra', fecha: dia(20), costo_unitario: 1000, documento: 'T-1', series: 'T001\nT002\nT003\nT004' });
  await mov({ articulo_id: id, tipo: 'salida', concepto: 'entrega', fecha: dia(5), series: 'T004', empresa: 'ACME SA', unidad: 'Norte' });
  const cid = (await call('admin', 'POST', '/conteos', { articulo_ids: [id] })).j.id;
  const ct = await call('admin', 'POST', `/conteos/${cid}/contar`, { articulo_id: id, series: 'T001\nT003\nT009\nT004' });
  assert.equal(ct.s, 200); const r = ct.j.resultado;
  assert.deepEqual(r.faltantes, ['T002']); assert.deepEqual(r.sobrantes_desconocidas, ['T009']); assert.deepEqual(r.sobrantes_conocidas, [{ serie: 'T004', estado: 'asignada' }]);
  assert.equal(r.esperado, 3); assert.equal(r.contado, 4);
  const mal = await call('admin', 'POST', `/conteos/${cid}/cerrar`, { decisiones: [{ articulo_id: id, accion: 'ajustar', motivo: 'Ajuste del conteo físico' }] });
  assert.equal(mal.s, 422); assert.equal(mal.j.codigo, 'conocidas');                                                                                     // T004 aparece en almacén pero el sistema la tiene con el cliente
  // se registra la devolución del cliente y se vuelve a contar
  await mov({ articulo_id: id, tipo: 'entrada', concepto: 'devolucion_cliente', fecha: dia(0), costo_unitario: 0, series: 'T004' });
  await call('admin', 'POST', `/conteos/${cid}/contar`, { articulo_id: id, series: 'T001\nT003\nT009\nT004' });
  const ci = await call('admin', 'POST', `/conteos/${cid}/cerrar`, { decisiones: [{ articulo_id: id, accion: 'ajustar', motivo: 'Ajuste del conteo físico' }] });
  assert.equal(ci.s, 200, JSON.stringify(ci.j)); assert.equal(ci.j.ajustes, 2);
  const se = (await call('admin', 'GET', `/series?articulo_id=${id}`)).j.series;
  assert.deepEqual(se.map(s => [s.serie, s.estado]).sort(), [['T001', 'almacen'], ['T002', 'baja'], ['T003', 'almacen'], ['T004', 'almacen'], ['T009', 'almacen']]);
});

test('layout simple con IMEI y TID: se guardan por equipo y no se pueden repetir', async () => {
  const libro = filas => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), 'Terminales'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }).toString('base64'); };
  const H = ['sn', 'imei', 'tid', 'modelo', 'costo', 'fecha_compra', 'documento', 'proveedor', 'empresa', 'unidad', 'fecha_entrega'];
  const lay = (archivo, extra) => call('admin', 'POST', '/layout', { archivo, nombre: 'terminales.xlsx', ...(extra || {}) });
  const dup = await lay(libro([H, ['L001', '350000000010001', 'TL1', 'Terminal Layout', 1500, dia(9), 'F-9', 'P', '', '', ''], ['L002', '350000000010001', 'TL2', 'Terminal Layout', 1500, dia(9), 'F-9', 'P', '', '', '']]));
  assert.equal(dup.j.ok, false); assert.ok(dup.j.errores.some(e => /IMEI 350000000010001 está en dos equipos/.test(e.mensaje)));
  assert.equal((await lay(libro([H, ['L001', '123', '', 'Terminal Layout', 1500, dia(9), 'F-9', 'P', '', '', '']]))).j.errores[0].mensaje.includes('15 dígitos'), true);
  const buen = libro([H, ['L001', '350000000010001', 'TL1', 'Terminal Layout', 1500, dia(9), 'F-9', 'P', 'ACME SA', 'Norte', dia(2)], ['L002', '350000000010002', '', 'Terminal Layout', 1500, dia(9), 'F-9', 'P', '', '', '']]);
  const sim = await lay(buen); assert.equal(sim.j.ok, true, JSON.stringify(sim.j.errores));
  assert.equal((await lay(buen, { aplicar: true, huella: sim.j.huella })).s, 200);
  const s1 = (await call('admin', 'GET', '/series?q=350000000010001')).j.series;
  assert.equal(s1.length, 1); assert.equal(s1[0].serie, 'L001'); assert.equal(s1[0].tid, 'TL1'); assert.equal(s1[0].estado, 'asignada');
  // otro archivo con un IMEI que ya existe en el inventario: no se aplica nada
  const choque = libro([H, ['L003', '350000000010001', '', 'Terminal Layout', 1500, dia(1), 'F-10', 'P', '', '', '']]);
  const s2 = await lay(choque); assert.equal(s2.j.ok, true);
  const ap = await lay(choque, { aplicar: true, huella: s2.j.huella });
  assert.equal(ap.s, 409); assert.equal(ap.j.codigo, 'imei_tid');
  assert.equal((await call('admin', 'GET', '/series?q=L003')).j.series.length, 0);                                                                       // todo o nada
});
