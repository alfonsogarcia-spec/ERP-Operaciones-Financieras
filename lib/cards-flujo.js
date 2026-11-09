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
   admin / cards_admin: todo · cards_tesoreria: asigna o rechaza y sube el comprobante del saldo · comercial: solo lo suyo · cards_consulta: solo mira.
   El CEP es OPCIONAL: no hace falta para pasar a tesorería ni para asignar (el candado es el comprobante del saldo validado). */
function permisos(estatus, rol, esSuyo) {
  const adm = rol === 'admin' || rol === 'cards_admin';
  const asigna = adm || rol === 'cards_tesoreria';
  const solicita = adm || (rol === 'comercial' && esSuyo !== false);
  const abierto = ['SOLICITADO', 'POR_ASIGNAR', 'RECHAZADO'].includes(estatus);
  return {
    subir_cep: solicita && abierto,
    quitar_cep: solicita && abierto,
    asignar: asigna && estatus === 'POR_ASIGNAR',
    rechazar: asigna && estatus === 'POR_ASIGNAR',
    cancelar: (adm && estatus !== 'CANCELADO') || (rol === 'comercial' && !!esSuyo && ['SOLICITADO', 'POR_ASIGNAR', 'RECHAZADO'].includes(estatus)),
    // Tras un rechazo, quien solicitó lo corrige (con o sin CEP) y lo vuelve a enviar a tesorería.
    reenviar: solicita && estatus === 'RECHAZADO',
    editar: adm && ['SOLICITADO', 'POR_ASIGNAR'].includes(estatus),
    // Comprobante del saldo asignado: lo sube tesorería con el fondeo por asignar o ya asignado. Quitarlo, una vez asignado, solo un administrador.
    comprobante: asigna && ['SOLICITADO', 'POR_ASIGNAR', 'ASIGNADO'].includes(estatus),   // desde que espera CEP: sin CEP el comprobante se sube antes de asignar
    quitar_comprobante: asigna && (['SOLICITADO', 'POR_ASIGNAR'].includes(estatus) || (estatus === 'ASIGNADO' && adm)),
  };
}

/* CANDADO DEL COMPROBANTE: para poner "saldo asignado" tesorería primero sube el comprobante del sistema y su monto debe estar validado
   contra el fondeo calculado. Devuelve null si está listo o el motivo. `f.comprobantes` = [{ validado, coincide_actual }]; `fondeo` = el neto contra el que se compara
   (por omisión el del fondeo; en "sin CEP" es el que resultará de lo capturado). */
function comprobanteFalta(f, fondeo) {
  const cs = f.comprobantes || [];
  const neto = fondeo != null ? fondeo : f.fondeo;
  const bien = cs.some(c => c.validado && (fondeo != null ? c.monto_leido != null && Math.round(Math.abs(Number(c.monto_leido) - Number(fondeo)) * 100) <= 1 : c.coincide_actual !== false));
  if (bien) return null;
  const mx = n => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  if (cs.some(c => c.validado)) return `Los comprobantes cargados no coinciden con el fondeo calculado${neto != null ? ' (' + mx(neto) + ')' : ''}: sube el comprobante con el monto correcto.`;
  if (cs.length) return 'El comprobante cargado no tiene su monto validado: quítalo y vuelve a subirlo para validarlo.';
  return `Falta el comprobante del saldo: súbelo y su monto debe coincidir con el fondeo calculado${neto != null ? ' (' + mx(neto) + ')' : ''}.`;
}

/* CANDADO: ¿puede tesorería poner "saldo asignado"? Solo con un comprobante del saldo cuyo monto esté validado contra el fondeo calculado.
   El CEP ya NO es requisito: es opcional (si existe, su validación se muestra y puede pedir nota, pero no bloquea).
   `f` = { estatus, fondeo, comprobantes: [{ validado, coincide_actual }] }. */
function candadoAsignacion(f) {
  if (f.estatus === 'ASIGNADO') return { abierto: false, motivo: 'El saldo de este fondeo ya está asignado.' };
  if (f.estatus === 'CANCELADO') return { abierto: false, motivo: 'El fondeo está cancelado.' };
  if (f.estatus === 'RECHAZADO') return { abierto: false, motivo: 'Está rechazado: quien lo solicitó debe corregirlo y volver a enviarlo.' };
  if (!['SOLICITADO', 'POR_ASIGNAR'].includes(f.estatus)) return { abierto: false, motivo: 'Aún no está por asignar.' };
  const falta = comprobanteFalta(f);
  if (falta) return { abierto: false, motivo: falta };
  return { abierto: true, motivo: null };
}

module.exports = { ESTATUS, TOL, FORMATOS_ACEPTADOS, evaluarCep, permisos, candadoAsignacion, comprobanteFalta };
