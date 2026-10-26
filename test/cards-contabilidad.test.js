// Corte de comisiones de BSO Cards (acumulado, como el de MCEB): qué entra, qué cae en el siguiente, a quién se factura y el correo.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const C = require('../lib/cards-contabilidad');
const { armarCorteContable } = require('../lib/cards-correo');
const SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-cards.sql'), 'utf8');

test('RFC: persona moral (12) y física (13); lo demás no', () => {
  for (const r of ['ACM010101AAA', 'acm010101aaa', 'XAXX010101000', 'ÑAB010101AB1']) assert.equal(C.rfcValido(r), true, r);
  for (const r of ['', 'ABC', 'ACM01010AAA', '1234567890123', null]) assert.equal(C.rfcValido(r), false, String(r));
});
test('resumen por empresa: comisión + IVA = total a facturar, rango de depósitos y datos fiscales que faltan', () => {
  const d = [
    { empresa_id: 1, empresa: 'Acme', razon_social: 'Acme Servicios SA de CV', rfc: 'acm010101aaa', fecha_abono: '2026-10-05', fondeo: 300000, comision: 1500, iva: 240 },
    { empresa_id: 1, empresa: 'Acme', razon_social: 'Acme Servicios SA de CV', rfc: 'ACM010101AAA', fecha_abono: '2026-10-12', fondeo: 100000, comision: 500.01, iva: 80 },
    { empresa_id: 2, empresa: 'Beta', razon_social: null, rfc: 'MAL', fecha_abono: '2026-10-09', fondeo: 1000, comision: 5, iva: 0.8 },
  ];
  const r = C.resumir(d), a = r.resumen.find(e => e.empresa === 'Acme'), b = r.resumen.find(e => e.empresa === 'Beta');
  assert.deepEqual([a.fondeos, a.comision, a.iva, a.total, a.rfc, a.falta], [2, 2000.01, 320, 2320.01, 'ACM010101AAA', []]);
  assert.deepEqual(b.falta, ['razón social', 'RFC válido']);
  assert.deepEqual(r.totales, { empresas: 2, fondeos: 3, fondeo: 401000, comision: 2005.01, iva: 320.8, total: 2325.81, deposito_desde: '2026-10-05', deposito_hasta: '2026-10-12' });
  assert.equal(C.resumir([]).totales.total, 0); assert.equal(C.textoDepositos(r.totales), 'depósitos del 05/10/2026 al 12/10/2026'); assert.equal(C.textoDepositos(C.resumir([]).totales), 'sin depósitos');
  assert.equal(C.tituloCorte({ fecha_corte: '2026-10-26' }), 'Corte al 26 de octubre de 2026');
});

test('corte acumulado: entra lo asignado hasta ese momento; lo demás cae en el siguiente; cada fondeo en un solo corte', async () => {
  const { PGlite } = await import('@electric-sql/pglite'); const db = new PGlite();
  try {
    await db.exec(SQL);
    const emp = (await db.query(`insert into cards.entidades(nivel,nombre,clabe,referencia,razon_social) values('EMPRESA','Acme','012180000000001014','ACM010101AAA','Acme Servicios SA de CV') returning id`)).rows[0].id;
    await db.query('update cards.entidades set empresa_id=id where id=$1', [emp]);
    let n = 0;
    const fondeo = async (deposito, monto, estatus = 'ASIGNADO') => {
      n++;
      const f = (await db.query(`insert into cards.fondeos(folio,entidad_id,empresa_id,fondeo,comision,iva,comision_pct,iva_pct,clabe_destino,estatus,monto_recibido,fecha,clave_rastreo)
        values($1,$2,$2,$3,$4,$5,0.5,16,'012180000000001014','POR_ASIGNAR',$6,$7,$8) returning id`, ['F' + n, emp, monto, monto * 0.005, monto * 0.005 * 0.16, monto * 1.0058, deposito, 'R' + n])).rows[0].id;
      await db.query(`insert into cards.fondeo_ceps(fondeo_id,filename,bytes_cifrado,sha256_hash,validado,datos,formato) values($1,'c.pdf','x'::bytea,$2,true,'{}','cep_banxico')`, [f, 'h' + n]);
      if (estatus === 'ASIGNADO') await db.query(`update cards.fondeos set estatus='ASIGNADO', validado_at=now() where id=$1`, [f]);
      return f;
    };
    const f1 = await fondeo('2026-10-05', 100000), f2 = await fondeo('2026-10-12', 200000), f3 = await fondeo('2026-10-20', 400000), sinAsignar = await fondeo('2026-10-08', 50000, 'POR_ASIGNAR');
    // por cortar: todo lo asignado hasta la fecha, por su fecha de depósito
    assert.equal((await C.pendientes(db, '2026-10-31')).detalle.length, 3);
    assert.deepEqual((await C.pendientes(db, '2026-10-15')).detalle.map(f => f.id), [f1, f2]);        // depósitos hasta el 15: el del 20 queda fuera
    // corte 1: depósitos hasta el 15
    const id1 = await C.hacerCorte(db, { hasta: '2026-10-15', hoy: '2026-10-16', quien: 'ana', origen: 'MANUAL' });
    let c1 = (await db.query('select * from cards.cortes_comision where id=$1', [id1])).rows[0];
    assert.deepEqual([c1.totales.fondeos, c1.totales.comision, c1.totales.iva, c1.totales.total], [2, 1500, 240, 1740]);
    assert.deepEqual([c1.totales.deposito_desde, c1.totales.deposito_hasta], ['2026-10-05', '2026-10-12']);
    assert.deepEqual([c1.resumen[0].razon_social, c1.resumen[0].rfc], ['Acme Servicios SA de CV', 'ACM010101AAA']);
    assert.equal((await db.query('select count(*)::int n from cards.fondeos where corte_comision_id=$1', [id1])).rows[0].n, 2);
    // un fondeo se asigna DESPUÉS del corte (depositado el 10): cae en el siguiente corte, no en el anterior
    const tarde = await fondeo('2026-10-10', 100000);
    assert.equal((await db.query('select estado from cards.cortes_comision where id=$1', [id1])).rows[0].estado, 'GENERADO');
    assert.equal((await C.pendientes(db, '2026-10-31')).detalle.map(f => f.id).includes(f1), false);   // el ya cortado no vuelve a salir
    const id2 = await C.hacerCorte(db, { hasta: '2026-10-31', hoy: '2026-10-31', quien: 'sistema', origen: 'POS', posCorteId: 77 });
    const c2 = (await db.query('select * from cards.cortes_comision where id=$1', [id2])).rows[0];
    assert.deepEqual(c2.detalle.map(f => f.id).sort((a, b) => a - b), [f3, tarde]);                    // el del 20 y el asignado tarde
    assert.equal(c2.origen, 'POS'); assert.equal(c2.pos_corte_id, 77);
    assert.equal((await db.query('select count(*)::int n from cards.fondeos where estatus=$1 and corte_comision_id is null', ['ASIGNADO'])).rows[0].n, 0);
    // un corte sin nada nuevo se hace igual (en ceros)
    const id3 = await C.hacerCorte(db, { hasta: '2026-10-31', hoy: '2026-10-31', quien: 'sistema', origen: 'POS' });
    const c3 = (await db.query('select * from cards.cortes_comision where id=$1', [id3])).rows[0]; assert.deepEqual([c3.totales.fondeos, c3.totales.total], [0, 0]);
    // deshacer: solo uno sin enviar; sus fondeos vuelven a quedar por cortar
    assert.deepEqual(await C.deshacerCorte(db, id2), { ok: true });
    assert.deepEqual((await C.pendientes(db, '2026-10-31')).detalle.map(f => f.id).sort((a, b) => a - b), [f3, tarde]);
    await db.query("update cards.cortes_comision set estado='ENVIADO', enviado_at=now() where id=$1", [id1]);
    assert.deepEqual(await C.deshacerCorte(db, id1), { error: 'enviado' }); assert.deepEqual(await C.deshacerCorte(db, 9999), { error: 'no_existe' });
    const hojas = C.hojasXlsx({ fecha_corte: '2026-10-16', totales: c1.totales, resumen: c1.resumen, detalle: c1.detalle });
    assert.deepEqual(hojas.map(h => h.name), ['Facturación', 'Detalle']); assert.equal(hojas[1].aoa.length, 1 + c1.detalle.length);
    assert.equal(hojas[1].aoa[0][0], 'Fecha de depósito'); assert.equal(hojas[1].aoa[1][0], '2026-10-05');
    assert.ok(hojas[0].aoa.some(r => r[0] === 'Acme Servicios SA de CV' && r[1] === 'ACM010101AAA'));
  } finally { try { await db.close(); } catch (_e) { /* nada */ } }
});

test('correo del corte (BSO Cards): corte al día, depósitos, razón social y RFC, comisión + IVA, totales y datos fiscales por completar', () => {
  const corte = { fecha_corte: '2026-10-26', totales: { empresas: 2, fondeos: 3, comision: 2005.01, iva: 320.8, total: 2325.81, deposito_desde: '2026-10-05', deposito_hasta: '2026-10-12' },
    resumen: [{ empresa: 'Acme <SA>', razon_social: 'Acme Servicios SA de CV', rfc: 'ACM010101AAA', fondeos: 2, comision: 2000.01, iva: 320, total: 2320.01, falta: [] },
      { empresa: 'Beta', razon_social: null, rfc: null, fondeos: 1, comision: 5, iva: 0.8, total: 5.8, falta: ['razón social', 'RFC'] }] };
  const m = armarCorteContable({ corte, appUrl: 'https://x.test/', adjunto: true });
  assert.equal(m.subject, '[BSO Cards] Corte de comisiones · al 26 de octubre de 2026 · $2,325.81 a facturar');
  assert.match(m.html, /BSO Cards · Corte de comisiones/); assert.match(m.html, /corte de comisiones de BSO Cards/); assert.match(m.html, /26 de octubre de 2026/); assert.match(m.html, /depósitos del 05\/10\/2026 al 12\/10\/2026/);
  assert.match(m.html, /Acme Servicios SA de CV/); assert.match(m.html, /ACM010101AAA/); assert.match(m.html, /Acme &lt;SA&gt;/); assert.ok(!m.html.includes('Acme <SA>'));
  assert.match(m.html, /\$2,325\.81/); assert.match(m.html, /Datos fiscales por completar/); assert.match(m.html, /Beta: falta razón social y RFC/);
  assert.match(m.html, /Lo que se guarde después de este corte se incluye en el siguiente/); assert.match(m.html, /fecha de depósito/);
  assert.match(m.html, /Polipay Cards Settlement · BSO · ops\.emisor@polipay\.io/); assert.match(m.text, /Total a facturar: \$2,325\.81/);
  const vacio = armarCorteContable({ corte: { fecha_corte: '2026-10-26', totales: {}, resumen: [] } });
  assert.match(vacio.html, /No hay comisiones por facturar en este corte/); assert.match(vacio.subject, /\$0\.00 a facturar/);
});
