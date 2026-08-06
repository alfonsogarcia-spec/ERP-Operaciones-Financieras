/* ============================================================================
   lib/excel.js — Lectura y generación de Excel EN EL SERVIDOR (paquete `xlsx`).
   El navegador ya no parsea ni genera Excel: sube el archivo y descarga lo que
   genera el server.
   ========================================================================= */
'use strict';
const XLSX = require('xlsx');
const { normStr } = require('../engine.js');

const TX_COLS = ['fecha','hora','cliente','comercio','numero_afiliacion','estatus','metodo','producto','monto','folio','referencia','autorizacion','terminal'];

// Alias de encabezados comunes del gateway → columnas canónicas.
const TX_ALIAS = {
  fecha:['fecha','fecha_operacion','fecha_transaccion','fecha_venta','fecha_de_operacion','date'],
  hora:['hora','time','hora_operacion','hora_transaccion'],
  cliente:['cliente','grupo','nombre_cliente','nombre_del_cliente','razon_social_cliente'],
  comercio:['comercio','nombre_comercio','nombre_del_comercio','merchant'],
  numero_afiliacion:['numero_afiliacion','afiliacion','no_afiliacion','num_afiliacion','numero_de_afiliacion','no_de_afiliacion','id_afiliacion'],
  estatus:['estatus','estado','status'],
  metodo:['metodo','marca','red','tipo_de_tarjeta','tarjeta'],
  producto:['producto','tipo_producto','tipo_de_producto','producto_tarjeta'],
  monto:['monto','importe','monto_venta','monto_de_venta','monto_operacion','monto_de_la_operacion','monto_transaccion','monto_de_la_transaccion','monto_mxn','importe_venta','importe_transaccion','importe_de_la_transaccion','importe_mxn','venta','valor','amount','total'],
  folio:['folio','no_folio'], referencia:['referencia','ref'],
  autorizacion:['autorizacion','codigo_autorizacion','no_autorizacion','auth'], terminal:['terminal','no_terminal'],
};
function pickCol(o, field) {
  for (const a of (TX_ALIAS[field] || [field])) { if (o[a] != null && String(o[a]).trim() !== '') return o[a]; }
  return o[field] != null ? o[field] : '';
}

// Encabezado normalizado: sin acentos, minúsculas, guion_bajo.
function normHeader(h) { return normStr(h).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

function aoaToObjects(aoa) {
  if (!aoa || !aoa.length) return [];
  const head = aoa[0].map(normHeader);
  return aoa.slice(1).filter(r => r && r.some(c => c != null && String(c).trim() !== ''))
    .map(r => { const o = {}; head.forEach((h, i) => o[h] = (r[i] != null ? r[i] : '')); return o; });
}

// Lee un archivo (Buffer .xlsx/.xls) → array de objetos. Fechas como Date, resto crudo.
// Elige la hoja con MÁS filas de datos (evita quedarse con hojas de detalle/pivote).
function parseBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  let best = null;
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });
    const objs = aoaToObjects(aoa);
    if (!best || objs.length > best.objs.length) best = { name, objs, headers: aoa.length ? aoa[0].map(normHeader) : [] };
  }
  return best || { objs: [], headers: [] };
}

// Parseo de CSV/TSV pegado (respaldo)
function parseCSVText(text) {
  text = String(text).replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const rows = []; let i = 0, f = '', row = [], q = false;
  const first = text.split('\n')[0] || '';
  const delim = first.includes('\t') && !first.includes(',') ? '\t' : ',';
  while (i < text.length) { const ch = text[i];
    if (q) { if (ch === '"') { if (text[i+1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; } f += ch; i++; continue; }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === delim) { row.push(f); f = ''; i++; continue; }
    if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; continue; }
    f += ch; i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const aoa = rows.filter(r => r.some(c => String(c).trim() !== ''));
  return { objs: aoaToObjects(aoa), headers: aoa.length ? aoa[0].map(normHeader) : [] };
}

// Genera un Buffer .xlsx. sheets: [{name, aoa, cols}]
// Aplica estilo a una celda (crea la celda como string vacío si no existe, para permitir fondos en celdas mergeadas).
// Estilo shape: { fill:'RRGGBB', font:{color,bold,size,name}, align:{h,v,wrap}, border, numFmt }
function applyCellStyle(ws, addr, st) {
  if (!ws[addr]) ws[addr] = { t: 's', v: '' };
  ws[addr].s = Object.assign({}, ws[addr].s || {}, styleObj(st));
}
function styleObj(st) {
  const s = {};
  if (st.fill) s.fill = { patternType: 'solid', fgColor: { rgb: st.fill }, bgColor: { rgb: st.fill } };
  if (st.font) {
    s.font = {};
    if (st.font.color) s.font.color = { rgb: st.font.color };
    if (st.font.bold != null) s.font.bold = !!st.font.bold;
    if (st.font.size) s.font.sz = st.font.size;
    if (st.font.name) s.font.name = st.font.name;
  }
  if (st.align) {
    s.alignment = {};
    if (st.align.h) s.alignment.horizontal = st.align.h;
    if (st.align.v) s.alignment.vertical = st.align.v;
    if (st.align.wrap) s.alignment.wrapText = true;
  }
  if (st.border) s.border = st.border;
  if (st.numFmt) s.numFmt = st.numFmt;
  return s;
}

function buildXLSX(sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(s => {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    if (s.cols) ws['!cols'] = s.cols;
    if (s.rows) ws['!rows'] = s.rows;              // alturas de fila [{hpt: 33.75}, ...]
    if (s.merges) ws['!merges'] = s.merges;         // celdas combinadas: [{s:{r,c},e:{r,c}}]
    if (s.freeze) {                                 // ej. {xSplit:0, ySplit:5, topLeftCell:'A6'}
      // SheetJS soporta !views con {state:'frozen', xSplit, ySplit, topLeftCell}
      ws['!views'] = [{ state: 'frozen', xSplit: s.freeze.xSplit || 0, ySplit: s.freeze.ySplit || 0, topLeftCell: s.freeze.topLeftCell || 'A1' }];
    }
    // Formato de número por columnas: s.fmt = { z, cols:[idx...], rowFrom }
    if (s.fmt) {
      const range = XLSX.utils.decode_range(ws['!ref']);
      const rowFrom = s.fmt.rowFrom || 0;
      for (let r = rowFrom; r <= range.e.r; r++) {
        for (const c of s.fmt.cols) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (cell && cell.t === 'n') cell.z = s.fmt.z;
        }
      }
    }
    // Estilos por celda: s.styles = [{ range:'A1:L1', style:{fill,font,align,numFmt} }, { cell:'A5', style:{...} }]
    if (s.styles) {
      for (const st of s.styles) {
        if (st.cell) applyCellStyle(ws, st.cell, st.style);
        else if (st.range) {
          const rg = XLSX.utils.decode_range(st.range);
          for (let r = rg.s.r; r <= rg.e.r; r++) for (let c = rg.s.c; c <= rg.e.c; c++) {
            applyCellStyle(ws, XLSX.utils.encode_cell({ r, c }), st.style);
          }
        }
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, (s.name || 'Hoja1').slice(0, 31));
  });
  // cellStyles:true asegura que los estilos se escriban al xlsx
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

module.exports = { TX_COLS, TX_ALIAS, pickCol, normHeader, aoaToObjects, parseBuffer, parseCSVText, buildXLSX };
