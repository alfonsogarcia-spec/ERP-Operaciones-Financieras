/* Tasas por comercio: el motor suma comercio por comercio, los cargos se aplican una vez y el reparto por comercio sigue cuadrando. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const RC = require('../lib/reparto-comercio.js');
const TC = require('../lib/tasas-comercio.js');

const PAR = { IVA: 0.16, tasa_int_amex: 0.0247, tasa_int_int: 0.0302, fee_broxel: 0.0028 };
const TASAS = { pac_tdd: 0.015, pac_tdc: 0.025, pac_amex: 0.03, pac_int: 0.035, costo_x_trx: 0, pct_banca: 0.01 };
const CAT = { tasas: TASAS, costos: { int_tdd: 0.005, int_tdc: 0.01, int_amex: null, int_int: null, fee_broxel: null } };
const txs = [
  { comercio: 'Centro', producto: 'Débito', monto: 1000 }, { comercio: 'Centro', producto: 'Crédito', monto: 2000 },
  { comercio: 'Norte', producto: 'Débito', monto: 3000 }, { comercio: 'Norte', producto: 'American Express', monto: 500 },
  { comercio: 'Sur', producto: 'Crédito', monto: 4000 }, { comercio: '', producto: 'Débito', monto: 250 },
];
const cerca = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m || ''} ${a} vs ${b}`);

test('sin comercios con tasa propia el resultado es idéntico al de siempre', () => {
  const base = E.calcularBase(txs, CAT, PAR, {});
  for (const cat of [CAT, { ...CAT, comercios: [] }, { ...CAT, comercios: [{ comercio: 'Centro', tasas: {} }] }, { ...CAT, comercios: [{ comercio: 'No llega', tasas: { pac_tdd: 0.001 } }] }]) assert.deepEqual(E.calcularCompensacion(txs, cat, PAR, {}), base);
});

test('una tasa propia igual a la pactada no cambia nada; una distinta solo cambia a ese comercio', () => {
  const base = E.calcularBase(txs, CAT, PAR, {});
  const igual = E.calcularCompensacion(txs, { ...CAT, comercios: [{ comercio: 'Centro', tasas: { pac_tdd: 0.015, pac_tdc: 0.025 } }] }, PAR, {});
  for (const k of Object.keys(base)) cerca(igual[k], base[k], k);
  // Centro cobra 1 % de débito y 2 % de crédito
  const c = E.calcularCompensacion(txs, { ...CAT, comercios: [{ comercio: 'Centro', tasas: { pac_tdd: 0.01, pac_tdc: 0.02 } }] }, PAR, {});
  cerca(c.com_tdd, 1000 * 0.01 + 3250 * 0.015); cerca(c.com_tdc, 2000 * 0.02 + 4000 * 0.025);          // el resto sigue con la pactada
  cerca(c.com_amex, 500 * 0.03); cerca(c.m_tdd + c.m_tdc + c.m_amex + c.m_int, 10750);
  cerca(c.iva_com_tdd, c.com_tdd * 0.16);
  assert.ok(c.disp_total > base.disp_total);                                                           // cobra menos → se dispersa más
});

test('el nombre del comercio se compara sin acentos, mayúsculas ni espacios de más', () => {
  const t = [{ comercio: ' SUCURSAL  Mérida ', producto: 'Débito', monto: 1000 }];
  const r = E.calcularCompensacion(t, { ...CAT, comercios: [{ comercio: 'sucursal merida', tasas: { pac_tdd: 0.01 } }] }, PAR, {});
  cerca(r.com_tdd, 10);
});

test('costo por trx y % de banca propios; la banca del grupo es la suma de la de cada comercio', () => {
  const cat = { ...CAT, tasas: { ...TASAS, costo_x_trx: 2 }, comercios: [{ comercio: 'Norte', tasas: { costo_x_trx: 0.5, pct_banca: 0 } }] };
  const r = E.calcularCompensacion(txs, cat, PAR, {});
  cerca(r.com_trx, 4 * 2 + 2 * 0.5);                                                                    // Centro 2 trx + Sur 1 + sin comercio 1 a $2; Norte 2 a $0.50 (el costo cuenta todas las trx)
  assert.ok(r.banca > 0 && r.pct_banca < 0.01 && r.pct_banca > 0);                                      // Norte sin banca baja el % efectivo
});

test('los cargos (financiamientos y contracargos) se aplican una sola vez, sobre el total del grupo', () => {
  const cat = { ...CAT, comercios: [{ comercio: 'Centro', tasas: { pac_tdd: 0.01 } }, { comercio: 'Sur', tasas: { pac_tdc: 0.02 } }] };
  const sin = E.calcularCompensacion(txs, cat, PAR, {});
  const con = E.calcularCompensacion(txs, cat, PAR, { financiamientos: 100, contracargos_dom: 50, contracargos_amex: 10 });
  cerca(con.disp_dom, sin.disp_dom - 150); cerca(con.disp_amex, sin.disp_amex - 10); cerca(con.disp_total, sin.disp_total - 160);
  assert.equal(con.financiamientos, 100); assert.equal(con.contracargos_dom, 50); assert.equal(con.contracargos_amex, 10);
  cerca(con.diferencia, 0); cerca(con.com_tdd, sin.com_tdd); cerca(con.utilidad, sin.utilidad);
});

test('utilidad = comisión − intercambio − Broxel sigue cumpliéndose con tasas por comercio', () => {
  const r = E.calcularCompensacion(txs, { ...CAT, comercios: [{ comercio: 'Sur', tasas: { pac_tdc: 0.012 } }] }, PAR, {});
  cerca(r.utilidad, (r.com_tdd + r.com_tdc + r.com_amex + r.com_int) - (r.int_tdd + r.int_tdc + r.int_amex + r.int_int) - r.broxel);
});

test('reparto por comercio con tasas propias: la suma de las partes es exactamente lo que dispersa el grupo, y el comercio con mejor tasa recibe más', () => {
  const comercios = TC.comerciosDeFila([{ comercio: 'Centro', com_tasa_tdd: '0.005', com_tasa_tdc: '0.01' }, { comercio: 'Norte' }]);
  const cat = { ...CAT, comercios };
  const final = E.calcularCompensacion(txs, cat, PAR, { financiamientos: 0, contracargos_dom: 120, contracargos_amex: 0 });
  const cta = (comercio, clabe) => ({ comercio, clabe, codigo_banco: 12, banco: 'BBVA', beneficiario: comercio });
  const rep = RC.repartir({ txs, cuentasComercio: [cta('Centro', '1'), cta('Norte', '2')], calcular: sub => E.calcularCompensacion(sub, cat, PAR, {}), final, general: cta('General', '9') });
  cerca(rep.partes.reduce((a, p) => a + p.disp_dom, 0), RC.round2(final.disp_dom) + 0, 'dom'); 
  assert.ok(Math.abs(rep.partes.reduce((a, p) => a + p.disp_dom, 0) - final.disp_dom) < 0.011);
  assert.ok(Math.abs(rep.partes.reduce((a, p) => a + p.disp_amex, 0) - final.disp_amex) < 0.011);
  // Centro con tasas más bajas recibe una proporción mayor de su monto que con la tasa del grupo
  const sinTasa = RC.repartir({ txs, cuentasComercio: [cta('Centro', '1'), cta('Norte', '2')], calcular: sub => E.calcularCompensacion(sub, CAT, PAR, {}), final: E.calcularCompensacion(txs, CAT, PAR, { contracargos_dom: 120 }), general: cta('General', '9') });
  const centro = r => r.partes.find(p => p.comercio === 'Centro').disp_dom;
  assert.ok(centro(rep) > centro(sinTasa));
});

test('comerciosDeFila: solo los comercios con tasa propia; si el comercio está dos veces manda la primera cuenta', () => {
  const l = TC.comerciosDeFila([{ comercio: 'A', com_tasa_tdd: '0.01', com_pct_banca: null }, { comercio: 'a', com_tasa_tdd: '0.02' }, { comercio: 'B' }, { comercio: 'C', com_tasa_tdc: 0 }]);
  assert.deepEqual(l, [{ comercio: 'A', tasas: { pac_tdd: 0.01 } }, { comercio: 'C', tasas: { pac_tdc: 0 } }]);          // 0 % es una tasa propia válida (vacío es lo que usa la pactada)
  assert.equal(TC.tasaDeProducto(l, ' a ', 'tdd'), 0.01); assert.equal(TC.tasaDeProducto(l, 'A', 'tdc'), null); assert.equal(TC.tasaDeProducto(l, 'Z', 'tdd'), null); assert.equal(TC.tasaDeProducto(l, '', 'tdd'), null);
});

test('normalizar: vacío usa la pactada; rango y formato se validan', () => {
  const v = TC.normalizar({ tasa_tdd: '0.015', tasa_tdc: '', pct_banca: '0.001', costo_x_trx: '2.5' });
  assert.equal(v.ok, true); assert.deepEqual(v.valores, { com_tasa_tdd: 0.015, com_tasa_tdc: null, com_tasa_amex: null, com_tasa_int: null, com_costo_x_trx: 2.5, com_pct_banca: 0.001 });
  assert.equal(TC.normalizar({ tasa_tdd: '2.5%' }).ok, false);                                                      // el servidor recibe fracciones, no porcentajes
  assert.equal(TC.normalizar({ tasa_tdd: 1 }).ok, false); assert.equal(TC.normalizar({ tasa_tdd: -0.1 }).ok, false); assert.equal(TC.normalizar({ tasa_tdc: 'abc' }).ok, false);
  assert.equal(TC.normalizar({ costo_x_trx: 5000 }).ok, false); assert.equal(TC.normalizar({}).ok, true);
  assert.match(TC.normalizar({ tasa_amex: 2 }).errores[0], /AMEX/);
});

test('guardarEnCuenta: solo una cuenta con comercio guarda tasas; vaciar todo regresa a la pactada', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite();
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const cols = [...sql.matchAll(/alter table cuentas add column if not exists (com_\w+)\s+numeric;/g)].map(m => m[1]);
  assert.deepEqual(cols.slice().sort(), Object.keys(TC.COLUMNAS).sort());                            // el esquema y el código hablan de las mismas columnas
  await pg.exec('create table cuentas (id serial primary key, id_grupo int, numero_afiliacion text, comercio text, ' + cols.map(c => c + ' numeric').join(', ') + ');'
    + " insert into cuentas (id_grupo, numero_afiliacion, comercio) values (1, '', null), (1, '', 'Centro');");
  const q = (t, p) => pg.query(t, p || []);
  await assert.rejects(TC.guardarEnCuenta(q, 1, TC.normalizar({ tasa_tdd: 0.01 }).valores), e => e.codigo === 'solo_comercio' && e.status === 400);
  await assert.rejects(TC.guardarEnCuenta(q, 99, {}), e => e.status === 404);
  await TC.guardarEnCuenta(q, 2, TC.normalizar({ tasa_tdd: 0.01, pct_banca: 0.002 }).valores);
  const fila = (await q('select * from cuentas where id = 2')).rows[0];
  assert.deepEqual(TC.deCuenta(fila), { pac_tdd: 0.01, pct_banca: 0.002 });                              // pg devuelve numeric como texto: deCuenta lo convierte
  assert.deepEqual(TC.comerciosDeFila([fila]), [{ comercio: 'Centro', tasas: { pac_tdd: 0.01, pct_banca: 0.002 } }]);
  await TC.guardarEnCuenta(q, 2, TC.normalizar({}).valores);
  assert.deepEqual(TC.deCuenta((await q('select * from cuentas where id = 2')).rows[0]), {});
  await pg.close();
});

test('avisosCosto: avisa cuando la tasa del comercio queda por debajo del costo', () => {
  const costos = { int_tdd: 0.005, int_tdc: 0.01, int_amex: null, int_int: null, fee_broxel: null };
  const par = { tasa_int_amex: 0.0247, tasa_int_int: 0.0302, fee_broxel: 0.0028 };
  const a = TC.avisosCosto({ com_tasa_tdd: 0.006, com_tasa_tdc: 0.02, com_tasa_amex: null, com_tasa_int: null }, costos, par);
  assert.equal(a.length, 1); assert.match(a[0], /débito.*0\.60 %.*0\.78 %/);
  assert.deepEqual(TC.avisosCosto({ com_tasa_tdd: 0.0 }, null, par), []);
});
