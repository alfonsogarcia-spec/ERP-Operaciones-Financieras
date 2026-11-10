/* ============================================================================
   lib/reparto-comercio.js — Reparto de la dispersión de un grupo entre sus COMERCIOS.

   El CÁLCULO sigue siendo por grupo de cliente + afiliación (tasas, costos, cargos del ledger). Lo único que cambia es A QUIÉN se paga: si un
   comercio del grupo tiene su propia CLABE, su parte del importe a dispersar sale a esa cuenta; lo de los comercios sin CLABE propia sale a la
   cuenta general del grupo (el "resto"). Funciones puras, sin base de datos.

   Cómo se reparte: cada comercio pesa lo que le tocaría SIN cargos (su disponible bruto, calculado con las mismas tasas del grupo). Los cargos
   del ledger (contracargos, financiamientos), que se aplican al grupo, quedan repartidos en proporción a ese peso. La suma de las partes es
   siempre exactamente lo que el corte calculó para el grupo (el redondeo lo absorbe la parte más grande).
   ========================================================================= */
'use strict';

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const norm = s => String(s == null ? '' : s).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const EPS = 0.005;

/* Cuentas de comercio que aplican a una fila del corte (grupo + afiliación): las del grupo, sin afiliación (valen para todas) o de esa afiliación. */
function cuentasDeFila(cuentas, idGrupo, afil) {
  return (cuentas || []).filter(c => c.comercio && String(c.id_grupo) === String(idGrupo)
    && (!c.numero_afiliacion || String(c.numero_afiliacion) === String(afil)));
}

/* Reparte `final.disp_dom` y `final.disp_amex` (ya con cargos) entre los comercios con CLABE propia y el resto.
   · txs: transacciones de la fila [{ comercio, producto, monto }]
   · cuentasComercio: cuentas con `comercio` de esa fila (ver cuentasDeFila); cada una: { comercio, clabe, codigo_banco, banco, beneficiario }
   · calcular(txsSubconjunto) → { disp_dom, disp_amex }: el cálculo del grupo (mismas tasas y costos) SIN ajustes, aplicado a un subconjunto
   · final: { disp_dom, disp_amex } de la fila · general: cuenta general del grupo para el resto (o null)
   Devuelve null si ningún comercio con CLABE propia tuvo transacciones (la fila se paga como siempre), o
   { partes: [{ comercio, es_resto, clabe, codigo_banco, banco, beneficiario, n_trx, disp_dom, disp_amex }] }. */
function repartir({ txs, cuentasComercio, calcular, final, general }) {
  const porNombre = new Map();
  for (const c of cuentasComercio || []) { const k = norm(c.comercio); if (k && !porNombre.has(k)) porNombre.set(k, c); }
  if (!porNombre.size) return null;
  const grupos = new Map();     // clave normalizada → { cuenta, nombre, txs }
  const resto = [];
  for (const t of txs || []) {
    const k = norm(t.comercio), cta = k ? porNombre.get(k) : null;
    if (!cta) { resto.push(t); continue; }
    if (!grupos.has(k)) grupos.set(k, { cuenta: cta, nombre: cta.comercio, txs: [] });
    grupos.get(k).txs.push(t);
  }
  if (!grupos.size) return null;

  const partes = [...grupos.values()].map(g => {
    const b = calcular(g.txs) || {};
    return { comercio: g.nombre, es_resto: false, clabe: g.cuenta.clabe || '', codigo_banco: g.cuenta.codigo_banco == null ? null : g.cuenta.codigo_banco, banco: g.cuenta.banco || '',
      beneficiario: g.cuenta.beneficiario || g.nombre, n_trx: g.txs.length, _dom: Math.max(Number(b.disp_dom) || 0, 0), _amex: Math.max(Number(b.disp_amex) || 0, 0) };
  });
  if (resto.length) {
    const b = calcular(resto) || {};
    const g = general || {};
    partes.push({ comercio: 'Resto del grupo', es_resto: true, clabe: g.clabe || '', codigo_banco: g.codigo_banco == null ? null : g.codigo_banco, banco: g.banco || '',
      beneficiario: g.beneficiario || '', n_trx: resto.length, _dom: Math.max(Number(b.disp_dom) || 0, 0), _amex: Math.max(Number(b.disp_amex) || 0, 0) });
  }

  for (const [bloque, clave] of [['_dom', 'disp_dom'], ['_amex', 'disp_amex']]) {
    const total = round2(final[clave] || 0);
    const pesos = partes.map(p => p[bloque]);
    const suma = pesos.reduce((s, x) => s + x, 0);
    if (suma <= EPS) {
      // Sin base para repartir (todo el disponible bruto es 0): el importe, si lo hay, va a la cuenta general del grupo.
      partes.forEach(p => { p[clave] = 0; });
      if (Math.abs(total) > EPS) {
        let r = partes.find(p => p.es_resto);
        if (!r) { const g = general || {}; r = { comercio: 'Resto del grupo', es_resto: true, clabe: g.clabe || '', codigo_banco: g.codigo_banco == null ? null : g.codigo_banco, banco: g.banco || '', beneficiario: g.beneficiario || '', n_trx: 0, _dom: 0, _amex: 0, disp_dom: 0, disp_amex: 0 }; partes.push(r); }
        r[clave] = total;
      }
      continue;
    }
    let asignado = 0, mayor = 0;
    partes.forEach((p, i) => { p[clave] = round2(total * pesos[i] / suma); asignado += p[clave]; if (pesos[i] > pesos[mayor]) mayor = i; });
    partes[mayor][clave] = round2(partes[mayor][clave] + (total - asignado));      // el redondeo lo absorbe la parte más grande
  }
  partes.forEach(p => { delete p._dom; delete p._amex; });
  return { partes };
}

/* Reajusta un reparto ya hecho cuando cambia lo que se dispersa a la fila (p. ej. una retención manual dentro del corte): los nuevos totales se
   reparten en proporción a lo que cada parte ya tenía, así la suma sigue siendo exacta. */
function reescalar(reparto, final) {
  if (!reparto || !Array.isArray(reparto.partes) || !reparto.partes.length) return reparto || null;
  const partes = reparto.partes.map(p => ({ ...p }));
  for (const clave of ['disp_dom', 'disp_amex']) {
    const total = round2(final[clave] || 0), pesos = partes.map(p => Math.max(Number(p[clave]) || 0, 0)), suma = pesos.reduce((a, b) => a + b, 0);
    if (suma <= EPS) {
      partes.forEach(p => { p[clave] = 0; });
      if (Math.abs(total) > EPS) { const i = Math.max(partes.findIndex(p => p.es_resto), 0); partes[i][clave] = total; }
      continue;
    }
    let asignado = 0, mayor = 0;
    partes.forEach((p, i) => { p[clave] = round2(total * pesos[i] / suma); asignado += p[clave]; if (pesos[i] > pesos[mayor]) mayor = i; });
    partes[mayor][clave] = round2(partes[mayor][clave] + (total - asignado));
  }
  return { ...reparto, partes };
}

/* ¿Qué partes de un reparto no se pueden pagar? (con importe y sin CLABE o sin código de banco). */
function partesBloqueadas(reparto) {
  return ((reparto && reparto.partes) || []).filter(p => (Math.abs(p.disp_dom) > EPS || Math.abs(p.disp_amex) > EPS) && (!p.clabe || !p.codigo_banco));
}

module.exports = { norm, cuentasDeFila, repartir, reescalar, partesBloqueadas, round2 };
