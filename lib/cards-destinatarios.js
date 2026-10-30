/* ============================================================================
   lib/cards-destinatarios.js — Alta masiva de destinatarios de los correos de Cards.
   Recibe el texto que pegó el usuario (coma, punto y coma, espacios o un correo por renglón; admite
   «Nombre <correo>» y «Nombre correo») y lo separa en correos válidos, sin repetidos, e inválidos.
   ========================================================================== */
'use strict';

const MAX_CORREOS = 200;      // por alta
const MAX_CORREO = 160;       // largo de un correo (igual que el alta individual)
const MAX_NOMBRE = 80;
const emailOk = v => v.length <= MAX_CORREO && /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/.test(v);

function separarCorreos(texto) {
  const validos = [], invalidos = [], vistos = new Set();
  let repetidosEnTexto = 0;
  const poner = (email, nombre) => {
    const e = email.toLowerCase();
    if (vistos.has(e)) { repetidosEnTexto++; return; }
    vistos.add(e);
    validos.push({ email: e, nombre: nombre ? nombre.replace(/[\u0000-\u001f"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOMBRE) : '' });
  };
  String(texto == null ? '' : texto).replace(/\r/g, '\n').replace(/"([^"]*)"/g, (_m, n) => '"' + n.replace(/[,;\n]/g, ' ') + '"').split(/[\n;,]+/).forEach(trozo => {
    const t = trozo.trim();
    if (!t) return;
    const m = /^(.*?)<\s*([^<>\s]+)\s*>\s*$/.exec(t);                       // «Nombre <correo>»
    if (m) { if (emailOk(m[2])) poner(m[2], m[1]); else invalidos.push(t); return; }
    const piezas = t.split(/\s+/);
    const correos = piezas.filter(emailOk), otros = piezas.filter(p => !emailOk(p));
    if (correos.length === 1 && otros.every(p => !p.includes('@'))) { poner(correos[0], otros.join(' ')); return; }   // «Nombre correo»
    if (correos.length === 0) { invalidos.push(t); return; }
    correos.forEach(c => poner(c, ''));                                       // varios correos separados por espacios
    otros.forEach(o => invalidos.push(o));
  });
  return { validos, invalidos, repetidosEnTexto, excede: validos.length > MAX_CORREOS };
}

module.exports = { separarCorreos, emailOk, MAX_CORREOS };
