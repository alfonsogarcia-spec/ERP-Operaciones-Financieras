/* ============================================================================
   scripts/dividir-cumplimiento.js — Divide un Excel GRANDE del gateway en CSV para cargar en Cumplimiento (PLD).
   La carga del sistema admite hasta 25 MB y 30,000 filas por Excel (100,000 por CSV): un export de cientos de miles
   de filas se sube en varios archivos. Se lee por flujo (memoria acotada) y se normaliza el estatus APROBADA → APROBADO.

   Uso:  node scripts/dividir-cumplimiento.js <archivo.xlsx> [--salida carpeta] [--filas 50000]
   ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path');
const ExcelJS = require('exceljs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const ORIGEN = process.argv[2]; if (!ORIGEN || ORIGEN.startsWith('--')) { console.error('Uso: node scripts/dividir-cumplimiento.js <archivo.xlsx> [--salida carpeta] [--filas 50000]'); process.exit(1); }
const SALIDA = path.resolve(arg('salida', path.join(process.cwd(), 'cargas-pld'))), POR_ARCHIVO = Math.max(1000, Math.min(90000, parseInt(arg('filas', '50000'), 10) || 50000));
fs.mkdirSync(SALIDA, { recursive: true });
const celda = v => { if (v == null) return ''; if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' '); if (typeof v === 'object') v = v.result !== undefined ? v.result : (v.text !== undefined ? v.text : String(v)); const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const fechaIso = s => { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : (String(s || '').match(/^\d{4}-\d{2}-\d{2}/) || [null])[0]; };

(async () => {
  const rd = new ExcelJS.stream.xlsx.WorkbookReader(ORIGEN, { sharedStrings: 'cache', styles: 'ignore', worksheets: 'emit', hyperlinks: 'ignore' });
  let head = null, iFecha = -1, iEst = -1, iId = -1, iBin = -1, iTerm = -1, iAfil = -1, iTipo = -1;
  let total = 0, archivo = 0, enArchivo = 0, ws_ = null, nombres = [], ini = null, fin = null;
  const est = {}, tipo = {}, mes = {}, ids = new Set(), terms = new Set(), afils = new Set(); let dupIds = 0, sinBin = 0, minF = null, maxF = null;
  const abrir = () => { archivo++; const nombre = `pld_${String(archivo).padStart(2, '0')}.csv`; nombres.push({ nombre, filas: 0, desde: null, hasta: null }); ws_ = fs.createWriteStream(path.join(SALIDA, nombre), { encoding: 'utf8' }); ws_.write('﻿' + head.join(',') + '\n'); enArchivo = 0; };
  const cerrar = () => new Promise(r => { if (!ws_) return r(); ws_.end(r); });
  for await (const ws of rd) {
    for await (const row of ws) {
      const v = row.values.slice(1);
      if (!head) { head = v.map(x => String(x == null ? '' : x).trim()); const f = n => head.findIndex(h => h.toLowerCase() === n); iFecha = f('fecha local'); iEst = f('estatus'); iId = f('id'); iBin = f('bin'); iTerm = f('terminal'); iAfil = f('afiliación'); iTipo = f('tipo trans.'); continue; }
      if (v.every(x => x == null || x === '')) continue;
      if (enArchivo >= POR_ARCHIVO) { await cerrar(); abrir(); } else if (!ws_) abrir();
      const fila = head.map((_, i) => v[i]);
      if (iEst >= 0 && /^APROBAD[AO]S?$/i.test(String(fila[iEst] || '').trim())) fila[iEst] = 'APROBADO';   // el export usa "APROBADA"
      ws_.write(fila.map(celda).join(',') + '\n'); enArchivo++; total++;
      const cur = nombres[nombres.length - 1]; cur.filas++;
      const f = fechaIso(fila[iFecha]); if (f) { if (!cur.desde || f < cur.desde) cur.desde = f; if (!cur.hasta || f > cur.hasta) cur.hasta = f; if (!minF || f < minF) minF = f; if (!maxF || f > maxF) maxF = f; mes[f.slice(0, 7)] = (mes[f.slice(0, 7)] || 0) + 1; }
      const e = String(fila[iEst] || '(vacío)').toUpperCase(); est[e] = (est[e] || 0) + 1; const t = String(fila[iTipo] || '(vacío)').toUpperCase(); tipo[t] = (tipo[t] || 0) + 1;
      if (iId >= 0) { const id = String(fila[iId]); if (ids.has(id)) dupIds++; else ids.add(id); }
      if (!/^\d{6,}/.test(String(fila[iBin] || ''))) sinBin++;
      if (fila[iTerm]) terms.add(String(fila[iTerm])); if (fila[iAfil]) afils.add(String(fila[iAfil]));
      if (total % 100000 === 0) process.stderr.write(`  ${total} filas…\n`);
    }
    break;   // solo la primera hoja
  }
  await cerrar();
  const resumen = { origen: ORIGEN, filas: total, archivos: nombres, desde: minF, hasta: maxF, columnas: head, estatus: est, tipo_trans: tipo, filas_por_mes: mes, terminales: terms.size, afiliaciones: afils.size, ids_duplicados: dupIds, sin_bin_valido: sinBin };
  fs.writeFileSync(path.join(SALIDA, 'resumen.json'), JSON.stringify(resumen, null, 1));
  console.log(JSON.stringify({ filas: total, archivos: nombres.length, desde: minF, hasta: maxF, estatus: est, tipo_trans: tipo, terminales: terms.size, afiliaciones: afils.size, ids_duplicados: dupIds, sin_bin_valido: sinBin }, null, 1));
  console.log('\nFilas por mes:', JSON.stringify(mes)); console.log('\nArchivos:'); nombres.forEach(n => console.log(`  ${n.nombre}  ${n.filas} filas  ${n.desde} → ${n.hasta}  ${(fs.statSync(path.join(SALIDA, n.nombre)).size / 1048576).toFixed(1)} MB`));
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
