'use strict';
/* ============================================================================
   lib/inventario-peps.js — Inventario ADMINISTRATIVO con método PEPS (primeras entradas, primeras salidas). Puro: sin base de datos.

   La verdad son los MOVIMIENTOS (entradas y salidas capturadas a mano). El costo de cada salida, el saldo y la valuación NO se guardan: se
   calculan reproduciendo los movimientos en orden (fecha, entradas antes que salidas el mismo día, luego folio). Así, una entrada con fecha
   anterior o la anulación de un movimiento recalculan todo de forma coherente, sin capas «cacheadas» que se puedan desfasar.

   Cada entrada abre una CAPA (cantidad y costo unitario). Cada salida consume las capas más antiguas primero; su costo es la suma de lo
   consumido de cada capa a su propio costo unitario.
   ========================================================================= */

const EPS = 1e-9;
const r4 = n => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const CONCEPTOS_ENTRADA = { compra: 'Compra', inventario_inicial: 'Inventario inicial', devolucion_cliente: 'Devolución de cliente', ajuste_positivo: 'Ajuste (aumenta)' };
const CONCEPTOS_SALIDA = { entrega: 'Entrega a cliente o área', consumo_interno: 'Consumo interno', merma: 'Merma o baja', devolucion_proveedor: 'Devolución a proveedor', ajuste_negativo: 'Ajuste (disminuye)' };
const TOPE = 1e9;
const esFecha = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s && s >= '2000-01-01' && s <= '2100-12-31';
const hoyMX = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

/* Orden de reproducción: fecha; el mismo día, entradas antes que salidas; luego folio. */
function ordenar(movs) {
  return movs.slice().sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0)
    || ((a.tipo === 'entrada' ? 0 : 1) - (b.tipo === 'entrada' ? 0 : 1)) || (Number(a.id) - Number(b.id)));
}

/* Reproduce los movimientos (ya sin anulados) de UN artículo. Devuelve:
   { filas:[{...mov, costo_total, costo_unitario_prom, consumos:[{capa, cantidad, costo_unitario}], saldo_cantidad, saldo_valor}], capas:[...restantes], existencia, valor, error? }
   Si una salida pide más de lo que hay, `error` trae el primer problema (con folio, fecha y faltante) y el cálculo se detiene ahí. */
function kardex(movs) {
  const capas = [];
  const filas = [];
  let existencia = 0, valor = 0, error = null;
  for (const m of ordenar(movs)) {
    const cant = r4(m.cantidad);
    if (m.tipo === 'entrada') {
      const cu = r4(m.costo_unitario || 0);
      capas.push({ id: Number(m.id), fecha: m.fecha, original: cant, restante: cant, costo_unitario: cu });
      existencia = r4(existencia + cant); valor = r2(valor + cant * cu);
      filas.push({ ...m, cantidad: cant, costo_unitario: cu, costo_total: r2(cant * cu), consumos: [], saldo_cantidad: existencia, saldo_valor: valor });
    } else {
      let falta = cant, costo = 0;
      const consumos = [];
      while (falta > EPS && capas.length) {
        const c = capas[0];
        const toma = Math.min(falta, c.restante);
        consumos.push({ capa: c.id, fecha_capa: c.fecha, cantidad: r4(toma), costo_unitario: c.costo_unitario });
        costo += toma * c.costo_unitario;
        c.restante = r4(c.restante - toma); falta = r4(falta - toma);
        if (c.restante <= EPS) capas.shift();
      }
      if (falta > EPS) { error = { folio: Number(m.id), fecha: m.fecha, faltante: r4(falta), disponible: r4(cant - falta) }; break; }
      const total = r2(costo);
      existencia = r4(existencia - cant); valor = r2(valor - total);
      if (existencia <= EPS) { existencia = 0; valor = 0; }
      filas.push({ ...m, cantidad: cant, costo_total: total, costo_unitario: cant > 0 ? r4(costo / cant) : 0, consumos, saldo_cantidad: existencia, saldo_valor: valor });
    }
  }
  return { filas, capas, existencia, valor, error };
}

/* ¿Qué costaría la siguiente salida de `cantidad`? (para avisar antes de registrar) */
function costoDeSalida(capasRestantes, cantidad) {
  let falta = r4(cantidad), costo = 0;
  for (const c of capasRestantes) { if (falta <= EPS) break; const t = Math.min(falta, c.restante); costo += t * c.costo_unitario; falta = r4(falta - t); }
  return falta > EPS ? null : r2(costo);
}

function validarMovimiento(m) {
  const errs = [];
  if (!['entrada', 'salida'].includes(m.tipo)) errs.push('El tipo debe ser entrada o salida.');
  const catalogo = m.tipo === 'entrada' ? CONCEPTOS_ENTRADA : CONCEPTOS_SALIDA;
  if (!Object.prototype.hasOwnProperty.call(catalogo, m.concepto)) errs.push('El concepto no es válido para ' + (m.tipo === 'entrada' ? 'una entrada' : 'una salida') + '.');
  if (!esFecha(m.fecha)) errs.push('La fecha no es válida.');
  else if (m.fecha > hoyMX()) errs.push('La fecha no puede ser futura.');
  const cant = Number(m.cantidad);
  if (!Number.isFinite(cant) || cant <= 0 || cant > TOPE) errs.push('La cantidad debe ser mayor a cero.');
  else if (Math.abs(cant * 1e4 - Math.round(cant * 1e4)) > 1e-6) errs.push('La cantidad admite hasta 4 decimales.');
  if (m.tipo === 'entrada') {
    const cu = Number(m.costo_unitario);
    if (m.costo_unitario === undefined || m.costo_unitario === null || m.costo_unitario === '' || !Number.isFinite(cu) || cu < 0 || cu > TOPE) errs.push('El costo unitario es obligatorio y no puede ser negativo.');
    else if (Math.abs(cu * 1e4 - Math.round(cu * 1e4)) > 1e-6) errs.push('El costo unitario admite hasta 4 decimales.');
    if (m.concepto === 'compra' && !String(m.documento || '').trim()) errs.push('Una compra lleva su documento (factura, remisión u orden de compra).');
  } else if (m.concepto === 'entrega' && (!String(m.empresa || '').trim() || !String(m.unidad || '').trim())) errs.push('Una entrega lleva la Empresa y la Unidad del cliente a la que se asigna.');
  if (['merma', 'ajuste_negativo', 'ajuste_positivo', 'devolucion_proveedor'].includes(m.concepto) && String(m.notas || '').trim().length < 5) errs.push('Este concepto lleva una nota que explique el motivo.');
  for (const [k, max] of [['proveedor', 120], ['documento', 80], ['destino', 120], ['empresa', 140], ['unidad', 140], ['afiliacion', 30], ['notas', 400]]) if (m[k] != null && String(m[k]).length > max) errs.push(`«${k}» es demasiado largo (máximo ${max}).`);
  return errs;
}

/* Agrega un movimiento (con folio provisional) y valida que NINGUNA salida —nueva ni ya registrada— quede sin existencia. */
function simularAlta(movs, nuevo) {
  const k = kardex([...movs, { ...nuevo, id: nuevo.id || Number.MAX_SAFE_INTEGER }]);
  return k;
}
/* Anular un movimiento: el resto debe seguir siendo coherente (no puede dejar salidas sin existencia). */
function simularAnulacion(movs, id) {
  return kardex(movs.filter(m => Number(m.id) !== Number(id)));
}

module.exports = { kardex, costoDeSalida, validarMovimiento, simularAlta, simularAnulacion, ordenar, CONCEPTOS_ENTRADA, CONCEPTOS_SALIDA, r2, r4, hoyMX, esFecha };
