/* lib/mesa/roles.js — Mesa de control: roles fijos y lo que puede hacer cada uno. El rol se asigna en Administración (usuarios.rol_cartera).
   El administrador del sistema es administrador de la mesa. Lógica pura. */
'use strict';

const PERMISOS = {
  crear:        'Crear solicitudes',
  editar:       'Editar solicitudes propias y subir documentos',
  enviar:       'Enviar a verificación',
  ver_todas:    'Ver todas las solicitudes',
  validar_docs: 'Validar o rechazar documentos',
  verificar:    'Cerrar la verificación (pasa a decisión)',
  pld_consulta: 'Consultar contra listas PLD',
  pld_revisar:  'Resolver coincidencias de listas y firmar riesgo alto',
  autorizar:    'Autorizar en la mesa de control',
  comite:       'Firmar como comité (montos sobre la facultad de la mesa)',
  rechazar:     'Rechazar solicitudes',
  devolver:     'Devolver solicitudes para corrección',
  cancelar:     'Cancelar solicitudes',
  bitacora:     'Ver la bitácora y verificar su integridad',
  administrar:  'Productos, política, facultades, listas y ejemplos',
  formalizar:   'Formalizar créditos: contrato y firmas',
  desembolso_solicitar: 'Solicitar, enviar y confirmar desembolsos',
  desembolso_autorizar: 'Autorizar desembolsos',
  cobrar:       'Registrar pagos y gestiones de cobranza',
  conciliar:    'Conciliar movimientos bancarios',
  fondeo:       'Administrar líneas de fondeo',
  contabilidad: 'Pólizas y cierre contable',
  reportes:     'Reportes de cartera, buró y comisiones',
  uif:          'Dictaminar operaciones relevantes e inusuales (UIF)',
};

const ROLES = {
  admin:        { nombre: 'Administrador de Credit Solvendom', permisos: Object.keys(PERMISOS) },
  ejecutivo:    { nombre: 'Ejecutivo de crédito', permisos: ['crear', 'editar', 'enviar', 'cancelar'] },
  analista:     { nombre: 'Analista de verificación', permisos: ['ver_todas', 'validar_docs', 'verificar', 'pld_consulta', 'devolver', 'rechazar', 'formalizar'] },
  cumplimiento: { nombre: 'Cumplimiento (PLD)', permisos: ['ver_todas', 'pld_consulta', 'pld_revisar', 'devolver', 'rechazar', 'bitacora', 'reportes', 'uif'] },
  mesa:         { nombre: 'Mesa de control', permisos: ['ver_todas', 'autorizar', 'rechazar', 'devolver', 'bitacora', 'desembolso_autorizar', 'reportes'] },
  tesoreria:    { nombre: 'Tesorería', permisos: ['ver_todas', 'desembolso_solicitar', 'conciliar', 'fondeo', 'reportes'] },
  cobranza:     { nombre: 'Cobranza', permisos: ['ver_todas', 'cobrar', 'reportes'] },
  contador:     { nombre: 'Contabilidad', permisos: ['ver_todas', 'contabilidad', 'reportes'] },
  consulta:     { nombre: 'Consulta (solo lectura)', permisos: ['ver_todas', 'reportes'] },
};

const lista = () => Object.entries(ROLES).map(([id, r]) => ({ id, nombre: r.nombre }));
const permisosDe = rol => (ROLES[rol] ? ROLES[rol].permisos : []);
const puede = (rol, p) => permisosDe(rol).includes(p);

module.exports = { PERMISOS, ROLES, lista, permisosDe, puede };
