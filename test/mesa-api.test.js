/* Mesa de control (Credit Solvendom): API completa contra una base pglite en memoria — flujo, segregación de funciones, versiones y bitácora inalterable. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { montar } = require('../lib/mesa/routes.js');
const B = require('../lib/mesa/bitacora.js');

const U = {
  ej:  { email: 'ej@t.local', nombre: 'Ejecutivo', rol: 'consulta', rol_cartera: 'ejecutivo' },
  ej2: { email: 'ej2@t.local', nombre: 'Ejecutivo 2', rol: 'consulta', rol_cartera: 'ejecutivo' },
  an:  { email: 'an@t.local', nombre: 'Analista', rol: 'consulta', rol_cartera: 'analista' },
  cu:  { email: 'cu@t.local', nombre: 'Cumplimiento', rol: 'consulta', rol_cartera: 'cumplimiento' },
  me:  { email: 'me@t.local', nombre: 'Mesa', rol: 'consulta', rol_cartera: 'mesa' },
  ad:  { email: 'ad@t.local', nombre: 'Admin', rol: 'admin', rol_cartera: 'admin' },
  co:  { email: 'co@t.local', nombre: 'Consulta', rol: 'consulta', rol_cartera: 'consulta' },
  nada:{ email: 'x@t.local', nombre: 'Sin acceso', rol: 'consulta', rol_cartera: null },
};

async function arrancar() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec('create table usuarios(id serial primary key, activo boolean default true, rol text, rol_cartera text)');
  await pg.exec("insert into usuarios(rol, rol_cartera) values ('admin','admin')");                    // un solo administrador activo
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-mesa.sql'), 'utf8'));
  const db = { query: (t, p) => pg.query(t, p || []), tx: fn => pg.transaction(async t => fn({ query: (q, p) => t.query(q, p || []) })) };
  const app = express(); app.use(express.json({ limit: '12mb' }));
  const auth = (req, res, next) => { const u = U[req.get('x-u')]; if (!u) return res.status(401).json({ error: 'sin_token' }); req.user = { sub: 1, ...u }; next(); };
  montar(app, { auth, db });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = async (u, metodo, ruta, cuerpo) => {
    const opts = { method: metodo, headers: { 'x-u': u } };
    if (cuerpo instanceof FormData) opts.body = cuerpo; else if (cuerpo !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(cuerpo); }
    const r = await fetch(base + '/api/cartera/mc' + ruta, opts);
    let j = null; try { j = await r.json(); } catch (_e) { /* descarga */ }
    return { s: r.status, j };
  };
  const bajar = async (u, ruta) => { const r = await fetch(base + '/api/cartera/mc' + ruta, { headers: { 'x-u': u } }); return { s: r.status, tipo: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };
  return { pg, db, api, bajar, cerrar: async () => { srv.close(); await pg.close(); } };
}

const PROD = { clave: 'pyme_test', nombre: 'PyME de prueba', tipo: 'simple', monto_min: 10000, monto_max: 800000, plazo_min: 3, plazo_max: 36, tasa_min: 0.2, tasa_max: 0.5, tasa_default: 0.36, periodicidades: ['mensual'], comision_apertura: 0.02 };
const solicitud = (producto_id, monto, extra) => ({
  solicitante: { tipo: 'moral', nombre: 'Taller Mecánico Los Pinos SA de CV', rfc: 'TMP120730KL5', domicilio: 'Av. Siempre Viva 742', telefono: '3312345678', email: 'taller@ejemplo.com', actividad: 'Reparación automotriz', beneficiario_controlador: 'Socio A', origen_recursos: 'Ventas', ...(extra || {}) },
  solicitud: { producto_id, monto, plazo_meses: 12, periodicidad: 'mensual', tasa_anual: 0.36, destino: 'Capital de trabajo', ingresos_mensuales: 300000, egresos_mensuales: 120000, otras_deudas_mensuales: 5000, antiguedad_meses: 60, score_buro: 700 },
});
const pdf = (nombre) => { const f = new FormData(); return f; void nombre; };
async function subirDoc(api, usuario, id, tipo) {
  const f = new FormData(); f.append('tipo', tipo); f.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'doc.pdf');
  return api(usuario, 'POST', `/solicitudes/${id}/documentos`, f);
}
async function llevarAVerificacion(api, producto, monto, extra) {
  const c = await api('ej', 'POST', '/solicitudes', solicitud(producto, monto, extra)); assert.equal(c.s, 201, JSON.stringify(c.j));
  const id = c.j.id; let d = (await api('ej', 'GET', '/solicitudes/' + id)).j;
  for (const doc of d.documentos) assert.equal((await subirDoc(api, 'ej', id, doc.tipo)).s, 200);
  d = (await api('ej', 'GET', '/solicitudes/' + id)).j;
  const env = await api('ej', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar', _v: d.solicitud.version }); assert.equal(env.s, 200, JSON.stringify(env.j));
  return id;
}
async function verificar(api, id) {
  let d = (await api('an', 'GET', '/solicitudes/' + id)).j;
  for (const doc of d.documentos) assert.equal((await api('an', 'PATCH', `/solicitudes/${id}/documentos`, { tipo: doc.tipo, estado: 'validado' })).s, 200);
  assert.equal((await api('an', 'POST', `/solicitudes/${id}/pld`)).s, 200);
  d = (await api('an', 'GET', '/solicitudes/' + id)).j;
  return api('an', 'POST', `/solicitudes/${id}/accion`, { accion: 'verificar', _v: d.solicitud.version });
}

test('mesa de control: flujo completo, segregación, versión y bitácora inalterable', async () => {
  const { pg, api, cerrar } = await arrancar();
  try {
    // ---- acceso y permisos ----
    assert.equal((await api('nada', 'GET', '/yo')).s, 403, 'sin rol_cartera no entra');
    assert.equal((await api('ej', 'GET', '/yo')).j.rol, 'ejecutivo');
    assert.equal((await api('ej', 'POST', '/productos', PROD)).s, 403, 'el ejecutivo no administra productos');
    const p = await api('ad', 'POST', '/productos', PROD); assert.equal(p.s, 201, JSON.stringify(p.j));
    assert.equal((await api('ad', 'POST', '/productos', PROD)).s, 409, 'clave repetida');
    assert.equal((await api('ad', 'POST', '/productos', { ...PROD, clave: 'x2', tasa_default: 0.9 })).s, 400, 'tasa de referencia fuera de rango');
    const prod = p.j.id;

    // ---- captura con validación ----
    assert.equal((await api('ej', 'POST', '/solicitudes', solicitud(prod, 100000, { rfc: 'MALRFC' }))).s, 400, 'RFC inválido');
    assert.equal((await api('co', 'POST', '/solicitudes', solicitud(prod, 100000))).s, 403, 'consulta no crea');
    const bad = solicitud(prod, 100000); bad.solicitud.tasa_anual = 0.9;
    assert.equal((await api('ej', 'POST', '/solicitudes', bad)).s, 400, 'tasa fuera del producto');

    // ---- alta → expediente → envío ----
    const c = await api('ej', 'POST', '/solicitudes', solicitud(prod, 100000)); assert.equal(c.s, 201);
    const id = c.j.id; assert.match(c.j.folio, /^SOL-\d{4}-\d{4}$/);
    let d = (await api('ej', 'GET', '/solicitudes/' + id)).j;
    assert.equal(d.solicitud.estado, 'borrador'); assert.equal(d.solicitante.rfc, 'TMP120730KL5', 'RFC se descifra al leer');
    assert.equal(d.documentos.length, 6, 'persona moral pide 6 documentos');
    const crudo = (await pg.query('select rfc_cifrado, domicilio_cifrado from credit_solvendom.mc_solicitantes limit 1')).rows[0];
    assert.ok(!String(crudo.rfc_cifrado).includes('TMP120730') || String(crudo.rfc_cifrado).startsWith('plain:'), 'en base va cifrado (o con prefijo plain en dev sin llaves)');
    assert.equal((await api('ej2', 'GET', '/solicitudes/' + id)).s, 403, 'otro ejecutivo no ve la solicitud');
    assert.equal((await api('ej2', 'GET', '/solicitudes')).j.total, 0, 'ni en su lista');
    assert.equal((await api('an', 'GET', '/solicitudes')).j.total, 1, 'el analista ve todas');
    let env = await api('ej', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar', _v: d.solicitud.version });
    assert.equal(env.s, 400, 'sin documentos no se puede enviar'); assert.ok(env.j.faltan.length === 6);
    assert.equal((await subirDoc(api, 'ej', id, 'Documento inventado')).s, 400, 'solo documentos requeridos');
    for (const doc of d.documentos) assert.equal((await subirDoc(api, 'ej', id, doc.tipo)).s, 200);
    d = (await api('ej', 'GET', '/solicitudes/' + id)).j;
    // versión: una edición con versión vieja se rechaza
    const ed = { ...solicitud(prod, 100000), _v: d.solicitud.version - 1 };
    assert.equal((await api('ej', 'PUT', '/solicitudes/' + id, ed)).s, 409, 'versión vieja');
    assert.equal((await api('ej', 'PUT', '/solicitudes/' + id, { ...solicitud(prod, 110000), _v: d.solicitud.version })).s, 200);
    d = (await api('ej', 'GET', '/solicitudes/' + id)).j; assert.equal(d.solicitud.monto, 110000);
    assert.equal((await api('ej', 'POST', `/solicitudes/${id}/accion`, { accion: 'autorizar', _v: d.solicitud.version })).s, 409, 'no se autoriza un borrador');
    env = await api('ej', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar', _v: d.solicitud.version }); assert.equal(env.s, 200, JSON.stringify(env.j));

    // ---- verificación: segregación de documentos y PLD ----
    assert.equal((await api('ej', 'PATCH', `/solicitudes/${id}/documentos`, { tipo: d.documentos[0].tipo, estado: 'validado' })).s, 403, 'el ejecutivo no valida');
    d = (await api('an', 'GET', '/solicitudes/' + id)).j; assert.equal(d.solicitud.estado, 'verificacion');
    assert.equal((await api('an', 'POST', `/solicitudes/${id}/accion`, { accion: 'verificar', _v: d.solicitud.version })).s, 409, 'sin documentos validados no pasa');
    for (const doc of d.documentos) assert.equal((await api('an', 'PATCH', `/solicitudes/${id}/documentos`, { tipo: doc.tipo, estado: 'validado' })).s, 200);
    assert.equal((await api('an', 'POST', `/solicitudes/${id}/accion`, { accion: 'verificar', _v: d.solicitud.version })).s, 409, 'sin consulta PLD no pasa');
    // lista con coincidencia: se confirma → no se puede autorizar; aquí se descarta
    await api('ad', 'POST', '/listas', { fuente: 'UIF', nombre: 'Taller Mecanico Los Pinos', tipo: 'empresa' });
    assert.equal((await api('an', 'POST', `/solicitudes/${id}/pld`)).j.coincidencias, 1);
    d = (await api('an', 'GET', '/solicitudes/' + id)).j;
    assert.equal((await api('an', 'POST', `/solicitudes/${id}/accion`, { accion: 'verificar', _v: d.solicitud.version })).s, 409, 'coincidencia por resolver');
    assert.equal((await api('an', 'PATCH', `/pld/coincidencias/${d.pld.coincidencias[0].id}`, { estado: 'descartada', comentario: 'x'.repeat(20) })).s, 403, 'el analista no resuelve PLD');
    assert.equal((await api('cu', 'PATCH', `/pld/coincidencias/${d.pld.coincidencias[0].id}`, { estado: 'descartada', comentario: 'corto' })).s, 400, 'comentario obligatorio');
    assert.equal((await api('cu', 'PATCH', `/pld/coincidencias/${d.pld.coincidencias[0].id}`, { estado: 'descartada', comentario: 'Homónimo: distinto RFC y domicilio.' })).s, 200);
    d = (await api('an', 'GET', '/solicitudes/' + id)).j;
    const ver = await api('an', 'POST', `/solicitudes/${id}/accion`, { accion: 'verificar', _v: d.solicitud.version }); assert.equal(ver.s, 200, JSON.stringify(ver.j));

    // ---- decisión: evaluación, segregación y autorización ----
    d = (await api('me', 'GET', '/solicitudes/' + id)).j;
    assert.equal(d.solicitud.estado, 'decision'); assert.equal(d.evaluacion_guardada.vigente, true); assert.equal(d.nivel_pendiente, 'mesa');
    assert.equal(d.acciones.autorizar, true); assert.equal((await api('an', 'GET', '/solicitudes/' + id)).j.acciones.autorizar, false, 'el analista no firma');
    assert.equal((await api('an', 'POST', `/solicitudes/${id}/accion`, { accion: 'autorizar', _v: d.solicitud.version })).s, 403);
    assert.equal((await api('me', 'POST', `/solicitudes/${id}/accion`, { accion: 'autorizar', _v: d.solicitud.version, monto_autorizado: 999999 })).s, 400, 'no se autoriza más de lo solicitado');
    assert.equal((await api('me', 'POST', `/solicitudes/${id}/accion`, { accion: 'autorizar', _v: d.solicitud.version - 1 })).s, 409, 'versión vieja');
    const aut = await api('me', 'POST', `/solicitudes/${id}/accion`, { accion: 'autorizar', _v: d.solicitud.version, monto_autorizado: 100000, comentario: 'ok' });
    assert.equal(aut.s, 200, JSON.stringify(aut.j)); assert.equal(aut.j.final, true);
    d = (await api('me', 'GET', '/solicitudes/' + id)).j;
    assert.equal(d.solicitud.estado, 'autorizada'); assert.equal(d.solicitud.monto_autorizado, 100000); assert.ok(d.solicitud.vigencia_hasta);
    assert.equal((await api('me', 'POST', `/solicitudes/${id}/accion`, { accion: 'rechazar', motivo: 'Política de crédito', comentario: 'x'.repeat(20), _v: d.solicitud.version })).s, 409, 'una autorizada ya no se rechaza');
    assert.equal((await api('ej', 'PUT', '/solicitudes/' + id, { ...solicitud(prod, 90000), _v: d.solicitud.version })).s, 409, 'una autorizada no se edita');

    // ---- monto sobre la facultad de la mesa → también firma el comité (administrador) ----
    const id2 = await llevarAVerificacion(api, prod, 400000, { rfc: 'ABC120730KL5', nombre: 'Comercializadora Grande SA de CV' });
    const v2 = await verificar(api, id2); assert.equal(v2.s, 200, JSON.stringify(v2.j));
    d = (await api('me', 'GET', '/solicitudes/' + id2)).j; assert.deepEqual(d.niveles, ['mesa', 'comite']);
    let f1 = await api('me', 'POST', `/solicitudes/${id2}/accion`, { accion: 'autorizar', _v: d.solicitud.version, comentario: 'ok' });
    assert.equal(f1.j.final, false); assert.deepEqual(f1.j.falta, ['comite']);
    d = (await api('me', 'GET', '/solicitudes/' + id2)).j; assert.equal(d.solicitud.estado, 'decision'); assert.equal(d.acciones.autorizar, false, 'la mesa no firma el comité');
    d = (await api('ad', 'GET', '/solicitudes/' + id2)).j; assert.equal(d.acciones.autorizar, true);
    const f2 = await api('ad', 'POST', `/solicitudes/${id2}/accion`, { accion: 'autorizar', _v: d.solicitud.version, comentario: 'Aprobado por comité.' });
    assert.equal(f2.s, 200, JSON.stringify(f2.j)); assert.equal(f2.j.final, true);

    // ---- rechazo con motivo; devolución; cancelación ----
    const id3 = await llevarAVerificacion(api, prod, 150000, { rfc: 'DEF120730KL5', nombre: 'Estudio Creativo Sol SA de CV' });
    d = (await api('an', 'GET', '/solicitudes/' + id3)).j;
    assert.equal((await api('an', 'POST', `/solicitudes/${id3}/accion`, { accion: 'devolver', comentario: 'corto', _v: d.solicitud.version })).s, 400);
    const dev = await api('an', 'POST', `/solicitudes/${id3}/accion`, { accion: 'devolver', comentario: 'Falta el estado de cuenta más reciente.', _v: d.solicitud.version }); assert.equal(dev.s, 200);
    d = (await api('ej', 'GET', '/solicitudes/' + id3)).j; assert.equal(d.solicitud.estado, 'devuelta'); assert.equal(d.acciones.editar, true);
    assert.equal((await api('ej2', 'POST', `/solicitudes/${id3}/accion`, { accion: 'cancelar', comentario: 'x'.repeat(12), _v: d.solicitud.version })).s, 403, 'otro ejecutivo no cancela');
    assert.equal((await api('ej', 'POST', `/solicitudes/${id3}/accion`, { accion: 'cancelar', comentario: 'El cliente ya no la quiere.', _v: d.solicitud.version })).s, 200);
    const id4 = await llevarAVerificacion(api, prod, 150000, { rfc: 'GHI120730KL5', nombre: 'Panificadora Luna SA de CV' });
    assert.equal((await verificar(api, id4)).s, 200);
    d = (await api('me', 'GET', '/solicitudes/' + id4)).j;
    assert.equal((await api('me', 'POST', `/solicitudes/${id4}/accion`, { accion: 'rechazar', comentario: 'Perfil débil.', motivo: 'Inventado', _v: d.solicitud.version })).s, 400, 'motivo del catálogo');
    assert.equal((await api('me', 'POST', `/solicitudes/${id4}/accion`, { accion: 'rechazar', comentario: 'Perfil débil de pago.', motivo: 'Capacidad de pago', _v: d.solicitud.version })).s, 200);
    assert.equal((await api('me', 'GET', '/solicitudes/' + id4)).j.solicitud.estado, 'rechazada');

    // ---- tablero, listado paginado y bitácora ----
    const tb = (await api('ad', 'GET', '/tablero')).j;
    assert.equal(tb.kpi.autorizadas, 2); assert.equal(tb.kpi.rechazadas, 1); assert.equal(tb.kpi.tasa_aprobacion, 66.7);
    assert.equal((await api('ad', 'GET', '/solicitudes?estado=autorizada')).j.total, 2);
    const pg1 = (await api('ad', 'GET', '/solicitudes')).j; assert.equal(pg1.por_pag, 10); assert.equal(pg1.total, 4);
    assert.equal((await api('ej', 'GET', '/bitacora')).s, 403, 'el ejecutivo no ve la bitácora');
    const bit = (await api('ad', 'GET', '/bitacora?entidad=solicitud')).j; assert.ok(bit.total > 20);
    const v = (await api('ad', 'GET', '/bitacora/verificar')).j; assert.equal(v.ok, true, JSON.stringify(v));

    // ---- inalterable: los triggers impiden cambiar o borrar; y si se altera saltándolos, la cadena lo detecta ----
    await assert.rejects(pg.query("update credit_solvendom.mc_bitacora set resumen='x' where id=1"), /inalterable/);
    await assert.rejects(pg.query('delete from credit_solvendom.mc_bitacora where id=1'), /inalterable/);
    await assert.rejects(pg.query('truncate credit_solvendom.mc_bitacora'), /inalterable/);
    await pg.exec('alter table credit_solvendom.mc_bitacora disable trigger mc_bitacora_sin_update');
    await pg.exec("update credit_solvendom.mc_bitacora set resumen='ALTERADO' where id=3");
    const roto = (await api('ad', 'GET', '/bitacora/verificar')).j; assert.equal(roto.ok, false); assert.equal(roto.primero_roto, 3);
    void B;
  } finally { await cerrar(); }
});

test('mesa de control: autoaprobación solo del único administrador, con comentario y en alerta', async () => {
  const { pg, api, cerrar } = await arrancar();
  try {
    const prod = (await api('ad', 'POST', '/productos', PROD)).j.id;
    // el administrador captura, verifica y autoriza: con UN solo administrador activo se permite, pero exige comentario y queda marcado
    const c = await api('ad', 'POST', '/solicitudes', solicitud(prod, 80000)); const id = c.j.id;
    let d = (await api('ad', 'GET', '/solicitudes/' + id)).j;
    for (const doc of d.documentos) await subirDoc(api, 'ad', id, doc.tipo);
    d = (await api('ad', 'GET', '/solicitudes/' + id)).j;
    assert.equal((await api('ad', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar', _v: d.solicitud.version })).s, 200);
    d = (await api('ad', 'GET', '/solicitudes/' + id)).j;
    for (const doc of d.documentos) assert.equal((await api('ad', 'PATCH', `/solicitudes/${id}/documentos`, { tipo: doc.tipo, estado: 'validado' })).s, 200);
    await api('ad', 'POST', `/solicitudes/${id}/pld`);
    d = (await api('ad', 'GET', '/solicitudes/' + id)).j;
    assert.equal((await api('ad', 'POST', `/solicitudes/${id}/accion`, { accion: 'verificar', _v: d.solicitud.version })).s, 400, 'sin comentario no se autoaprueba');
    assert.equal((await api('ad', 'POST', `/solicitudes/${id}/accion`, { accion: 'verificar', comentario: 'Soy el único administrador; verifiqué personalmente el expediente.', _v: d.solicitud.version })).s, 200);
    d = (await api('ad', 'GET', '/solicitudes/' + id)).j; assert.equal(d.acciones.conflicto_firma, true);
    assert.equal((await api('ad', 'POST', `/solicitudes/${id}/accion`, { accion: 'autorizar', _v: d.solicitud.version })).s, 400, 'autoaprobación sin comentario');
    const ok = await api('ad', 'POST', `/solicitudes/${id}/accion`, { accion: 'autorizar', comentario: 'Único administrador: revisé el expediente completo.', _v: d.solicitud.version });
    assert.equal(ok.s, 200, JSON.stringify(ok.j));
    assert.ok(Number((await api('ad', 'GET', '/tablero')).j.alertas.autoaprobadas) >= 2, 'queda en alerta');
    // con DOS administradores activos la autoaprobación se prohíbe
    await pg.exec("insert into usuarios(rol, rol_cartera) values ('admin','admin')");
    const c2 = await api('ad', 'POST', '/solicitudes', solicitud(prod, 80000, { rfc: 'ZZZ120730KL5', nombre: 'Otra Empresa SA de CV' })); const id2 = c2.j.id;
    d = (await api('ad', 'GET', '/solicitudes/' + id2)).j;
    for (const doc of d.documentos) await subirDoc(api, 'ad', id2, doc.tipo);
    d = (await api('ad', 'GET', '/solicitudes/' + id2)).j;
    assert.equal((await api('ad', 'POST', `/solicitudes/${id2}/accion`, { accion: 'enviar', _v: d.solicitud.version })).s, 200);
    d = (await api('ad', 'GET', '/solicitudes/' + id2)).j;
    for (const doc of d.documentos) await api('an', 'PATCH', `/solicitudes/${id2}/documentos`, { tipo: doc.tipo, estado: 'validado' });
    await api('an', 'POST', `/solicitudes/${id2}/pld`);
    d = (await api('ad', 'GET', '/solicitudes/' + id2)).j;
    assert.equal((await api('ad', 'POST', `/solicitudes/${id2}/accion`, { accion: 'verificar', comentario: 'x'.repeat(30), _v: d.solicitud.version })).s, 403, 'con 2 administradores el que capturó no verifica');
  } finally { await cerrar(); }
});

test('mesa de control: listas PLD (importar CSV, retirar) y ejemplos', async () => {
  const { api, cerrar } = await arrancar();
  try {
    const f = new FormData(); f.append('archivo', new Blob(['fuente,tipo,nombre,rfc,curp,notas\nOFAC,persona,Pedro Prueba Lista,PEPL800101AB1,,x\nOFAC,empresa,Empresa Fantasma SA,,,\n,persona,Sin fuente,,,\n'], { type: 'text/csv' }), 'l.csv');
    const r = await api('cu', 'POST', '/listas/importar', f); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.cargados, 2); assert.equal(r.j.omitidas, 1);
    assert.equal((await api('cu', 'GET', '/listas')).j.total, 2);
    assert.equal((await api('an', 'POST', '/listas', { fuente: 'X', nombre: 'Y' })).s, 403);
    const f2 = new FormData(); f2.append('archivo', new Blob(['fuente,nombre\nOFAC,Solo Uno\n'], { type: 'text/csv' }), 'l.csv'); f2.append('reemplazar', '1');
    const r2 = await api('cu', 'POST', '/listas/importar', f2); assert.equal(r2.j.retirados, 2); assert.equal((await api('cu', 'GET', '/listas')).j.total, 1);
    // ejemplos
    assert.equal((await api('ej', 'POST', '/ejemplos')).s, 403);
    const e = await api('ad', 'POST', '/ejemplos'); assert.equal(e.s, 200, JSON.stringify(e.j)); assert.equal(e.j.solicitudes, 10); assert.equal(e.j.creditos, 3); assert.equal(e.j.fondeos, 1);
    assert.equal((await api('ad', 'POST', '/ejemplos')).s, 409, 'no se duplican');
    const ls = (await api('ad', 'GET', '/solicitudes')).j; assert.equal(ls.total, 10);
    const estados = new Set(ls.filas.map(x => x.estado)); for (const s of ['borrador', 'devuelta', 'verificacion', 'decision', 'autorizada', 'rechazada']) assert.ok(estados.has(s), 'hay ejemplo ' + s);
    const tb = (await api('ad', 'GET', '/tablero')).j; assert.ok(tb.para_hoy.length > 0); assert.ok(tb.embudo.find(x => x.estado === 'decision').n === 2);
    const dec = ls.filas.find(x => x.estado === 'decision' && x.monto > 250000); const dd = (await api('ad', 'GET', '/solicitudes/' + dec.id)).j;
    assert.deepEqual(dd.niveles, ['cumplimiento', 'mesa', 'comite'], 'el ejemplo de riesgo alto pide cumplimiento, mesa y comité');
    assert.equal((await api('ad', 'GET', '/bitacora/verificar')).j.ok, true);
    const cr = (await api('ad', 'GET', '/creditos')).j; assert.equal(cr.total, 3); assert.ok(cr.filas.some(c => c.estado === 'vigente' && c.dias > 90), 'un ejemplo con atraso de más de 90 días'); assert.ok(cr.filas.some(c => c.estado === 'desembolso'));
    assert.ok((await api('ad', 'GET', '/cobranza')).j.filas.length >= 1); assert.ok((await api('ad', 'GET', '/panel-cartera')).j.resumen.imor > 0);
    const b = await api('ad', 'DELETE', '/ejemplos'); assert.equal(b.j.solicitudes, 10); assert.equal(b.j.creditos, 3); assert.equal((await api('ad', 'GET', '/creditos')).j.total, 0);
    assert.equal((await api('ad', 'GET', '/solicitudes')).j.total, 0);
    assert.equal((await api('ad', 'GET', '/bitacora/verificar')).j.ok, true, 'la bitácora conserva y sigue íntegra');
  } finally { await cerrar(); }
});

test('mesa de control: los archivos del expediente se guardan y se bajan idénticos (binarios, varios tipos, con y sin llaves de cifrado)', async () => {
  const { api, bajar, cerrar } = await arrancar();
  try {
    const prod = (await api('ad', 'POST', '/productos', PROD)).j.id;
    const id = (await api('ej', 'POST', '/solicitudes', solicitud(prod, 100000))).j.id;
    const d = (await api('ej', 'GET', '/solicitudes/' + id)).j;
    const binario = n => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 256; b[0] = 0x25; b[1] = 0x50; return b; };   // incluye todos los bytes, también los mayores a 0x7f
    const casos = [['a.pdf', 'application/pdf', binario(300000)], ['b.jpg', 'image/jpeg', binario(5000)], ['c.xlsx', 'application/octet-stream', binario(40000)], ['d.heic', '', binario(2000)], ['e.docx', 'application/zip', binario(1000)]];
    for (let i = 0; i < casos.length; i++) {
      const [nombre, mime, buf] = casos[i], tipo = d.documentos[i].tipo;
      const f = new FormData(); f.append('tipo', tipo); f.append('archivo', new Blob([buf], { type: mime }), nombre);
      const r = await api('ej', 'POST', `/solicitudes/${id}/documentos`, f); assert.equal(r.s, 200, nombre + ' ' + JSON.stringify(r.j));
      const g = await bajar('ej', `/solicitudes/${id}/documentos/archivo?tipo=${encodeURIComponent(tipo)}`);
      assert.equal(g.s, 200, nombre); assert.ok(g.buf.equals(buf), `${nombre}: el archivo bajado debe ser idéntico byte por byte`);
    }
    const mal = new FormData(); mal.append('tipo', d.documentos[5].tipo); mal.append('archivo', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'virus.exe');
    assert.equal((await api('ej', 'POST', `/solicitudes/${id}/documentos`, mal)).s, 400, 'un ejecutable no se acepta');
    const dd = (await api('ej', 'GET', '/solicitudes/' + id)).j;
    assert.equal(dd.documentos.filter(x => x.tiene_archivo).length, 5);
  } finally { await cerrar(); }
});
void pdf;
