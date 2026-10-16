/* ============================================================================
   lib/pld-alertas.js — Alertas y bloqueo por operativa inusual (POL-CUM-FOR-006 v1.0).
   Reglas de AVISO, TIEMPO REAL (suspender) y BLOQUEO evaluadas sobre la base de transacciones de
   Cumplimiento (cumplimiento.transacciones). Los detectores son funciones puras (se prueban sin BD);
   `evaluar` hace el preselección en SQL (solo llegan a Node los grupos candidatos, con tope) y persiste
   en cumplimiento.alertas sin duplicar.
   ========================================================================= */
'use strict';

const NIVELES = { AVISO: 'Aviso', SUSPENDER: 'Suspender', BLOQUEO: 'Bloqueo' };
const MEDIDA = { AVISO: 'Aviso para monitoreo en tiempo real', SUSPENDER: 'Suspender terminal / comercio', BLOQUEO: 'Bloquear' };

/* ---------- Catálogo de reglas y parámetros (valores por defecto = los del documento) ---------- */
const REGLAS = [
  { id: 'AV-1', nivel: 'AVISO', titulo: 'Concentración diaria por BIN (rango de aviso)',
    desc: 'Monto acumulado de un mismo BIN en el mismo día entre el mínimo y el máximo del rango.',
    params: [{ key: 'av1_min', label: 'Monto mínimo ($)', def: 30000, min: 1 }, { key: 'av1_max', label: 'Monto máximo ($)', def: 50000, min: 1 }] },
  { id: 'AV-2', nivel: 'AVISO', titulo: 'Fondos insuficientes con montos en decremento',
    desc: 'Misma tarjeta, mismo día, más de 2 intentos con estatus de fondos insuficientes y montos cada vez menores.',
    params: [{ key: 'av2_min_ops', label: 'Intentos mínimos (documento: mayor a 2 = 3)', def: 3, min: 2, max: 50 }] },
  { id: 'RT-1', nivel: 'SUSPENDER', titulo: 'Tasa de rechazo extrema por BIN en una terminal',
    desc: 'Una terminal (o comercio) supera la tasa de rechazo con un mismo BIN dentro de una ventana corta.',
    params: [{ key: 'rt1_tasa_pct', label: 'Tasa de rechazo (%)', def: 50, min: 1, max: 100 }, { key: 'rt1_ventana_min', label: 'Ventana máxima (min)', def: 10, min: 1, max: 240 },
      { key: 'rt1_min_ops', label: 'Operaciones mínimas en la ventana (para que el % signifique algo)', def: 4, min: 2, max: 500 }] },
  { id: 'RT-2', nivel: 'SUSPENDER', titulo: 'Volumen inusual por BIN en una terminal',
    desc: 'Una terminal procesa más de N transacciones con tarjetas distintas del mismo BIN en menos de X minutos (aprobadas o rechazadas).',
    params: [{ key: 'rt2_max_tarjetas', label: 'Más de (tarjetas distintas)', def: 9, min: 2, max: 500 }, { key: 'rt2_ventana_min', label: 'En menos de (min)', def: 8, min: 1, max: 240 }] },
  { id: 'RT-3', nivel: 'SUSPENDER', titulo: 'Conectividad PAN: terminaciones consecutivas en un BIN',
    desc: 'Mismo BIN con últimos dígitos consecutivos (+1, +2, +3) en un lapso corto: lote robado o generado artificialmente.',
    params: [{ key: 'rt3_ventana_min', label: 'Lapso máximo (min)', def: 3, min: 1, max: 60 }, { key: 'rt3_min_secuencia', label: 'Tarjetas consecutivas mínimas', def: 3, min: 3, max: 50 }] },
  { id: 'RT-4', nivel: 'SUSPENDER', titulo: 'Vaciado escalonado (goteo / pitufeo)',
    desc: 'La misma tarjeta intenta montos decrecientes de inmediato tras un rechazo por fondos insuficientes.',
    params: [{ key: 'rt4_min_intentos', label: 'Intentos decrecientes mínimos (incluye el rechazo)', def: 3, min: 2, max: 50 }, { key: 'rt4_ventana_min', label: 'Tiempo máximo entre intentos (min)', def: 30, min: 1, max: 1440 }] },
  { id: 'RT-5', nivel: 'SUSPENDER', titulo: 'Cobros múltiples justo debajo del umbral de auditoría',
    desc: 'Una terminal acumula varios cobros aprobados en el rango sospechoso en el mismo día (estructuración bajo $10,000).',
    params: [{ key: 'rt5_min', label: 'Monto mínimo ($)', def: 4500, min: 1 }, { key: 'rt5_max', label: 'Monto máximo ($)', def: 9999, min: 1 }, { key: 'rt5_min_cobros', label: 'Cobros mínimos en el día', def: 3, min: 2, max: 500 }] },
  { id: 'RT-6', nivel: 'SUSPENDER', titulo: 'Micro-cobros de prueba seguidos de alto valor',
    desc: 'Una terminal procesa cobros sucesivos de montos fijos muy bajos seguidos de inmediato por intentos de alto valor.',
    params: [{ key: 'rt6_montos', label: 'Montos de prueba ($, separados por coma)', def: '1,5,10', tipo: 'txt' }, { key: 'rt6_min_micro', label: 'Micro-cobros sucesivos mínimos', def: 3, min: 2, max: 100 },
      { key: 'rt6_alto_valor', label: 'Alto valor desde ($)', def: 5000, min: 1 }, { key: 'rt6_ventana_min', label: 'Tiempo máximo hasta el intento de alto valor (min)', def: 15, min: 1, max: 1440 }] },
  { id: 'BL-1', nivel: 'BLOQUEO', titulo: 'Tarjeta robada o perdida',
    desc: 'Una sola transacción del día con estatus de tarjeta robada o perdida.', params: [] },
  { id: 'BL-2', nivel: 'BLOQUEO', titulo: 'Monto acumulado mayor al máximo por BIN en el día',
    desc: 'Monto acumulado de un mismo BIN en el día por encima del máximo permitido.',
    params: [{ key: 'bl2_monto', label: 'Monto máximo ($)', def: 50000, min: 1 }] },
];
// Parámetros globales (no de una regla).
const GLOBALES = [
  { key: 'alcance_bin', label: 'Alcance de los acumulados por BIN (AV-1, BL-2)', def: 'afiliacion', tipo: 'sel', opciones: [['afiliacion', 'Por afiliación (recomendado)'], ['plataforma', 'Toda la plataforma']] },
  { key: 'palabras_fondos', label: 'Texto que identifica "fondos insuficientes" (separado por coma)', def: 'FONDOS INSUF,INSUFICIENTE,SIN FONDOS,INSUFFICIENT,NSF', tipo: 'txt' },
  { key: 'palabras_robada', label: 'Texto que identifica "tarjeta robada o perdida" (separado por coma)', def: 'ROBADA,PERDIDA,STOLEN,LOST', tipo: 'txt' },
  { key: 'correo_activo', label: 'Enviar correo a los destinatarios cuando salgan alertas nuevas', def: true, tipo: 'bool' },
  { key: 'correo_dias', label: 'No enviar correo de alertas más antiguas que (días)', def: 3, tipo: 'num', min: 0, max: 60 },
];

function catalogoParametros() {
  const out = {}; for (const r of REGLAS) { out['act_' + r.id] = true; for (const p of r.params) out[p.key] = p.def; } for (const g of GLOBALES) out[g.key] = g.def; return out;
}
// Valida/normaliza lo que llegue del cliente; lo inválido cae al valor por defecto (o al ya guardado).
function normalizarParametros(raw, base) {
  raw = raw || {}; const def = Object.assign(catalogoParametros(), base || {}); const out = {};
  for (const r of REGLAS) {
    const k = 'act_' + r.id; out[k] = raw[k] === undefined ? def[k] !== false : (raw[k] === true || raw[k] === 'true' || raw[k] === 1);
    for (const p of r.params) {
      const v = raw[p.key];
      if (p.tipo === 'txt') { const s = String(v == null ? '' : v).trim().slice(0, 300); out[p.key] = s && /^[\d.,\s]+$/.test(s) ? s : def[p.key]; continue; }
      const n = Number(v); out[p.key] = v !== undefined && v !== '' && Number.isFinite(n) && n >= (p.min == null ? -Infinity : p.min) && n <= (p.max == null ? Infinity : p.max) ? n : def[p.key];
    }
  }
  if (out.av1_max < out.av1_min) { out.av1_min = def.av1_min; out.av1_max = def.av1_max; }
  if (out.rt5_max < out.rt5_min) { out.rt5_min = def.rt5_min; out.rt5_max = def.rt5_max; }
  for (const g of GLOBALES) {
    const v = raw[g.key];
    if (g.tipo === 'sel') out[g.key] = g.opciones.some(o => o[0] === v) ? v : def[g.key];
    else if (g.tipo === 'bool') out[g.key] = v === undefined ? def[g.key] !== false : (v === true || v === 'true' || v === 1);
    else if (g.tipo === 'num') { const n = Number(v); out[g.key] = v !== undefined && v !== '' && Number.isFinite(n) && n >= g.min && n <= g.max ? Math.round(n) : def[g.key]; }
    else { const s = String(v == null ? '' : v).trim().slice(0, 300); out[g.key] = s || def[g.key]; }
  }
  return out;
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Límite de palabra solo al INICIO: "ROBADA" no debe coincidir dentro de "APROBADA", y "FONDOS INSUF" sí cubre "…INSUFICIENTES".
const regexPalabras = lista => { const ps = String(lista || '').split(',').map(s => s.trim()).filter(Boolean).map(esc); return ps.length ? new RegExp('\\b(?:' + ps.join('|') + ')', 'i') : null; };
// En el archivo de PLD el motivo viene EN la columna Estatus (p. ej. "FONDOS INSUFICIENTES", "TARJETA ROBADA"):
// es rechazo todo estatus que no sea APROBADO ni una cancelación / devolución / reverso / pendiente.
const NO_RECHAZO = '^(APROBAD|CANCEL|DEVOL|REEMBOLS|REVERS|ANULAD|PENDIENT)';
const RX_NO_RECHAZO = new RegExp(NO_RECHAZO);
const hh = ts => { const d = new Date(ts * 1000); return d.toISOString().slice(11, 19); };

// Convierte una fila de la BD en la forma que usan los detectores.
function normFila(r, rxFondos) {
  const est = String(r.estatus || '').toUpperCase(); const texto = [r.estatus, r.estatus_fin, r.motivo].filter(Boolean).join(' ').toUpperCase();
  return { id: r.id, folio: r.folio || '', f: r.f, hora: r.hora || '', ts: Number(r.ts_s), terminal: r.terminal || '', afil: r.numero_afiliacion || '', comercio: r.comercio || '', cliente: r.cliente || '',
    bin6: r.bin6 || '', u4: r.ultimos4 || '', tarjeta: r.tarjeta_key || (r.bin6 && r.ultimos4 ? r.bin6 + '|' + r.ultimos4 : ''), monto: Number(r.monto) || 0,
    aprobada: est === 'APROBADO', rechazada: est !== '' && !RX_NO_RECHAZO.test(est), texto, fondos: !!(rxFondos && rxFondos.test(texto)), estatus: est };
}
const evid = rows => rows.slice(0, 25).map(r => ({ folio: r.folio, hora: r.hora, monto: r.monto, estatus: r.estatus, tarjeta: r.bin6 && r.u4 ? r.bin6 + ' •••• ' + r.u4 : '' }));
const ordenar = rows => rows.slice().sort((a, b) => a.ts - b.ts || (a.id || 0) - (b.id || 0));
const base = (regla, rows, extra) => {
  const r0 = rows[0], rN = rows[rows.length - 1]; const def = REGLAS.find(x => x.id === regla);
  return Object.assign({ regla, nivel: def.nivel, fecha: r0.f, hora_ini: r0.hora || hh(r0.ts), hora_fin: rN.hora || hh(rN.ts), terminal: r0.terminal, comercio: r0.comercio, cliente: r0.cliente, afil: r0.afil, bin: r0.bin6,
    tarjeta: '', monto: 0, n_ops: rows.length, evidencia: evid(rows) }, extra);
};

/* ---------- Acción ejecutable por regla (lo que el equipo debe hacer en el gateway / con el comercio) ---------- */
function accionEjecutable(a) {
  const term = a.terminal ? `la terminal ${a.terminal}` : 'la terminal / comercio';
  const com = a.comercio ? ` (${a.comercio})` : '';
  const tarj = a.tarjeta || (a.bin ? 'BIN ' + a.bin : 'la tarjeta');
  const m = {
    'AV-1': `AVISO · Dar aviso al área de monitoreo y revisar en tiempo real los movimientos del BIN ${a.bin || ''}${a.afil ? ' en la afiliación ' + a.afil : ''}. Sin suspensión por ahora; si el acumulado pasa del máximo se escala a BLOQUEO.`,
    'AV-2': `AVISO · Dar aviso y monitorear ${tarj}: intentos con montos decrecientes tras fondos insuficientes. Si reintenta, escalar a SUSPENDER.`,
    'RT-1': `SUSPENDER ${term}${com} de forma preventiva y validar la operación con el comercio: rechazo extremo con el BIN ${a.bin || ''}.`,
    'RT-2': `SUSPENDER ${term}${com} y notificar de inmediato: volumen inusual de tarjetas distintas del BIN ${a.bin || ''} en pocos minutos.`,
    'RT-3': `SUSPENDER ${term}${com} y bloquear las tarjetas del BIN ${a.bin || ''} con terminaciones consecutivas: posible lote robado o generado artificialmente.`,
    'RT-4': `SUSPENDER ${term}${com} y bloquear ${tarj} (y las tarjetas del mismo lote): vaciado escalonado / pitufeo.`,
    'RT-5': `SUSPENDER ${term}${com}: cobros múltiples justo por debajo del umbral de $10,000; revisar posible estructuración.`,
    'RT-6': `SUSPENDER ${term}${com}: micro-cobros de prueba seguidos de cobros de alto valor (bandera roja).`,
    'BL-1': `BLOQUEAR ${tarj}: transacción con estatus de tarjeta robada o perdida. Bloquear la tarjeta/BIN en el gateway.`,
    'BL-2': `BLOQUEAR el BIN ${a.bin || ''}${a.afil ? ' para la afiliación ' + a.afil : ''}: el acumulado del día superó el máximo permitido.`,
  };
  return m[a.regla] || '';
}

/* ---------- Detectores (puros) ---------- */
// RT-1: tasa de rechazo ≥ X% en una ventana ≤ V minutos (misma terminal y BIN).
function detRT1(rows, p) {
  const R = ordenar(rows), W = p.rt1_ventana_min * 60, out = []; let i = 0;
  while (i < R.length) {
    let j = i; while (j + 1 < R.length && R[j + 1].ts - R[i].ts <= W) j++;
    const win = R.slice(i, j + 1), rech = win.filter(r => r.rechazada).length;
    if (win.length >= p.rt1_min_ops && rech / win.length * 100 >= p.rt1_tasa_pct) {
      out.push(base('RT-1', win, { monto: win.reduce((s, r) => s + r.monto, 0), detalle: `${rech} de ${win.length} operaciones rechazadas (${(rech / win.length * 100).toFixed(0)}%) con el BIN ${win[0].bin6} en ${Math.max(1, Math.round((win[win.length - 1].ts - win[0].ts) / 60))} min.` }));
      i = j + 1;
    } else i++;
  }
  return out;
}
// RT-2: más de N tarjetas distintas del mismo BIN en menos de X minutos (cualquier estatus).
function detRT2(rows, p) {
  const R = ordenar(rows), W = p.rt2_ventana_min * 60, out = []; let i = 0;
  while (i < R.length) {
    let j = i; const set = new Set(); while (j < R.length && R[j].ts - R[i].ts < W) { set.add(R[j].tarjeta || R[j].id); j++; }
    if (set.size > p.rt2_max_tarjetas) {
      const win = R.slice(i, j);
      out.push(base('RT-2', win, { monto: win.reduce((s, r) => s + r.monto, 0), detalle: `${set.size} tarjetas distintas del BIN ${win[0].bin6} (${win.length} operaciones, aprobadas o rechazadas) en ${Math.max(1, Math.round((win[win.length - 1].ts - win[0].ts) / 60))} min.` }));
      i = j;
    } else i++;
  }
  return out;
}
// RT-3: terminaciones consecutivas (+1,+2,+3…) en el mismo BIN dentro de ≤ V minutos.
function detRT3(rows, p) {
  const R = ordenar(rows.filter(r => /^\d{4}$/.test(r.u4))), W = p.rt3_ventana_min * 60, out = []; let i = 0;
  const corrida = win => { const v = [...new Set(win.map(r => Number(r.u4)))].sort((a, b) => a - b); let mejor = [], cur = []; for (const x of v) { if (cur.length && x === cur[cur.length - 1] + 1) cur.push(x); else cur = [x]; if (cur.length > mejor.length) mejor = cur.slice(); } return mejor; };
  while (i < R.length) {
    let j = i; while (j + 1 < R.length && R[j + 1].ts - R[i].ts <= W) j++;
    const win = R.slice(i, j + 1), c = corrida(win);
    if (c.length >= p.rt3_min_secuencia) {
      const set = new Set(c.map(x => String(x).padStart(4, '0'))); const involv = win.filter(r => set.has(r.u4));
      out.push(base('RT-3', involv, { monto: involv.reduce((s, r) => s + r.monto, 0), detalle: `Terminaciones consecutivas ${c.map(x => String(x).padStart(4, '0')).join(', ')} del BIN ${win[0].bin6} en ${Math.max(1, Math.round((involv[involv.length - 1].ts - involv[0].ts) / 60))} min: patrón de lote robado o generado.` }));
      i = j + 1;
    } else i++;
  }
  return out;
}
// RT-4: tras un rechazo por fondos insuficientes, la misma tarjeta reintenta montos cada vez menores.
function detRT4(rows, p) {
  const R = ordenar(rows), V = p.rt4_ventana_min * 60, out = []; let s = 0;
  while (s < R.length) {
    if (!R[s].fondos) { s++; continue; }
    const run = [R[s]]; let k = s + 1;
    while (k < R.length && R[k].ts - run[run.length - 1].ts <= V && R[k].monto < run[run.length - 1].monto) { run.push(R[k]); k++; }
    if (run.length >= p.rt4_min_intentos) {
      const fin = run[run.length - 1];
      out.push(base('RT-4', run, { tarjeta: run[0].bin6 + ' •••• ' + run[0].u4, monto: run.reduce((s2, r) => s2 + r.monto, 0), detalle: `${run.length} intentos decrecientes (${run.map(r => r.monto.toLocaleString('es-MX')).join(' → ')}) tras un rechazo por fondos insuficientes${fin.aprobada ? '; el último fue APROBADO' : ''}.` }));
      s = k;
    } else s++;
  }
  return out;
}
// AV-2: más de 2 operaciones con fondos insuficientes el mismo día con montos en decremento (misma tarjeta).
function detAV2(rows, p) {
  const R = ordenar(rows.filter(r => r.fondos)), out = []; let s = 0;
  while (s < R.length) {
    const run = [R[s]]; let k = s + 1; while (k < R.length && R[k].monto < run[run.length - 1].monto) { run.push(R[k]); k++; }
    if (run.length >= p.av2_min_ops) out.push(base('AV-2', run, { tarjeta: run[0].bin6 + ' •••• ' + run[0].u4, monto: run.reduce((s2, r) => s2 + r.monto, 0), detalle: `${run.length} rechazos por fondos insuficientes el mismo día con montos cada vez menores (${run.map(r => r.monto.toLocaleString('es-MX')).join(' → ')}).` }));
    s = Math.max(k, s + 1);
  }
  return out;
}
// RT-6: micro-cobros fijos sucesivos seguidos de un cobro de alto valor.
function detRT6(rows, p) {
  const R = ordenar(rows), V = p.rt6_ventana_min * 60, set = new Set(String(p.rt6_montos).split(',').map(s => Number(s.trim())).filter(Number.isFinite)), out = []; let i = 0;
  while (i < R.length) {
    if (!set.has(R[i].monto)) { i++; continue; }
    let j = i; while (j + 1 < R.length && set.has(R[j + 1].monto)) j++;
    const micro = R.slice(i, j + 1); const ultimo = micro[micro.length - 1];
    if (micro.length >= p.rt6_min_micro) {
      const alto = R.slice(j + 1).find(r => r.ts - ultimo.ts <= V && r.monto >= p.rt6_alto_valor);
      if (alto) { const rows2 = micro.concat([alto]); out.push(base('RT-6', rows2, { monto: rows2.reduce((s, r) => s + r.monto, 0), detalle: `${micro.length} micro-cobros de ${[...new Set(micro.map(r => r.monto))].join('/')} seguidos de un intento de ${alto.monto.toLocaleString('es-MX')} (${alto.estatus}) en ${Math.max(1, Math.round((alto.ts - ultimo.ts) / 60))} min.` })); }
    }
    i = j + 1;
  }
  return out;
}

/* ---------- Orquestación (SQL de preselección + detectores) ---------- */
const TS_SQL = "(case when t.hora ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then extract(epoch from (t.fecha::timestamp + t.hora::time)) else extract(epoch from t.fecha::timestamp) end)";
const RECHAZO_SQL = "(t.estatus is not null and t.estatus <> '' and t.estatus !~ '^(APROBAD|CANCEL|DEVOL|REEMBOLS|REVERS|ANULAD|PENDIENT)')";
const TERM = "coalesce(nullif(t.terminal,''), t.numero_afiliacion, '(sin terminal)')";
const CAP = 40000;

async function filasCandidatas(db, desde, hasta, k0, k1, having, hp, extra) {
  const sql = `with base as (select t.id, t.folio, t.fecha::text f, t.hora, t.terminal, t.numero_afiliacion, t.comercio, t.cliente, left(t.bin,6) bin6, t.ultimos4, t.tarjeta_key, t.monto, t.estatus, t.estatus_fin, t.motivo,
        ${TS_SQL} ts_s, ${k0} k0, ${k1} k1, t.fecha::text k2 from cumplimiento.transacciones t where t.fecha between $1 and $2 ${extra || ''}),
      g as (select k0, k1, k2 from base group by k0, k1, k2 having ${having})
    select b.* from base b join g using (k0, k1, k2) order by b.k0, b.k1, b.k2, b.ts_s limit ${CAP + 1}`;
  const rows = (await db.query(sql, [desde, hasta, ...hp])).rows; const truncado = rows.length > CAP; if (truncado) rows.length = CAP;
  return { rows, truncado };
}
const agrupar = (rows, rxF) => { const m = new Map(); for (const r of rows) { const k = r.k0 + '|' + r.k1 + '|' + r.k2; if (!m.has(k)) m.set(k, []); m.get(k).push(normFila(r, rxF)); } return m; };

async function evaluar(db, desde, hasta, params) {
  const p = normalizarParametros(params); const act = id => p['act_' + id] !== false; const rxF = regexPalabras(p.palabras_fondos), rxR = regexPalabras(p.palabras_robada);
  const alertas = []; const aviso = []; let truncado = false; const sinMotivo = (await db.query(`select count(*)::int n, count(*) filter (where motivo is null)::int sm from cumplimiento.transacciones t where t.fecha between $1 and $2 and ${RECHAZO_SQL}`, [desde, hasta])).rows[0];
  const add = a => alertas.push(a);
  const sumaDia = async (campo, k, minimo, maximo) => (await db.query(`select ${campo} afil, left(t.bin,6) bin6, t.fecha::text f, min(t.comercio) comercio, min(t.cliente) cliente, count(*)::int n, sum(t.monto) total, min(t.hora) h0, max(t.hora) h1
      from cumplimiento.transacciones t where t.fecha between $1 and $2 and t.estatus='APROBADO' and t.bin is not null group by 1,2,3 having sum(t.monto) >= $3 ${maximo != null ? 'and sum(t.monto) <= $4' : ''} order by 6 desc limit 20000`,
    maximo != null ? [desde, hasta, minimo, maximo] : [desde, hasta, minimo])).rows;
  const campoAlcance = p.alcance_bin === 'plataforma' ? "'(plataforma)'" : "coalesce(t.numero_afiliacion,'(sin afiliación)')";
  const nombreAlcance = r => p.alcance_bin === 'plataforma' ? '' : r.afil;

  if (act('AV-1')) for (const r of await sumaDia(campoAlcance, 'af', p.av1_min, p.av1_max)) {
    add({ regla: 'AV-1', nivel: 'AVISO', fecha: r.f, hora_ini: r.h0 || '', hora_fin: r.h1 || '', terminal: '', comercio: r.comercio || '', cliente: r.cliente || '', afil: nombreAlcance(r), bin: r.bin6, tarjeta: '', monto: Number(r.total), n_ops: r.n,
      detalle: `El BIN ${r.bin6} acumuló ${Number(r.total).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} aprobados en el día (${r.n} operaciones)${p.alcance_bin === 'plataforma' ? ' en toda la plataforma' : ' en la afiliación ' + r.afil}; rango de aviso ${p.av1_min.toLocaleString('es-MX')}–${p.av1_max.toLocaleString('es-MX')}.`, evidencia: [] });
  }
  if (act('BL-2')) for (const r of await sumaDia(campoAlcance, 'af', p.bl2_monto + 0.005, null)) {
    add({ regla: 'BL-2', nivel: 'BLOQUEO', fecha: r.f, hora_ini: r.h0 || '', hora_fin: r.h1 || '', terminal: '', comercio: r.comercio || '', cliente: r.cliente || '', afil: nombreAlcance(r), bin: r.bin6, tarjeta: '', monto: Number(r.total), n_ops: r.n,
      detalle: `El BIN ${r.bin6} acumuló ${Number(r.total).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} aprobados en el día (${r.n} operaciones), por encima del máximo de ${p.bl2_monto.toLocaleString('es-MX')}${p.alcance_bin === 'plataforma' ? '' : ' en la afiliación ' + r.afil}.`, evidencia: [] });
  }
  if (act('RT-5')) for (const r of (await db.query(`select ${TERM} term, min(t.numero_afiliacion) afil, min(t.comercio) comercio, min(t.cliente) cliente, t.fecha::text f, count(*)::int n, sum(t.monto) total, min(t.hora) h0, max(t.hora) h1
      from cumplimiento.transacciones t where t.fecha between $1 and $2 and t.estatus='APROBADO' and t.monto between $3 and $4 group by 1, t.fecha having count(*) >= $5 order by 6 desc limit 20000`, [desde, hasta, p.rt5_min, p.rt5_max, p.rt5_min_cobros])).rows) {
    add({ regla: 'RT-5', nivel: 'SUSPENDER', fecha: r.f, hora_ini: r.h0 || '', hora_fin: r.h1 || '', terminal: r.term, comercio: r.comercio || '', cliente: r.cliente || '', afil: r.afil || '', bin: '', tarjeta: '', monto: Number(r.total), n_ops: r.n,
      detalle: `${r.n} cobros aprobados entre ${p.rt5_min.toLocaleString('es-MX')} y ${p.rt5_max.toLocaleString('es-MX')} en la terminal ${r.term} el mismo día (suma ${Number(r.total).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}): justo por debajo del umbral de auditoría.`, evidencia: [] });
  }
  if (act('BL-1') && rxR) for (const r of (await db.query(`select coalesce(t.tarjeta_key, left(t.bin,6)||'|'||t.ultimos4, t.id::text) k, min(left(t.bin,6)) bin6, min(t.ultimos4) u4, t.fecha::text f, min(t.terminal) terminal, min(t.numero_afiliacion) afil, min(t.comercio) comercio, min(t.cliente) cliente,
        count(*)::int n, sum(t.monto) total, min(t.hora) h0, min(t.folio) folio from cumplimiento.transacciones t where t.fecha between $1 and $2 and (coalesce(t.estatus,'')||' '||coalesce(t.estatus_fin,'')||' '||coalesce(t.motivo,'')) ~* $3 group by 1, t.fecha order by 10 desc limit 20000`,
    [desde, hasta, '\\y(?:' + p.palabras_robada.split(',').map(s => s.trim()).filter(Boolean).map(esc).join('|') + ')'])).rows) {
    add({ regla: 'BL-1', nivel: 'BLOQUEO', fecha: r.f, hora_ini: r.h0 || '', hora_fin: r.h0 || '', terminal: r.terminal || '', comercio: r.comercio || '', cliente: r.cliente || '', afil: r.afil || '', bin: r.bin6 || '', tarjeta: r.bin6 && r.u4 ? r.bin6 + ' •••• ' + r.u4 : '', monto: Number(r.total), n_ops: r.n,
      detalle: `Transacción con estatus de tarjeta robada o perdida (BIN ${r.bin6 || '—'}, terminación ${r.u4 || '—'}).`, evidencia: [{ folio: r.folio || '', hora: r.h0 || '', monto: Number(r.total), estatus: 'ROBADA/PERDIDA', tarjeta: r.bin6 && r.u4 ? r.bin6 + ' •••• ' + r.u4 : '' }] });
  }
  // Las reglas de ventana trabajan dentro de un mismo día: se evalúa DÍA POR DÍA (memoria acotada y sin toparse con el límite de filas).
  const dias = []; for (let d = Date.parse(desde); d <= Date.parse(hasta); d += 86400000) dias.push(new Date(d).toISOString().slice(0, 10));
  const porGrupo = async (id, k0, k1, having, hp, extra, det, tipo) => {
    if (!act(id)) return;
    for (const dia of dias) {
      const { rows, truncado: tr } = await filasCandidatas(db, dia, dia, k0, k1, having, hp, extra); if (tr) truncado = true;
      for (const [, g] of agrupar(rows, rxF)) for (const a of det(g, p)) add(a);
    }
  };
  await porGrupo('RT-1', TERM, 'left(t.bin,6)', `count(*) >= $3 and count(*) filter (where ${RECHAZO_SQL.replace(/t\./g, 'base.')}) >= 1`, [p.rt1_min_ops], 'and t.bin is not null', detRT1);
  await porGrupo('RT-2', TERM, 'left(t.bin,6)', 'count(*) > $3', [p.rt2_max_tarjetas], 'and t.bin is not null', detRT2);
  await porGrupo('RT-3', TERM, 'left(t.bin,6)', 'count(*) >= $3', [p.rt3_min_secuencia], "and t.bin is not null and t.ultimos4 ~ '^[0-9]{4}$'", detRT3);
  const tarj = (id, det) => porGrupo(id, "coalesce(t.tarjeta_key,'(sin tarjeta)')", "'x'", 'count(*) >= $3', [id === 'AV-2' ? p.av2_min_ops : p.rt4_min_intentos], 'and t.tarjeta_key is not null', det);
  const alertasRT4 = [];
  if (rxF) { await tarj('RT-4', (g, pp) => { const o = detRT4(g, pp); alertasRT4.push(...o.map(a => a.fecha + '|' + g[0].tarjeta)); return o; }); await tarj('AV-2', (g, pp) => detAV2(g, pp).filter(a => !alertasRT4.includes(a.fecha + '|' + g[0].tarjeta))); }
  await porGrupo('RT-6', TERM, "'x'", 'count(*) >= $3', [p.rt6_min_micro + 1], '', detRT6);

  // Clave anti-duplicado: regla + alcance + fecha + inicio.
  for (const a of alertas) a.clave = [a.regla, a.terminal || a.afil || '', a.bin || '', a.tarjeta || '', a.fecha, a.hora_ini].join('|');
  const nuevas = []; for (const a of alertas) {
    const r = await db.query(`insert into cumplimiento.alertas(clave, regla, nivel, fecha, hora_ini, hora_fin, terminal, comercio, cliente, numero_afiliacion, bin, tarjeta, monto, n_ops, detalle, evidencia)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict (clave) do nothing returning id`,
      [a.clave, a.regla, a.nivel, a.fecha, a.hora_ini || null, a.hora_fin || null, a.terminal || null, a.comercio || null, a.cliente || null, a.afil || null, a.bin || null, a.tarjeta || null, a.monto || 0, a.n_ops || 0, a.detalle, JSON.stringify(a.evidencia || [])]);
    if (r.rows.length) nuevas.push(a);
  }
  return { detectadas: alertas.length, nuevas: nuevas.length, por_regla: alertas.reduce((m, a) => (m[a.regla] = (m[a.regla] || 0) + 1, m), {}), truncado, rechazos_sin_motivo: sinMotivo.sm, rechazos: sinMotivo.n };
}

module.exports = { accionEjecutable, RX_NO_RECHAZO, REGLAS, GLOBALES, NIVELES, MEDIDA, catalogoParametros, normalizarParametros, regexPalabras, normFila, evaluar, detRT1, detRT2, detRT3, detRT4, detAV2, detRT6 };
