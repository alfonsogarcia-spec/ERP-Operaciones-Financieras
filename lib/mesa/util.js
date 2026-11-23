/* lib/mesa/util.js — Mesa de control: utilidades puras compartidas (CLABE, CSV, huellas, fechas de México). */
'use strict';
const crypto = require('crypto');

/* CLABE interbancaria: 18 dígitos; el último es el dígito verificador (pesos 3-7-1 repetidos, módulo 10). */
function clabeValida(c) {
  const s = String(c == null ? '' : c).replace(/\s+/g, '');
  if (!/^\d{18}$/.test(s)) return false;
  const w = [3, 7, 1]; let suma = 0;
  for (let i = 0; i < 17; i++) suma += (Number(s[i]) * w[i % 3]) % 10;
  return (10 - (suma % 10)) % 10 === Number(s[17]);
}
const digitoClabe = c17 => { const w = [3, 7, 1]; let s = 0; for (let i = 0; i < 17; i++) s += (Number(c17[i]) * w[i % 3]) % 10; return (10 - (s % 10)) % 10; };

const sha256 = t => crypto.createHash('sha256').update(typeof t === 'string' || Buffer.isBuffer(t) ? t : JSON.stringify(t)).digest('hex');

/* CSV con comillas y BOM para que Excel lo abra con acentos. */
function csv(filas) {
  const cel = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + filas.map(f => f.map(cel).join(',')).join('\r\n') + '\r\n';
}

const hoyMx = () => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); return p; };
const periodoDe = fechaISO => String(fechaISO).slice(0, 7);
const finDePeriodo = p => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const inicioDePeriodo = p => p + '-01';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mxn = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
const fechaLarga = iso => iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—';

module.exports = { clabeValida, digitoClabe, sha256, csv, hoyMx, periodoDe, finDePeriodo, inicioDePeriodo, esc, mxn, fechaLarga };
