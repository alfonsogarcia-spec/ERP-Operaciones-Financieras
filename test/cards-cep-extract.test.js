// Extracción de datos de un CEP (PDF/XML). Los ejemplos son inventados pero con la MISMA estructura que los CEP reales.
const test = require('node:test'), assert = require('node:assert/strict');
const E = require('../lib/cards-cep-extract');
const { clabeValida } = require('../lib/cards-fondeo');

const clabe = p17 => p17 + String((10 - ([...p17].reduce((s, d, i) => s + (Number(d) * [3, 7, 1][i % 3]) % 10, 0) % 10)) % 10);
const ORD = clabe('68418029700600000'), BEN = clabe('64618017181560001');
assert.ok(clabeValida(ORD) && clabeValida(BEN));

// Texto como lo entrega el lector de PDF del CEP de Banxico (etiquetas y valores en bloques separados).
const textoBanxico = (extra = {}) => `
horas
Fecha de consulta
12 de junio de 2026
COMPROBANTE   ELECTRÓNICO   DE   PAGO
Concepto del pago
Monto
IVA
Referencia numérica
Clave de rastreo
10 de junio de 2026
${extra.concepto || 'FONDEO ACME'}
$ 301,740.00
$ 0.00
1100626
2026061090646AWS29740AC7580BA3
Fecha de operación en el SPEI®
10 de junio de 2026
12:02:58 horas
Fecha de abono en la cuenta beneficiaria*
Ordenante
Institución emisora del pago
Beneficiario
Cadena Original (información del pago):
||1|10062026|10062026|120258|90646|BANCO EJEMPLO|ACME SA DE
CV|40|${ORD}|ACM010101AAA|STP|CARDS BSO SA DE
CV|40|${extra.ben || BEN}|CBS200101XX1|${extra.concepto || 'FONDEO ACME'}|0.00|${extra.monto || '301740.00'}|NA|NA|0|0|NA|0|0.00|NA|NA|00001000000700974929||
Sello Digital (firma provista por la institución receptora del pago):
clpywAl0CPFfQbedpQoQglmeP3v7eOv1GrGgRQ==
`;
const textoPolipay = `Comprobante de dispersión
Fecha - Hora:16/10/2026 09:41:10 horas
Empresa:BANCO EJEMPLO
Titular del Ordenante:ACME SA DE CV
CLABE del Ordenante:${ORD}
Titular del Beneficiario:CARDS BSO
CLABE del Beneficiario:${BEN}
Banco destino:ASP Integra OPC
Monto:$17,053.54 MXN
Concepto:Retorno de Comisiones
Referencia numérica:9417078
Clave de rastreo:PPQQB722UVGVI5PU24161026094109
Tipo de operación:Polipay a Polipay`;
const textoConsulta = `Información del estado del pago
Lo sentimos, por el momento no es posible generar el CEP.
Número de Referencia 1300626
Clave de Rastreo 2026063090684AWS297CFB3A268824
Institución emisora del pago TRANSFER
Institución receptora del pago STP
Estado del pago en Banxico Liquidado
Fecha y hora de recepción 30/06/2026 12:58:51
Cuenta Beneficiaria ${BEN}
Monto 935.97
IMPORTANTE: Esta consulta no es un Comprobante Electrónico de Pago (CEP).`;


// PDF mínimo hecho a mano (sin dependencias): una página con un renglón de texto por línea. `texto` = null → página sin texto.
function pdfMinimo(lineas) {
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const cont = lineas ? 'BT /F1 9 Tf 40 760 Td 11 TL\n' + lineas.map(l => `(${esc(l)}) Tj T*`).join('\n') + '\nET' : '0.8 g 50 50 100 100 re f';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(cont, 'latin1')} >>\nstream\n${cont}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  let out = '%PDF-1.4\n'; const pos = [];
  objs.forEach((o, i) => { pos.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + pos.map(p => String(p).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

test('CEP de Banxico: la cadena original da monto, fecha, hora, cuentas y partes; el rastreo sale de las etiquetas', () => {
  const r = E.parseBanxicoPdf(textoBanxico());
  const d = r.datos;
  assert.equal(r.confianza, 'alta');
  assert.equal(d.cadena_original, true);
  assert.equal(d.monto, 301740);
  assert.equal(d.fecha_abono, '2026-06-10');
  assert.equal(d.hora_abono, '12:02:58');
  assert.equal(d.clave_rastreo, '2026061090646AWS29740AC7580BA3');
  assert.equal(d.referencia, '1100626');
  assert.equal(d.beneficiario.cuenta, BEN);
  assert.equal(d.beneficiario.nombre, 'CARDS BSO SA DE CV');   // el nombre venía partido en dos renglones
  assert.equal(d.beneficiario.rfc, 'CBS200101XX1');
  assert.equal(d.ordenante.nombre, 'ACME SA DE CV');
  assert.equal(d.ordenante.rfc, 'ACM010101AAA');
  assert.equal(d.ordenante.cuenta, ORD);
  assert.equal(d.concepto, 'FONDEO ACME');
  assert.equal(d.certificado, '00001000000700974929');
  assert.deepEqual(r.avisos, []);
});
test('CEP de Banxico: si el monto impreso no coincide con la cadena firmada, avisa', () => {
  const r = E.parseBanxicoPdf(textoBanxico({ monto: '999.00' }));
  assert.equal(r.datos.monto, 999);
  assert.ok(r.avisos.some(a => /no coincide/i.test(a)));
});
test('comprobante de dispersión de Polipay', () => {
  const r = E.parsePolipay(textoPolipay);
  assert.equal(r.confianza, 'alta');
  assert.equal(r.datos.monto, 17053.54);
  assert.equal(r.datos.fecha_abono, '2026-10-16');
  assert.equal(r.datos.hora_abono, '09:41:10');
  assert.equal(r.datos.clave_rastreo, 'PPQQB722UVGVI5PU24161026094109');
  assert.equal(r.datos.beneficiario.cuenta, BEN);
  assert.equal(r.datos.ordenante.nombre, 'ACME SA DE CV');
  assert.equal(r.datos.referencia, '9417078');
});
test('consulta de estado de Banxico: se lee pero se avisa que NO es un CEP', () => {
  const r = E.parseConsultaEstado(textoConsulta);
  assert.equal(r.es_cep, false);
  assert.equal(r.datos.monto, 935.97);
  assert.equal(r.datos.fecha_abono, '2026-06-30');
  assert.equal(r.datos.beneficiario.cuenta, BEN);
  assert.match(r.avisos[0], /NO es un CEP/);
});
test('XML del CEP (atributos de SPEI_Tercero / Beneficiario / Ordenante)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><SPEI_Tercero FechaOperacion="2026-06-10" FechaAbono="2026-06-10" Hora="12:02:58" claveRastreo="ABC123XYZ" numeroCertificado="0000100">
    <Beneficiario BancoReceptor="STP" Nombre="CARDS BSO" TipoCuenta="40" Cuenta="${BEN}" RFC="CBS200101XX1" Concepto="FONDEO" IVA="0.00" MontoPago="301740.00"/>
    <Ordenante BancoEmisor="BANCO EJEMPLO" Nombre="ACME" TipoCuenta="40" Cuenta="${ORD}" RFC="ACM010101AAA"/></SPEI_Tercero>`;
  const r = E.parseXml(xml);
  assert.equal(r.datos.monto, 301740);
  assert.equal(r.datos.clave_rastreo, 'ABC123XYZ');
  assert.equal(r.datos.fecha_abono, '2026-06-10');
  assert.equal(r.datos.beneficiario.cuenta, BEN);
  assert.equal(r.datos.ordenante.rfc, 'ACM010101AAA');
});
test('XML ajeno no revienta ni inventa datos; entidades externas no se expanden', () => {
  const r = E.parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>');
  assert.equal(r.datos.monto, null);
  assert.equal(r.datos.clave_rastreo, null);
  assert.equal(r.confianza, 'baja');
});
test('PDF genérico: solo lo que se puede validar (CLABE con verificador) y siempre confianza baja', () => {
  const r = E.parseGenerico(`Recibo de transferencia\nFecha: 03/07/2026\nClave de rastreo: BNET0123456789\nImporte: $1,250.00\nCuenta destino ${BEN}\nOtro número 123456789012345678`);
  assert.equal(r.confianza, 'baja');
  assert.equal(r.datos.monto, 1250);
  assert.equal(r.datos.clave_rastreo, 'BNET0123456789');
  assert.equal(r.datos.beneficiario.cuenta, BEN);
  assert.equal(r.datos.fecha_abono, '2026-07-03');
});
test('fechas largas y compactas', () => {
  assert.equal(E.fechaLarga('10 de junio de 2026'), '2026-06-10');
  assert.equal(E.fechaLarga('1 de septiembre de 2026'), '2026-09-01');
  assert.equal(E.fechaLarga('31 de febrero de 2026'), null);
  assert.equal(E.fechaCompacta('10062026'), '2026-06-10');
  assert.equal(E.fechaCompacta('32062026'), null);
});

test('verificación contra lo capturado: monto, CLABE y rastreo son duros; la fecha solo avisa', () => {
  const datos = E.parseBanxicoPdf(textoBanxico()).datos;
  const ok = E.verificar(datos, { monto_recibido: 301740, clabe_destino: BEN, clave_rastreo: '2026061090646aws29740ac7580ba3', fecha: '2026-06-10' });
  assert.equal(ok.coincide, true); assert.equal(ok.conflicto, false);
  const mal = E.verificar(datos, { monto_recibido: 300000, clabe_destino: BEN, clave_rastreo: null, fecha: '2026-06-11' });
  assert.equal(mal.conflicto, true);
  assert.equal(mal.checks.find(c => c.campo === 'monto').estado, 'difiere');
  assert.equal(mal.checks.find(c => c.campo === 'rastreo').estado, 'difiere');   // el CEP trae rastreo y lo capturado no
  assert.equal(mal.checks.find(c => c.campo === 'fecha').duro, false);
  const soloFecha = E.verificar(datos, { monto_recibido: 301740, clabe_destino: BEN, clave_rastreo: '2026061090646AWS29740AC7580BA3', fecha: '2026-06-11' });
  assert.equal(soloFecha.conflicto, false);
  assert.equal(soloFecha.coincide, false);
  const otraClabe = E.verificar(datos, { monto_recibido: 301740, clabe_destino: ORD, clave_rastreo: null, fecha: '2026-06-10' });
  assert.equal(otraClabe.checks.find(c => c.campo === 'clabe').estado, 'difiere');
});

test('de punta a punta con un PDF de verdad (armado a mano): lee el texto y reconoce el formato', async () => {
  const r = await E.extraerCep(pdfMinimo(textoPolipay.split('\n')), 'application/pdf');
  assert.equal(r.formato, 'dispersion_polipay');
  assert.equal(r.legible, true);
  assert.equal(r.datos.monto, 17053.54);
  assert.equal(r.datos.beneficiario.cuenta, BEN);
});
test('PDF sin texto (escaneado) e imágenes: no inventa datos', async () => {
  const a = await E.extraerCep(pdfMinimo(null), 'application/pdf');
  assert.equal(a.legible, false); assert.equal(a.formato, 'pdf_sin_texto');
  const b = await E.extraerCep(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
  assert.equal(b.legible, false); assert.equal(b.formato, 'imagen');
  const c = await E.extraerCep(Buffer.from('%PDF-1.4 roto'), 'application/pdf');
  assert.equal(c.legible, false); assert.equal(c.formato, 'error');
});
