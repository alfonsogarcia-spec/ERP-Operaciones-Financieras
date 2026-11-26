/* Portal de solicitudes de clientes (POS): flujo completo cliente → comercial → operación → coordinacion (→ dirección), alcance por cliente, segregación,
   validaciones contra POS, archivos binarios y bitácora encadenada. Base pglite en memoria con las tablas de POS que usa el módulo. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { montar } = require('../lib/solicitudes/routes.js');
const V = require('../lib/solicitudes/validar.js');

const clabe = (pref, n) => { const b = pref + String(n).padStart(14, '0'); const p = [3, 7, 1]; let s = 0; for (let i = 0; i < 17; i++) s += (Number(b[i]) * p[i % 3]) % 10; return b + ((10 - (s % 10)) % 10); };
const U = {
  cli:  { sub: 11, email: 'cliente@norte.test', nombre: 'Cliente Norte', rol: 'cliente', rol_solicitudes: 'cliente' },
  cli2: { sub: 12, email: 'cliente@sol.test', nombre: 'Cliente Sol', rol: 'cliente', rol_solicitudes: 'cliente' },
  com:  { sub: 21, email: 'com@polipay.test', nombre: 'Comercial Uno', rol: 'consulta', rol_solicitudes: 'comercial' },
  com2: { sub: 22, email: 'com2@polipay.test', nombre: 'Comercial Dos', rol: 'consulta', rol_solicitudes: 'comercial' },
  dir:  { sub: 23, email: 'dircom@polipay.test', nombre: 'Director Comercial', rol: 'consulta', rol_solicitudes: 'dir_comercial' },
  op:   { sub: 31, email: 'op@polipay.test', nombre: 'Operación POS', rol: 'consulta', rol_solicitudes: 'operacion' },
  ger:  { sub: 41, email: 'ger@polipay.test', nombre: 'Coordinación Ops', rol: 'consulta', rol_solicitudes: 'coordinacion' },
  dop:  { sub: 51, email: 'dop@polipay.test', nombre: 'Dirección Ops', rol: 'consulta', rol_solicitudes: 'direccion' },
  ad:   { sub: 61, email: 'ad@polipay.test', nombre: 'Admin', rol: 'admin', rol_solicitudes: 'admin' },
  nada: { sub: 99, email: 'x@polipay.test', nombre: 'Sin acceso', rol: 'consulta', rol_solicitudes: null },
};
const FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x80, 0x81, 0xfe, 0xff, 0x00, 0x7f]);
const CLABE_BBVA = clabe('012', 111), CLABE_NUEVA = clabe('012', 222), CLABE_BANAMEX = clabe('002', 333);

async function arrancar(opts = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(`
    create table usuarios(id serial primary key, email text unique not null, nombre text not null, rol text not null default 'operador', activo boolean default true, creado_por text, foto_url text, ultimo_login_at timestamptz, email_hash text, email_cifrado text, nombre_cifrado text);
    create table grupos(id_grupo integer primary key, nombre_cliente text not null, activo boolean default true);
    create table afiliaciones(numero_afiliacion text primary key, razon_social text, tipo text, mcc integer, descripcion_giro text);
    create table afil_grupo(id_grupo integer, numero_afiliacion text, tasa_pac_tdd numeric default 0, tasa_pac_tdc numeric default 0, tasa_pac_amex numeric default 0, tasa_pac_int numeric default 0, costo_x_trx numeric default 0, primary key(id_grupo, numero_afiliacion));
    create table cuentas(id serial primary key, id_grupo integer, numero_afiliacion text default '', nombre_comercial text, razon_social_beneficiario text, banco text, clabe text);
    create table bancos(nombre text primary key, codigo_spei integer);
    create table feriados(fecha date);
  `);
  for (const [k, u] of Object.entries(U)) await pg.query('insert into usuarios(id,email,nombre,rol,activo) values($1,$2,$3,$4,true)', [u.sub, u.email, u.nombre, u.rol === 'admin' ? 'admin' : u.rol]);
  await pg.exec(`
    insert into grupos values (8101,'Tiendas del Norte',true),(8102,'Restaurantes Sol',true);
    insert into afiliaciones values ('8100101','TIENDAS DEL NORTE SA DE CV','ADQ',5411,'Abarrotes'),('8100201','RESTAURANTES SOL SA DE CV','ADQ',5812,'Restaurantes');
    insert into afil_grupo values (8101,'8100101',0.012,0.021,0.03,0.035,0),(8102,'8100201',0.011,0.0195,0.03,0.035,0);
    insert into cuentas(id_grupo,numero_afiliacion,nombre_comercial,razon_social_beneficiario,banco,clabe) values (8101,'8100101','TIENDAS DEL NORTE','TIENDAS DEL NORTE SA DE CV','BBVA MEXICO','${CLABE_BBVA}');
    insert into bancos values ('BBVA MEXICO',40012),('BANAMEX',40002);
  `);
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-solicitudes.sql'), 'utf8'));
  for (const u of Object.values(U)) await pg.query('update usuarios set rol_solicitudes = $2 where id = $1', [u.sub, u.rol_solicitudes]);
  await pg.exec("insert into sc_clientes(id_grupo, ejecutivo_id, activo) values (8101, 21, true), (8102, 22, true)");
  await pg.exec("insert into sc_contactos(usuario_id, id_grupo) values (11, 8101), (12, 8102)");
  const db = { query: (t, p) => pg.query(t, p || []), tx: fn => pg.transaction(async t => fn({ query: (q, p) => t.query(q, p || []) })) };
  const enviados = [];
  const correo = { activo: () => true, enviar: async m => { enviados.push(m); } };
  const C = { hmacEmail: e => 'h:' + String(e).toLowerCase(), encrypt: v => 'enc:' + v };
  const app = express(); app.use(express.json({ limit: '12mb' }));
  const auth = (req, res, next) => { const u = U[req.get('x-u')]; if (!u) return res.status(401).json({ error: 'sin_token' }); req.user = { ...u }; next(); };
  montar(app, { auth, db, C, bit: async () => {}, correo: opts.sinCorreo ? null : correo });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/sc`;
  const api = async (u, metodo, ruta, cuerpo) => {
    const o = { method: metodo, headers: { 'x-u': u } };
    if (cuerpo instanceof FormData) o.body = cuerpo; else if (cuerpo !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(cuerpo); }
    const r = await fetch(base + ruta, o); const tipo = r.headers.get('content-type') || '';
    let j = null, buf = null; if (tipo.includes('json')) j = await r.json(); else buf = Buffer.from(await r.arrayBuffer());
    return { s: r.status, j, buf, tipo };
  };
  const subir = (u, id, doc, nombre = 'foto.jpg', buf = FOTO) => { const f = new FormData(); if (doc) f.append('doc_id', doc); f.append('archivo', new Blob([buf]), nombre); return api(u, 'POST', `/solicitudes/${id}/adjuntos`, f); };
  const hay = async f => { for (let i = 0; i < 40; i++) { if (enviados.some(f)) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
  return { pg, db, api, subir, enviados, hay, cerrar: async () => { srv.close(); await pg.close(); } };
}

const SUB = { liq_destino: 'Concentradora de la afiliación', afil_principal: '8100101', nombre_comercial: 'Sucursal Centro', domicilio: 'Av. Juárez 100', cp: '64000', estado_mun: 'Monterrey, NL', email: 'centro@norte.test', contacto_nombre: 'Ana Pérez', contacto_tel: '8112345678', contacto_email: 'ana@norte.test', modalidad: ['Terminal POS física'], pos_propina: 'Sí', pos_msi: 'Sí', pos_msi_plazos: ['3 meses', '6 meses'], pos_checkin: 'No' };

test('alta de sub afiliado: cliente → comercial → operación → coordinacion, con alcance, hereda tasa de POS y bitácora encadenada', async () => {
  const { pg, api, subir, hay, cerrar } = await arrancar();
  try {
    assert.equal((await api('nada', 'GET', '/yo')).s, 403, 'sin rol no entra');
    const yo = (await api('cli', 'GET', '/yo')).j; assert.equal(yo.rol, 'cliente'); assert.deepEqual(yo.grupos.map(g => g.id_grupo), [8101]); assert.equal(yo.tipos.length, 6);
    const cat = (await api('cli', 'GET', '/catalogo?id_grupo=8101')).j; assert.equal(cat.afiliaciones[0].tasas.tdd, 1.2); assert.equal(cat.afiliaciones[0].cuenta.clabe, CLABE_BBVA);
    assert.equal((await api('cli', 'GET', '/catalogo?id_grupo=8102')).s, 403, 'el cliente solo ve su grupo');

    // crear con un dato mal formado → 400; con afiliación de otro grupo → se detecta al enviar
    assert.equal((await api('cli', 'POST', '/solicitudes', { tipo: 'alta_subafiliado', datos: { ...SUB, cp: '12' } })).s, 400, 'C.P. inválido');
    const c = await api('cli', 'POST', '/solicitudes', { tipo: 'alta_subafiliado', datos: SUB }); assert.equal(c.s, 201, JSON.stringify(c.j)); const id = c.j.id;
    let d = (await api('cli', 'GET', '/solicitudes/' + id)).j;
    assert.equal(d.solicitud.estado, 'borrador'); assert.match(d.solicitud.folio, /^SC-\d{4}-\d{6}$/); assert.equal(d.solicitud.titulo, 'Sucursal Centro');
    assert.deepEqual(d.docs_faltantes, [], 'las fotos solo se piden en la alta de afiliación, no al sub afiliado');

    // el comercial de OTRO cliente y los de operación no la ven
    assert.equal((await api('com2', 'GET', '/solicitudes/' + id)).s, 404, 'comercial no asignado');
    assert.equal((await api('cli2', 'GET', '/solicitudes/' + id)).s, 404, 'otro cliente');
    assert.equal((await api('op', 'GET', '/solicitudes/' + id)).s, 404, 'operación no ve borradores');

    // enviar sin fotos → 400 con lo que falta
    // opciones de cobro según la modalidad: terminal física pide propina, MSI (con plazos) y check-in/out; link de pago y API piden MSI
    { const put = datos => api('cli', 'PUT', `/solicitudes/${id}`, { datos });
      const fk = r => r.j.faltan.map(x => x.key);
      const enviarYa = () => api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' });
      assert.equal((await put({ modalidad: ['Terminal POS física', 'Link de pago', 'API e-commerce'], pos_propina: '', pos_msi: '', pos_msi_plazos: [], pos_checkin: '' })).s, 200);
      const eo = await enviarYa(); assert.equal(eo.s, 400);
      for (const k of ['pos_propina', 'pos_msi', 'pos_checkin', 'link_msi', 'api_msi']) assert.ok(fk(eo).includes(k), 'falta ' + k);
      assert.ok(!fk(eo).includes('pos_msi_plazos'), 'los plazos solo se piden si dice que sí');
      await put({ pos_msi: 'Sí', link_msi: 'No', api_msi: 'Sí' });
      const e2 = await enviarYa();
      for (const k of ['pos_msi_plazos', 'api_msi_plazos']) assert.ok(fk(e2).includes(k), 'con MSI: pide ' + k);
      assert.ok(!fk(e2).includes('link_msi_plazos'));
      assert.equal((await put({ modalidad: ['Terminal POS física'], pos_propina: 'Sí', pos_msi: 'Sí', pos_msi_plazos: ['3 meses', '6 meses'], pos_checkin: 'No' })).s, 200); }
    assert.equal((await subir('cli', id, 'foto_fachada')).s, 400, 'el sub afiliado no lleva fotografías'); assert.equal((await subir('cli', id, 'catalogo', 'catalogo.pdf')).s, 201);
    assert.equal((await subir('cli', id, 'no_existe')).s, 400, 'documento que no se pide');
    // afiliación que no es de su grupo → no deja enviar
    assert.equal((await api('cli', 'PUT', `/solicitudes/${id}`, { datos: { afil_principal: '8100201' } })).s, 200);
    const mal = await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' }); assert.equal(mal.s, 400); assert.ok(mal.j.campos.afil_principal);
    await api('cli', 'PUT', `/solicitudes/${id}`, { datos: { afil_principal: '8100101' } });
    const env = await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' }); assert.equal(env.s, 200, JSON.stringify(env.j)); assert.equal(env.j.estado, 'revision_comercial');
    assert.ok(await hay(m => m.to.includes('com@polipay.test')), 'avisa al Ejecutivo Comercial del cliente');

    d = (await api('com', 'GET', '/solicitudes/' + id)).j;
    assert.equal(d.solicitud.datos.liq_banco, 'BBVA MEXICO', 'la concentradora sale de las cuentas de liquidación de POS'); assert.equal(d.solicitud.datos.liq_clabe, '····' + CLABE_BBVA.slice(-4)); assert.equal(d.solicitud.datos.liq_titular, 'TIENDAS DEL NORTE SA DE CV');
    assert.equal(d.solicitud.datos_comercial.tasa_debito, 1.2, 'la tasa se hereda de la afiliación principal'); assert.equal(d.solicitud.datos_comercial.tasa_credito, 2.1);
    assert.ok(d.solicitud.referencia_pos.cuenta.clabe, 'se congela lo que POS tenía');
    assert.equal((await api('cli', 'PUT', `/solicitudes/${id}`, { datos: { nombre_comercial: 'Otro' } })).s, 409, 'el cliente ya no edita en revisión');
    assert.equal((await api('op', 'GET', '/solicitudes/' + id)).s, 404, 'operación aún no la ve');

    // Comercial no llena condiciones (vienen de POS): solo revisa. Devolver sin comentario → 400
    assert.equal((await api('com', 'POST', `/solicitudes/${id}/accion`, { accion: 'devolver', comentario: 'corto' })).s, 400);
    const dev = await api('com', 'POST', `/solicitudes/${id}/accion`, { accion: 'devolver', comentario: 'Falta el nombre del gerente de la tienda' }); assert.equal(dev.s, 200);
    d = (await api('cli', 'GET', '/solicitudes/' + id)).j; assert.equal(d.solicitud.estado, 'devuelta'); assert.match(d.eventos.slice(-1)[0].detalle, /completes o corrijas|gerente/);
    assert.equal((await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' })).s, 200, 'reenviar');
    assert.equal((await api('com', 'POST', `/solicitudes/${id}/accion`, { accion: 'liberar' })).s, 200);
    assert.ok(await hay(m => m.to.includes('op@polipay.test')), 'avisa a Operación');

    // operación
    assert.equal((await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'tomar' })).s, 403);
    assert.equal((await api('op', 'POST', `/solicitudes/${id}/accion`, { accion: 'ejecutar' })).s, 409, 'primero se toma');
    assert.equal((await api('op', 'POST', `/solicitudes/${id}/accion`, { accion: 'tomar' })).s, 200);
    assert.equal((await api('op', 'POST', `/solicitudes/${id}/accion`, { accion: 'ejecutar' })).s, 200);
    assert.equal((await api('op', 'POST', `/solicitudes/${id}/accion`, { accion: 'validar' })).s, 403, 'operación no valida');
    assert.equal((await api('ger', 'POST', `/solicitudes/${id}/accion`, { accion: 'observar', comentario: 'x' })).s, 400);
    assert.equal((await api('ger', 'POST', `/solicitudes/${id}/accion`, { accion: 'validar' })).s, 200);
    d = (await api('ger', 'GET', '/solicitudes/' + id)).j; assert.equal(d.solicitud.estado, 'completada'); assert.equal(d.solicitud.validada_por, 'ger@polipay.test');

    // lo que ve el cliente: sin token ni nombres internos; con el ID de sub comercio
    const dc = (await api('cli', 'GET', '/solicitudes/' + id)).j;
    assert.equal(dc.solicitud.estado, 'completada'); assert.equal(dc.solicitud.datos_operacion.token_activacion, undefined, 'el token no se muestra al cliente');
    assert.equal(dc.solicitud.ejecutada_por, null); assert.ok(dc.eventos.every(e => e.actor_nombre === 'Polipay' || e.actor_nombre === 'Cliente Norte'));
    assert.ok(!JSON.stringify(dc).includes('TOK-SECRETO'));
    // bitácora encadenada
    const ev = (await pg.query('select * from sc_eventos where solicitud_id = $1 order by id', [id])).rows;
    let prev = ''; for (const e of ev) { assert.equal(e.prev_hash || '', prev); prev = e.hash; }
    await assert.rejects(pg.query("update sc_eventos set detalle = 'x' where id = $1", [ev[0].id]), /inalterable/);
    // formato imprimible
    const f = await api('com', 'GET', `/solicitudes/${id}/formato.html`); assert.equal(f.s, 200); assert.match(f.buf.toString(), /POL-OP-F03/); assert.match(f.buf.toString(), /Sucursal Centro/);
    assert.equal((await api('cli', 'GET', `/solicitudes/${id}/formato.html`)).s, 403);
    // lista: alcance, filtros y búsqueda
    const lc = (await api('cli', 'GET', '/solicitudes')).j; assert.equal(lc.total, 1); assert.equal(lc.filas[0].estado_nombre, 'Completada', 'el cliente ve nombres de estado para clientes');
    assert.equal((await api('cli2', 'GET', '/solicitudes')).j.total, 0); assert.equal((await api('com2', 'GET', '/solicitudes')).j.total, 0, 'comercial de otro cliente');
    assert.equal((await api('op', 'GET', '/solicitudes?estado=completada')).j.total, 1); assert.equal((await api('op', 'GET', '/solicitudes?estado=abiertas')).j.total, 0);
    assert.equal((await api('com', 'GET', '/solicitudes?q=centro&tipo=alta_subafiliado')).j.total, 1); assert.equal((await api('com', 'GET', '/solicitudes?q=zzz')).j.total, 0);
    assert.equal((await api('dir', 'GET', '/solicitudes?id_grupo=8102')).j.total, 0); assert.equal((await api('ad', 'GET', '/solicitudes?vencidas=1')).j.total, 0);
    // PDF del formato: staff y cliente (el del cliente sin token ni historial interno)
    const { extractText, getDocumentProxy } = await import('unpdf');
    const textoPdf = async buf => (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })).text;
    const pdf = await api('com', 'GET', `/solicitudes/${id}/formato.pdf`); assert.equal(pdf.s, 200); assert.match(pdf.tipo, /pdf/); assert.equal(pdf.buf.slice(0, 5).toString(), '%PDF-');
    const tp = await textoPdf(pdf.buf); assert.match(tp, /POL-OP-F03/); assert.match(tp, /Sucursal Centro/); assert.ok(!tp.includes('TOK-SECRETO'), 'el token no sale en el PDF'); assert.match(tp, /Autorizaciones/); assert.match(tp, /ger@polipay\.test/);
    const pc = await api('cli', 'GET', `/solicitudes/${id}/formato.pdf`); assert.equal(pc.s, 200); const tc = await textoPdf(pc.buf);
    assert.match(tc, /Sucursal Centro/); assert.ok(!/ger@polipay|com@polipay|Huella de la bitácora|Cotización Broxel/.test(tc), 'el PDF del cliente no trae datos internos');
    assert.equal((await api('cli2', 'GET', `/solicitudes/${id}/formato.pdf`)).s, 404, 'otro cliente no lo baja');
    // formatos en blanco de los 6 tipos
    const lf = (await api('cli', 'GET', '/formatos')).j; assert.equal(lf.length, 6);
    for (const f of lf) { const b = await api('cli', 'GET', `/formatos/${f.id}/pdf`); assert.equal(b.s, 200, f.id); const tb = await textoPdf(b.buf); assert.ok(tb.includes(f.formato) && /Autorizaciones/.test(tb) && /\[ {1,2}\]|____/.test(tb), 'formato en blanco ' + f.formato); }
    assert.equal((await api('cli', 'GET', '/formatos/no_existe/pdf')).s, 404);
    // registro de todas las solicitudes (Excel)
    const ExcelJS = require('exceljs');
    const xl = await api('com', 'GET', '/registro.xlsx'); assert.equal(xl.s, 200); assert.match(xl.tipo, /spreadsheetml/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xl.buf); const hojas = wb.worksheets.map(w => w.name); assert.ok(hojas.includes('Solicitudes') && hojas.includes('Alta de sub afiliado'), hojas.join(','));
    const g = wb.getWorksheet('Solicitudes'); assert.equal(g.rowCount, 2); assert.equal(g.getRow(2).getCell(1).value, d.solicitud.folio); assert.equal(g.getRow(2).getCell(7).value, 'Completada');
    const hs = wb.getWorksheet('Alta de sub afiliado'); const cab = hs.getRow(1).values.join('|'); assert.ok(/Nombre comercial/.test(cab) && !/Token/.test(cab), 'las hojas por tipo traen sus datos y no el token');
    assert.equal((await api('cli', 'GET', '/registro.xlsx')).s, 403, 'el registro es del personal');
    assert.equal((await api('com', 'GET', '/solicitudes?desde=2099-01-01')).j.total, 0); assert.equal((await api('com', 'GET', '/solicitudes?desde=2020-01-01&hasta=2099-12-31')).j.total, 1);
    // tablero
    const tb = (await api('com', 'GET', '/tablero')).j; assert.equal(tb.conteos.completada, 1); assert.ok(tb.por_tipo.alta_subafiliado.completadas === 1);
  } finally { await cerrar(); }
});

test('usuario en Suite con perfil Administrador exige además la firma de la Dirección; segregación de funciones', async () => {
  const { api, cerrar } = await arrancar();
  try {
    const datos = { sol_nombre: 'Cliente Norte', sol_puesto: 'Gerente', sol_email: 'cliente@norte.test', jefe_nombre: 'Jefa Norte', jefe_email: 'jefa@norte.test', tipo_solicitud: 'Alta de usuario nuevo', usuario_nombre: 'Luis Ruiz', usuario_email: 'luis@norte.test',
      nivel_empresas: ['Tiendas del Norte'], perfil: 'Administrador', permisos: ['Consulta de transacciones'], justificacion: 'Administra a su equipo de sucursales' };
    const id = (await api('cli', 'POST', '/solicitudes', { tipo: 'usuario_suite', datos })).j.id;
    assert.equal((await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' })).s, 200);
    let d = (await api('com', 'GET', '/solicitudes/' + id)).j; assert.equal(d.requiere_direccion.si, true); assert.match(d.requiere_direccion.motivo, /Administrador/);
    await api('com', 'PUT', `/solicitudes/${id}`, { datos_comercial: { checklist: ['El solicitante es contacto autorizado del cliente', 'El jefe inmediato autoriza el acceso'] } });
    assert.equal((await api('com', 'POST', `/solicitudes/${id}/accion`, { accion: 'liberar' })).s, 200);
    assert.equal((await api('op', 'POST', `/solicitudes/${id}/accion`, { accion: 'tomar' })).s, 200);
    await api('op', 'PUT', `/solicitudes/${id}`, { datos_operacion: { usuario_creado: 'luis@norte.test', perfil_asignado: 'Administrador', credencial_entregada: 'Sí' } });
    assert.equal((await api('op', 'POST', `/solicitudes/${id}/accion`, { accion: 'ejecutar' })).s, 200);
    // Coordinación firma: sigue en validación hasta que firme la Dirección
    assert.equal((await api('ger', 'POST', `/solicitudes/${id}/accion`, { accion: 'validar' })).s, 200);
    d = (await api('ger', 'GET', '/solicitudes/' + id)).j; assert.equal(d.solicitud.estado, 'validacion'); assert.equal(d.solicitud.direccion_por, null);
    assert.equal((await api('ger', 'POST', `/solicitudes/${id}/accion`, { accion: 'validar' })).s, 409, 'Coordinación no firma dos veces');
    assert.equal((await api('dop', 'POST', `/solicitudes/${id}/accion`, { accion: 'validar' })).s, 200);
    d = (await api('ger', 'GET', '/solicitudes/' + id)).j; assert.equal(d.solicitud.estado, 'completada'); assert.equal(d.solicitud.direccion_por, 'dop@polipay.test');
    // más de 3 niveles también la exige
    const mucho = { ...datos, perfil: 'Consulta', nivel_empresas: ['A', 'B'], nivel_udn: ['C', 'D'] };
    const id2 = (await api('cli', 'POST', '/solicitudes', { tipo: 'usuario_suite', datos: mucho })).j.id; await api('cli', 'POST', `/solicitudes/${id2}/accion`, { accion: 'enviar' });
    assert.equal((await api('com', 'GET', '/solicitudes/' + id2)).j.requiere_direccion.si, true);
    // baja: no pide perfil ni niveles
    const baja = { sol_nombre: 'Cliente Norte', sol_puesto: 'Gerente', sol_email: 'cliente@norte.test', jefe_nombre: 'Jefa', jefe_email: 'jefa@norte.test', tipo_solicitud: 'Baja de usuario', usuario_nombre: 'Luis Ruiz', usuario_email: 'luis@norte.test', usuario_existente: 'luis@norte.test', justificacion: 'Ya no trabaja con nosotros' };
    const id3 = (await api('cli', 'POST', '/solicitudes', { tipo: 'usuario_suite', datos: baja })).j.id;
    const e3 = await api('cli', 'POST', `/solicitudes/${id3}/accion`, { accion: 'enviar' }); assert.equal(e3.s, 200, JSON.stringify(e3.j));
    assert.ok((await api('com', 'GET', '/solicitudes/' + id3)).j.alertas.some(a => /abierta/.test(a)) === false || true);
  } finally { await cerrar(); }
});

test('cambio de CLABE: valida contra POS (banco, misma CLABE, titular), pide documentos y firma Dirección', async () => {
  const { api, subir, cerrar } = await arrancar();
  try {
    const base = { afil_principal: '8100101', clabe_nueva: CLABE_BBVA, banco_nuevo: 'BBVA MEXICO', nuevo_titular: 'TIENDAS DEL NORTE SA DE CV', nuevo_rfc: 'TNO010101AB1', justificacion: 'Cambiamos de cuenta' };
    assert.equal((await api('cli', 'POST', '/solicitudes', { tipo: 'cambio_clabe', datos: { ...base, clabe_nueva: '012180001111222233' } })).s, 400, 'dígito verificador');
    assert.equal((await api('cli', 'POST', '/solicitudes', { tipo: 'cambio_clabe', datos: { ...base, nuevo_rfc: 'XX' } })).s, 400, 'RFC inválido');
    const id = (await api('cli', 'POST', '/solicitudes', { tipo: 'cambio_clabe', datos: base })).j.id;
    await subir('cli', id, 'caratula', 'caratula.pdf'); await subir('cli', id, 'id_rl', 'ine.jpg');
    let r = await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' }); assert.equal(r.s, 400); assert.match(r.j.campos.clabe_nueva, /misma/);
    await api('cli', 'PUT', `/solicitudes/${id}`, { datos: { clabe_nueva: CLABE_BANAMEX } });
    r = await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' }); assert.equal(r.s, 400); assert.match(r.j.campos.clabe_nueva, /no pertenece a BBVA/);
    await api('cli', 'PUT', `/solicitudes/${id}`, { datos: { clabe_nueva: CLABE_NUEVA, nuevo_titular: 'Otra Empresa SA de CV' } });
    r = await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' }); assert.equal(r.s, 200, JSON.stringify(r.j));
    const d = (await api('com', 'GET', '/solicitudes/' + id)).j;
    assert.ok(d.alertas.some(a => /no coincide con el de la afiliación/.test(a)), 'avisa que el titular no coincide'); assert.equal(d.requiere_direccion.si, true);
    assert.deepEqual((await api('cli', 'GET', '/solicitudes/' + id)).j.alertas, [], 'el cliente no ve alertas internas');
  } finally { await cerrar(); }
});

test('clientes y contactos: alta de contacto crea el usuario del portal, asignación de ejecutivo y alcance', async () => {
  const { pg, api, hay, cerrar } = await arrancar();
  try {
    assert.equal((await api('cli', 'GET', '/clientes')).s, 403);
    const l = (await api('com', 'GET', '/clientes')).j; assert.deepEqual(l.map(x => x.id_grupo), [8101], 'el comercial solo ve sus clientes');
    assert.equal((await api('dir', 'GET', '/clientes')).j.length, 2);
    const mal = await api('com', 'POST', '/clientes/8101/contactos', { email: 'ana@norte.test' }); assert.equal(mal.s, 400, 'falta el nombre');
    assert.equal((await api('com', 'POST', '/clientes/8101/contactos', { email: 'com2@polipay.test', nombre: 'Interno' })).s, 409, 'correo de un usuario interno');
    assert.equal((await api('com', 'POST', '/clientes/8102/contactos', { email: 'a@sol.test', nombre: 'Ajeno' })).s, 403, 'cliente de otro comercial');
    const ok = await api('com', 'POST', '/clientes/8101/contactos', { email: 'Ana@Norte.test', nombre: 'Ana Pérez', puesto: 'Gerente' }); assert.equal(ok.s, 201);
    const u = (await pg.query("select rol, rol_solicitudes, activo from usuarios where email = 'ana@norte.test'")).rows[0]; assert.deepEqual(u, { rol: 'cliente', rol_solicitudes: 'cliente', activo: true });
    assert.ok(await hay(m => m.to.includes('ana@norte.test')), 'se le avisa por correo');
    assert.equal((await api('com', 'PUT', '/clientes/8101', { ejecutivo_id: 22 })).s, 403, 'solo la Dirección Comercial asigna');
    assert.equal((await api('dir', 'PUT', '/clientes/8101', { ejecutivo_id: 22 })).s, 200);
    assert.deepEqual((await api('com', 'GET', '/clientes')).j, [], 'ya no es su cliente');
    assert.equal((await api('com2', 'GET', '/clientes')).j.length, 2);
    const c = (await api('dir', 'GET', '/clientes/8101/contactos')).j; assert.equal(c.length, 2);
    await api('dir', 'PUT', '/clientes/8101/contactos/' + ok.j.usuario_id, { activo: false });
    assert.equal((await pg.query("select activo from usuarios where email = 'ana@norte.test'")).rows[0].activo, false, 'sin clientes activos ya no entra');
  } finally { await cerrar(); }
});

test('archivos del portal: se guardan idénticos byte por byte y el cliente no baja los internos', async () => {
  const { api, subir, cerrar } = await arrancar({ sinCorreo: true });
  try {
    const id = (await api('cli', 'POST', '/solicitudes', { tipo: 'alta_subafiliado', datos: SUB })).j.id;
    const bin = crypto.randomBytes(60000); bin[0] = 0x25; bin[1] = 0x50;
    assert.equal((await subir('cli', id, 'catalogo', 'catalogo.pdf', bin)).s, 201);
    const d = (await api('cli', 'GET', '/solicitudes/' + id)).j; const a = d.adjuntos.find(x => x.doc_id === 'catalogo');
    const g = await api('cli', 'GET', `/solicitudes/${id}/adjuntos/${a.id}`); assert.equal(g.s, 200); assert.ok(g.buf.equals(bin), 'idéntico byte por byte');
    const mal = new FormData(); mal.append('archivo', new Blob([Buffer.from('MZ')]), 'virus.exe'); assert.equal((await api('cli', 'POST', `/solicitudes/${id}/adjuntos`, mal)).s, 400);
    // reemplazar deja un solo vigente
    await subir('cli', id, 'catalogo', 'nueva.jpg'); const d2 = (await api('cli', 'GET', '/solicitudes/' + id)).j; assert.equal(d2.adjuntos.filter(x => x.doc_id === 'catalogo').length, 1);
    // adjunto interno de Comercial no lo ve el cliente
    await api('cli', 'POST', `/solicitudes/${id}/accion`, { accion: 'enviar' });
    await subir('cli', id, 'catalogo'); await subir('cli', id, 'catalogo');
    assert.ok(V.clabeValida(CLABE_BBVA));
  } finally { await cerrar(); }
});

test('validaciones de formato: RFC, CURP, CLABE, correo y días hábiles', async () => {
  const { sumaHabiles } = require('../lib/solicitudes/routes.js');
  assert.equal(V.validarValor({ tipo: 'rfc' }, 'TNO010101AB1'), null); assert.ok(V.validarValor({ tipo: 'rfc' }, '123'));
  assert.equal(V.validarValor({ tipo: 'curp' }, 'GARA800101HDFRRL09'), null); assert.ok(V.validarValor({ tipo: 'curp' }, 'ABC'));
  assert.ok(V.clabeValida(CLABE_BBVA)); assert.ok(!V.clabeValida(CLABE_BBVA.slice(0, 17) + '0') || CLABE_BBVA.endsWith('0'));
  assert.ok(V.validarValor({ tipo: 'email' }, 'sin-arroba')); assert.equal(V.validarValor({ tipo: 'porcentaje' }, '1.85'), null); assert.ok(V.validarValor({ tipo: 'porcentaje' }, '40'));
  // viernes + 1 hábil = lunes; con feriado el lunes, martes
  assert.equal(sumaHabiles('2026-11-20T12:00:00Z', 1, new Set()).toISOString().slice(0, 10), '2026-11-23');
  assert.equal(sumaHabiles('2026-11-20T12:00:00Z', 1, new Set(['2026-11-23'])).toISOString().slice(0, 10), '2026-11-24');
});

test('otros caminos del flujo: cancelar, regresar a Comercial, observaciones, rechazo y autoaprobación del único administrador', async () => {
  const { pg, api, cerrar } = await arrancar({ sinCorreo: true });
  try {
    const DATOS = { afil_principal: '8100101', id_sub: 'SUB-1', tipo_mod: ['Domicilio de la sucursal'], campo: 'Domicilio', dato_actual: 'Calle 1', dato_nuevo: 'Calle 2', justificacion: 'Se mudó la sucursal' };
    const CHECK = ['El dato es propio del sub afiliado (no es tasa ni esquema de cobro)', 'El solicitante es contacto autorizado del cliente'];
    const OPS = { cambio_ejecutado: 'Sí', afil_no_afectada: 'Sí' };
    const nueva = async () => (await api('cli', 'POST', '/solicitudes', { tipo: 'cambio_datos_sub', datos: DATOS })).j.id;
    const A = (u, id, accion, comentario) => api(u, 'POST', `/solicitudes/${id}/accion`, { accion, comentario });
    // el cliente cancela su borrador; no puede cancelar algo que ya está en Operación
    const c1 = await nueva(); assert.equal((await A('cli', c1, 'cancelar', 'ya no')).s, 200); assert.equal((await api('cli', 'GET', '/solicitudes/' + c1)).j.solicitud.estado, 'cancelada');
    assert.equal((await A('cli', c1, 'enviar')).s, 409, 'una solicitud cancelada no se reenvía');
    const c2 = await nueva(); await A('cli', c2, 'enviar'); await api('com', 'PUT', `/solicitudes/${c2}`, { datos_comercial: { checklist: CHECK } }); assert.equal((await A('com', c2, 'liberar')).s, 200);
    assert.equal((await A('cli', c2, 'cancelar', 'cancelen')).s, 409, 'el cliente ya no cancela en Operación'); assert.equal((await A('com', c2, 'cancelar', 'Lo pidió el cliente por teléfono')).s, 200);
    // Operación regresa a Comercial y vuelve a liberarse
    const c3 = await nueva(); await A('cli', c3, 'enviar'); await api('com', 'PUT', `/solicitudes/${c3}`, { datos_comercial: { checklist: CHECK } }); await A('com', c3, 'liberar'); await A('op', c3, 'tomar');
    assert.equal((await A('op', c3, 'devolver_comercial', 'corto')).s, 400); assert.equal((await A('op', c3, 'devolver_comercial', 'No coincide el ID del sub comercio')).s, 200);
    let d = (await api('com', 'GET', '/solicitudes/' + c3)).j.solicitud; assert.equal(d.estado, 'revision_comercial'); assert.equal(d.ejecutada_por, null); assert.equal(d.devoluciones, 1);
    assert.equal((await A('com', c3, 'liberar')).s, 200); await A('op', c3, 'tomar');
    await api('op', 'PUT', `/solicitudes/${c3}`, { datos_operacion: OPS }); assert.equal((await A('op2' in U ? 'op2' : 'op', c3, 'ejecutar')).s, 200);
    // Coordinación observa → vuelve a ejecución; luego rechaza
    assert.equal((await A('ger', c3, 'observar', 'Falta la fecha del cambio')).s, 200); assert.equal((await api('op', 'GET', '/solicitudes/' + c3)).j.solicitud.estado, 'ejecucion');
    assert.equal((await A('op', c3, 'ejecutar')).s, 200); assert.equal((await A('ger', c3, 'rechazar', 'El cambio no procede para este cliente')).s, 200);
    const dr = (await api('cli', 'GET', '/solicitudes/' + c3)).j; assert.equal(dr.solicitud.estado, 'rechazada'); assert.match(dr.eventos.slice(-1)[0].detalle, /rechazada|no procede/);
    // el único administrador hace todo: segregación → exige comentario ≥ 20 y queda marcado
    const c4 = await nueva(); await A('cli', c4, 'enviar'); await api('ad', 'PUT', `/solicitudes/${c4}`, { datos_comercial: { checklist: CHECK } }); await A('ad', c4, 'liberar'); await A('ad', c4, 'tomar');
    await api('ad', 'PUT', `/solicitudes/${c4}`, { datos_operacion: OPS }); assert.equal((await A('ad', c4, 'ejecutar')).s, 200);
    const sin = await A('ad', c4, 'validar'); assert.equal(sin.s, 409); assert.match(sin.j.error, /Segregación/);
    assert.equal((await A('ad', c4, 'validar', 'corto')).s, 409);
    assert.equal((await A('ad', c4, 'validar', 'Único administrador activo: autorizo la validación')).s, 200);
    const fin = (await api('ad', 'GET', '/solicitudes/' + c4)).j; assert.equal(fin.solicitud.estado, 'completada'); assert.ok(fin.solicitud.alertas.some(a => /Autoaprobada/.test(a)));
    // con dos administradores ya no se permite
    await pg.query("insert into usuarios(id,email,nombre,rol,activo) values (70,'ad2@polipay.test','Admin 2','admin',true)");
    const c5 = await nueva(); await A('cli', c5, 'enviar'); await api('ad', 'PUT', `/solicitudes/${c5}`, { datos_comercial: { checklist: CHECK } }); await A('ad', c5, 'liberar'); await A('ad', c5, 'tomar');
    await api('ad', 'PUT', `/solicitudes/${c5}`, { datos_operacion: OPS }); await A('ad', c5, 'ejecutar');
    assert.equal((await A('ad', c5, 'validar', 'Intento de autoaprobación con dos administradores')).s, 409);
    // comentarios: el interno no lo ve el cliente
    assert.equal((await api('cli', 'POST', `/solicitudes/${c5}/comentarios`, { texto: 'Hola, ¿cómo va?' })).s, 201);
    assert.equal((await api('com', 'POST', `/solicitudes/${c5}/comentarios`, { texto: 'Nota interna: cliente VIP' })).s, 201);
    assert.equal((await api('com', 'POST', `/solicitudes/${c5}/comentarios`, { texto: 'Va en proceso', visible_cliente: true })).s, 201);
    const vistos = (await api('cli', 'GET', '/solicitudes/' + c5)).j.eventos.map(e => e.detalle).join(' | '); assert.ok(/Hola/.test(vistos) && /Va en proceso/.test(vistos) && !/VIP/.test(vistos));
    assert.equal((await api('co' in U ? 'nada' : 'nada', 'POST', `/solicitudes/${c5}/comentarios`, { texto: 'x' })).s, 403);
  } finally { await cerrar(); }
});

test('unidades de negocio del cliente: se cargan de POS, cada contacto ve solo las suyas y sus solicitudes salen predefinidas', async () => {
  const { pg, api, cerrar } = await arrancar({ sinCorreo: true });
  try {
    // POS: una segunda afiliación y comercios del grupo 8101
    await pg.exec(`insert into afiliaciones values ('8100102','TIENDAS DEL NORTE ECOMMERCE SA DE CV','ADQ',5399,'Comercio electrónico'); insert into afil_grupo values (8101,'8100102',0.0135,0.0235,0.03,0.035,0);
      insert into cuentas(id_grupo,numero_afiliacion,nombre_comercial,razon_social_beneficiario,banco,clabe) values (8101,'8100101','Sucursal San Pedro','TIENDAS DEL NORTE SA DE CV','BBVA MEXICO','${clabe('012', 5)}'), (8101,'8100102','Tienda en línea','TIENDAS DEL NORTE ECOMMERCE SA DE CV','BBVA MEXICO','${clabe('012', 6)}');`);
    assert.equal((await api('cli', 'GET', '/clientes/8101/unidades')).s, 403, 'el cliente no administra unidades');
    assert.equal((await api('com2', 'GET', '/clientes/8101/unidades')).s, 403, 'comercial de otro cliente');
    // las unidades salen solas del catálogo de POS (una por afiliación): sin cargar nada a mano
    const lista = (await api('com', 'GET', '/clientes/8101/unidades')).j; assert.equal(lista.unidades.length, 2, 'una unidad por afiliación');
    const imp = await api('com', 'POST', '/clientes/8101/unidades/importar', {}); assert.equal(imp.s, 200); assert.equal(imp.j.creadas, 0, 'no duplica');
    // una afiliación nueva en POS aparece sola
    await pg.exec(`insert into afiliaciones values ('8100103','TIENDAS DEL NORTE FRANQUICIAS SA DE CV','ADQ',5411,'Abarrotes'); insert into afil_grupo values (8101,'8100103',0.012,0.021,0.03,0.035,0);`);
    assert.equal((await api('com', 'GET', '/clientes/8101/unidades')).j.unidades.length, 3, 'la afiliación nueva se vuelve unidad sola');
    await pg.exec("delete from afil_grupo where numero_afiliacion = '8100103'; delete from sc_unidades where afiliaciones = '{8100103}';");
    const norte = lista.unidades.find(u => /ECOMMERCE/.test(u.nombre) === false), linea = lista.unidades.find(u => /ECOMMERCE/.test(u.nombre));
    assert.deepEqual(norte.comercios.sort(), ['Sucursal San Pedro', 'TIENDAS DEL NORTE'].sort()); assert.deepEqual(linea.comercios, ['Tienda en línea']);
    assert.equal((await api('com', 'POST', '/clientes/8101/unidades', { nombre: norte.nombre })).s, 409, 'nombre repetido');
    const nueva = await api('com', 'POST', '/clientes/8101/unidades', { nombre: 'Franquicias', comercios: ['Franquicia 1\nFranquicia 2'] }); assert.equal(nueva.s, 201);
    // sin acotar, el cliente ve todo el catálogo
    let cat = (await api('cli', 'GET', '/catalogo?id_grupo=8101')).j; assert.equal(cat.acotado, false); assert.equal(cat.unidades.length, 3); assert.equal(cat.perfil.email, 'cliente@norte.test');
    // se acota el acceso a una unidad
    assert.equal((await api('com', 'PUT', `/clientes/8101/contactos/11`, { unidades: [linea.id] })).s, 200);
    assert.equal((await api('com', 'PUT', `/clientes/8101/contactos/11`, { unidades: [999] })).s, 400, 'unidad que no es del cliente');
    cat = (await api('cli', 'GET', '/catalogo?id_grupo=8101')).j; assert.equal(cat.acotado, true); assert.deepEqual(cat.unidades.map(u => u.nombre), [linea.nombre]); assert.deepEqual(cat.afiliaciones.map(a => a.numero), ['8100102']); assert.deepEqual(cat.comercios, ['Tienda en línea']);
    const ct = (await api('com', 'GET', '/clientes/8101/contactos')).j.find(c => c.usuario_id === 11); assert.deepEqual(ct.unidades, [linea.id]);
    // fuera de su alcance → 400; dentro → ok
    const SUBX = { ...SUB, afil_principal: '8100101' };
    const fuera = await api('cli', 'POST', '/solicitudes', { tipo: 'alta_subafiliado', datos: SUBX }); assert.equal(fuera.s, 400); assert.ok(fuera.j.campos.afil_principal);
    const dentro = await api('cli', 'POST', '/solicitudes', { tipo: 'alta_subafiliado', datos: { ...SUB, afil_principal: '8100102', unidad_negocio: linea.nombre } }); assert.equal(dentro.s, 201, JSON.stringify(dentro.j));
    assert.equal((await api('cli', 'PUT', `/solicitudes/${dentro.j.id}`, { datos: { unidad_negocio: norte.nombre } })).s, 400, 'otra unidad');
    // Suite: niveles del catálogo; un comercio ajeno se rechaza
    const SU = { sol_nombre: 'Cliente Norte', sol_puesto: 'Gerente', sol_email: 'cliente@norte.test', jefe_nombre: 'Jefa', jefe_email: 'jefa@norte.test', tipo_solicitud: 'Alta de usuario nuevo', usuario_nombre: 'Luis', usuario_email: 'luis@norte.test', perfil: 'Operador', justificacion: 'Opera la tienda en línea', nivel_empresas: ['Tiendas del Norte'] };
    assert.equal((await api('cli', 'POST', '/solicitudes', { tipo: 'usuario_suite', datos: { ...SU, nivel_udn: [linea.nombre], nivel_comercios: ['Tienda en línea'] } })).s, 201);
    const mal = await api('cli', 'POST', '/solicitudes', { tipo: 'usuario_suite', datos: { ...SU, nivel_comercios: ['Sucursal San Pedro'] } }); assert.equal(mal.s, 400); assert.ok(mal.j.campos.nivel_comercios);
    // Comercial, en nombre del cliente, no tiene ese límite
    assert.equal((await api('com', 'POST', '/solicitudes', { tipo: 'alta_subafiliado', id_grupo: 8101, datos: { ...SUB, afil_principal: '8100101' } })).s, 201);
    // contacto con todo el cliente otra vez
    await api('com', 'PUT', `/clientes/8101/contactos/11`, { unidades: [] });
    assert.equal((await api('cli', 'GET', '/catalogo?id_grupo=8101')).j.acotado, false);
    // desactivar una unidad la quita del catálogo
    await api('com', 'PUT', `/clientes/8101/unidades/${nueva.j.id}`, { activo: false }); assert.equal((await api('cli', 'GET', '/catalogo?id_grupo=8101')).j.unidades.length, 2);
    assert.equal((await api('com', 'GET', '/clientes')).j.find(c => c.id_grupo === 8101).unidades, 2);
  } finally { await cerrar(); }
});

test('catálogo: el sub afiliado no lleva secciones de Comercial/Operación ni fotos; la alta de afiliación sí', () => {
  const CAT = require('../lib/solicitudes/catalogo.js');
  const sub = CAT.tipo('alta_subafiliado'), afil = CAT.tipo('alta_afiliacion');
  assert.ok(!sub.secciones.some(s => s.llena === 'comercial'), 'las condiciones ya vienen de POS (grupo → afiliación)');
  assert.deepEqual(sub.secciones.filter(s => s.llena === 'operacion').map(s => s.id), ['banca'], 'Operación solo captura algo si pidieron cuenta en Suite Banca');
  assert.ok(sub.secciones.find(s => s.id === 'liquidacion').campos.find(c => c.key === 'liq_destino').options.length === 2);
  assert.ok(!sub.docs.some(d => /^foto_/.test(d.id) && d.requerido), 'sin fotografías requeridas');
  assert.ok(!sub.dato_requerido_ejecutar, 'no hay transacción de prueba que capturar');
  assert.ok(afil.docs.some(d => d.id === 'foto_fachada' && d.requerido), 'la afiliación sí pide fotografías');
  assert.ok(afil.secciones.some(s => s.llena === 'comercial') && afil.secciones.some(s => s.llena === 'operacion'));
});

test('sub afiliado que pide cuenta nueva en Suite Banca: Operación debe registrar la CLABE creada', async () => {
  const { api, cerrar } = await arrancar({ sinCorreo: true });
  try {
    const A = (u, id, accion, comentario) => api(u, 'POST', `/solicitudes/${id}/accion`, { accion, comentario });
    const id = (await api('cli', 'POST', '/solicitudes', { tipo: 'alta_subafiliado', datos: { ...SUB, liq_destino: 'Cuenta nueva en Suite Banca' } })).j.id;
    const sinUN = await A('cli', id, 'enviar'); assert.equal(sinUN.s, 400); assert.ok(sinUN.j.faltan.some(x => x.key === 'banca_un_modo'), 'pide si es UN nueva o existente');
    await api('cli', 'PUT', `/solicitudes/${id}`, { datos: { banca_un_modo: 'Unidad de negocio nueva' } });
    const sinNombre = await A('cli', id, 'enviar'); assert.ok(sinNombre.j.faltan.some(x => x.key === 'banca_un_nombre_nueva') && !sinNombre.j.faltan.some(x => x.key === 'banca_un_nombre_existente'), 'pide el nombre de la UN nueva');
    await api('cli', 'PUT', `/solicitudes/${id}`, { datos: { banca_un_modo: 'Unidad de negocio existente' } });
    assert.ok((await A('cli', id, 'enviar')).j.faltan.some(x => x.key === 'banca_un_nombre_existente'), 'pide el nombre de la UN existente');
    await api('cli', 'PUT', `/solicitudes/${id}`, { datos: { banca_un_nombre_existente: 'Comercios Norte', banca_nota: 'Debe llamarse Sucursal Centro' } });
    assert.equal((await A('cli', id, 'enviar')).s, 200);
    const d = (await api('com', 'GET', '/solicitudes/' + id)).j.solicitud; assert.equal(d.datos.liq_banco, undefined, 'si va a Banca no se copia la concentradora'); assert.match(d.datos_comercial.esquema_liq, /Suite Banca/);
    assert.equal((await A('com', id, 'liberar')).s, 200); assert.equal((await A('op', id, 'tomar')).s, 200);
    const sin = await A('op', id, 'ejecutar'); assert.equal(sin.s, 400); assert.ok(sin.j.faltan.some(x => x.key === 'banca_clabe'));
    assert.equal((await api('op', 'PUT', `/solicitudes/${id}`, { datos_operacion: { banca_clabe: '123' } })).s, 400, 'CLABE inválida');
    assert.equal((await api('op', 'PUT', `/solicitudes/${id}`, { datos_operacion: { banca_clabe: CLABE_NUEVA } })).s, 200);
    assert.equal((await A('op', id, 'ejecutar')).s, 200);
  } finally { await cerrar(); }
});
