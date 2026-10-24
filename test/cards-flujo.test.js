// Flujo de fondeos de Cards: qué CEP se acepta, permisos por estatus y correos.
const test = require('node:test'), assert = require('node:assert/strict');
const FL = require('../lib/cards-flujo');
const { armarCorreoFondeo } = require('../lib/cards-correo');

const CLABE = '012180000000001014', OTRA = '646180171815600015';
const cep = (o = {}) => ({
  formato: 'cep_banxico', es_cep: null, legible: true, confianza: 'alta',
  datos: { monto: 301740, clave_rastreo: 'RAST0001', fecha_abono: '2026-10-22', ordenante: { nombre: 'ACME SA DE CV', rfc: 'ACM010101AAA', institucion: 'BANCO EJEMPLO' }, beneficiario: { cuenta: CLABE }, ...o.datos },
  ...o.top,
});
const ctx = (o = {}) => ({ clabe_destino: CLABE, empresa_nombre: 'Acme SA', empresa_rfc: 'ACM010101AAA', monto_esperado: 301740, rastreos_previos: [], hoy: '2026-10-23', ...o });

test('un CEP de Banxico que cuadra se acepta y trae lo que se aplicará a la solicitud', () => {
  const r = FL.evaluarCep(cep(), ctx());
  assert.equal(r.ok, true); assert.deepEqual(r.avisos, []);
  assert.deepEqual(r.aplicar, { monto: 301740, fecha: '2026-10-22', clave_rastreo: 'RAST0001', banco_ordenante: 'BANCO EJEMPLO', ordenante_nombre: 'ACME SA DE CV', ordenante_rfc: 'ACM010101AAA' });
});
test('solo se aceptan CEP: consulta de estado, imagen, PDF sin texto, genérico o ilegible se rechazan', () => {
  for (const formato of ['consulta_estado_banxico', 'imagen', 'pdf_sin_texto', 'pdf_generico', 'desconocido']) {
    const r = FL.evaluarCep(cep({ top: { formato, es_cep: formato === 'consulta_estado_banxico' ? false : null } }), ctx());
    assert.equal(r.ok, false, formato); assert.equal(r.errores[0].codigo, 'no_es_cep'); assert.match(r.errores[0].mensaje, /Solo se aceptan CEP/);
  }
});
test('si el sistema falla al abrir el archivo, no se culpa al documento', () => {
  const r = FL.evaluarCep(cep({ top: { formato: 'error', avisos: ['No se pudo leer el archivo.'] } }), ctx());
  assert.equal(r.ok, false); assert.equal(r.errores[0].codigo, 'lectura_fallida');
  assert.match(r.errores[0].mensaje, /No se pudo leer el archivo.*fallo temporal/); assert.doesNotMatch(r.errores[0].mensaje, /Solo se aceptan CEP/);
});
test('el XML y el comprobante de dispersión de Polipay sí cuentan (este último con aviso)', () => {
  assert.equal(FL.evaluarCep(cep({ top: { formato: 'xml' } }), ctx()).ok, true);
  const p = FL.evaluarCep(cep({ top: { formato: 'dispersion_polipay' } }), ctx());
  assert.equal(p.ok, true); assert.match(p.avisos[0], /no un CEP de Banxico/);
});
test('CLABE beneficiaria distinta a la de la empresa → se rechaza', () => {
  const r = FL.evaluarCep(cep({ datos: { beneficiario: { cuenta: OTRA } } }), ctx());
  assert.equal(r.ok, false); assert.equal(r.errores[0].codigo, 'clabe_distinta'); assert.match(r.errores[0].mensaje, /…5600015|…0015/);
});
test('CEP incompleto, fecha futura y CEP de otro depósito → se rechazan', () => {
  assert.equal(FL.evaluarCep(cep({ datos: { monto: null } }), ctx()).errores[0].codigo, 'cep_incompleto');
  assert.equal(FL.evaluarCep(cep({ datos: { clave_rastreo: null } }), ctx()).errores[0].codigo, 'cep_incompleto');
  assert.equal(FL.evaluarCep(cep({ datos: { fecha_abono: '2026-12-01' } }), ctx()).errores[0].codigo, 'fecha_futura');
  const d = FL.evaluarCep(cep(), ctx({ rastreos_previos: ['OTRA-CLAVE'] }));
  assert.equal(d.ok, false); assert.equal(d.errores[0].codigo, 'cep_distinto');
  assert.equal(FL.evaluarCep(cep(), ctx({ rastreos_previos: ['rast0001'] })).ok, true);  // el XML del mismo pago, sin importar mayúsculas
});
test('monto distinto del esperado y RFC distinto: se aceptan pero avisan a tesorería', () => {
  const r = FL.evaluarCep(cep({ datos: { monto: 300000, ordenante: { rfc: 'XAXX010101000', institucion: 'B' } } }), ctx());
  assert.equal(r.ok, true); assert.equal(r.avisos.length, 2);
  assert.match(r.avisos[0], /se esperaban/); assert.match(r.avisos[1], /tercero/);
});

test('permisos por rol de Cards y estatus', () => {
  const p = (est, rol, suyo) => FL.permisos(est, rol, suyo);
  // comercial: solo lo suyo, solo mientras está abierto, nunca asigna ni rechaza
  assert.deepEqual([p('SOLICITADO', 'comercial', true).subir_cep, p('SOLICITADO', 'comercial', true).cancelar, p('SOLICITADO', 'comercial', true).asignar], [true, true, false]);
  assert.equal(p('POR_ASIGNAR', 'comercial', true).cancelar, false);            // ya está con tesorería
  assert.equal(p('RECHAZADO', 'comercial', true).subir_cep, true);
  assert.equal(p('SOLICITADO', 'comercial', false).subir_cep, false);          // de otro comercial
  assert.equal(p('ASIGNADO', 'comercial', true).subir_cep, false);
  // administrador (de POS o de Cards): todo; cancelar un asignado solo ellos
  for (const rol of ['admin', 'cards_admin']) {
    assert.equal(p('POR_ASIGNAR', rol).asignar, true, rol); assert.equal(p('POR_ASIGNAR', rol).rechazar, true, rol); assert.equal(p('SOLICITADO', rol).asignar, false, rol);
    assert.equal(p('ASIGNADO', rol).cancelar, true, rol); assert.equal(p('CANCELADO', rol).cancelar, false, rol); assert.equal(p('SOLICITADO', rol).subir_cep, true, rol);
  }
  // tesorería de Cards: asigna o rechaza lo que está por asignar y sube el comprobante; nada más
  const t = p('POR_ASIGNAR', 'cards_tesoreria');
  assert.deepEqual([t.asignar, t.rechazar, t.comprobante, t.quitar_comprobante], [true, true, true, true]);
  assert.deepEqual([t.subir_cep, t.quitar_cep, t.cancelar, t.editar], [false, false, false, false]);
  assert.equal(p('SOLICITADO', 'cards_tesoreria').asignar, false);
  assert.equal(p('ASIGNADO', 'cards_tesoreria').cancelar, false);
  // los demás solo miran (incluidos los roles de POS, que ya no tienen acceso a Cards por sí mismos)
  for (const rol of ['cards_consulta', 'tesoreria', 'operador', 'bancos', 'consulta', null]) assert.equal(Object.values(p('POR_ASIGNAR', rol)).some(Boolean), false, String(rol));
});

test('correo por asignar: asunto, destino, avisos y datos escapados', () => {
  const f = { folio: 'FND-2026-000001', ruta: 'Acme <SA>', empresa_nombre: 'Acme <SA>', fondeo: 300000, comision: 1500, iva: 240, monto_recibido: 301740, clave_rastreo: 'RAST0001', fecha_iso: '2026-10-22', solicitante_nombre: 'Ana "Comercial"', ordenante_nombre: 'ACME SA', ordenante_rfc: 'ACM010101AAA' };
  const c = armarCorreoFondeo({ tipo: 'por_asignar', fondeo: f, avisos: ['Revisa el RFC'], appUrl: 'https://x.test/' });
  assert.match(c.subject, /^\[Cards\] Por asignar · FND-2026-000001 · Acme <SA> · \$301,740\.00$/);
  assert.match(c.html, /Fondeo por asignar/); assert.match(c.html, /Ana &quot;Comercial&quot;/); assert.match(c.html, /Acme &lt;SA&gt;/);
  assert.ok(!c.html.includes('Acme <SA>'));
  assert.match(c.html, /Revisa el RFC/); assert.match(c.html, /href="https:\/\/x\.test"/);
  assert.match(c.text, /Total recibido: \$301,740\.00/);
});
test('correos de asignado, rechazado y cancelado llevan la nota o el motivo', () => {
  const f = { folio: 'FND-1', ruta: 'Acme', fondeo: 100, comision: 0.5, iva: 0.08, monto_esperado: 100.58 };
  assert.match(armarCorreoFondeo({ tipo: 'asignado', fondeo: f, nota: 'Todo bien' }).html, /Todo bien/);
  assert.match(armarCorreoFondeo({ tipo: 'rechazado', fondeo: f, motivo: 'No llegó el dinero' }).html, /No llegó el dinero/);
  assert.match(armarCorreoFondeo({ tipo: 'cancelado', fondeo: f, motivo: 'Cliente desistió' }).subject, /Cancelada/);
  assert.match(armarCorreoFondeo({ tipo: 'cancelado', fondeo: f }).html, /Total a depositar/);   // sin CEP aún
  assert.throws(() => armarCorreoFondeo({ tipo: 'otro', fondeo: f }));
});

test('candado de asignación: solo abre con un CEP validado y los datos completos', () => {
  const ok = { estatus: 'POR_ASIGNAR', monto_recibido: 100, fecha: '2026-10-22', clave_rastreo: 'R1', ceps: [{ validado: true }] };
  assert.deepEqual(FL.candadoAsignacion(ok), { abierto: true, motivo: null });
  assert.match(FL.candadoAsignacion({ ...ok, estatus: 'SOLICITADO', ceps: [] }).motivo, /Falta el CEP/);
  assert.match(FL.candadoAsignacion({ ...ok, estatus: 'RECHAZADO', ceps: [] }).motivo, /Está rechazado y sin CEP/);
  assert.match(FL.candadoAsignacion({ ...ok, ceps: [{ validado: false }] }).motivo, /no está validado/);
  assert.match(FL.candadoAsignacion({ ...ok, monto_recibido: null }).motivo, /Faltan datos/);
  assert.match(FL.candadoAsignacion({ ...ok, clave_rastreo: null }).motivo, /Faltan datos/);
  assert.match(FL.candadoAsignacion({ ...ok, estatus: 'RECHAZADO' }).motivo, /Está rechazado/);
  assert.equal(FL.candadoAsignacion({ ...ok, estatus: 'ASIGNADO' }).abierto, false);
  assert.equal(FL.candadoAsignacion({ ...ok, estatus: 'CANCELADO' }).abierto, false);
  assert.equal(FL.candadoAsignacion({ estatus: 'POR_ASIGNAR' }).abierto, false);   // sin datos: cerrado
});


test('correo de nueva solicitud: quién la registró, cuenta de fondeo, total a depositar y datos escapados', () => {
  const f = { folio: 'FND-2026-000134', ruta: 'Acme <SA>', empresa_nombre: 'Acme <SA>', solicitante_nombre: 'Fátima "Ruiz"', solicitante_email: 'fatima@polipay.io', beneficiario_destino: 'Acme SA de CV', banco_destino: 'STP', clabe_destino: '646180171800000010', fondeo: 300000, comision: 1500, iva: 240, comision_pct: 0.5, iva_pct: 16, monto_esperado: 301740, notas: 'Quincena <2>' };
  const c = armarCorreoFondeo({ tipo: 'solicitado', fondeo: f, appUrl: 'https://x.test/' });
  assert.equal(c.subject, '[Cards] Nueva solicitud · FND-2026-000134 · Acme <SA> · $301,740.00 a depositar');
  assert.match(c.html, /Nueva solicitud de fondeo/); assert.match(c.html, /Fátima &quot;Ruiz&quot; · fatima@polipay\.io/);
  assert.match(c.html, /Beneficiario/); assert.match(c.html, /646180171800000010/); assert.match(c.html, /Comisión \(0\.5%\)/); assert.match(c.html, /IVA \(16%\)/);
  assert.match(c.html, /La empresa debe depositar/); assert.match(c.html, /Quincena &lt;2&gt;/);
  assert.ok(!c.html.includes('Acme <SA>') && !c.html.includes('<2>'));
  assert.match(c.text, /Solicitó: Fátima "Ruiz" · fatima@polipay\.io/); assert.match(c.text, /La empresa debe depositar: \$301,740\.00/);
  assert.doesNotMatch(c.html, /Total recibido|Clave de rastreo/);       // no aplica: aún no hay depósito
});

test('correo con CEP: indica si va adjunto, el resultado de la validación y cada dato comparado', () => {
  const f = { folio: 'F1', ruta: 'Acme', empresa_nombre: 'Acme', fondeo: 1000, comision: 5, iva: 0.8, monto_recibido: 1005.8, solicitante_nombre: 'Ana Pérez' };
  const ok = { filename: 'cep.pdf', formato: 'cep_banxico', confianza: 'alta', validado: true, adjunto: true, checks: [
    { campo: 'monto', etiqueta: 'Monto', cep: 1005.8, capturado: 1005.8, estado: 'ok', duro: true },
    { campo: 'beneficiario', etiqueta: 'Beneficiario', cep: null, capturado: 'Acme', estado: 'sin_dato', duro: true }] };
  const a = armarCorreoFondeo({ tipo: 'por_asignar', fondeo: f, ceps: [ok] });
  assert.match(a.html, /CEP y validación/); assert.match(a.html, /cep\.pdf/); assert.match(a.html, /adjunto a este correo/);
  assert.match(a.html, /Validado por el sistema · todo coincide/); assert.match(a.html, /No viene en el CEP/);
  assert.match(a.text, /cep\.pdf \(CEP de Banxico, adjunto\): validado por el sistema/);
  const mal = { ...ok, adjunto: false, checks: [{ campo: 'banco', etiqueta: 'Banco beneficiario', cep: 'BANORTE', capturado: 'STP', estado: 'difiere', duro: true }] };
  const b = armarCorreoFondeo({ tipo: 'asignado', fondeo: f, ceps: [mal] });
  assert.match(b.html, /1 diferencia por revisar/); assert.match(b.html, /Difiere/); assert.match(b.html, /no se adjuntó/); assert.match(b.html, /Hola Ana,/);
  assert.match(armarCorreoFondeo({ tipo: 'por_asignar', fondeo: f, ceps: [{ ...ok, validado: false }] }).html, /No validado por el sistema/);
  assert.doesNotMatch(armarCorreoFondeo({ tipo: 'solicitado', fondeo: f }).html, /CEP y validación/);   // aún no hay CEP
});

test('comprobante del saldo asignado: lo sube tesorería (por asignar o asignado); quitarlo ya asignado, solo un administrador', () => {
  const p = (est, rol) => FL.permisos(est, rol, true);
  for (const rol of ['cards_tesoreria', 'admin', 'cards_admin']) {
    assert.equal(p('POR_ASIGNAR', rol).comprobante, true, rol); assert.equal(p('ASIGNADO', rol).comprobante, true, rol);
    assert.equal(p('POR_ASIGNAR', rol).quitar_comprobante, true, rol);
  }
  assert.deepEqual(['admin', 'cards_admin', 'cards_tesoreria'].map(r => p('ASIGNADO', r).quitar_comprobante), [true, true, false]);
  for (const est of ['SOLICITADO', 'RECHAZADO', 'CANCELADO']) assert.equal(p(est, 'cards_tesoreria').comprobante, false, est);
  for (const rol of ['comercial', 'cards_consulta', 'tesoreria']) assert.equal(p('ASIGNADO', rol).comprobante, false, rol);
});
test('correo de saldo asignado: menciona el comprobante y si va adjunto', () => {
  const f = { folio: 'F1', ruta: 'Acme', empresa_nombre: 'Acme', fondeo: 1000, comision: 5, iva: 0.8, monto_recibido: 1005.8, solicitante_nombre: 'Ana Pérez' };
  const c = armarCorreoFondeo({ tipo: 'asignado', fondeo: f, comprobantes: [{ filename: 'saldo.png', adjunto: true }, { filename: 'grande.pdf', adjunto: false }] });
  assert.match(c.html, /Comprobante del saldo asignado/); assert.match(c.html, /saldo\.png/); assert.match(c.html, /adjunto a este correo/); assert.match(c.html, /no se adjuntó/);
  assert.match(c.html, /Va adjunto el comprobante del sistema/); assert.match(c.text, /saldo\.png \(adjunto\)/);
  const sin = armarCorreoFondeo({ tipo: 'asignado', fondeo: f });
  assert.doesNotMatch(sin.html, /Comprobante del saldo asignado/); assert.doesNotMatch(sin.html, /Va adjunto/);
});

test('correos: nombran a quien subió el CEP (el solicitante) y a quien subió el comprobante (tesorería)', () => {
  const f = { folio: 'F1', ruta: 'Acme', empresa_nombre: 'Acme', fondeo: 1000, comision: 5, iva: 0.8, monto_recibido: 1005.8, solicitante_nombre: 'Ana Pérez', cep_subido_por: 'Fátima Ruiz' };
  const pa = armarCorreoFondeo({ tipo: 'por_asignar', fondeo: f, ceps: [{ filename: 'cep.pdf', por: 'Fátima Ruiz', formato: 'cep_banxico', validado: true, adjunto: true, checks: [] }] });
  assert.match(pa.html, /Fátima Ruiz cargó el CEP/); assert.match(pa.html, /subido por Fátima Ruiz/);
  const sinDato = armarCorreoFondeo({ tipo: 'por_asignar', fondeo: { ...f, cep_subido_por: null } });
  assert.match(sinDato.html, /Ana Pérez cargó el CEP/);                                  // sin dato del archivo, se usa al solicitante
  const asig = armarCorreoFondeo({ tipo: 'asignado', fondeo: f, comprobantes: [{ filename: 'saldo.png', adjunto: true, por: 'Omar Tesorería' }] });
  assert.match(asig.html, /saldo\.png/); assert.match(asig.html, /subido por Omar Tesorería/);
});
