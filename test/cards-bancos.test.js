// Bancos de Cards: catálogo, identificación por CLABE y comparación de beneficiario / banco contra el CEP.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const B = require('../lib/cards-bancos');
const FL = require('../lib/cards-flujo');
const CEPX = require('../lib/cards-cep-extract');

const bancos = B.SEMILLA.map(b => ({ ...b, prefijo: B.prefijoDe(b.codigo_spei), activo: true }));
const banco = n => bancos.find(b => b.nombre === n);

test('el prefijo de la CLABE sale del código SPEI; las claves que no llevan cuentas no tienen', () => {
  assert.equal(B.prefijoDe(40012), '012'); assert.equal(B.prefijoDe(90646), '646'); assert.equal(B.prefijoDe(37006), '006');
  for (const c of [91812, 2001, 90901, 90903, 'x', null]) assert.equal(B.prefijoDe(c), null, String(c));
  const pref = bancos.map(b => b.prefijo).filter(Boolean);
  assert.equal(new Set(pref).size, pref.length, 'no hay dos bancos con el mismo prefijo');
  assert.equal(B.SEMILLA.length, 113);
});

test('el banco se identifica con los 3 primeros dígitos de la CLABE', () => {
  assert.equal(B.bancoDeClabe('012180000000001014', bancos).nombre, 'BBVA MEXICO');
  assert.equal(B.bancoDeClabe('646180171815600015', bancos).nombre, 'STP');
  assert.equal(B.bancoDeClabe('012', bancos).nombre, 'BBVA MEXICO');          // mientras se teclea
  assert.equal(B.bancoDeClabe('01', bancos), null);
  assert.equal(B.bancoDeClabe('999180000000000000', bancos), null);
  assert.equal(B.bancoDeClabe('012180000000001014', bancos.map(b => b.nombre === 'BBVA MEXICO' ? { ...b, activo: false } : b)), null);
});

test('beneficiario: tolera forma societaria, acentos, puntuación, cortes del CEP y orden', () => {
  const ok = (a, b) => assert.equal(B.nombresCoinciden(a, b), true, `${a} ≈ ${b}`);
  ok('ACME SERVICIOS S.A. DE C.V.', 'Acme Servicios SA de CV');
  ok('ACME SERVICIOS SAPI DE CV', 'ACME SERVICIOS');
  ok('Comercializadora Peña & Hijos', 'COMERCIALIZADORA PENA Y HIJOS S.A.');
  ok('ACME COMERCIALIZADORA', 'COMERCIALIZADORA ACME DEL NORTE');
  ok('COMERCIALIZADORA INTERNACIONAL DEL', 'COMERCIALIZADORA INTERNACIONAL DEL NORTE SA DE CV');   // el CEP cortó el nombre
  const no = (a, b) => assert.equal(B.nombresCoinciden(a, b), false, `${a} ≠ ${b}`);
  no('OTRA EMPRESA SA DE CV', 'ACME SERVICIOS SA DE CV'); no('ACME', 'ACME SERVICIOS DEL NORTE'); no('JUAN PEREZ', 'JUANA PEREZ');
  assert.equal(B.nombresCoinciden('', 'ACME'), null); assert.equal(B.nombresCoinciden('ACME', null), null);
});

test('banco: “BBVA BANCOMER”, “BBVA MEXICO” y el nombre largo de Banxico son el mismo banco', () => {
  const bbva = banco('BBVA MEXICO'), norte = banco('BANORTE');
  for (const n of ['BBVA MEXICO', 'BBVA BANCOMER', 'BBVA', 'BBVA México, S.A., Institución de Banca Múltiple, Grupo Financiero BBVA México']) assert.equal(B.bancoCoincide(n, bbva, bancos), true, n);
  for (const n of ['BANORTE', 'Banco Mercantil del Norte S.A. Institución de Banca Múltiple, Grupo Financiero Banorte']) assert.equal(B.bancoCoincide(n, norte, bancos), true, n);
  assert.equal(B.bancoCoincide('BANORTE', bbva, bancos), false); assert.equal(B.bancoCoincide('SANTANDER', banco('BANAMEX'), bancos), false);
  assert.equal(B.bancoCoincide('', bbva, bancos), null);
  assert.equal(B.bancoCoincide('STP', banco('STP'), bancos), true); assert.equal(B.bancoCoincide('Mercado Pago W', banco('Mercado Pago W'), bancos), true);
});

const datos = (o = {}) => ({ monto: 301740, clave_rastreo: 'R1', fecha_abono: '2026-10-22', beneficiario: { nombre: 'ACME SERVICIOS SA DE CV', cuenta: '012180000000001014', institucion: 'BBVA MEXICO', ...o } });
const fon = (o = {}) => ({ monto_recibido: 301740, clave_rastreo: 'R1', clabe_destino: '012180000000001014', fecha: '2026-10-22', beneficiario_destino: 'Acme Servicios S.A. de C.V.', banco_destino: 'BBVA MEXICO', banco_codigo_destino: 40012, bancos, ...o });

test('el CEP se compara con el beneficiario y el banco de la cuenta', () => {
  const v = CEPX.verificar(datos(), fon());
  assert.equal(v.conflicto, false); assert.equal(v.coincide, true);
  assert.deepEqual(v.checks.filter(c => ['beneficiario', 'banco'].includes(c.campo)).map(c => [c.campo, c.estado]), [['beneficiario', 'ok'], ['banco', 'ok']]);
  const mal = CEPX.verificar(datos({ nombre: 'OTRA EMPRESA SA', institucion: 'BANORTE' }), fon());
  assert.equal(mal.conflicto, true);
  assert.deepEqual(mal.checks.filter(c => c.estado === 'difiere').map(c => c.campo), ['beneficiario', 'banco']);
  assert.ok(mal.checks.filter(c => c.estado === 'difiere').every(c => c.duro), 'una diferencia exige nota de tesorería');
});
test('si el CEP no trae el dato, o la cuenta no tiene beneficiario definido, no hay conflicto', () => {
  const sin = CEPX.verificar(datos({ nombre: null, institucion: null }), fon());
  assert.equal(sin.conflicto, false); assert.ok(sin.checks.filter(c => ['beneficiario', 'banco'].includes(c.campo)).every(c => c.estado === 'sin_dato'));
  const vieja = CEPX.verificar(datos({ nombre: 'OTRA' }), fon({ beneficiario_destino: null, banco_codigo_destino: null, banco_destino: null }));
  assert.equal(vieja.checks.some(c => ['beneficiario', 'banco'].includes(c.campo)), false);
});

test('al subir el CEP, una diferencia de beneficiario o banco se acepta con aviso (la CLABE ya identifica la cuenta)', () => {
  const cep = (b = {}) => ({ formato: 'cep_banxico', es_cep: null, datos: { monto: 100, clave_rastreo: 'R', fecha_abono: '2026-10-22', beneficiario: { cuenta: '012180000000001014', nombre: 'ACME SERVICIOS SA DE CV', institucion: 'BBVA MEXICO', ...b } } });
  const ctx = { clabe_destino: '012180000000001014', empresa_nombre: 'Acme', monto_esperado: 100, rastreos_previos: [], hoy: '2026-10-23', beneficiario_nombre: 'Acme Servicios', banco: banco('BBVA MEXICO'), bancos };
  const bien = FL.evaluarCep(cep(), ctx); assert.equal(bien.ok, true); assert.deepEqual(bien.avisos, []);
  const r = FL.evaluarCep(cep({ nombre: 'OTRA EMPRESA SA', institucion: 'BANORTE' }), ctx);
  assert.equal(r.ok, true); assert.equal(r.avisos.length, 2);
  assert.match(r.avisos[0], /beneficiario del CEP/); assert.match(r.avisos[1], /banco del CEP/);
  assert.equal(FL.evaluarCep(cep({ nombre: 'OTRA' }), { ...ctx, beneficiario_nombre: null, banco: null }).avisos.length, 0);   // cuenta sin definir: nada que comparar
});

test('sembrarBancos: copia el catálogo de MCEB, completa con la semilla, no pisa y deja a cada entidad con su banco', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-cards.sql'), 'utf8'));
    await db.exec(`create table bancos_mceb(nombre text, codigo_spei integer);
      insert into bancos_mceb values ('BBVA MEXICO', 40012), ('BANCO NUEVO', 40888), ('KAPITAL', 90670), ('Otro nombre', 40014);`);
    const e = (await db.query(`insert into cards.entidades(nivel,nombre,clabe) values('EMPRESA','Acme','012180000000001014') returning id`)).rows[0].id;
    await db.query('update cards.entidades set empresa_id=id where id=$1', [e]);
    await db.query(`update cards.entidades set beneficiario='ACME SA' where id=$1`, [e]);
    const f = (await db.query(`insert into cards.fondeos(folio,entidad_id,empresa_id,fondeo,comision,iva,comision_pct,iva_pct,clabe_destino) values('F1',$1,$1,100,1,0.16,1,16,'012180000000001014') returning id`, [e])).rows[0].id;
    const q = (sql, p) => db.query(sql, p);
    await B.sembrarBancos(q, { origen: 'bancos_mceb' });
    await B.sembrarBancos(q, { origen: 'bancos_mceb' });   // idempotente
    const n = (await db.query('select count(*)::int n from cards.bancos')).rows[0].n;
    assert.equal(n, 114);                                                              // 113 de la semilla + BANCO NUEVO
    const nuevo = (await db.query(`select prefijo from cards.bancos where codigo_spei=40888`)).rows[0];
    assert.equal(nuevo.prefijo, '888');
    assert.equal((await db.query(`select nombre from cards.bancos where codigo_spei=90670`)).rows[0].nombre, 'LIBERTAD');   // la semilla manda: no se pisa
    assert.equal((await db.query(`select nombre from cards.bancos where codigo_spei=40014`)).rows[0].nombre, 'SANTANDER');
    const ent = (await db.query('select banco_codigo from cards.entidades where id=$1', [e])).rows[0];
    assert.equal(ent.banco_codigo, 40012);                                             // se dedujo de la CLABE
    const fo = (await db.query('select beneficiario_destino b, banco_destino n, banco_codigo_destino c from cards.fondeos where id=$1', [f])).rows[0];
    assert.deepEqual(fo, { b: 'ACME SA', n: 'BBVA MEXICO', c: 40012 });
    await assert.rejects(db.query(`insert into cards.bancos(codigo_spei,nombre) values(1234,'bbva mexico')`), /unique|duplicate/i);   // nombre repetido (sin importar mayúsculas)
  } finally { try { await db.close(); } catch (_e) { /* nada */ } }
});
