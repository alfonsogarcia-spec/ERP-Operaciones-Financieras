/* Direcciones de correo para encabezados MIME / Destinations de SES. */
'use strict';

// "Nombre <correo>" → { name, email }; un correo suelto → { name: '', email }.
function parseDir(a) {
  const m = String(a).match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  return m ? { name: m[1].replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(), email: m[2].trim() } : { name: '', email: String(a).trim() };
}

// Encabezado seguro: nombre en RFC 2047 (acentos, comas, comillas) y correo sin saltos de línea.
function fmtDir(a) {
  const { name, email } = parseDir(a);
  if (!email || /[\r\n<>,;"\s]/.test(email)) throw new Error('destinatario_invalido: ' + email);
  return name ? `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?= <${email}>` : email;
}

module.exports = { parseDir, fmtDir };
