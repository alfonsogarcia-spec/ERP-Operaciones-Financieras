// Layout "ya dispersado": el usuario sube el layout con lo que SÍ se dispersó y la diferencia contra lo que el corte mandaba
// pagar es lo que NO se dispersó (queda como pendiente para la recuperación). Aquí solo hay lógica pura (sin BD ni HTTP).
'use strict';

const norm = s => String(s == null ? '' : s).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const soloDigitos = v => {
  if (typeof v === 'number') return String(Math.round(v));       // Excel entrega CLABEs largas como número
  return String(v == null ? '' : v).replace(/\D/g, '');
};
// Importe en centavos (acepta número, "$1,234.50", "1234.5"); null si no es un importe.
const centavos = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const t = String(v == null ? '' : v).replace(/[$\s,]/g, '');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

/* Filas {clabe, cents, concepto, nombre} de una hoja (matriz de celdas). Busca el encabezado del layout (Concepto / Cuenta clabe / Cantidad) en las
   primeras filas; tolera la banda POLIPAY o títulos arriba. Devuelve null si no reconoce el encabezado. */
function filasDeHoja(aoa) {
  let h = -1, ci = {};
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const cel = (aoa[i] || []).map(norm);
    const clabe = cel.findIndex(c => c.includes('clabe')), cant = cel.findIndex(c => c === 'cantidad' || c.startsWith('cantidad') || c === 'importe' || c === 'monto');
    if (clabe >= 0 && cant >= 0) { h = i; ci = { clabe, cant, concepto: cel.findIndex(c => c === 'concepto'), nombre: cel.findIndex(c => c.includes('nombre')) }; break; }
  }
  if (h < 0) return null;
  const out = [];
  for (let i = h + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const cl = soloDigitos(r[ci.clabe]), ct = centavos(r[ci.cant]);
    if (!cl && ct == null) continue;                  // fila vacía
    if (!cl || ct == null) continue;                  // sin CLABE o sin importe: no es una orden
    // Una CLABE guardada como NÚMERO en Excel pierde precisión pasados 15 dígitos (los últimos salen en ceros): se marca para compararla por sus primeros 15.
    out.push({ aprox: typeof r[ci.clabe] === 'number' && cl.length > 15, clabe: cl, cents: ct, concepto: ci.concepto >= 0 ? norm(r[ci.concepto]) : '', nombre: ci.nombre >= 0 ? String(r[ci.nombre] || '') : '' });
  }
  return out;
}

/* Cruza lo que el corte mandaba pagar (`esperadas`: [{clave, clabe, cant, concepto}], en el orden en que se quiere asignar) con lo que trae el archivo.
   Una fila del archivo salda UNA orden (misma CLABE e importe; si hay varias candidatas gana la de mismo concepto). Devuelve:
   - resultado: [{clave, dispersado}]  (dispersado = apareció en el archivo)
   - sobrantes: filas del archivo que no corresponden a ninguna orden del corte
   - distintas: órdenes no encontradas cuya CLABE sí viene en el archivo con otro importe (para avisar, no se adivinan) */
function conciliar(esperadas, filas) {
  const libres = filas.map((f, i) => ({ ...f, i, usada: false }));
  const mismaClabe = (f, clabe) => f.aprox ? f.clabe.slice(0, 15) === clabe.slice(0, 15) : f.clabe === clabe;
  const resultado = [];
  for (const e of esperadas) {
    const clabe = soloDigitos(e.clabe), cents = Math.round((Number(e.cant) || 0) * 100), conc = norm(e.concepto);
    const cand = libres.filter(f => !f.usada && mismaClabe(f, clabe) && f.cents === cents);
    const f = cand.find(x => x.concepto === conc) || cand[0];
    if (f) f.usada = true;
    resultado.push({ clave: e.clave, dispersado: !!f });
  }
  const sobrantes = libres.filter(f => !f.usada).map(f => ({ aprox: f.aprox, clabe: f.clabe, cantidad: f.cents / 100, concepto: f.concepto, nombre: f.nombre }));
  const distintas = [];
  esperadas.forEach((e, k) => {
    if (resultado[k].dispersado) return;
    const otras = sobrantes.filter(s => mismaClabe(s, soloDigitos(e.clabe)));
    if (otras.length) distintas.push({ clave: e.clave, clabe: soloDigitos(e.clabe), esperado: Math.round((Number(e.cant) || 0) * 100) / 100, en_archivo: otras.map(o => o.cantidad) });
  });
  return { resultado, sobrantes, distintas };
}

module.exports = { filasDeHoja, conciliar, centavos, soloDigitos };
