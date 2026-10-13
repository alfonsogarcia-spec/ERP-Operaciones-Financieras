/* Pruebas de la asignación de cargos (retenciones) a las filas del corte.
   Ejecuta: node test/ledger.test.js  → sale con código ≠0 si algo falla.
   Cubre el bug del corte 91: una afiliación compartida por varios grupos
   retenía el MISMO cargo en todas sus filas. */
'use strict';
const L = require('../lib/ledger.js');

const nrm = s => String(s == null ? '' : s).trim().toLowerCase();
const grupos = [
  { id_grupo: 8, nombre_cliente: 'IPRO' },
  { id_grupo: 3, nombre_cliente: 'DEAL' },
  { id_grupo: 16, nombre_cliente: 'GRUPO DG' },
];
const grupoPorNombre = n => grupos.find(g => nrm(g.nombre_cliente) === nrm(n));
const out = []; const chk = (desc, got, esp) => out.push({ desc, got: JSON.stringify(got), esperado: JSON.stringify(esp), pass: JSON.stringify(got) === JSON.stringify(esp) });
const r2 = n => Math.round(n * 100) / 100;

// Simula el ciclo de computeCorte para una afiliación: devuelve retención por fila.
function corte(filas, cargosPorBloque, bolsas) {
  const consumido = new Map(); const n = filas.length; const res = {};
  filas.forEach((f, i) => {
    const sel = L.seleccionarCargosParaFila(cargosPorBloque.DOM, { idGrupo: f.idGrupo, cliente: f.cliente }, n, grupoPorNombre, nrm);
    res[f.cliente] = L.aplicarCargosFifo(sel.aplicables, bolsas[i], consumido).tot;
  });
  return { res, consumido };
}

// 1) EL CASO DEL CORTE 91: un cargo de GRUPO DG, afiliación compartida con IPRO y DEAL.
const cargoDG = { id: 21, tipo: 'financiamiento', grupo_cliente: 'GRUPO DG', monto_pendiente: 3981.64 };
const filas3 = [{ cliente: 'IPRO', idGrupo: 8 }, { cliente: 'DEAL', idGrupo: 3 }, { cliente: 'GRUPO DG', idGrupo: 16 }];
let r = corte(filas3, { DOM: [cargoDG] }, [60000, 23000, 4600]);
chk('Afiliación compartida: solo retiene a GRUPO DG', r.res, { 'IPRO': 0, 'DEAL': 0, 'GRUPO DG': 3981.64 });
chk('El cargo se consume una sola vez', r2(r.consumido.get(21)), 3981.64);

// 2) El orden de las filas no cambia el resultado (antes caía en la primera fila que apareciera).
r = corte([...filas3].reverse(), { DOM: [cargoDG] }, [4600, 23000, 60000]);
chk('Mismo resultado con otro orden de filas', r.res, { 'GRUPO DG': 3981.64, 'DEAL': 0, 'IPRO': 0 });

// 3) Una sola fila para la afiliación: el número manda, aunque el nombre del grupo esté mal escrito.
r = corte([{ cliente: 'IPRO', idGrupo: 8 }], { DOM: [{ id: 5, tipo: 'contracargo', grupo_cliente: 'Grupo escrito mal', monto_pendiente: 1000 }] }, [5000]);
chk('Fila única: aplica aunque el grupo del cargo no coincida', r.res, { 'IPRO': 1000 });

// 4) Afiliación compartida y cargo SIN grupo identificable: no se retiene a nadie.
r = corte(filas3, { DOM: [{ id: 6, tipo: 'contracargo', grupo_cliente: 'Grupo escrito mal', monto_pendiente: 800 }] }, [60000, 23000, 4600]);
chk('Compartida + grupo no identificado: no retiene a nadie', r.res, { 'IPRO': 0, 'DEAL': 0, 'GRUPO DG': 0 });
r = corte(filas3, { DOM: [{ id: 7, tipo: 'contracargo', grupo_cliente: null, monto_pendiente: 800 }] }, [60000, 23000, 4600]);
chk('Compartida + cargo sin grupo: no retiene a nadie', r.res, { 'IPRO': 0, 'DEAL': 0, 'GRUPO DG': 0 });

// 5) Coincidencia sin importar mayúsculas/espacios.
r = corte(filas3, { DOM: [{ id: 8, tipo: 'contracargo', grupo_cliente: '  grupo dg ', monto_pendiente: 500 }] }, [60000, 23000, 4600]);
chk('Coincide el grupo sin importar mayúsculas ni espacios', r.res, { 'IPRO': 0, 'DEAL': 0, 'GRUPO DG': 500 });

// 6) FIFO con bolsa insuficiente: aplica lo que cabe y deja el resto.
const c1 = { id: 1, tipo: 'financiamiento', monto_pendiente: 11124.24 };
const cons = new Map(); const x = L.aplicarCargosFifo([c1], 9651.56, cons);
chk('Bolsa menor al cargo: aplica solo lo que cabe (parcial)', x.tot, 9651.56);
chk('…y queda el saldo para el siguiente corte', r2(c1.monto_pendiente - cons.get(1)), 1472.68);

// 7) Dos cargos del mismo grupo: FIFO, y el segundo no se pasa del saldo.
const cons2 = new Map(); const c = [{ id: 1, tipo: 'contracargo', monto_pendiente: 700 }, { id: 2, tipo: 'financiamiento', monto_pendiente: 600 }];
const y = L.aplicarCargosFifo(c, 1000, cons2);
chk('FIFO entre dos cargos hasta agotar la bolsa', y.usados.map(u => [u.cargo_id, u.monto_aplicado]), [[1, 700], [2, 300]]);
chk('Separa contracargo y financiamiento', [y.totContracargo, y.totFin], [700, 300]);

// 8) El mismo cargo en dos bolsas/filas nunca supera su saldo (consumo compartido).
const cons3 = new Map(); const cc = [{ id: 9, tipo: 'contracargo', monto_pendiente: 1000 }];
const a1 = L.aplicarCargosFifo(cc, 600, cons3), a2 = L.aplicarCargosFifo(cc, 600, cons3);
chk('Segunda aplicación del mismo cargo solo toma el saldo', [a1.tot, a2.tot], [600, 400]);

// 9) EL CASO DEL CORTE 92: retención (financiamiento DOM) por todo el "A compensar" de la fila.
//    Bolsa DOM $9,651.56 + bolsa AMEX $1,472.68 = $11,124.24. Antes quedaba parcial ($9,651.56).
const fin = id => ({ id, tipo: 'financiamiento', monto_pendiente: 11124.24 });
let z = L.aplicarCargosEnFila([fin(20)], [], 9651.56, 1472.68, new Map());
chk('Financiamiento DOM se completa con la bolsa AMEX', [z.resDom.tot, z.resAmex.tot], [9651.56, 1472.68]);
chk('…retiene el total subido', r2(z.resDom.tot + z.resAmex.tot), 11124.24);
chk('…y se registra UNA sola aplicación por el total, con su bloque', z.aplicaciones, [{ cargo_id: 20, monto_aplicado: 11124.24, bloque: 'DOM' }]);

// 10) Un contracargo DOM NO desborda a la bolsa AMEX (es de su marca).
z = L.aplicarCargosEnFila([{ id: 21, tipo: 'contracargo', monto_pendiente: 11124.24 }], [], 9651.56, 1472.68, new Map());
chk('Contracargo DOM solo toma de la bolsa DOM', [z.resDom.tot, z.resAmex.tot], [9651.56, 0]);
// …ni un ajuste manual.
z = L.aplicarCargosEnFila([{ id: 22, tipo: 'ajuste_manual', monto_pendiente: 5000 }], [], 1000, 4000, new Map());
chk('Ajuste manual no desborda', [z.resDom.tot, z.resAmex.tot], [1000, 0]);

// 11) Financiamiento AMEX que no cabe en AMEX toma de DOM.
z = L.aplicarCargosEnFila([], [{ id: 23, tipo: 'revenue_share', monto_pendiente: 3000 }], 5000, 1000, new Map());
chk('Revenue share AMEX se completa con la bolsa DOM', [z.resDom.tot, z.resAmex.tot], [2000, 1000]);
chk('…una aplicación, bloque AMEX', z.aplicaciones, [{ cargo_id: 23, monto_aplicado: 3000, bloque: 'AMEX' }]);

// 12) El desborde no excede el saldo ni las bolsas; si no alcanza queda parcial.
z = L.aplicarCargosEnFila([fin(24)], [], 3000, 2000, new Map());
chk('Si entre las dos bolsas no alcanza, aplica lo que hay (parcial)', r2(z.resDom.tot + z.resAmex.tot), 5000);
// 13) Una bolsa vacía no genera aplicaciones de cero.
z = L.aplicarCargosEnFila([fin(25)], [], 0, 0, new Map());
chk('Sin bolsa no aplica nada', [z.resDom.tot, z.resAmex.tot, z.aplicaciones.length], [0, 0, 0]);
// 14) Dos financiamientos: FIFO y el desborde respeta el orden.
z = L.aplicarCargosEnFila([{ id: 30, tipo: 'financiamiento', monto_pendiente: 800 }, { id: 31, tipo: 'financiamiento', monto_pendiente: 800 }], [], 1000, 500, new Map());
chk('FIFO con desborde: el 1º completo, el 2º con lo que queda', z.aplicaciones.map(a => [a.cargo_id, a.monto_aplicado]), [[30, 800], [31, 700]]);
chk('…las dos bolsas quedan exactamente agotadas', [z.resDom.tot, z.resAmex.tot], [1000, 500]);

let pass = 0;
for (const t of out) { console.log((t.pass ? 'PASS  ' : 'FAIL  ') + t.desc + (t.pass ? '' : `  → obtenido ${t.got}, esperado ${t.esperado}`)); if (t.pass) pass++; }
console.log(`\n${pass}/${out.length} pruebas correctas`);
process.exit(pass === out.length ? 0 : 1);
