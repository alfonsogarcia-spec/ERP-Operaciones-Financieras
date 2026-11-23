/* lib/mesa/amortiza.js — Mesa de control: tabla de amortización, CAT y estado de un crédito con sus pagos (moratorios, atraso, saldos).
   Lógica pura (sin BD ni HTTP): el estado de un crédito se recalcula SIEMPRE desde su tabla y su lista de pagos, nunca se guarda un saldo que pueda
   desfasarse. Convenciones:
     · amortización francesa (cuota fija de capital + interés sobre saldo insoluto, tasa nominal anual / periodos por año);
     · IVA (por omisión 16%) sobre el interés y sobre los moratorios, aparte de la cuota;
     · moratorios = tasa moratoria anual / 360 × capital vencido × días de atraso (desde el día siguiente al vencimiento);
     · cada pago se aplica en orden: moratorios (con su IVA) → por cada pago periódico, del más viejo al más nuevo: interés, IVA y capital;
       lo que sobra después de lo vencido adelanta los pagos siguientes (la tabla no se recalcula);
     · CAT sin IVA, a partir de la TIR de los flujos reales (base 365 días). */
'use strict';

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const PPY = { mensual: 12, quincenal: 24, semanal: 52 };
const MS = 864e5;
const parse = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const iso = t => new Date(t).toISOString().slice(0, 10);
const dias = (a, b) => Math.round((parse(b) - parse(a)) / MS);
const finMes = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/* Fecha del pago k (1..n) contando desde la base: mensual = mismo día de cada mes (se ajusta al fin de mes); quincenal = cada 15 días; semanal = cada 7. */
function fechaPago(base, per, k) {
  const t = parse(base);
  if (per === 'quincenal') return iso(t + 15 * k * MS);
  if (per === 'semanal') return iso(t + 7 * k * MS);
  const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth() + k, dia = d.getUTCDate();
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return iso(Date.UTC(yy, mm, Math.min(dia, finMes(yy, mm))));
}

/* Tabla de amortización. p = { monto, tasaAnual, plazoMeses, periodicidad, fechaDesembolso, ivaPct }. */
function tabla(p) {
  const ppy = PPY[p.periodicidad] || 12, n = Math.max(1, Math.round(p.plazoMeses * ppy / 12)), r = (p.tasaAnual || 0) / ppy, iva = p.ivaPct == null ? 0.16 : p.ivaPct;
  const cuota = r === 0 ? p.monto / n : p.monto * r / (1 - Math.pow(1 + r, -n));
  let saldo = p.monto; const filas = [];
  for (let k = 1; k <= n; k++) {
    const interes = r2(saldo * r);
    let capital = k === n ? r2(saldo) : r2(cuota - interes);
    if (capital > saldo) capital = r2(saldo);
    const ivaI = r2(interes * iva);
    saldo = r2(saldo - capital);
    filas.push({ num: k, fecha: fechaPago(p.fechaDesembolso, p.periodicidad, k), capital, interes, iva: ivaI, total: r2(capital + interes + ivaI), saldo });
  }
  return filas;
}

/* CAT (costo anual total) sin IVA: tasa efectiva anual que iguala lo recibido (monto − comisión de apertura) con los pagos de capital e interés. */
function cat(monto, comision, filas, fechaDesembolso) {
  const flujos = [{ d: 0, v: monto - (comision || 0) }, ...filas.map(f => ({ d: dias(fechaDesembolso, f.fecha), v: -(f.capital + f.interes) }))];
  const vp = d => flujos.reduce((s, f) => s + f.v / Math.pow(1 + d, f.d), 0);
  let lo = 0, hi = 0.01;                                         // tasa diaria
  if (vp(0) > 0) return 0;                                        // paga menos de lo que recibió: sin costo
  for (let i = 0; i < 80 && vp(hi) < 0; i++) hi *= 2; if (vp(hi) < 0) return null;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (vp(m) > 0) hi = m; else lo = m; }
  return Math.round((Math.pow(1 + (lo + hi) / 2, 365) - 1) * 10000) / 10000;
}

/* Estado de un crédito a una fecha.
   c = { filas (tabla), tasaMor (anual, fracción), ivaPct, fechaDesembolso }, pagos = [{id, fecha, monto}] (los cancelados no van), fechaCorte. */
function estado(c, pagos, fechaCorte) {
  const iva = c.ivaPct == null ? 0.16 : c.ivaPct, tm = c.tasaMor || 0;
  const f = c.filas.map(x => ({ ...x, pCap: x.capital, pInt: x.interes, pIva: x.iva }));          // pendientes por renglón
  let mor = 0, ult = c.fechaDesembolso; const aplic = [];
  const devenga = hasta => {
    for (const x of f) { if (x.pCap > 0.004 && x.fecha < hasta) { const desde = x.fecha > ult ? x.fecha : ult; const d = Math.max(0, dias(desde, hasta)); mor += x.pCap * tm / 360 * d; } }
    ult = hasta;
  };
  const orden = [...pagos].filter(p => p.fecha <= fechaCorte).sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : (a.id > b.id ? 1 : -1));
  let pagado = 0;
  for (const p of orden) {
    devenga(p.fecha); let resto = r2(p.monto); const ap = { id: p.id, fecha: p.fecha, monto: r2(p.monto), mor: 0, interes: 0, iva: 0, capital: 0, adelanto: 0 };
    const morTot = r2(mor * (1 + iva)), pmor = Math.min(resto, morTot); if (pmor > 0) { ap.mor = r2(pmor / (1 + iva)); ap.iva += r2(pmor - ap.mor); mor = Math.max(0, (morTot - pmor) / (1 + iva)); resto = r2(resto - pmor); }
    for (const x of f) {
      if (resto <= 0.004) break;
      const adel = x.fecha > p.fecha;
      for (const [k, campo] of [['pInt', 'interes'], ['pIva', 'iva'], ['pCap', 'capital']]) { const t = Math.min(resto, x[k]); if (t > 0) { x[k] = r2(x[k] - t); ap[campo] = r2(ap[campo] + t); if (adel) ap.adelanto = r2(ap.adelanto + t); resto = r2(resto - t); } }
    }
    ap.exceso = r2(resto); pagado = r2(pagado + p.monto); aplic.push(ap);
  }
  devenga(fechaCorte);
  const morPend = r2(mor), morIva = r2(mor * iva);
  const vencidos = f.filter(x => x.fecha <= fechaCorte && (x.pCap + x.pInt + x.pIva) > 0.004);
  const venc = vencidos.reduce((s, x) => ({ capital: s.capital + x.pCap, interes: s.interes + x.pInt, iva: s.iva + x.pIva }), { capital: 0, interes: 0, iva: 0 });
  const vencidoCuota = r2(venc.capital + venc.interes + venc.iva);
  const atrasados = vencidos.filter(x => x.fecha < fechaCorte);
  const diasAtraso = atrasados.length ? dias(atrasados[0].fecha, fechaCorte) : 0;
  const saldoCapital = r2(f.reduce((s, x) => s + x.pCap, 0)), interesPend = r2(f.reduce((s, x) => s + x.pInt, 0)), ivaPend = r2(f.reduce((s, x) => s + x.pIva, 0));
  const proximo = f.find(x => x.fecha > fechaCorte && (x.pCap + x.pInt + x.pIva) > 0.004) || null;
  const vencidoTotal = r2(vencidoCuota + morPend + morIva);
  // saldo para liquidar hoy: capital + moratorios + intereses y IVA de lo ya vencido (lo futuro no devengado no se cobra)
  const liquidar = r2(saldoCapital + venc.interes + venc.iva + morPend + morIva);
  const liquidado = saldoCapital <= 0.004 && venc.interes + venc.iva + morPend <= 0.004 && !f.some(x => x.fecha <= fechaCorte && x.pCap + x.pInt + x.pIva > 0.004);
  return {
    filas: f.map(x => ({ num: x.num, fecha: x.fecha, capital: x.capital, interes: x.interes, iva: x.iva, total: x.total, pCap: r2(x.pCap), pInt: r2(x.pInt), pIva: r2(x.pIva), pagada: (x.pCap + x.pInt + x.pIva) <= 0.004, vencida: x.fecha < fechaCorte && (x.pCap + x.pInt + x.pIva) > 0.004 })),
    saldoCapital, interesPend, ivaPend, moratorios: morPend, ivaMoratorios: morIva, vencido: { capital: r2(venc.capital), interes: r2(venc.interes), iva: r2(venc.iva), cuotas: vencidoCuota, total: vencidoTotal },
    diasAtraso, cuotasVencidas: atrasados.length, proximo: proximo ? { num: proximo.num, fecha: proximo.fecha, monto: r2(proximo.pCap + proximo.pInt + proximo.pIva) } : null,
    liquidar, liquidado, pagado, aplicaciones: aplic, bucket: bucket(diasAtraso),
  };
}

const BUCKETS = ['al_corriente', '1-30', '31-60', '61-90', '91+'];
const bucket = d => d <= 0 ? 'al_corriente' : d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '91+';
/* Estimación preventiva sobre el saldo de capital según el atraso (porcentajes configurables). */
const ESTIMACION_DEFAULT = { al_corriente: 0.01, '1-30': 0.05, '31-60': 0.15, '61-90': 0.4, '91+': 1 };
const estimacion = (saldoCapital, diasAtraso, tabla_) => r2(saldoCapital * ((tabla_ || ESTIMACION_DEFAULT)[bucket(diasAtraso)] || 0));

module.exports = { r2, PPY, dias, fechaPago, tabla, cat, estado, bucket, BUCKETS, estimacion, ESTIMACION_DEFAULT, parse, iso };
