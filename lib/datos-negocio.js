/* ============================================================================
   lib/datos-negocio.js — "Datos del negocio" del Panel de POS: los números que se piden para presentar el negocio.
     · comercios activos (y cuántos nuevos suma por año, con el histórico) · volumen mensual y anual · canal (TPV / e-commerce)
     · tasa de contracargos · giros principales (MCC) · share por tipo de tarjeta (débito, crédito, internacional, AMEX).
   Todo sale de las transacciones APROBADAS por su FECHA DE LIQUIDACIÓN (la misma del resto del Panel, así que cuadra con "Monto transaccionado") y de la
   tabla de contracargos. Respeta los mismos filtros del Panel (fechas, grupo de cliente y afiliación). Las clasificaciones (producto, marca, canal) son
   funciones puras con pruebas; las consultas agregan en la base para no traer filas.
   ========================================================================= */
'use strict';
const E = require('../engine.js');
const MCC = require('./mcc.js');

const r2 = E.round2;
const pct = (n, d) => (d > 0 ? r2((n / d) * 100) : 0);

const PRODUCTOS = { tdd: 'Débito', tdc: 'Crédito', int: 'Internacional', amex: 'AMEX', otro: 'Sin clasificar' };

/* Tipo de tarjeta de una transacción (mismo criterio que el cálculo de liquidación). */
function productoDe(producto) { return E.prodKey(producto) || 'otro'; }

/* Marca de la tarjeta (campo "método" de la transacción): se unifican las escrituras más comunes; lo vacío es "Sin marca". */
function marcaDe(metodo) {
  const m = String(metodo == null ? '' : metodo).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!m) return 'Sin marca';
  if (/^VISA/.test(m)) return 'Visa';
  if (/^(MASTER ?CARD|MC$|MASTER)/.test(m)) return 'Mastercard';
  if (/^(AMEX|AMERICAN ?EXPRESS|AX$)/.test(m)) return 'American Express';
  if (/^CARNET/.test(m)) return 'Carnet';
  return m.charAt(0) + m.slice(1).toLowerCase();
}

/* Canal de venta. Se deduce del "modo de entrada" que trae la transacción (solo si el archivo lo trae):
   URL / e-commerce / link / API → E-commerce · MANUAL (capturada a mano, sin tarjeta presente) → aparte · cualquier otro (chip, contactless, banda…) → TPV. */
function canalDe(modo) {
  const m = String(modo == null ? '' : modo).trim().toUpperCase();
  if (!m) return 'Sin clasificar';
  if (/URL|ECOM|E-COM|WEB|LINK|API|ONLINE|INTERNET|REMOTO|REMOTE/.test(m)) return 'E-commerce';
  if (m === 'MANUAL' || /KEYED|CAPTURA|MOTO/.test(m)) return 'Manual (tarjeta no presente)';
  return 'TPV';
}

/* Suma filas {clave → monto, n} agrupándolas con `fn(clave)` y calcula el % de cada grupo. */
function agrupar(filas, fn, etiquetas) {
  const m = new Map();
  for (const f of filas) { const k = fn(f.clave); const e = m.get(k) || { clave: k, monto: 0, n: 0 }; e.monto += Number(f.monto) || 0; e.n += Number(f.n) || 0; m.set(k, e); }
  const totM = [...m.values()].reduce((s, e) => s + e.monto, 0), totN = [...m.values()].reduce((s, e) => s + e.n, 0);
  return [...m.values()].sort((a, b) => b.monto - a.monto).map(e => ({ clave: e.clave, etiqueta: (etiquetas && etiquetas[e.clave]) || e.clave, monto: r2(e.monto), n: e.n, pct_monto: pct(e.monto, totM), pct_trx: pct(e.n, totN) }));
}

/* Volumen por año calendario a partir de las filas mensuales; marca "parcial" el año que el periodo no cubre completo. */
function anuales(mensual, desde, hasta) {
  const por = new Map();
  for (const m of mensual) { const y = Number(String(m.mes).slice(0, 4)); const e = por.get(y) || { anio: y, monto: 0, n: 0 }; e.monto += m.monto; e.n += m.n; por.set(y, e); }
  return [...por.values()].sort((a, b) => a.anio - b.anio).map(e => ({
    anio: e.anio, monto: r2(e.monto), n: e.n,
    parcial: !(desde <= `${e.anio}-01-01` && hasta >= `${e.anio}-12-31`),
  }));
}

/* Giros: agrupa por MCC (los sin MCC van aparte), con su descripción y su % del volumen; el resto fuera del top se junta en "Otros". */
function girosMcc(filas, top = 10) {
  const totM = filas.reduce((s, f) => s + (Number(f.monto) || 0), 0);
  const por = new Map();
  for (const f of filas) {
    const k = f.mcc == null ? 'sin' : String(Number(f.mcc)).padStart(4, '0');
    const e = por.get(k) || { mcc: k === 'sin' ? null : k, giro: '', monto: 0, n: 0, comercios: 0 };
    e.monto += Number(f.monto) || 0; e.n += Number(f.n) || 0; e.comercios += Number(f.comercios) || 0;
    if (!e.giro) e.giro = String(f.giro || '').trim() || (f.mcc != null ? (MCC.descripcionDe(f.mcc) || '') : '');
    por.set(k, e);
  }
  const lista = [...por.values()].map(e => ({ ...e, monto: r2(e.monto), pct_monto: pct(e.monto, totM) })).sort((a, b) => b.monto - a.monto);
  const sin = lista.find(e => e.mcc == null) || null;
  const conMcc = lista.filter(e => e.mcc != null);
  const principales = conMcc.slice(0, top);
  const resto = conMcc.slice(top);
  const otros = resto.length ? { mcc: null, giro: `Otros (${resto.length} giros)`, monto: r2(resto.reduce((s, e) => s + e.monto, 0)), n: resto.reduce((s, e) => s + e.n, 0), comercios: resto.reduce((s, e) => s + e.comercios, 0), pct_monto: pct(resto.reduce((s, e) => s + e.monto, 0), totM) } : null;
  return { principales, otros, sin_mcc: sin ? { ...sin, giro: 'Sin MCC en el catálogo de afiliaciones' } : null, total_monto: r2(totM) };
}

/* Consulta todo en la base. `extra`/`vals` = filtro de grupo y afiliación sobre transacciones (lo arma el Panel); `extraCC`/`valsCC` = el mismo sobre
   contracargos (valsCC ya trae [desde, hasta] al inicio). */
async function consultar(db, { desde, hasta, extra = '', vals = [], extraCC = '', valsCC = null }) {
  const base = `with t as (select numero_afiliacion, producto, monto, modo_entrada, metodo,
      coalesce(nullif(lower(btrim(comercio)), ''), 'afil ' || numero_afiliacion) || '|' || numero_afiliacion as k, fecha_liq as f
      from transacciones where upper(estatus) = 'APROBADO' and fecha_liq is not null${extra}) `;
  const run = async (sel, fechas) => (await db.query(base + sel.replace(/\{(\d)\}/g, (_m, i) => '$' + (vals.length + Number(i))), [...vals, ...fechas])).rows;
  const R = [desde, hasta];

  const mensualR = await run(`select to_char(f, 'YYYY-MM') as mes, count(*)::int as n, coalesce(sum(monto), 0) as monto, count(distinct k)::int as comercios
     from t where f between {1}::date and {2}::date group by 1 order by 1`, R);
  const tot = (await run(`select count(*)::int as n, coalesce(sum(monto), 0) as monto, count(distinct k)::int as comercios from t where f between {1}::date and {2}::date`, R))[0];
  const u12 = (await run(`select count(*)::int as n, coalesce(sum(monto), 0) as monto, count(distinct k)::int as comercios from t where f between ({1}::date - 364) and {1}::date`, [hasta]))[0];
  const act30 = (await run(`select count(distinct k)::int as n from t where f between ({1}::date - 29) and {1}::date`, [hasta]))[0].n;
  const hist = (await run(`select count(distinct k)::int as n, min(f)::text as primero from t where f <= {1}::date`, [hasta]))[0];
  const nuevosR = await run(`select extract(year from m)::int as anio, count(*)::int as n from (select k, min(f) as m from t where f <= {1}::date group by k) x group by 1 order by 1`, [hasta]);
  const nuevos12 = (await run(`select count(*)::int as n from (select k, min(f) as m from t where f <= {1}::date group by k) x where m > ({1}::date - 365)`, [hasta]))[0].n;
  const prodR = await run(`select producto as clave, coalesce(sum(monto), 0) as monto, count(*)::int as n from t where f between {1}::date and {2}::date group by 1`, R);
  const marcaR = await run(`select coalesce(metodo, '') as clave, coalesce(sum(monto), 0) as monto, count(*)::int as n from t where f between {1}::date and {2}::date group by 1`, R);
  const canalR = await run(`select coalesce(nullif(upper(btrim(modo_entrada)), ''), '') as clave, coalesce(sum(monto), 0) as monto, count(*)::int as n from t where f between {1}::date and {2}::date group by 1`, R);
  const mccR = await run(`select a.mcc, max(a.descripcion_giro) as giro, coalesce(sum(t.monto), 0) as monto, count(*)::int as n, count(distinct t.k)::int as comercios
     from t left join afiliaciones a on a.numero_afiliacion = t.numero_afiliacion where t.f between {1}::date and {2}::date group by a.mcc`, R);

  // Contracargos (misma tabla que usa Cumplimiento), por la fecha del reporte en que se cargaron; los cancelados no cuentan.
  const ccR = (await db.query(`select to_char(cargado_en_fecha, 'YYYY-MM') as mes, count(*)::int as n, coalesce(sum(monto), 0) as monto
     from contracargos where cargado_en_fecha between $1 and $2 and estatus <> 'Cancelado'${extraCC} group by 1 order by 1`, valsCC || [desde, hasta])).rows;
  return { mensualR, tot, u12, act30, hist, nuevosR, nuevos12, prodR, marcaR, canalR, mccR, ccR };
}

/* Arma el resultado a partir de lo consultado. */
function ensamblar(r, { desde, hasta }) {
  const mensual = r.mensualR.map(m => ({ mes: m.mes, monto: r2(Number(m.monto)), n: m.n, comercios: m.comercios }));
  const monto = r2(Number(r.tot.monto)), n = r.tot.n;
  const productos = agrupar(r.prodR, productoDe, PRODUCTOS);
  const marcas = agrupar(r.marcaR, marcaDe);
  const canales = agrupar(r.canalR, canalDe);
  const detalleCanal = r.canalR.map(c => ({ modo: c.clave || '(vacío)', canal: canalDe(c.clave), monto: r2(Number(c.monto)), n: c.n })).sort((a, b) => b.monto - a.monto);
  const ccMonto = r2(r.ccR.reduce((s, c) => s + Number(c.monto), 0)), ccN = r.ccR.reduce((s, c) => s + c.n, 0);
  const montoPorMes = new Map(mensual.map(m => [m.mes, m]));
  const ccMensual = r.ccR.map(c => ({ mes: c.mes, n: c.n, monto: r2(Number(c.monto)), tasa_pct: pct(Number(c.monto), (montoPorMes.get(c.mes) || {}).monto || 0) }));
  const primero = r.hist.primero || null;
  // "Nuevos por año": el año en que arranca el histórico no son altas, es la base con la que empezó el sistema.
  const nuevos = r.nuevosR.map(x => ({ anio: x.anio, n: x.n, base_inicial: primero ? x.anio === Number(primero.slice(0, 4)) : false }));
  const historialSuficiente = primero ? primero <= isoMenosDias(hasta, 365) : false;
  return {
    periodo: { desde, hasta },
    comercios: {
      activos_30_dias: r.act30, activos_en_periodo: r.tot.comercios, historicos: r.hist.n, primer_dato: primero,
      nuevos_por_anio: nuevos,
      nuevos_ultimos_12_meses: historialSuficiente ? r.nuevos12 : null,
      ritmo_anual_estimado: historialSuficiente ? r.nuevos12 : null,
    },
    volumen: {
      monto, n_trx: n, ticket_promedio: n ? r2(monto / n) : 0,
      mensual, anual: anuales(mensual, desde, hasta),
      ultimos_12_meses: { desde: isoMenosDias(hasta, 364), hasta, monto: r2(Number(r.u12.monto)), n: r.u12.n, comercios: r.u12.comercios },
    },
    canales: { agrupado: canales, detalle: detalleCanal, sin_clasificar_pct: (canales.find(c => c.clave === 'Sin clasificar') || {}).pct_monto || 0 },
    contracargos: { n: ccN, monto: ccMonto, tasa_pct_monto: pct(ccMonto, monto), tasa_pct_trx: pct(ccN, n), mensual: ccMensual },
    giros: girosMcc(r.mccR.map(x => ({ mcc: x.mcc, giro: x.giro, monto: Number(x.monto), n: x.n, comercios: x.comercios }))),
    tarjetas: productos,
    marcas,
  };
}

function isoMenosDias(iso, d) { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); }

async function datosNegocio(db, p) { return ensamblar(await consultar(db, p), p); }

module.exports = { productoDe, marcaDe, canalDe, agrupar, anuales, girosMcc, ensamblar, consultar, datosNegocio, isoMenosDias, PRODUCTOS };
