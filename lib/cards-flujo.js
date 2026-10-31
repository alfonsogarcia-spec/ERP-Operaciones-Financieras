/* ============================================================================
   lib/cards-flujo.js — Reglas del flujo de fondeos de Cards (BSO). Funciones puras (sin base de datos).

   Ciclo:  SOLICITADO (esperando CEP) → POR_ASIGNAR (CEP aceptado; avisa a tesorería) → ASIGNADO (tesorería confirma el saldo)
                                             ↘ RECHAZADO (tesorería devuelve al comercial; vuelve a SOLICITADO al quitar el CEP)
           CANCELADO desde cualquier estado antes de ASIGNADO (y un administrador, también después).
   ========================================================================= */
'use strict';
const { round2 } = require('./cards-fondeo.js');
const BNK = require('./cards-bancos.js');

const ESTATUS = ['SOLICITADO', 'POR_ASIGNAR', 'ASIGNADO', 'RECHAZADO', 'CANCELADO'];
const TOL = 0.01;

// Qué documentos cuentan como CEP. El comprobante de dispersión de Polipay se acepta porque es la única
// evidencia de las transferencias Polipay → Polipay (no existe CEP de Banxico para ellas). Para exigir solo Banxico: quitar 'dispersion_polipay'.
const FORMATOS_ACEPTADOS = new Set(['cep_banxico', 'xml', 'dispersion_polipay']);
const QUE_ES = {
  imagen: 'una imagen', pdf_sin_texto: 'un PDF sin texto legible (escaneado)', pdf_generico: 'un documento de formato no reconocido',
  consulta_estado_banxico: 'la consulta del estado del pago de Banxico', error: 'ilegible (no se pudo leer su contenido)', desconocido: 'de un tipo no reconocido',
};
const mxn = n => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const ult4 = c => '…' + String(c || '').slice(-4);

/* Evalúa un archivo ya leído (salida de extraerCep) contra la solicitud.
   ctx = { clabe_destino, empresa_nombre, empresa_rfc, monto_esperado, rastreos_previos: [..], hoy: 'AAAA-MM-DD',
           beneficiario_nombre?, banco?: { codigo_spei, nombre }, bancos?: [catálogo] }
   Rechaza (errores) lo que invalida el comprobante; lo demás solo se avisa y lo ve tesorería. */
function evaluarCep(x, ctx) {
  const errores = [], avisos = [], d = x.datos || {};
  const err = (codigo, mensaje) => errores.push({ codigo, mensaje });
  if (x.formato === 'error') {
    // Falla al abrir el archivo (no es que el documento no sea un CEP): no se le dice al usuario que "solo se aceptan CEP".
    err('lectura_fallida', `${(x.avisos && x.avisos[0]) || 'No se pudo leer el archivo.'} Puede ser un fallo temporal: vuelve a intentarlo y, si se repite, avisa a soporte.`);
    return { ok: false, errores, avisos, aplicar: null };
  }
  if (!FORMATOS_ACEPTADOS.has(x.formato) || x.es_cep === false) {
    err('no_es_cep', `Solo se aceptan CEP en PDF o XML (el de Banxico o el comprobante de Polipay). Este archivo es ${QUE_ES[x.formato] || 'otro tipo de documento'}.`);
    return { ok: false, errores, avisos, aplicar: null };
  }
  const ben = d.beneficiario || {}, ord = d.ordenante || {};
  const falta = [];
  if (!(d.monto > 0)) falta.push('el monto');
  if (!d.clave_rastreo) falta.push('la clave de rastreo');
  if (!ben.cuenta) falta.push('la CLABE beneficiaria');
  if (!d.fecha_abono) falta.push('la fecha de abono');
  if (falta.length) err('cep_incompleto', `No se pudo leer ${falta.join(', ')} del CEP. Descarga el CEP original de Banxico y vuelve a subirlo.`);
  if (ben.cuenta && String(ben.cuenta) !== String(ctx.clabe_destino))
    err('clabe_distinta', `El CEP depositó a la CLABE ${ult4(ben.cuenta)}, que no es la de ${ctx.empresa_nombre} (${ult4(ctx.clabe_destino)}). Revisa que sea el CEP correcto.`);
  if (d.fecha_abono && ctx.hoy && d.fecha_abono > ctx.hoy) err('fecha_futura', 'La fecha de abono del CEP es futura.');
  const previos = (ctx.rastreos_previos || []).filter(Boolean);
  if (d.clave_rastreo && previos.length && !previos.some(r => String(r).toUpperCase() === String(d.clave_rastreo).toUpperCase()))
    err('cep_distinto', 'Esta solicitud ya tiene un CEP con otra clave de rastreo. Cada solicitud corresponde a un solo depósito: quita el CEP anterior o crea otra solicitud.');
  if (errores.length) return { ok: false, errores, avisos, aplicar: null };

  if (ctx.monto_esperado != null && Math.abs(Number(d.monto) - Number(ctx.monto_esperado)) > TOL)
    avisos.push(`El CEP trae ${mxn(d.monto)} y se esperaban ${mxn(ctx.monto_esperado)} (diferencia ${mxn(d.monto - ctx.monto_esperado)}). Tesorería lo verá marcado y decidirá.`);
  const rfcE = ctx.empresa_rfc ? String(ctx.empresa_rfc).toUpperCase().replace(/\s/g, '') : null, rfcO = ord.rfc ? String(ord.rfc).toUpperCase() : null;
  if (rfcE && rfcO && rfcE !== rfcO) avisos.push(`El ordenante (RFC ${rfcO}) no es ${ctx.empresa_nombre} (RFC ${rfcE}): puede ser un depósito de un tercero.`);
  // Titular y banco de la cuenta: se avisa (no se rechaza, la CLABE ya identifica la cuenta); tesorería lo verá marcado.
  if (ctx.beneficiario_nombre && BNK.nombresCoinciden(ben.nombre, ctx.beneficiario_nombre) === false)
    avisos.push(`El beneficiario del CEP («${ben.nombre}») no coincide con el de la cuenta («${ctx.beneficiario_nombre}»). Tesorería lo verá marcado.`);
  if (ctx.banco && BNK.bancoCoincide(ben.institucion, ctx.banco, ctx.bancos) === false)
    avisos.push(`El banco del CEP («${ben.institucion}») no coincide con el de la cuenta (${ctx.banco.nombre}). Tesorería lo verá marcado.`);
  if (x.formato === 'dispersion_polipay') avisos.push('Es un comprobante de dispersión de Polipay, no un CEP de Banxico.');
  return {
    ok: true, errores, avisos,
    aplicar: { monto: round2(d.monto), fecha: d.fecha_abono, clave_rastreo: d.clave_rastreo, banco_ordenante: ord.institucion || null, ordenante_nombre: ord.nombre || null, ordenante_rfc: rfcO },
  };
}

/* Qué puede hacer cada rol de Cards con un fondeo según su estatus. `esSuyo` = lo solicitó quien consulta.
   admin / cards_admin: todo · cards_tesoreria: asigna (también sin CEP, solo ella) o rechaza y sube el comprobante del saldo · comercial: solo lo suyo · cards_consulta: solo mira. */
function permisos(estatus, rol, esSuyo) {
  const adm = rol === 'admin' || rol === 'cards_admin';
  const asigna = adm || rol === 'cards_tesoreria';
  const solicita = adm || (rol === 'comercial' && esSuyo !== false);
  const abierto = ['SOLICITADO', 'POR_ASIGNAR', 'RECHAZADO'].includes(estatus);
  return {
    subir_cep: solicita && abierto,
    quitar_cep: solicita && abierto,
    asignar: asigna && estatus === 'POR_ASIGNAR',
    // Asignar SIN CEP: lo único que se salta el candado, y solo lo hace tesorería (ni administrador ni administrador Cards).
    asignar_sin_cep: rol === 'cards_tesoreria' && ['SOLICITADO', 'POR_ASIGNAR'].includes(estatus),
    rechazar: asigna && estatus === 'POR_ASIGNAR',
    cancelar: (adm && estatus !== 'CANCELADO') || (rol === 'comercial' && !!esSuyo && ['SOLICITADO', 'RECHAZADO'].includes(estatus)),
    editar: adm && ['SOLICITADO', 'POR_ASIGNAR'].includes(estatus),
    // Comprobante del saldo asignado: lo sube tesorería con el fondeo por asignar o ya asignado. Quitarlo, una vez asignado, solo un administrador.
    comprobante: asigna && ['POR_ASIGNAR', 'ASIGNADO'].includes(estatus),
    quitar_comprobante: asigna && (estatus === 'POR_ASIGNAR' || (estatus === 'ASIGNADO' && adm)),
  };
}

/* CANDADO: ¿puede tesorería poner "saldo asignado"? Solo con un CEP validado por el sistema y los datos del CEP ya en el fondeo.
   `f` = { estatus, monto_recibido, fecha, clave_rastreo, ceps: [{ validado }] }. Lo repite la base de datos (trigger) como última barrera. */
function candadoAsignacion(f) {
  const ceps = f.ceps || [];
  if (f.estatus === 'ASIGNADO') return { abierto: false, motivo: 'El saldo de este fondeo ya está asignado.' };
  if (f.estatus === 'CANCELADO') return { abierto: false, motivo: 'El fondeo está cancelado.' };
  if (!ceps.length) return { abierto: false, motivo: f.estatus === 'RECHAZADO' ? 'Está rechazado y sin CEP: el comercial debe subir el CEP correcto.' : 'Falta el CEP: sin CEP no se puede asignar el saldo.' };
  if (!ceps.some(c => c.validado)) return { abierto: false, motivo: 'El CEP cargado no está validado por el sistema.' };
  if (!(Number(f.monto_recibido) > 0) || !f.fecha || !f.clave_rastreo) return { abierto: false, motivo: 'Faltan datos del CEP en el fondeo (monto, fecha o clave de rastreo).' };
  if (f.estatus === 'RECHAZADO') return { abierto: false, motivo: 'Está rechazado: el comercial debe corregir el CEP y volver a enviarlo.' };
  if (f.estatus !== 'POR_ASIGNAR') return { abierto: false, motivo: 'Aún no está por asignar.' };
  return { abierto: true, motivo: null };
}

module.exports = { ESTATUS, TOL, FORMATOS_ACEPTADOS, evaluarCep, permisos, candadoAsignacion };
