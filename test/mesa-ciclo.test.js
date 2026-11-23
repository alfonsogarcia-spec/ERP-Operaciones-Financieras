/* Mesa de control: ciclo completo del crédito — formalización, desembolso con doble control, pagos y moratorios, cobranza, conciliación, fondeo, contabilidad, reportes y UIF. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { montar } = require('../lib/mesa/routes.js');
const B = require('../lib/mesa/bitacora.js');
const U = require('../lib/mesa/util.js');
const A = require('../lib/mesa/amortiza.js');

const mk = (email, rol_cartera) => ({ email, nombre: email.split('@')[0], rol: rol_cartera === 'admin' ? 'admin' : 'consulta', rol_cartera });
const USERS = { ej: mk('ej@t.local', 'ejecutivo'), an: mk('an@t.local', 'analista'), me: mk('me@t.local', 'mesa'), te: mk('te@t.local', 'tesoreria'), co: mk('co@t.local', 'cobranza'), cu: mk('cu@t.local', 'cumplimiento'), cn: mk('cn@t.local', 'contador'), ad: mk('ad@t.local', 'admin') };

async function arrancar() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec('create table usuarios(id serial primary key, activo boolean default true, rol text, rol_cartera text)');
  await pg.exec("insert into usuarios(rol, rol_cartera) values ('admin','admin'), ('admin','admin')");              // dos administradores: no hay autoaprobación
  await pg.exec('create table bancos(nombre text primary key, codigo_spei integer); insert into bancos values (\'STP\', 90646)');
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-mesa.sql'), 'utf8'));
  const db = { query: (t, p) => pg.query(t, p || []), tx: fn => pg.transaction(async t => fn({ query: (q, p) => t.query(q, p || []) })) };
  const app = express(); app.use(express.json({ limit: '12mb' }));
  app.use((req, res, next) => { const u = USERS[req.get('x-u')]; if (!u) return res.status(401).json({ error: 'sin_token' }); req.user = { sub: 1, ...u }; next(); });
  // montar espera `auth` como middleware; el de arriba ya fijó req.user
  const enviados = []; const correo = { activo: () => true, enviar: async m => { enviados.push(m); return 'msg-' + enviados.length; } };
  montar(app, { auth: (req, res, next) => next(), db, correo });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = async (u, metodo, ruta, cuerpo, crudo) => {
    const o = { method: metodo, headers: { 'x-u': u } };
    if (cuerpo instanceof FormData) o.body = cuerpo; else if (cuerpo !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(cuerpo); }
    const r = await fetch(base + '/api/cartera/mc' + ruta, o);
    if (crudo) return { s: r.status, t: await r.text(), h: r.headers };
    let j = null; try { j = await r.json(); } catch (_e) { /* sin cuerpo */ }
    return { s: r.status, j };
  };
  return { pg, db, correo, enviados, api, cerrar: async () => { srv.close(); await pg.close(); } };
}
const sumaDias = (iso, d) => new Date(Date.parse(iso + 'T00:00:00Z') + d * 864e5).toISOString().slice(0, 10);
const clabeOk = () => { const c17 = '01218000000000001'; return c17 + U.digitoClabe(c17); };
const archivo = (campos, nombre, tipo, contenido) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.append(k, v); f.append('archivo', new Blob([contenido], { type: tipo }), nombre); return f; };

test('mesa de control: del crédito autorizado al cierre contable', async () => {
  const { pg, db, correo, enviados, api, cerrar } = await arrancar();
  try {
    const hoy = U.hoyMx(), desembolso = sumaDias(hoy, -100);
    // ---- producto y solicitud autorizada (el flujo de autorización ya se prueba en mesa-api.test) ----
    const prod = (await api('ad', 'POST', '/productos', { clave: 'pyme_c', nombre: 'PyME ciclo', tipo: 'simple', monto_min: 10000, monto_max: 800000, plazo_min: 3, plazo_max: 36, tasa_min: 0.2, tasa_max: 0.5, tasa_default: 0.36, tasa_moratoria: 0.72, periodicidades: ['mensual'], comision_apertura: 0.02 })).j.id;
    const sol = await api('ej', 'POST', '/solicitudes', { solicitante: { tipo: 'moral', nombre: 'Taller Los Pinos SA de CV', rfc: 'TMP120730KL5', domicilio: 'Av. Siempre Viva 742', telefono: '3312345678', actividad: 'Taller', beneficiario_controlador: 'Socio A', origen_recursos: 'Ventas' },
      solicitud: { producto_id: prod, monto: 200000, plazo_meses: 12, periodicidad: 'mensual', tasa_anual: 0.36, destino: 'Capital', ingresos_mensuales: 300000, egresos_mensuales: 100000, antiguedad_meses: 60, score_buro: 700 } });
    const sid = sol.j.id;
    assert.equal((await api('an', 'POST', `/solicitudes/${sid}/credito`)).s, 409, 'una solicitud sin autorizar no se formaliza');
    await pg.exec(`update credit_solvendom.mc_solicitudes set estado='autorizada', monto_autorizado=monto, tasa_autorizada=tasa_anual, plazo_autorizado=plazo_meses, vigencia_hasta=current_date+30 where id=${sid}`);
    assert.equal((await api('ej', 'POST', `/solicitudes/${sid}/credito`)).s, 403, 'el ejecutivo no formaliza');
    const cr = await api('an', 'POST', `/solicitudes/${sid}/credito`); assert.equal(cr.s, 201, JSON.stringify(cr.j)); assert.match(cr.j.folio, /^CR-\d{4}-\d{4}$/);
    assert.equal((await api('an', 'POST', `/solicitudes/${sid}/credito`)).s, 409, 'solo un crédito por solicitud');
    const cid = cr.j.id; let d = (await api('an', 'GET', '/creditos/' + cid)).j;
    assert.equal(d.credito.estado, 'formalizacion'); assert.equal(d.filas.length, 12); assert.ok(d.credito.cat > 0.36, 'CAT calculado: ' + d.credito.cat);

    // ---- cuenta de depósito, contrato y firmas ----
    assert.equal((await api('an', 'PUT', '/creditos/' + cid, { _v: d.credito.version, clabe: '123456789012345678' })).s, 400, 'CLABE con dígito verificador incorrecto');
    assert.equal((await api('an', 'PUT', '/creditos/' + cid, { _v: d.credito.version, clabe: clabeOk(), beneficiario: 'Taller Los Pinos SA de CV', banco_codigo: '90646', banco_nombre: 'STP', fecha_desembolso: hoy })).s, 200);
    d = (await api('an', 'GET', '/creditos/' + cid)).j; assert.equal(d.credito.tiene_clabe, true); assert.ok(d.credito.clabe_mascara.endsWith(clabeOk().slice(-4))); assert.ok(!JSON.stringify(d).includes(clabeOk()), 'la CLABE completa no sale en la API');
    assert.equal((await api('an', 'PUT', '/creditos/' + cid, { _v: d.credito.version - 1, beneficiario: 'X' })).s, 409, 'versión vieja');
    const doc = await api('an', 'GET', `/creditos/${cid}/contrato`, undefined, true); assert.equal(doc.s, 200); assert.ok(doc.t.includes(cr.j.folio) && doc.t.includes('Tabla de amortización'));
    assert.equal((await api('an', 'POST', `/creditos/${cid}/firmas`, archivo({ firmante: 'Representante', calidad: 'representante_legal', metodo: 'autografa' }, 'x.txt', 'text/plain', 'x'))).s, 400, 'tipo de archivo no permitido');
    const f0 = new FormData(); f0.append('firmante', 'Representante'); f0.append('calidad', 'representante_legal'); f0.append('metodo', 'autografa');
    assert.equal((await api('an', 'POST', `/creditos/${cid}/firmas`, f0)).s, 400, 'la firma autógrafa pide el escaneo');
    assert.equal((await api('an', 'POST', `/creditos/${cid}/accion`, { accion: 'formalizar', _v: d.credito.version })).s, 409, 'sin firmas no se formaliza');
    assert.equal((await api('an', 'POST', `/creditos/${cid}/firmas`, archivo({ firmante: 'Juan Pérez, rep. legal', calidad: 'representante_legal', metodo: 'autografa' }, 'contrato.pdf', 'application/pdf', '%PDF-1.4 firmado'))).s, 201);
    assert.equal((await api('an', 'POST', `/creditos/${cid}/accion`, { accion: 'formalizar', _v: d.credito.version })).s, 409, 'falta la firma de la SOFOM');
    assert.equal((await api('an', 'POST', `/creditos/${cid}/firmas`, { firmante: 'Representante de la SOFOM', calidad: 'la_sofom', metodo: 'electronica' })).s, 201);
    d = (await api('an', 'GET', '/creditos/' + cid)).j; assert.equal(d.contrato.listo, true);
    const fz = await api('an', 'POST', `/creditos/${cid}/accion`, { accion: 'formalizar', _v: d.credito.version }); assert.equal(fz.s, 200, JSON.stringify(fz.j));

    // ---- desembolso con doble control ----
    d = (await api('te', 'GET', '/creditos/' + cid)).j; assert.equal(d.credito.estado, 'desembolso'); assert.equal(d.acciones.solicitar_desembolso, true);
    assert.equal((await api('an', 'POST', `/creditos/${cid}/desembolsos`, {})).s, 403, 'el analista no solicita desembolsos');
    const ds = await api('te', 'POST', `/creditos/${cid}/desembolsos`, { fecha_prevista: hoy }); assert.equal(ds.s, 201, JSON.stringify(ds.j));
    assert.equal(ds.j.neto, A.r2(200000 - 200000 * 0.02 * 1.16), 'neto = monto − comisión con IVA');
    const did = ds.j.id;
    assert.equal((await api('te', 'POST', `/desembolsos/${did}/accion`, { accion: 'autorizar' })).s, 403, 'tesorería no autoriza su propia solicitud ni tiene el permiso');
    assert.equal((await api('te', 'GET', `/desembolsos/${did}/layout.xlsx`, undefined, true)).s, 409, 'sin autorizar no hay layout');
    assert.equal((await api('me', 'POST', `/desembolsos/${did}/accion`, { accion: 'autorizar' })).s, 200);
    const lay = await api('te', 'GET', `/desembolsos/${did}/layout.xlsx`, undefined, true); assert.equal(lay.s, 200); assert.match(lay.h.get('content-type'), /spreadsheetml/);
    assert.equal((await api('te', 'POST', `/desembolsos/${did}/accion`, { accion: 'confirmar', referencia: 'X', fecha_real: desembolso })).s, 409, 'no se confirma lo que no se envió');
    assert.equal((await api('te', 'POST', `/desembolsos/${did}/accion`, { accion: 'enviar' })).s, 200);
    assert.equal((await api('te', 'POST', `/desembolsos/${did}/accion`, { accion: 'confirmar', fecha_real: desembolso })).s, 400, 'la referencia SPEI es obligatoria');
    assert.equal((await api('te', 'POST', `/desembolsos/${did}/accion`, { accion: 'confirmar', referencia: 'SPEI-DES-1', fecha_real: sumaDias(hoy, 3) })).s, 400, 'la fecha no puede ser futura');
    const cf = await api('te', 'POST', `/desembolsos/${did}/accion`, { accion: 'confirmar', referencia: 'SPEI-DES-1', fecha_real: desembolso }); assert.equal(cf.s, 200, JSON.stringify(cf.j));
    d = (await api('co', 'GET', '/creditos/' + cid)).j; assert.equal(d.credito.estado, 'vigente'); assert.equal(d.credito.fecha_desembolso, desembolso); assert.equal(d.filas.length, 12);
    assert.ok(d.st.diasAtraso > 0 && d.st.cuotasVencidas >= 2, 'con desembolso hace 100 días ya hay cuotas vencidas');
    assert.equal(d.filas[0].fecha, A.fechaPago(desembolso, 'mensual', 1), 'la tabla se congela con la fecha real');

    // ---- pagos: aplicación, referencia única, efectivo (UIF), cancelación ----
    const f1 = d.filas[0];
    assert.equal((await api('ej', 'POST', `/creditos/${cid}/pagos`, { monto: 1000, referencia: 'R0' })).s, 403, 'el ejecutivo no registra pagos');
    assert.equal((await api('co', 'POST', `/creditos/${cid}/pagos`, { monto: 1000, medio: 'spei' })).s, 400, 'sin referencia no se registra (salvo efectivo)');
    assert.equal((await api('co', 'POST', `/creditos/${cid}/pagos`, { monto: 1000, referencia: 'R0', fecha: sumaDias(hoy, 2) })).s, 400, 'sin pagos futuros');
    assert.equal((await api('co', 'POST', `/creditos/${cid}/pagos`, { monto: 1000, referencia: 'R0', fecha: sumaDias(desembolso, -1) })).s, 400, 'ni antes del desembolso');
    const p1 = await api('co', 'POST', `/creditos/${cid}/pagos`, { monto: f1.total, referencia: 'PAGO-1', fecha: f1.fecha, medio: 'spei' }); assert.equal(p1.s, 201, JSON.stringify(p1.j));
    assert.equal(p1.j.aplicacion.mor, 0); assert.equal(p1.j.aplicacion.capital, f1.capital); assert.equal(p1.j.aplicacion.interes, f1.interes);
    assert.equal((await api('co', 'POST', `/creditos/${cid}/pagos`, { monto: 500, referencia: 'pago-1' })).s, 409, 'referencia repetida (sin importar mayúsculas)');
    const antes = (await api('co', 'GET', '/creditos/' + cid)).j.st;
    const pe = await api('co', 'POST', `/creditos/${cid}/pagos`, { monto: 160000, medio: 'efectivo', comentario: 'Pago en ventanilla' }); assert.equal(pe.s, 201, JSON.stringify(pe.j));
    const uif = (await api('cu', 'GET', '/uif')).j; assert.ok(uif.filas.some(x => x.regla === 'relevante_efectivo' && x.estado === 'detectada'), 'pago en efectivo ≥ umbral → operación relevante');
    d = (await api('co', 'GET', '/creditos/' + cid)).j; assert.ok(d.st.saldoCapital < antes.saldoCapital); assert.ok(d.st.vencido.total < antes.vencido.total);
    assert.equal((await api('co', 'POST', `/pagos/${pe.j.id}/cancelar`, { comentario: 'x'.repeat(20) })).s, 403, 'solo el administrador cancela pagos');
    assert.equal((await api('ad', 'POST', `/pagos/${pe.j.id}/cancelar`, { comentario: 'corto' })).s, 400);
    assert.equal((await api('ad', 'POST', `/pagos/${pe.j.id}/cancelar`, { comentario: 'El depósito en ventanilla nunca se acreditó.' })).s, 200);
    d = (await api('co', 'GET', '/creditos/' + cid)).j; assert.equal(d.st.saldoCapital, antes.saldoCapital, 'cancelar el pago regresa el saldo');
    assert.ok((await api('cu', 'POST', '/uif/detectar')).j.ok);

    // ---- cobranza: bandeja, gestiones y promesas ----
    let cob = (await api('co', 'GET', '/cobranza')).j; const fila = cob.filas.find(f => f.id === cid); assert.ok(fila && fila.dias > 0); assert.equal(fila.promesa, null);
    assert.equal((await api('co', 'POST', `/creditos/${cid}/gestiones`, { tipo: 'promesa', comentario: 'Dice que paga el viernes', promesa_fecha: sumaDias(hoy, 5), promesa_monto: 0 })).s, 400, 'la promesa lleva monto');
    assert.equal((await api('co', 'POST', `/creditos/${cid}/gestiones`, { tipo: 'promesa', comentario: 'Dice que paga el viernes', promesa_fecha: sumaDias(hoy, 5), promesa_monto: 30000 })).s, 201);
    cob = (await api('co', 'GET', '/cobranza')).j; assert.equal(cob.filas.find(f => f.id === cid).promesa.estado, 'pendiente'); assert.ok(cob.resumen.creditos >= 1 && cob.buckets.length === 5);

    // ---- conciliación bancaria ----
    const csv = `fecha,descripcion,referencia,monto\n${f1.fecha},SPEI recibido,PAGO-1,${f1.total}\n${hoy},SPEI recibido de cliente,${cr.j.folio} abono,5000\n${hoy},Intereses bancarios,INT-1,12.5\n${hoy},Comisión,COM-1,-50\n`;
    const imp = await api('te', 'POST', '/conciliacion/importar', archivo({}, 'estado.csv', 'text/csv', csv)); assert.equal(imp.s, 200, JSON.stringify(imp.j));
    assert.equal(imp.j.importados, 3); assert.equal(imp.j.conciliados, 1, 'el abono con la referencia del pago se concilia solo'); assert.equal(imp.j.cargos_omitidos, 1);
    assert.equal((await api('te', 'POST', '/conciliacion/importar', archivo({}, 'estado.csv', 'text/csv', csv))).j.repetidos, 3, 'reimportar no duplica');
    const cc = (await api('te', 'GET', '/conciliacion')).j; assert.equal(cc.total, 2); const sug = cc.filas.find(m => m.sugerido); assert.equal(sug.sugerido.id, cid, 'el folio del crédito en la referencia sugiere a qué crédito va');
    const mp = await api('te', 'POST', `/conciliacion/${sug.id}/pago`, { credito_id: cid }); assert.equal(mp.s, 200, JSON.stringify(mp.j));
    const otro = cc.filas.find(m => !m.sugerido); assert.equal((await api('te', 'POST', `/conciliacion/${otro.id}/ignorar`, { nota: 'x' })).s, 400);
    assert.equal((await api('te', 'POST', `/conciliacion/${otro.id}/ignorar`, { nota: 'Intereses del banco: no es un pago de cliente.' })).s, 200);
    assert.equal((await api('te', 'GET', '/conciliacion')).j.total, 0, 'nada pendiente');

    // ---- fondeo ----
    const fo = await api('te', 'POST', '/fondeos', { nombre: 'Línea institucional A', tipo: 'institucional', monto_linea: 500000, tasa_anual: 0.2, revolvente: true }); assert.equal(fo.s, 201, JSON.stringify(fo.j));
    assert.equal((await api('co', 'POST', '/fondeos', { nombre: 'X', monto_linea: 1000 })).s, 403, 'cobranza no administra fondeo');
    assert.equal((await api('te', 'POST', `/fondeos/${fo.j.id}/movimientos`, { tipo: 'disposicion', monto: 600000 })).s, 409, 'no se dispone más que la línea');
    assert.equal((await api('te', 'POST', `/fondeos/${fo.j.id}/movimientos`, { tipo: 'disposicion', monto: 300000, referencia: 'DISP-1' })).s, 201);
    assert.equal((await api('te', 'POST', `/fondeos/${fo.j.id}/movimientos`, { tipo: 'pago_capital', monto: 400000 })).s, 409, 'no se paga más de lo dispuesto');
    const fl = (await api('te', 'GET', '/fondeos')).j.find(f => f.id === fo.j.id); assert.equal(fl.dispuesto, 300000); assert.equal(fl.deuda, 300000); assert.equal(fl.disponible, 500000);

    // ---- ingresos por facturar: comisiones por apertura e intereses cobrados, corte y correo semanal a contabilidad ----
    const stI = (await api('co', 'GET', '/creditos/' + cid)).j.st, apl = stI.aplicaciones;
    const suma = k => A.r2(apl.reduce((n, x) => n + x[k], 0));
    let ing = (await api('cn', 'GET', '/contabilidad/ingresos')).j, TI = ing.pendiente.totales;
    assert.equal(TI.comision_apertura.base, 4000); assert.equal(TI.comision_apertura.iva, 640, 'comisión por apertura cobrada, con IVA');
    assert.equal(TI.interes.base, suma('interes'), 'intereses ordinarios cobrados = lo aplicado a interés en los pagos');
    assert.equal(A.r2(TI.interes.iva + TI.moratorio.iva), suma('iva'), 'IVA cobrado de intereses y moratorios');
    assert.equal(TI.moratorio.base, suma('mor')); assert.equal(TI.total, A.r2(TI.base + TI.iva)); assert.equal(ing.pendiente.resumen.length, 1); assert.equal(ing.pendiente.resumen[0].rfc, 'TMP120730KL5');
    assert.equal((await api('ej', 'GET', '/contabilidad/ingresos')).s, 403); assert.equal((await api('co', 'POST', '/contabilidad/ingresos/cortes', {})).s, 403, 'cobranza no hace cortes');
    assert.equal((await api('cn', 'POST', '/contabilidad/ingresos/cortes', { hasta: sumaDias(hoy, 3) })).s, 400);
    const c1 = await api('cn', 'POST', '/contabilidad/ingresos/cortes', { enviar: true }); assert.equal(c1.s, 201, JSON.stringify(c1.j)); assert.equal(c1.j.envio.error, 'sin_destinatarios', 'el corte se hace aunque falten destinatarios'); assert.equal(enviados.length, 0);
    assert.equal((await api('cn', 'POST', '/contabilidad/ingresos/cortes', {})).s, 409, 'lo ya cortado no vuelve a entrar');
    assert.equal((await api('cn', 'POST', '/contabilidad/ingresos/destinatarios', { email: 'malo' })).s, 400);
    assert.equal((await api('cn', 'POST', '/contabilidad/ingresos/destinatarios', { email: 'Contabilidad@Ejemplo.com', nombre: 'Contabilidad', tipo: 'to' })).s, 201);
    assert.equal((await api('cn', 'POST', '/contabilidad/ingresos/destinatarios', { email: 'contabilidad@ejemplo.com', nombre: 'Contabilidad MCEB', tipo: 'to' })).s, 201, 'el mismo correo no se duplica');
    assert.equal((await api('cn', 'GET', '/contabilidad/ingresos/destinatarios')).j.length, 1);
    const env = await api('cn', 'POST', `/contabilidad/ingresos/cortes/${c1.j.id}/enviar`); assert.equal(env.s, 200, JSON.stringify(env.j)); assert.equal(enviados.length, 1);
    const m1 = enviados[0]; assert.deepEqual(m1.to, ['Contabilidad MCEB <contabilidad@ejemplo.com>']); assert.ok(m1.subject.includes(`corte #${c1.j.id}`) && m1.html.includes('Taller Los Pinos') && m1.html.includes('TMP120730KL5') && m1.html.includes('Comisión por apertura'));
    assert.match(m1.attachments[0].filename, /^ingresos_por_facturar_.*\.xlsx$/); assert.ok(m1.attachments[0].content.length > 1000);
    assert.equal((await api('cn', 'DELETE', `/contabilidad/ingresos/cortes/${c1.j.id}`)).s, 409, 'un corte enviado no se deshace');
    // un pago ya cortado se cancela → ajuste negativo para el siguiente corte; un pago nuevo también entra
    assert.equal((await api('ad', 'POST', `/pagos/${mp.j.id}/cancelar`, { comentario: 'El banco devolvió el abono por error.' })).s, 200);
    assert.equal((await api('co', 'POST', `/creditos/${cid}/pagos`, { monto: 2000, referencia: 'PAGO-CORTE-2', medio: 'spei' })).s, 201);
    ing = (await api('cn', 'GET', '/contabilidad/ingresos')).j; TI = ing.pendiente.totales;
    assert.ok(TI.ajuste.total < 0, 'el pago cancelado deja un ajuste negativo: ' + TI.ajuste.total); assert.ok(TI.movimientos >= 2);
    const c2 = await api('cn', 'POST', '/contabilidad/ingresos/cortes', {}); assert.equal(c2.s, 201); assert.equal((await api('cn', 'GET', '/contabilidad/ingresos')).j.pendiente.totales.movimientos, 0);
    assert.equal((await api('cn', 'DELETE', `/contabilidad/ingresos/cortes/${c2.j.id}`)).s, 200); assert.ok((await api('cn', 'GET', '/contabilidad/ingresos')).j.pendiente.totales.ajuste.total < 0, 'al deshacer vuelve el ajuste');
    // envío semanal automático: solo el día configurado, una vez, y sin movimientos no manda nada
    const IN = require('../lib/mesa/ingresos.js'), dow = new Date(hoy + 'T12:00:00Z').getUTCDay();
    assert.equal((await api('cn', 'PUT', '/contabilidad/ingresos/envio', { envio_activo: true, dia_semana: (dow + 1) % 7 })).s, 200); assert.equal((await IN.envioAutomatico(db, correo)).omitido, 'no_es_el_dia');
    assert.equal((await api('cn', 'PUT', '/contabilidad/ingresos/envio', { envio_activo: false, dia_semana: dow })).s, 200); assert.equal((await IN.envioAutomatico(db, correo)).omitido, 'apagado');
    assert.equal((await api('cn', 'PUT', '/contabilidad/ingresos/envio', { envio_activo: true, dia_semana: 9 })).s, 400);
    assert.equal((await api('cn', 'PUT', '/contabilidad/ingresos/envio', { envio_activo: true, dia_semana: dow })).s, 200);
    const antesEnv = enviados.length, au = await IN.envioAutomatico(db, correo); assert.ok(au.envio && au.envio.ok, JSON.stringify(au)); assert.equal(enviados.length, antesEnv + 1);
    assert.equal((await IN.envioAutomatico(db, correo)).omitido, 'ya_enviado');
    const lista = (await api('cn', 'GET', '/contabilidad/ingresos')).j.cortes; assert.ok(lista.some(c => c.origen === 'AUTOMATICO' && c.estado === 'ENVIADO' && c.generado_por === 'sistema (automático)'));
    assert.equal((await api('cn', 'GET', `/contabilidad/ingresos/cortes/${c1.j.id}/excel`, undefined, true)).s, 200);

    // ---- contabilidad: cierre en orden, pólizas cuadradas, periodo cerrado bloquea ----
    const per = (await api('cn', 'GET', '/contabilidad/periodos')).j; const orden = per.map(p => p.periodo).sort(); assert.ok(orden.length >= 4, 'periodos desde el desembolso: ' + orden);
    const actual = orden[orden.length - 1], primero = orden[0];
    assert.equal((await api('cn', 'POST', `/contabilidad/periodos/${actual}/cerrar`)).s, 409, 'el periodo en curso no se cierra');
    assert.equal((await api('cn', 'POST', `/contabilidad/periodos/${orden[1]}/cerrar`)).s, 409, 'hay que cerrar en orden');
    assert.equal((await api('co', 'POST', `/contabilidad/periodos/${primero}/cerrar`)).s, 403, 'cobranza no cierra');
    const vp = (await api('cn', 'GET', `/contabilidad/polizas?periodo=${primero}`)).j; assert.equal(vp.vista_previa, true); assert.equal(vp.totales.debe, vp.totales.haber, 'la vista previa cuadra');
    for (const p of orden.slice(0, -1)) { const r = await api('cn', 'POST', `/contabilidad/periodos/${p}/cerrar`); assert.equal(r.s, 200, p + ' ' + JSON.stringify(r.j)); }
    const pc = (await api('cn', 'GET', `/contabilidad/polizas?periodo=${primero}`)).j; assert.equal(pc.cerrado, true); assert.ok(pc.polizas.some(x => x.tipo === 'desembolso'));
    for (const x of pc.polizas) assert.equal(A.r2(x.lineas.reduce((s, l) => s + l.debe, 0)), A.r2(x.lineas.reduce((s, l) => s + l.haber, 0)), 'póliza cuadrada: ' + x.concepto);
    const ultimo = orden[orden.length - 2], bal = (await api('cn', 'GET', `/contabilidad/balanza?periodo=${ultimo}`)).j; assert.equal(bal.cuadra, true, 'la balanza cuadra');
    const saldoCont = A.r2(bal.cuentas.filter(c => ['1301', '1302'].includes(c.clave)).reduce((s, c) => s + c.saldo, 0)), fin = U.finDePeriodo(ultimo);
    const stFin = (await api('co', 'GET', `/creditos/${cid}?fecha=${fin}`)).j.st;
    assert.equal(saldoCont, stFin.saldoCapital, 'cartera contable (vigente + vencida) = saldo de capital del crédito al cierre');
    assert.equal((await api('co', 'POST', `/creditos/${cid}/pagos`, { monto: 1000, referencia: 'EN-CERRADO', fecha: f1.fecha })).s, 409, 'no se registran pagos en un periodo cerrado');
    assert.equal((await api('cn', 'POST', `/contabilidad/periodos/${primero}/reabrir`, { comentario: 'x'.repeat(25) })).s, 403, 'solo el administrador reabre');
    assert.equal((await api('ad', 'POST', `/contabilidad/periodos/${primero}/reabrir`, { comentario: 'Corrección de un pago mal fechado.' })).s, 409, 'solo se reabre el último cerrado');
    assert.equal((await api('ad', 'POST', `/contabilidad/periodos/${ultimo}/reabrir`, { comentario: 'Corrección de un pago mal fechado.' })).s, 200);
    const csvP = await api('cn', 'GET', `/contabilidad/polizas.csv?periodo=${primero}`, undefined, true); assert.equal(csvP.s, 200); assert.ok(csvP.t.includes('Cartera de crédito vigente'));

    // ---- reportes, panel y bitácora ----
    const rc = (await api('co', 'GET', '/reportes/cartera')).j; assert.equal(rc.resumen.creditos, 1); assert.ok(rc.resumen.capital > 0 && rc.filas[0].dias > 0);
    assert.equal((await api('ej', 'GET', '/reportes/cartera')).s, 403);
    assert.equal((await api('co', 'GET', '/reportes/cartera.csv', undefined, true)).s, 200);
    const buro = await api('cu', 'GET', '/reportes/buro.csv', undefined, true); assert.ok(buro.t.includes('BORRADOR') && buro.t.includes('TMP120730KL5'));
    const com = (await api('cn', 'GET', `/reportes/comisiones?desde=${desembolso}&hasta=${hoy}`)).j; const ap = com.filas.filter(f => f.concepto === 'Comisión por apertura'); assert.equal(A.r2(ap.reduce((n, f) => n + f.base, 0)), 4000); assert.equal(A.r2(ap.reduce((n, f) => n + f.iva, 0)), 640, 'comisión de apertura 2% + IVA');
    assert.ok(com.filas.some(f => f.concepto === 'Intereses moratorios cobrados'), 'los moratorios cobrados también cuentan'); assert.equal(com.totales.total, A.r2(com.filas.reduce((n, f) => n + f.total, 0)));
    const panel = (await api('te', 'GET', '/panel-cartera')).j; assert.equal(panel.resumen.creditos, 1); assert.ok(panel.pendientes.uif >= 1);
    const v = (await api('ad', 'GET', '/bitacora/verificar')).j; assert.equal(v.ok, true, JSON.stringify(v));
    assert.ok((await api('ad', 'GET', `/bitacora?entidad=credito`)).j.total > 10);
    void B;
  } finally { await cerrar(); }
});
