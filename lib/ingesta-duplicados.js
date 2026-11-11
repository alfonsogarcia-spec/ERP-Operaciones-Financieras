/* ============================================================================
   lib/ingesta-duplicados.js — Regla del candado de la ingesta de transacciones (POS). Funciones puras (sin base de datos).

   Una transacción se repite SOLO si coinciden referencia Y autorización (sin importar mayúsculas ni espacios de más); sin referencia no se compara.
   Esa pareja repetida es válida en UN solo caso: la DEVOLUCIÓN. Una devolución repite la referencia y la autorización de la venta que devuelve y su
   monto viene en NEGATIVO. Todo lo demás es una transacción duplicada y bloquea el archivo:
     · dentro del archivo: una pareja puede traer a lo más UNA fila que no sea devolución (la venta); las demás deben ser devoluciones (monto < 0);
     · contra lo ya cargado: si la pareja ya existe como venta (monto ≥ 0), una fila nueva con esa pareja debe ser una devolución.
   Un monto en cero NO es devolución. (Varias devoluciones de una misma venta, p. ej. parciales, sí se permiten.)
   ========================================================================= */
'use strict';

const SEP = '\u0001';
const norm = r => String(r == null ? '' : r).trim().toUpperCase();
const esDevolucion = monto => Number(monto) < 0;

/* Agrupa las filas por pareja referencia+autorización (solo las que traen referencia).
   → Map  "REF␁AUT" → { ref, aut, filas: [índices], ventas: [índices que NO son devolución], devoluciones: [índices con monto < 0] } */
function agrupar(filas) {
  const vistas = new Map();
  filas.forEach((f, i) => {
    const r = norm(f.referencia); if (!r) return;
    const a = norm(f.autorizacion), k = r + SEP + a;
    if (!vistas.has(k)) vistas.set(k, { ref: r, aut: a, filas: [], ventas: [], devoluciones: [] });
    const g = vistas.get(k);
    g.filas.push(i);
    (esDevolucion(f.monto) ? g.devoluciones : g.ventas).push(i);
  });
  return vistas;
}

/* Parejas repetidas dentro del archivo que NO son una venta + devoluciones: hay más de una fila que no es devolución. */
function repetidasEnArchivo(vistas) {
  return [...vistas.values()].filter(g => g.ventas.length > 1);
}

/* Parejas del archivo con una venta (monto ≥ 0) que YA existen como venta en el sistema.
   cargadas = [{ ref, aut, ventas, devoluciones, veces, archivo, cargado }] (lo que hay en la base para esas parejas). */
function repetidasContraCargadas(vistas, cargadas) {
  return (cargadas || []).filter(c => Number(c.ventas) > 0 && (vistas.get(norm(c.ref) + SEP + norm(c.aut)) || { ventas: [] }).ventas.length > 0);
}

/* Cuántas devoluciones del archivo quedan ligadas a una venta (del mismo archivo o ya cargada): informativo. */
function devolucionesLigadas(vistas, cargadas) {
  const enBase = new Set((cargadas || []).filter(c => Number(c.ventas) > 0).map(c => norm(c.ref) + SEP + norm(c.aut)));
  let n = 0;
  for (const [k, g] of vistas) if (g.devoluciones.length && (g.ventas.length > 0 || enBase.has(k))) n += g.devoluciones.length;
  return n;
}

const TEXTO_REGLA = 'La misma referencia y autorización solo puede repetirse en una devolución (con el monto en negativo).';

module.exports = { SEP, norm, esDevolucion, agrupar, repetidasEnArchivo, repetidasContraCargadas, devolucionesLigadas, TEXTO_REGLA };
