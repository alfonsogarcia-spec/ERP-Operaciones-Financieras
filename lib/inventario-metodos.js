'use strict';
/* ============================================================================
   lib/inventario-metodos.js — Las metodologías del inventario administrativo de TPV. Puro: sin base de datos.

     · Control operativo ......... serialización unitaria 1 a 1 (S/N, IMEI y TID por equipo; historial de fallas) → lib/inventario-series.js y este archivo
     · Rotación y valuación ...... PEPS/FIFO: costo por capas (lib/inventario-peps.js) Y rotación física: salen primero los equipos más antiguos del almacén
                                   (la batería de litio se degrada sin uso); alerta por antigüedad y por vencimiento de la certificación PCI PTS
     · Auditoría física .......... conteo cíclico con clasificación ABC: la frecuencia depende de la clase (A más seguido)
     · Abastecimiento ............ punto de reorden (ROP) = demanda diaria × tiempo total de reposición + stock de seguridad
   ========================================================================= */
const P = require('./inventario-peps.js');

const DIA = 864e5;
const dias = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / DIA);        // días entre dos fechas ISO
const sumaDias = (f, n) => new Date(new Date(f + 'T00:00:00Z').getTime() + n * DIA).toISOString().slice(0, 10);
const r2 = P.r2;

/* Salidas que cuentan como CONSUMO (demanda real). Los ajustes y devoluciones a proveedor no son demanda. */
const CONCEPTOS_CONSUMO = ['entrega', 'consumo_interno', 'merma'];
const FRECUENCIA_CONTEO = { A: 30, B: 90, C: 180 };                          // días entre conteos de una clase
const Z_SERVICIO = 1.65;                                                      // nivel de servicio de 95 %
const VENTANA_DEMANDA = 90;                                                   // días de historia para la demanda

/* ---------------- ABC ---------------- */
/* items: [{id, valor}] con valor = consumo valuado de los últimos 12 meses (o el valor en existencia si no hay consumo).
   A = el 80 % acumulado del valor, B = hasta el 95 %, C = el resto. Valor 0 → C. */
function claseABC(items) {
  const total = items.reduce((s, x) => s + Math.max(0, x.valor), 0);
  const out = new Map();
  let acum = 0;
  for (const x of items.slice().sort((a, b) => b.valor - a.valor || a.id - b.id)) {
    const v = Math.max(0, x.valor);
    const antes = total > 0 ? acum / total : 1;
    acum += v;
    out.set(x.id, { clase: v <= 0 || total <= 0 ? 'C' : antes < 0.8 ? 'A' : antes < 0.95 ? 'B' : 'C', valor: r2(v), pct_acum: total > 0 ? r2(acum / total * 100) : 100 });
  }
  return out;
}

/* ---------------- demanda, stock de seguridad y punto de reorden ---------------- */
/* salidas: [{fecha, cantidad, concepto}] de UN artículo. */
function demanda(salidas, hoy, ventana = VENTANA_DEMANDA) {
  const desde = sumaDias(hoy, -(ventana - 1));
  const porDia = new Array(ventana).fill(0);
  let total = 0;
  for (const s of salidas) {
    if (!CONCEPTOS_CONSUMO.includes(s.concepto) || s.fecha < desde || s.fecha > hoy) continue;
    porDia[dias(desde, s.fecha)] += Number(s.cantidad); total += Number(s.cantidad);
  }
  const media = total / ventana;
  const varianza = porDia.reduce((a, x) => a + (x - media) ** 2, 0) / ventana;
  return { total: P.r4(total), diaria: P.r4(media), desviacion: P.r4(Math.sqrt(varianza)), ventana };
}

/* art: {tiempo_entrega_dias, tiempo_config_dias, minimo (= stock de seguridad manual), cobertura_dias}; dem: resultado de demanda(); existencia: unidades en almacén. */
function reorden(art, dem, existencia) {
  const lead = Math.max(0, Number(art.tiempo_entrega_dias) || 0) + Math.max(0, Number(art.tiempo_config_dias) || 0);   // proveedor + configuración/encriptación interna
  const manual = Number(art.minimo) || 0;
  const ss = manual > 0 ? manual : Math.ceil(Z_SERVICIO * dem.desviacion * Math.sqrt(lead));
  const rop = Math.ceil(dem.diaria * lead + ss);
  const cobertura = Math.max(1, Number(art.cobertura_dias) || 30);
  let estado = 'ok';
  if (dem.diaria <= 0 && manual <= 0) estado = 'sin_consumo';
  else if (existencia <= ss) estado = 'urgente';
  else if (existencia <= rop) estado = 'reordenar';
  const objetivo = rop + Math.ceil(dem.diaria * cobertura);
  return { lead_dias: lead, stock_seguridad: ss, ss_manual: manual > 0, punto_reorden: rop, demanda_diaria: dem.diaria, cobertura_dias_objetivo: cobertura,
    dias_cobertura: dem.diaria > 0 ? P.r4(existencia / dem.diaria) : null, estado, sugerido: estado === 'reordenar' || estado === 'urgente' ? Math.max(0, objetivo - existencia) : 0 };
}

/* ---------------- certificación PCI PTS ---------------- */
function estadoPCI(vence, hoy, avisoDias = 90) {
  if (!vence) return null;
  const d = dias(hoy, vence);
  return d < 0 ? { estado: 'vencida', dias: d } : d <= avisoDias ? { estado: 'por_vencer', dias: d } : { estado: 'vigente', dias: d };
}

/* ---------------- antigüedad en almacén (rotación física) ---------------- */
const TRAMOS_EDAD = [[0, 90, '0–90 días'], [91, 180, '91–180 días'], [181, 365, '181–365 días'], [366, Infinity, 'más de 1 año']];
function antiguedad(unidadesAlmacen, hoy) {
  const out = unidadesAlmacen.map(u => ({ ...u, dias_almacen: Math.max(0, dias(u.desde, hoy)) }));
  const tramos = TRAMOS_EDAD.map(([a, b, et]) => ({ etiqueta: et, n: out.filter(u => u.dias_almacen >= a && u.dias_almacen <= b).length }));
  return { unidades: out, tramos };
}

/* ---------------- PEPS físico: ¿se están mandando primero los equipos más viejos? ---------------- */
/* disponibles: unidades en almacén [{serie, desde}]; elegidas: series que se quieren sacar. Devuelve las infracciones: un equipo más nuevo sale mientras un equipo más viejo sigue en almacén. */
function verificarFIFO(disponibles, elegidas) {
  const sel = new Set(elegidas);
  const quedan = disponibles.filter(u => !sel.has(u.serie));
  const infracciones = [];
  for (const u of disponibles.filter(x => sel.has(x.serie))) {
    const masViejas = quedan.filter(v => v.desde < u.desde);
    if (masViejas.length) infracciones.push({ serie: u.serie, desde: u.desde, mas_viejas: masViejas.sort((a, b) => (a.desde < b.desde ? -1 : 1)).slice(0, 3).map(v => ({ serie: v.serie, desde: v.desde })) });
  }
  return { ok: infracciones.length === 0, infracciones };
}
/* Las N unidades que corresponde sacar según PEPS (más antiguas primero; empate por serie). */
const sugeridasFIFO = (disponibles, n) => disponibles.slice().sort((a, b) => (a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : a.serie.localeCompare(b.serie))).slice(0, n).map(u => u.serie);

/* ---------------- conteo cíclico ---------------- */
/* arts: [{id, clase, ultimo_conteo (fecha ISO o null)}]. Propone los que ya toca contar: primero la clase A, luego los más atrasados. */
function propuestaConteo(arts, hoy, limite = 10) {
  const orden = { A: 0, B: 1, C: 2 };
  return arts.map(a => { const frec = FRECUENCIA_CONTEO[a.clase] || 180; const desde = a.ultimo_conteo ? dias(a.ultimo_conteo, hoy) : 9999; return { ...a, frecuencia_dias: frec, dias_sin_contar: a.ultimo_conteo ? desde : null, atraso: desde - frec, toca: desde >= frec }; })
    .filter(a => a.toca).sort((x, y) => orden[x.clase] - orden[y.clase] || y.atraso - x.atraso || x.id - y.id).slice(0, limite);
}

/* Compara lo contado con lo esperado.
   No serializado: esperado/contado son números. Serializado: esperadas = series en almacén según el sistema; contadas = series halladas físicamente; `conocidas` = mapa serie → estado en el sistema. */
function compararConteo({ serializado, esperado, contado, esperadas, contadas, conocidas }) {
  if (!serializado) return { diferencia: P.r4(Number(contado) - Number(esperado)), esperado: P.r4(esperado), contado: P.r4(contado) };
  const E = new Set(esperadas), C = new Set(contadas);
  const faltantes = [...E].filter(s => !C.has(s)).sort();
  const sobrantes = [...C].filter(s => !E.has(s)).sort();
  return { esperado: E.size, contado: C.size, diferencia: C.size - E.size, faltantes,
    sobrantes_conocidas: sobrantes.filter(s => conocidas && conocidas.get(s)).map(s => ({ serie: s, estado: conocidas.get(s) })),            // aparecen en almacén pero el sistema las tiene asignadas o de baja
    sobrantes_desconocidas: sobrantes.filter(s => !(conocidas && conocidas.get(s))) };                                                       // el sistema no las conoce: hay que darlas de alta
}

module.exports = { claseABC, demanda, reorden, estadoPCI, antiguedad, verificarFIFO, sugeridasFIFO, propuestaConteo, compararConteo, dias, sumaDias, CONCEPTOS_CONSUMO, FRECUENCIA_CONTEO, VENTANA_DEMANDA, TRAMOS_EDAD };
