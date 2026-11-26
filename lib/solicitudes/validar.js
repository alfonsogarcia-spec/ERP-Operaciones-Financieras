/* lib/solicitudes/validar.js — Portal de solicitudes de clientes: validaciones de los datos que captura el cliente (RFC, CURP, CLABE, correo, teléfono, C.P.…)
   y evaluación de campos condicionales. Todo se valida en el servidor; la pantalla solo lo anticipa. */
'use strict';
const { nombresCoinciden } = require('../cards-bancos.js');

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const CURP_RE = /^[A-Z]{4}\d{6}[HMX][A-Z]{2}[A-Z]{3}[A-Z0-9]\d$/;
const MAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const limpia = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9Ñ&]/g, '');
const digitos = s => String(s == null ? '' : s).replace(/\D/g, '');

function clabeValida(v) {
  const c = digitos(v);
  if (!/^\d{18}$/.test(c)) return false;
  const pesos = [3, 7, 1]; let s = 0;
  for (let i = 0; i < 17; i++) s += (Number(c[i]) * pesos[i % 3]) % 10;
  return (10 - (s % 10)) % 10 === Number(c[17]);
}
// Prefijo de la CLABE (3 dígitos) que corresponde a un código SPEI de 5 dígitos (40012 → 012).
const prefijoBanco = codigoSpei => String(codigoSpei == null ? '' : codigoSpei).slice(-3).padStart(3, '0');

// Evalúa show_if: { key, any_of:[…] } o { key, equals } o { all:[condición, …] } (todas deben cumplirse). `datos` es el objeto de valores.
function visible(campo, datos) {
  const c = campo.show_if; if (!c) return true;
  if (c.all) return c.all.every(x => visible({ show_if: x }, datos));
  const v = datos[c.key];
  const lista = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  if (c.any_of) return c.any_of.some(x => lista.includes(x));
  if (c.equals !== undefined) return lista.includes(c.equals);
  if (c.not_empty) return lista.length > 0;
  return true;
}
const vacio = v => v == null || v === '' || (Array.isArray(v) && v.length === 0) || v === false;

// Valida el valor de UN campo según su tipo. Devuelve un mensaje de error o null. No exige "requerido" (eso lo hace faltantes()).
function validarValor(campo, valor, ctx) {
  if (vacio(valor)) return null;
  const t = campo.tipo, s = String(valor).trim();
  switch (t) {
    case 'rfc': { const r = limpia(valor); return RFC_RE.test(r) && (r.length === 12 || r.length === 13) ? null : 'El RFC no es válido (12 caracteres si es persona moral, 13 si es física).'; }
    case 'curp': return CURP_RE.test(limpia(valor)) ? null : 'La CURP no es válida (18 caracteres).';
    case 'email': return MAIL_RE.test(s) ? null : 'El correo no es válido.';
    case 'tel': { const d = digitos(valor); return d.length >= 10 && d.length <= 13 ? null : 'El teléfono debe tener al menos 10 dígitos.'; }
    case 'cp': return /^\d{5}$/.test(s) ? null : 'El C.P. debe tener 5 dígitos.';
    case 'clabe': {
      if (!clabeValida(valor)) return 'La CLABE debe tener 18 dígitos y un dígito verificador correcto.';
      return null;
    }
    case 'number': { const n = Number(valor); return Number.isFinite(n) && n >= 0 ? null : 'Escribe un número válido.'; }
    case 'porcentaje': { const n = Number(String(valor).replace('%', '')); return Number.isFinite(n) && n >= 0 && n <= 25 ? null : 'La tasa debe ser un porcentaje entre 0 y 25.'; }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s)) ? null : 'La fecha no es válida.';
    case 'select': case 'radio': case 'banco': case 'afiliacion':
      if (campo.options && !campo.options.includes(valor)) return 'Elige una de las opciones.';
      return null;
    case 'checkbox_group': {
      if (!Array.isArray(valor)) return 'Elige al menos una opción.';
      if (campo.options && valor.some(x => !campo.options.includes(x))) return 'Hay una opción que no existe.';
      return null;
    }
    case 'lista': return null;
    case 'catalogo_multi': return Array.isArray(valor) && valor.every(x => typeof x === 'string') ? null : 'Elige de la lista.';
    default: return s.length > (campo.max || 2000) ? 'El texto es demasiado largo.' : null;
  }
}

// Normaliza lo que manda la pantalla según el tipo (RFC/CURP en mayúsculas sin espacios, CLABE solo dígitos, listas como arreglo…).
function normalizarValor(campo, valor) {
  if (valor == null) return valor;
  switch (campo.tipo) {
    case 'rfc': case 'curp': return limpia(valor);
    case 'clabe': return digitos(valor);
    case 'cp': return digitos(valor).slice(0, 5);
    case 'email': return String(valor).trim().toLowerCase();
    case 'checkbox_group': case 'catalogo_multi': return Array.isArray(valor) ? valor.map(String) : [];
    case 'checkbox': return !!valor;
    case 'number': return valor === '' ? '' : Number(valor);
    case 'porcentaje': return String(valor).replace('%', '').trim();
    case 'lista': return Array.isArray(valor) ? valor.map(x => String(x).trim()).filter(Boolean) : String(valor).split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
    default: return typeof valor === 'string' ? valor.trim() : valor;
  }
}

module.exports = { RFC_RE, CURP_RE, MAIL_RE, limpia, digitos, clabeValida, prefijoBanco, visible, vacio, validarValor, normalizarValor, nombresCoinciden };
