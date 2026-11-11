'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/catalogo-layout.js');

const HEAD = ['id_grupo', 'nombre_cliente', 'numero_afiliacion', 'razon_social', 'tasa_pac_tdd', 'tasa_pac_tdc', 'tasa_pac_amex', 'tasa_pac_int', 'costo_x_trx', 'pct_banca',
  'int_tdd', 'int_tdc', 'int_amex', 'int_int', 'fee_broxel', 'tasa_descuento_tdd', 'mcc', 'descripcion_giro'];
const ACTUAL = () => ({
  grupos: [{ id_grupo: 1, nombre_cliente: 'ALFA' }, { id_grupo: 2, nombre_cliente: 'BETA' }],
  afiliaciones: [{ numero_afiliacion: '0012345', razon_social: 'Alfa SA', mcc: 5411, descripcion_giro: 'Supermercados' }, { numero_afiliacion: '9988776', razon_social: 'Beta SA', mcc: null }],
  afilGrupo: [
    { id_grupo: 1, numero_afiliacion: '0012345', tasa_pac_tdd: 0.015, tasa_pac_tdc: 0.025, tasa_pac_amex: 0.03, tasa_pac_int: 0.035, costo_x_trx: 0, pct_banca: 0.001 },
    { id_grupo: 2, numero_afiliacion: '9988776', tasa_pac_tdd: 0.01, tasa_pac_tdc: 0.02, tasa_pac_amex: 0, tasa_pac_int: 0, costo_x_trx: 1, pct_banca: 0 }],
  costos: [{ numero_afiliacion: '0012345', int_tdd: 0.005, int_tdc: 0.01, int_amex: null, int_int: null, fee_broxel: 0.0028 }],
});
const PARAMS = { tasa_int_amex: 0.0247, tasa_int_int: 0.0302, fee_broxel: 0.0028 };
const plan = (filas, actual = ACTUAL()) => L.planificar(filas, actual, { headers: HEAD, params: PARAMS });
const fila = (o) => Object.assign({ id_grupo: 1, nombre_cliente: 'ALFA', numero_afiliacion: '0012345' }, o);

test('leerNumero: fracción, porcentaje, moneda y coma decimal', () => {
  assert.equal(L.leerNumero(0.025).valor, 0.025);
  assert.equal(L.leerNumero('2.5%').valor, 0.025);
  assert.equal(L.leerNumero('$1,200.50').valor, 1200.5);
  assert.equal(L.leerNumero('0,025').valor, 0.025);
  assert.equal(L.leerNumero('abc').ok, false);
});

test('una fila igual a lo actual no genera cambios', () => {
  const p = plan([fila({ tasa_pac_tdd: 0.015, tasa_pac_tdc: 0.025, mcc: 5411, razon_social: 'Alfa SA', int_tdd: 0.005 })]);
  assert.equal(p.filas[0].accion, 'sin_cambio');
  assert.equal(p.resumen.modificar, 0);
  assert.ok(p.ok);
});

test('celda vacía = no cambia (no se vuelve cero)', () => {
  const p = plan([fila({ tasa_pac_tdd: 0.02 })]);
  const f = p.filas[0];
  assert.equal(f.accion, 'modificar');
  assert.deepEqual(f.cambios.map(c => c.campo), ['tasa_pac_tdd']);
  assert.equal(f.final.relacion.tasa_pac_tdc, 0.025);   // intacta
  assert.equal(f.final.costos.fee_broxel, 0.0028);      // intacto
});

test('tasa fuera de rango es error y bloquea el archivo; "2.5" sugiere el porcentaje', () => {
  const p = plan([fila({ tasa_pac_tdd: 2.5 }), fila({ id_grupo: 2, nombre_cliente: 'BETA', numero_afiliacion: '9988776', tasa_pac_tdc: 0.03 })]);
  assert.equal(p.ok, false);
  assert.equal(p.resumen.error, 1);
  assert.match(p.filas[0].errores[0], /2\.5%/);
});

test('"2.5%" se lee como 0.025', () => {
  const p = plan([fila({ tasa_pac_tdc: '3%' })]);
  assert.equal(p.filas[0].final.relacion.tasa_pac_tdc, 0.03);
});

test('texto no numérico y negativos son error', () => {
  assert.equal(plan([fila({ tasa_pac_tdd: 'abc' })]).ok, false);
  assert.equal(plan([fila({ costo_x_trx: -1 })]).ok, false);
  assert.equal(plan([fila({ costo_x_trx: '5%' })]).ok, false);
});

test('PARAM deja nulo el costo para usar Parámetros; en tdd no aplica', () => {
  const p = plan([fila({ int_amex: 0.02, fee_broxel: 'PARAM' })]);
  assert.equal(p.filas[0].final.costos.fee_broxel, null);
  assert.equal(p.filas[0].final.costos.int_amex, 0.02);
  assert.equal(plan([fila({ int_tdd: 'PARAM' })]).ok, false);
});

test('relación nueva: vacío en tasas = 0 con aviso; afiliación existente se reutiliza', () => {
  const p = plan([{ id_grupo: 2, nombre_cliente: 'BETA', numero_afiliacion: '0012345', tasa_pac_tdc: 0.02 }]);
  const f = p.filas[0];
  assert.equal(f.accion, 'crear');
  assert.equal(f.afiliacion_nueva, false);
  assert.equal(f.final.relacion.tasa_pac_tdd, 0);
  assert.ok(f.avisos.some(a => /sin comisión/.test(a)));
});

test('grupo nuevo exige nombre; afiliación nueva exige razón social', () => {
  assert.equal(plan([{ id_grupo: 7, numero_afiliacion: '5555555', razon_social: 'X', tasa_pac_tdd: 0.01, tasa_pac_tdc: 0.02 }]).ok, false);
  assert.equal(plan([{ id_grupo: 7, nombre_cliente: 'NUEVO', numero_afiliacion: '5555555', tasa_pac_tdd: 0.01, tasa_pac_tdc: 0.02 }]).ok, false);
  const ok = plan([{ id_grupo: 7, nombre_cliente: 'NUEVO', numero_afiliacion: '5555555', razon_social: 'Nueva SA', tasa_pac_tdd: 0.01, tasa_pac_tdc: 0.02 }]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.grupos_nuevos, [{ id_grupo: 7, nombre: 'NUEVO' }]);
  assert.equal(ok.resumen.afiliaciones_nuevas, 1);
});

test('renombrar un grupo se reporta aparte (no es un cambio silencioso)', () => {
  const p = plan([fila({ nombre_cliente: 'ALFA 2' })]);
  assert.deepEqual(p.renombres, [{ id_grupo: 1, antes: 'ALFA', despues: 'ALFA 2', solo_mayusculas: false }]);
  assert.equal(p.filas[0].accion, 'sin_cambio');
});

test('duplicados en el archivo y valores distintos para la misma afiliación son error', () => {
  assert.equal(plan([fila({}), fila({})]).ok, false);
  const p = plan([fila({ int_tdd: 0.005 }), fila({ id_grupo: 2, nombre_cliente: 'BETA', int_tdd: 0.006 })]);
  assert.equal(p.ok, false);
  assert.match(p.filas[1].errores[0], /distinto/);
});

test('Excel sin ceros iniciales: 12345 se liga con 0012345', () => {
  const p = plan([fila({ numero_afiliacion: 12345, tasa_pac_tdd: 0.02 })]);
  assert.equal(p.filas[0].numero_afiliacion, '0012345');
  assert.equal(p.filas[0].afiliacion_nueva, false);
  assert.ok(p.filas[0].avisos.some(a => /ceros/.test(a)));
});

test('MCC: inválido es error; fuera de catálogo se ignora con aviso; válido cambia', () => {
  assert.equal(plan([fila({ mcc: 'abc' })]).ok, false);
  const fuera = plan([fila({ mcc: 5311 })]);
  assert.ok(fuera.filas[0].avisos.some(a => /catálogo/.test(a)));
  assert.equal(fuera.filas[0].final.afiliacion.mcc, 5411);
  const bueno = plan([fila({ mcc: 5812 })]);
  assert.equal(bueno.filas[0].final.afiliacion.mcc, 5812);
  assert.deepEqual(bueno.filas[0].cambios.map(c => c.campo), ['mcc']);
});

test('aviso de margen negativo cuando la tasa pactada no cubre intercambio + fee', () => {
  const p = plan([fila({ tasa_pac_tdd: 0.004 })]);    // costo TDD = 0.005 + 0.0028
  assert.ok(p.filas[0].avisos.some(a => /margen negativo/.test(a)));
  assert.ok(p.ok);                                     // avisa, no bloquea
});

test('columnas ignoradas e informativas; falta de columnas obligatorias', () => {
  const p = L.planificar([fila({ x: 1 })], ACTUAL(), { headers: [...HEAD, 'comentario'], params: PARAMS });
  assert.deepEqual(p.columnas_ignoradas, ['comentario']);
  assert.ok(p.columnas_informativas.includes('tasa_descuento_tdd'));
  const sin = L.planificar([{ nombre_cliente: 'X' }], ACTUAL(), { headers: ['nombre_cliente'], params: PARAMS });
  assert.equal(sin.ok, false);
  assert.equal(sin.errores_archivo.length, 2);
});

test('archivo vacío no es válido', () => {
  assert.equal(plan([]).ok, false);
});

/* ───────── Captura en PORCENTAJE (columnas *_pct): 2.5 = 2.5 %, sin decimales de fracción ───────── */
const HEAD_PCT = ['id_grupo', 'nombre_cliente', 'numero_afiliacion', 'razon_social', 'tasa_pac_tdd_pct', 'tasa_pac_tdc_pct', 'tasa_pac_amex_pct', 'tasa_pac_int_pct',
  'costo_x_trx', 'pct_banca_pct', 'int_tdd_pct', 'int_tdc_pct', 'int_amex_pct', 'int_int_pct', 'fee_broxel_pct', 'tasa_descuento_tdd_pct', 'mcc', 'descripcion_giro'];
const planPct = (filas, actual = ACTUAL()) => L.planificar(filas, actual, { headers: HEAD_PCT, params: PARAMS });

test('pct: 2.5 es 2.5 %, 0.28 es 0.28 % y "2.5%" también vale', () => {
  const p = planPct([fila({ tasa_pac_tdd_pct: 2.5, tasa_pac_tdc_pct: '3%', fee_broxel_pct: 0.28 })]);
  const f = p.filas[0];
  assert.equal(f.final.relacion.tasa_pac_tdd, 0.025);
  assert.equal(f.final.relacion.tasa_pac_tdc, 0.03);
  assert.equal(f.final.costos.fee_broxel, 0.0028);
  assert.ok(p.ok);
});

test('pct: lo que baja el export sin tocar queda "sin cambio" (round-trip)', () => {
  const p = planPct([fila({ tasa_pac_tdd_pct: 1.5, tasa_pac_tdc_pct: 2.5, tasa_pac_amex_pct: 3, tasa_pac_int_pct: 3.5, pct_banca_pct: 0.1, int_tdd_pct: 0.5, int_tdc_pct: 1, fee_broxel_pct: 0.28, mcc: 5411, razon_social: 'Alfa SA' })]);
  assert.equal(p.filas[0].accion, 'sin_cambio');
});

test('pct: 100 o más y negativos son error; texto es error', () => {
  assert.equal(planPct([fila({ tasa_pac_tdd_pct: 100 })]).ok, false);
  assert.equal(planPct([fila({ tasa_pac_tdd_pct: 250 })]).ok, false);
  assert.equal(planPct([fila({ tasa_pac_tdd_pct: -1 })]).ok, false);
  assert.equal(planPct([fila({ tasa_pac_tdd_pct: 'dos' })]).ok, false);
});

test('pct: un valor diminuto avisa que parece fracción (0.025 en vez de 2.5)', () => {
  const p = planPct([fila({ tasa_pac_tdc_pct: 0.025 })]);
  assert.ok(p.ok);
  assert.ok(p.filas[0].avisos.some(a => /fracción|muy pequeño/.test(a)));
});

test('pct: PARAM y vacío funcionan igual; 0 es cero de verdad', () => {
  const p = planPct([fila({ fee_broxel_pct: 'PARAM', int_amex_pct: 0 })]);
  assert.equal(p.filas[0].final.costos.fee_broxel, null);
  assert.equal(p.filas[0].final.costos.int_amex, 0);
  assert.equal(p.filas[0].final.relacion.tasa_pac_tdd, 0.015);   // vacío = intacto
});

test('pct: el mensaje de error nombra la columna con _pct', () => {
  assert.match(planPct([fila({ tasa_pac_tdd_pct: 150 })]).filas[0].errores[0], /tasa_pac_tdd_pct/);
});

test('pct: el archivo viejo (sin _pct) sigue funcionando como antes; con las dos columnas es error de archivo', () => {
  assert.equal(plan([fila({ tasa_pac_tdd: 0.02 })]).filas[0].final.relacion.tasa_pac_tdd, 0.02);
  const dos = L.planificar([fila({})], ACTUAL(), { headers: [...HEAD, 'tasa_pac_tdd_pct'], params: PARAMS });
  assert.equal(dos.ok, false);
  assert.ok(dos.errores_archivo.some(m => /dos veces/.test(m)));
});

test('pct: cambio de ×10 avisa posible error de escala', () => {
  const p = planPct([fila({ tasa_pac_tdd_pct: 15 })]);               // 1.5 → 15
  assert.ok(p.filas[0].avisos.some(a => /escala/.test(a)));
});

test('afiliación compartida: los datos propios de la afiliación se fusionan de todas sus filas', () => {
  const actual = ACTUAL();
  actual.afilGrupo.push({ id_grupo: 2, numero_afiliacion: '0012345', tasa_pac_tdd: 0.01, tasa_pac_tdc: 0.02, tasa_pac_amex: 0, tasa_pac_int: 0, costo_x_trx: 0, pct_banca: 0 });
  const p = planPct([fila({ int_tdd_pct: 0.6 }), fila({ id_grupo: 2, nombre_cliente: 'BETA', fee_broxel_pct: 0.3 })], actual);
  const a = p.afiliaciones['0012345'];
  assert.equal(a.final.costos.int_tdd, 0.006);
  assert.equal(a.final.costos.fee_broxel, 0.003);
  assert.deepEqual(Object.keys(a.cambios).sort(), ['fee_broxel', 'int_tdd']);
});

test('costo compartido: avisa cuando toca grupos que no vienen en el archivo', () => {
  const actual = ACTUAL();
  actual.afilGrupo.push({ id_grupo: 2, numero_afiliacion: '0012345', tasa_pac_tdd: 0.01, tasa_pac_tdc: 0.02, tasa_pac_amex: 0, tasa_pac_int: 0, costo_x_trx: 0, pct_banca: 0 });
  const p = planPct([fila({ int_tdd_pct: 0.6 })], actual);
  assert.ok(p.filas[0].avisos.some(a => /no vienen en el archivo/.test(a)));
});

test('límites: id_grupo enorme, NUL en el texto y textos largos', () => {
  assert.equal(planPct([fila({ id_grupo: 99999999999 })]).ok, false);
  assert.equal(planPct([fila({ razon_social: 'x'.repeat(201) })]).ok, false);
  const nul = planPct([fila({ razon_social: 'Alfa\u0000 SA2' })]);
  assert.equal(nul.filas[0].final.afiliacion.razon_social, 'Alfa SA2');   // el carácter de control se limpia
  assert.equal(planPct([{ id_grupo: 1, nombre_cliente: 'ALFA', numero_afiliacion: '1'.repeat(21) }]).ok, false);
});

test('rendimiento: 5,000 filas con grupos nuevos sin nombre no se vuelven cuadráticas', () => {
  const filas = Array.from({ length: 5000 }, (_, i) => ({ id_grupo: 1000 + i, numero_afiliacion: String(5000000 + i), razon_social: 'X', tasa_pac_tdd_pct: 1, tasa_pac_tdc_pct: 2 }));
  const t = Date.now();
  const p = planPct(filas);
  assert.ok(Date.now() - t < 1500, 'tardó demasiado');
  assert.equal(p.ok, false);                                              // sin nombre_cliente
});

/* ───────── Revisión CTO: formato % de Excel (M1), avisos de escala con confirmación (M2), encabezados con % y modos mezclados (B3), mensajes (B4) ───────── */
const X = require('../lib/excel.js');
const prep = (parsed, actual = ACTUAL()) => { const pp = L.prepararLayout(parsed); return L.planificar(pp.objs, actual, { headers: pp.headers, params: PARAMS }); };

test('M1: celda numérica con formato % en una columna _pct se lee como el porcentaje que se ve (0.025 con formato % = 2.5)', () => {
  const buf = X.buildXLSX([{ name: 'Grupos', aoa: [['id_grupo', 'numero_afiliacion', 'tasa_pac_tdd_pct', 'tasa_pac_tdc_pct', 'fee_broxel_pct'], [1, '0012345', 0.025, 3.5, 0.0028]],
    fmt: { z: '0.00%', cols: [2, 4], rowFrom: 1 } }]);
  const con = X.parseBuffer(buf, { hoja: 'Grupos', pctFmt: true });
  assert.equal(con.objs[0].tasa_pac_tdd_pct, 2.5);
  assert.equal(con.objs[0].tasa_pac_tdc_pct, 3.5);        // sin formato %: intacta
  assert.equal(con.objs[0].fee_broxel_pct, 0.28);
  assert.equal(con.celdasPct, 2);
  assert.match(L.prepararLayout(con).avisos[0], /2 celda/);
  assert.equal(X.parseBuffer(buf, { hoja: 'Grupos' }).objs[0].tasa_pac_tdd_pct, 0.025);   // sin la opción no cambia (otros importadores)
});

test('M1: una columna sin _pct (archivo anterior) con formato % NO se toca', () => {
  const buf = X.buildXLSX([{ name: 'Grupos', aoa: [['id_grupo', 'numero_afiliacion', 'tasa_pac_tdd'], [1, '0012345', 0.025]], fmt: { z: '0.00%', cols: [2], rowFrom: 1 } }]);
  assert.equal(X.parseBuffer(buf, { hoja: 'Grupos', pctFmt: true }).objs[0].tasa_pac_tdd, 0.025);
});

test('M1: defensa de columna — todas las pactadas < 0.5 % exigen confirmar', () => {
  const filas = [0.1, 0.2, 0.3].map((v, i) => ({ id_grupo: 1, nombre_cliente: 'ALFA', numero_afiliacion: '0012345', tasa_pac_tdd_pct: v + i * 0.001 }));
  const filas3 = [fila({ tasa_pac_tdd_pct: 0.1 }), fila({ id_grupo: 2, nombre_cliente: 'BETA', numero_afiliacion: '9988776', tasa_pac_tdd_pct: 0.2 }), fila({ id_grupo: 3, nombre_cliente: 'G3', numero_afiliacion: '5555', razon_social: 'X', tasa_pac_tdd_pct: 0.3, tasa_pac_tdc_pct: 2 })];
  const p = planPct(filas3);
  assert.equal(p.escala_archivo, true);
  assert.equal(p.requiere_confirmacion, true);
  assert.match(p.avisos_archivo[0], /menores a 0\.5/);
  assert.ok(filas.length);
});

test('M2: salto de escala, venir de 0 a ≥5 %, costo muy alto y «inusualmente alta» son avisos de escala que requieren confirmación', () => {
  const salto = planPct([fila({ tasa_pac_tdd_pct: 15 })]);                    // 1.5 → 15 (×10)
  assert.equal(salto.filas[0].escala, true); assert.equal(salto.requiere_confirmacion, true);
  const desdeCero = planPct([fila({ tasa_pac_amex_pct: 6 })], (() => { const a = ACTUAL(); a.afilGrupo[0].tasa_pac_amex = 0; return a; })());
  assert.ok(desdeCero.filas[0].avisos.some(m => /pasa de 0% a 6%/.test(m)));
  assert.equal(desdeCero.requiere_confirmacion, true);
  const costoAlto = planPct([fila({ int_tdc_pct: 6 })]);
  assert.ok(costoAlto.filas[0].avisos.some(m => /inusualmente alto para un costo/.test(m)));
  assert.equal(costoAlto.requiere_confirmacion, true);
  const alta = planPct([fila({ tasa_pac_tdc_pct: 12 })]);
  assert.ok(alta.filas[0].avisos.some(m => /inusualmente alta/.test(m)));
  assert.equal(alta.requiere_confirmacion, true);
  assert.equal(planPct([fila({ tasa_pac_tdd_pct: 2 })]).requiere_confirmacion, false);   // cambio normal: sin confirmación
});

test('B5: «muy pequeño» solo avisa si el valor cambia o la relación es nueva (no en cada re-subida)', () => {
  const a = ACTUAL(); a.afilGrupo[0].tasa_pac_tdd = 0.0003;
  const igualP = planPct([fila({ tasa_pac_tdd_pct: 0.03 })], a);                    // mismo valor que ya está
  assert.ok(!igualP.filas[0].avisos.some(m => /muy pequeño/.test(m)));
  assert.equal(igualP.requiere_confirmacion, false);
  const cambia = planPct([fila({ tasa_pac_tdd_pct: 0.04 })], a);
  assert.ok(cambia.filas[0].avisos.some(m => /muy pequeño/.test(m)));
});

test('B3: encabezados con «%» se leen como _pct; mezclar modos es error de archivo; se informa el modo leído', () => {
  const parsed = { objs: [{ id_grupo: 1, nombre_cliente: 'ALFA', numero_afiliacion: '0012345', fee_broxel: 0.3 }], headers: ['id_grupo', 'nombre_cliente', 'numero_afiliacion', 'fee_broxel'], rawHeaders: ['id_grupo', 'nombre_cliente', 'numero_afiliacion', 'Fee Broxel (%)'] };
  const p = prep(parsed);
  assert.equal(p.filas[0].final.costos.fee_broxel, 0.003);              // 0.3 como 0.3 %, no como 30 %
  assert.equal(p.modo_tasas, 'porcentaje');
  assert.match(L.prepararLayout(parsed).avisos[0], /fee_broxel → fee_broxel_pct/);
  const mixto = L.planificar([fila({})], ACTUAL(), { headers: ['id_grupo', 'numero_afiliacion', 'tasa_pac_tdd_pct', 'tasa_pac_tdc'], params: PARAMS });
  assert.equal(mixto.ok, false);
  assert.equal(mixto.modo_tasas, 'mixto');
  assert.equal(plan([fila({})]).modo_tasas, 'fraccion');
});

test('B4: los avisos usan el nombre visible de la columna (con _pct) y la bitácora/valores llevan unidad', () => {
  const p = planPct([fila({ tasa_pac_tdd_pct: 15 })]);
  assert.ok(p.filas[0].avisos.some(m => /tasa_pac_tdd_pct cambia de 1\.5% a 15%/.test(m)));
  const v = planPct([fila({ pct_banca_pct: 12 })]);
  assert.ok(v.filas[0].avisos.some(m => /pct_banca_pct.*% banca/.test(m)));
  assert.equal(L.textoValor('tasa_pac_tdd', 0.015), '1.5%');
});

/* ───────── id_grupo es la llave: cambiarlo en el layout NO es una modificación, no debe romper liquidación/cuentas/cortes ───────── */
test('cambiar el id_grupo (mismo nombre) es error: un id nuevo no puede llamarse igual que otro grupo', () => {
  const p = planPct([fila({ id_grupo: 9101, nombre_cliente: 'ALFA' })]);       // el grupo 1 ya se llama ALFA
  assert.equal(p.ok, false);
  assert.match(p.filas[0].errores[0], /ya lo usa el grupo 1/);
  assert.match(p.filas[0].errores[0], /no se cambia por layout/);
});

test('la comparación de nombres ignora mayúsculas, acentos y espacios', () => {
  const a = ACTUAL(); a.grupos[0].nombre_cliente = 'Peña  Hermanos';
  const p = planPct([{ id_grupo: 77, nombre_cliente: 'PENA HERMANOS', numero_afiliacion: '5555', razon_social: 'X', tasa_pac_tdd_pct: 1, tasa_pac_tdc_pct: 2 }], a);
  assert.equal(p.ok, false);
});

test('renombrar un grupo al nombre de otro grupo es error; renombrarlo a uno libre solo se reporta', () => {
  const choca = planPct([fila({ nombre_cliente: 'BETA' })]);
  assert.equal(choca.ok, false);
  assert.match(choca.filas[0].errores[0], /grupo 2/);
  const libre = planPct([fila({ nombre_cliente: 'ALFA NUEVO' })]);
  assert.ok(libre.ok);
  assert.equal(libre.renombres.length, 1);
});

test('H2: intercambiar o encadenar nombres entre grupos es error (las transacciones pasarían en silencio a otro grupo)', () => {
  const swap = planPct([fila({ nombre_cliente: 'BETA' }), fila({ id_grupo: 2, nombre_cliente: 'ALFA', numero_afiliacion: '9988776' })]);
  assert.equal(swap.ok, false);
  assert.ok(swap.filas.some(f => f.errores.some(e => /también se renombra.*OTRO grupo/.test(e))));
  const cadena = planPct([fila({ nombre_cliente: 'BETA' }), fila({ id_grupo: 2, nombre_cliente: 'GAMMA', numero_afiliacion: '9988776' })]);
  assert.equal(cadena.ok, false);
});

test('H1: renombrar un grupo y crear otro con su nombre anterior es error (el renombre es opcional)', () => {
  const p = planPct([fila({ nombre_cliente: 'OMEGA' }), { id_grupo: 99, nombre_cliente: 'ALFA', numero_afiliacion: '3333333', razon_social: 'N', tasa_pac_tdd_pct: 1, tasa_pac_tdc_pct: 2 }]);
  assert.equal(p.ok, false);
  assert.match(p.filas.find(f => f.id_grupo === 99).errores[0], /ya lo usa el grupo 1/);
});

test('H7/H8: solo mayúsculas se marca como tal; espacios de más NO son un renombre', () => {
  const may = planPct([fila({ nombre_cliente: 'Alfa' })]);
  assert.ok(may.ok); assert.equal(may.renombres[0].solo_mayusculas, true);
  const a = ACTUAL(); a.grupos[0].nombre_cliente = 'ACME  SA';
  const esp = planPct([fila({ nombre_cliente: 'ACME SA' })], a);
  assert.equal(esp.renombres.length, 0);                 // re-subir el export sin editar no propone un renombre fantasma
});

test('dos ids con el mismo nombre dentro del archivo es error', () => {
  const p = planPct([{ id_grupo: 70, nombre_cliente: 'REPETIDO', numero_afiliacion: '1', razon_social: 'A', tasa_pac_tdd_pct: 1, tasa_pac_tdc_pct: 2 },
    { id_grupo: 71, nombre_cliente: 'repetido', numero_afiliacion: '2', razon_social: 'B', tasa_pac_tdd_pct: 1, tasa_pac_tdc_pct: 2 }]);
  assert.equal(p.ok, false);
});

test('una afiliación que ya está en otro grupo avisa que se AGREGA una relación (no se mueve)', () => {
  const p = planPct([{ id_grupo: 2, nombre_cliente: 'BETA', numero_afiliacion: '0012345', tasa_pac_tdd_pct: 1, tasa_pac_tdc_pct: 2 }]);
  assert.ok(p.ok);
  assert.ok(p.filas[0].avisos.some(a => /ya pertenece al grupo 1.*no mueve ni borra/.test(a)));
});
