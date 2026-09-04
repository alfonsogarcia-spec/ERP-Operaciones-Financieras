// Genera el layout SPEI usando el template oficial `assets/polipay-layout-2025.xlsx`.
// El template se conserva TAL CUAL (hojas, fórmulas del template, formato,
// dropdowns intactos). Sólo se rellenan las 5 columnas de datos que pidió
// el usuario en la hoja "Archivo de dispersion":
//   F CUENTA_BENEFICIARIO · I NOMBRE_BENEFICIARIO · M MONTO ·
//   N CONCEPTO_PAGO · O REFERENCIA_NUMERICA
// Cualquier otra celda (G SELECCION BANCO, H CLAVE_RASTREO, J RFC_CURP,
// K TIPO_PAGO, L TIPO_CUENTA — que son fórmulas del template — y la hoja
// "Layout para pagos") NO se toca.
//
// Se usa SheetJS (`xlsx`) porque ExcelJS tarda >2 minutos leyendo un template
// con 4997 filas con fórmulas; SheetJS lo hace en milisegundos.

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'polipay-layout-2025.xlsx');
let _templateBuf = null;
function loadTemplate() {
  if (_templateBuf) return _templateBuf;
  if (!fs.existsSync(TEMPLATE_PATH)) throw new Error('template_polipay_layout_no_existe: ' + TEMPLATE_PATH);
  _templateBuf = fs.readFileSync(TEMPLATE_PATH);
  return _templateBuf;
}

// Elimina todas las filas > maxRow del worksheet (celdas + rango + metadatos
// de fila `!rows` que traen customHeight/height para las 4997 filas del
// template original y que si no se recortan explotan el tamaño del archivo).
function trimSheet(ws, maxRow) {
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith('!')) continue;
    const m = addr.match(/^[A-Z]+(\d+)$/);
    if (m && parseInt(m[1], 10) > maxRow) delete ws[addr];
  }
  if (ws['!ref']) {
    const range = require('xlsx').utils.decode_range(ws['!ref']);
    if (range.e.r >= maxRow) range.e.r = maxRow - 1;
    ws['!ref'] = require('xlsx').utils.encode_range(range);
  }
  if (Array.isArray(ws['!rows']) && ws['!rows'].length > maxRow) {
    ws['!rows'].length = maxRow;
  }
  // El template define customWidth para cientos de columnas vacías (hasta col
  // ~50+) que engordan cada hoja. Sólo conservamos anchos hasta la última
  // columna en uso según !ref.
  if (Array.isArray(ws['!cols']) && ws['!ref']) {
    const XLSX2 = require('xlsx');
    const range = XLSX2.utils.decode_range(ws['!ref']);
    const maxCol = range.e.c + 1;
    if (ws['!cols'].length > maxCol) ws['!cols'].length = maxCol;
  }
}

function setCell(ws, addr, value) {
  if (value === undefined || value === null || value === '') {
    if (ws[addr]) delete ws[addr];
    return;
  }
  const t = typeof value === 'number' ? 'n' : 's';
  ws[addr] = { t, v: value };
}

async function buildLayoutPolipay(orders, referencia) {
  const wb = XLSX.read(loadTemplate(), { cellFormula: true, cellStyles: true, cellNF: true });
  const ws = wb.Sheets['Archivo de dispersion'];
  if (!ws) throw new Error('template_hoja_archivo_de_dispersion_faltante');

  orders.forEach((o, i) => {
    const r = i + 2; // fila 1 es el encabezado del template
    setCell(ws, 'F' + r, String(o.clabe || ''));            // CUENTA_BENEFICIARIO
    setCell(ws, 'I' + r, o.razon || o.benef || '');         // NOMBRE_BENEFICIARIO
    setCell(ws, 'M' + r, Number(o.cant) || 0);              // MONTO
    setCell(ws, 'N' + r, o.concepto || '');                 // CONCEPTO_PAGO
    setCell(ws, 'O' + r, Number(referencia) || referencia); // REFERENCIA_NUMERICA
  });

  // Eliminar los comentarios de celda del template (los "tooltips amarillos"
  // que Monica Nieto puso en A1..Q1 explicando cada columna). El usuario no
  // los quiere en el archivo final; SheetJS los expone como .c en cada celda,
  // basta con borrar la propiedad para que no se re-escriban.
  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name];
    for (const addr of Object.keys(sh)) {
      if (addr.startsWith('!')) continue;
      if (sh[addr] && sh[addr].c) delete sh[addr].c;
    }
    if (sh['!comments']) delete sh['!comments'];
  }

  // Recortar filas sobrantes del template. El template trae 4997 filas con
  // fórmulas repetidas → archivo de ~11MB que rebota SES (>10MB) y no arma
  // el correo del corte. Dejamos las filas de datos + un buffer razonable
  // (100 filas extra) por si el usuario quiere agregar órdenes a mano en
  // Excel; el archivo queda en cientos de KB.
  const EXTRA = 20;
  const dispKeep = orders.length + 1 + EXTRA; // header + datos + buffer
  trimSheet(ws, dispKeep);
  // "Layout para pagos" no la llenamos y no tiene fórmulas útiles del template;
  // la dejamos con solo el header para que exista pero pese casi nada.
  const wsPay = wb.Sheets['Layout para pagos'];
  if (wsPay) trimSheet(wsPay, 1);
  // BASE BANCOS: mantener todas las filas (necesarias para VLOOKUP) pero
  // recortar los cientos de anchos de columnas vacías que trae el template.
  const wsBase = wb.Sheets['BASE BANCOS'];
  if (wsBase) trimSheet(wsBase, wsBase['!ref'] ? require('xlsx').utils.decode_range(wsBase['!ref']).e.r + 1 : 1000);

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', cellStyles: true });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

module.exports = { buildLayoutPolipay };
