/* ============================================================================
   lib/cards-bancos.js — Catálogo de bancos de Cards (copia del catálogo "Bancos SPEI" de MCEB), identificación del banco por
   CLABE y comparación del beneficiario / banco contra lo que dice el CEP. Funciones puras salvo `sembrarBancos`.

   Los 3 primeros dígitos de una CLABE son la clave del banco y coinciden con los 3 últimos del código SPEI (40012 BBVA → 012,
   90646 STP → 646, 37006 Bancomext → 006). Los códigos 91xxx (segundas claves), 2001 (Banxico) y 9xx (CLS, Indeval, CoDi) no
   llevan cuentas CLABE: no tienen prefijo.
   ========================================================================= */
'use strict';
const SEMILLA = require('./cards-bancos.json');

const prefijoDe = codigo => {
  const s = String(codigo == null ? '' : codigo);
  if (!/^(37|40|90)\d{3}$/.test(s)) return null;
  const p = s.slice(2);
  return Number(p) < 900 ? p : null;
};

/* Banco al que pertenece una CLABE, según el catálogo (activos). null si no se reconoce. */
function bancoDeClabe(clabe, bancos) {
  const p = String(clabe || '').replace(/\D/g, '').slice(0, 3);
  if (p.length < 3) return null;
  return (bancos || []).find(b => b.activo !== false && b.prefijo === p) || null;
}

/* ---------- nombres ---------- */
const sinAcentos = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const VACIAS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'E']);
// Une las letras sueltas (S.A. de C.V. → SA DE CV) para poder quitar la forma societaria.
function compacta(s) {
  const t = sinAcentos(s).toUpperCase().replace(/&/g, ' Y ').replace(/[^A-Z0-9Ñ ]/g, ' ').split(/\s+/).filter(Boolean), out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i].length === 1 && i + 1 < t.length && t[i + 1].length === 1) { let j = i, x = ''; while (j < t.length && t[j].length === 1) x += t[j++]; out.push(x); i = j - 1; }
    else out.push(t[i]);
  }
  return out.join(' ');
}
const FORMA = /\s(SAPI|SAB|SAS|SA|SC|AC|SRL|S DE RL|SOFOM ENR|SOFOM|SOFIPO)(\sDE\sCV)?$|\sDE\sCV$|\sSOCIEDAD ANONIMA( DE CAPITAL VARIABLE)?$/;
function normNombre(s) {
  let t = compacta(s);
  for (let i = 0; i < 4 && FORMA.test(t); i++) t = t.replace(FORMA, '');
  return t.trim();
}
const palabras = s => normNombre(s).split(' ').filter(w => w && !VACIAS.has(w));

/* ¿Es la misma razón social? true / false; null si falta alguno de los dos. Tolera forma societaria, acentos, puntuación,
   nombres cortados por el banco (el CEP trunca) y palabras en distinto orden o de menos. */
function nombresCoinciden(a, b) {
  const na = normNombre(a), nb = normNombre(b);
  if (!na || !nb) return null;
  if (na === nb) return true;
  const [c, l] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (c.length >= 10 && l.startsWith(c)) return true;                       // el CEP lo cortó
  const pc = palabras(c), pl = new Set(palabras(l));
  if (pc.length >= 2 && pc.every(w => pl.has(w) || [...pl].some(x => x.length >= 6 && w.length >= 6 && (x.startsWith(w) || w.startsWith(x))))) return true;
  return pc.length === 1 && pl.size === 1 && pl.has(pc[0]);
}

/* ---------- bancos ---------- */
// Nombres con los que Banxico, el SPEI y los bancos se refieren al mismo banco.
const SINONIMOS = [
  ['BBVA', 'BBVA MEXICO', 'BBVA BANCOMER', 'BANCOMER'],
  ['BANORTE', 'MERCANTIL DEL NORTE', 'BANCO MERCANTIL DEL NORTE', 'BANORTE IXE', 'IXE'],
  ['BANAMEX', 'CITIBANAMEX', 'BANCO NACIONAL DE MEXICO'],
  ['SANTANDER', 'BANCO SANTANDER', 'SANTANDER MEXICO'],
  ['SCOTIABANK', 'SCOTIABANK INVERLAT', 'INVERLAT'],
  ['BAJIO', 'BANBAJIO'],
  ['AZTECA', 'BANCO AZTECA'],
  ['NU MEXICO', 'NU', 'NUBANK'],
  ['MERCADO PAGO W', 'MERCADO PAGO', 'MERCADO PAGO WALLET'],
  ['VE POR MAS', 'BANCO VE POR MAS', 'BX', 'BXMAS'],
  ['CITI MEXICO', 'CITI', 'CITIBANK'],
  ['SPIN BY OXXO', 'SPIN', 'OXXO'],
  ['STP', 'SISTEMA DE TRANSFERENCIAS Y PAGOS'],
  ['INTERCAM BANCO', 'INTERCAM'],
  ['MULTIVA BANCO', 'MULTIVA'],
  ['HEY BANCO', 'HEY'],
  ['KAPITAL', 'BANCO KAPITAL'],
].map(g => g.map(x => limpiaBanco(x)));
function limpiaBanco(s) {
  return normNombre(s).replace(/\b(GRUPO FINANCIERO [A-Z ]+|INSTITUCION DE BANCA MULTIPLE|BANCA MULTIPLE|IBM|SA)\b/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^BANCO\s+/, '').replace(/([A-Z])2$/, '$1').trim();
}
const grupoDe = x => SINONIMOS.findIndex(g => g.includes(x));

/* ¿El banco que dice el CEP es `banco` ({ nombre, codigo_spei })? true / false; null si el CEP no trae banco.
   Resuelve el nombre contra el catálogo y los sinónimos para que “BBVA BANCOMER” y “BBVA MEXICO” sean el mismo. */
function bancoCoincide(nombreCep, banco, bancos) {
  const a = limpiaBanco(nombreCep);
  if (!a) return null;
  if (!banco) return null;
  const b = limpiaBanco(banco.nombre);
  if (a === b) return true;
  const ga = grupoDe(a), gb = grupoDe(b);
  if (ga >= 0 && ga === gb) return true;
  const enCatalogo = (bancos || []).find(x => { const n = limpiaBanco(x.nombre); return n === a || (ga >= 0 && grupoDe(n) === ga); });
  if (enCatalogo) return enCatalogo.codigo_spei === banco.codigo_spei || limpiaBanco(enCatalogo.nombre) === b;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

/* Copia el catálogo "Bancos SPEI" de MCEB (tabla `bancos` del sistema) a cards.bancos, la completa con la lista de
   participantes SPEI y deja a cada entidad y fondeo con su banco. Idempotente: nunca pisa lo que ya está. `query(sql, params)`. */
async function sembrarBancos(query, { origen = 'bancos' } = {}) {
  const ins = filas => query(
    `insert into cards.bancos(codigo_spei, nombre, prefijo)
       select x.codigo_spei, x.nombre, x.prefijo from json_to_recordset($1::json) as x(codigo_spei int, nombre text, prefijo text) on conflict do nothing`,
    [JSON.stringify(filas.map(b => ({ codigo_spei: b.codigo_spei, nombre: String(b.nombre).trim(), prefijo: prefijoDe(b.codigo_spei) })))]);
  await ins(SEMILLA);
  try {
    const r = await query(`select nombre, codigo_spei from ${origen} where nombre is not null and codigo_spei is not null`);
    if (r.rows.length) await ins(r.rows.map(b => ({ codigo_spei: Number(b.codigo_spei), nombre: b.nombre })));
  } catch (_e) { /* sin catálogo de origen (base nueva): basta con la semilla */ }
  await query(`update cards.entidades e set banco_codigo = b.codigo_spei from cards.bancos b
                where e.banco_codigo is null and b.activo and b.prefijo = substr(e.clabe, 1, 3)`);
  await query(`update cards.fondeos f set beneficiario_destino = e.beneficiario from cards.entidades e
                where f.entidad_id = e.id and f.beneficiario_destino is null and e.beneficiario is not null`);
  await query(`update cards.fondeos f set banco_codigo_destino = e.banco_codigo, banco_destino = b.nombre from cards.entidades e join cards.bancos b on b.codigo_spei = e.banco_codigo
                where f.entidad_id = e.id and f.banco_codigo_destino is null`);
}

module.exports = { SEMILLA, prefijoDe, bancoDeClabe, normNombre, nombresCoinciden, bancoCoincide, sembrarBancos };
