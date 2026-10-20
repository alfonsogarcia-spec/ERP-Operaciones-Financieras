/* ============================================================================
   scripts/generar-catalogo-mcc.js — Genera lib/mcc-catalogo.json (catálogo de MCC preestablecidos) desde un Excel
   con dos columnas: MCC y Descripción (primera hoja, encabezado en la fila 1).
   Uso:  node scripts/generar-catalogo-mcc.js "<ruta>/BD MCC.xlsx"
   Los MCC de 3 dígitos (Excel pierde el cero inicial: 742 → 0742) se respetan como número.
   ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path'), ExcelJS = require('exceljs');
const origen = process.argv[2]; if (!origen) { console.error('Uso: node scripts/generar-catalogo-mcc.js <BD MCC.xlsx>'); process.exit(1); }
(async () => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(origen); const ws = wb.worksheets[0];
  const vistos = new Map(), avisos = []; let n = 0;
  ws.eachRow((row, i) => {
    if (i === 1) return; const v = row.values.slice(1).map(x => x && x.result !== undefined ? x.result : x);
    const mcc = String(v[0] == null ? '' : v[0]).trim(), desc = String(v[1] == null ? '' : v[1]).replace(/\s+/g, ' ').trim();
    if (!mcc && !desc) return; n++;
    if (!/^\d{1,4}$/.test(mcc) || Number(mcc) < 1) { avisos.push(`fila ${i}: MCC inválido "${mcc}"`); return; }
    if (!desc) { avisos.push(`fila ${i}: MCC ${mcc} sin descripción`); return; }
    const k = Number(mcc); if (vistos.has(k)) { avisos.push(`fila ${i}: MCC ${mcc} repetido (se conserva el primero)`); return; }
    vistos.set(k, desc.slice(0, 300));
  });
  const cat = [...vistos.entries()].sort((a, b) => a[0] - b[0]).map(([mcc, descripcion]) => ({ mcc, descripcion }));
  fs.writeFileSync(path.join(__dirname, '..', 'lib', 'mcc-catalogo.json'), JSON.stringify(cat, null, 1) + '\n');
  console.log(`Leídas ${n} filas → ${cat.length} MCC en lib/mcc-catalogo.json`); avisos.forEach(a => console.log('  ⚠ ' + a));
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
