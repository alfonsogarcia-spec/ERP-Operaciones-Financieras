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

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', cellStyles: true });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

module.exports = { buildLayoutPolipay };
