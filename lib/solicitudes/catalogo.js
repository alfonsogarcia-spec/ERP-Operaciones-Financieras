/* lib/solicitudes/catalogo.js — Portal de solicitudes de clientes: tipos de solicitud de POS, con los campos de sus formatos oficiales
   (POL-OP-F02, F03, F07, F08, F11, F13) y quién llena cada parte:
     · cliente   → Parte 1 que captura el cliente (o el Ejecutivo Comercial en su nombre);
     · comercial → condiciones comerciales y verificaciones que cierra el Ejecutivo Comercial antes de liberar a Operación;
     · operacion → Parte 2 de Operación POS (afiliación, token, MCC, prueba, etc.).
   Cada campo puede traer: tipo, required, hint, options, show_if, y `desde` (de dónde se precarga con datos que ya tiene POS). */
'use strict';

const MODALIDADES_SUB = ['Terminal POS física', 'Link de pago', 'API e-commerce'];
const MODALIDADES_AFIL = ['Terminal POS física', 'Terminal virtual (MOTO)', 'Link de pago', 'API e-commerce — Hosted', 'API e-commerce — Server-to-Server', 'Dispersión SPEI/SPID', 'CoDi / Transferencias con referencia'];
const SI_NO = ['Sí', 'No'];
// Destino de la liquidación de un sub afiliado: la cuenta concentradora de su afiliación (la de «cuentas de liquidación» de POS) o una cuenta nueva en Suite Banca.
const DEST_CONC = 'Concentradora de la afiliación', DEST_BANCA = 'Cuenta nueva en Suite Banca';
const UN_NUEVA = 'Unidad de negocio nueva', UN_EXISTENTE = 'Unidad de negocio existente';
const COBRO_LINK = { key: 'modalidad', any_of: ['Link de pago', 'API e-commerce', 'API e-commerce — Hosted', 'API e-commerce — Server-to-Server'] };

const f = (key, label, tipo, extra) => Object.assign({ key, label, tipo: tipo || 'text' }, extra || {});
const req = (key, label, tipo, extra) => f(key, label, tipo, Object.assign({ required: true }, extra || {}));

// Opciones de cobro que dependen de la modalidad elegida: terminal física (propina, MSI, check-in / check-out), link de pago (MSI) y API e-commerce (MSI).
const PLAZOS_MSI = ['3 meses', '6 meses', '9 meses', '12 meses', '18 meses', '24 meses'];
const API_ECOM = ['API e-commerce', 'API e-commerce — Hosted', 'API e-commerce — Server-to-Server'];
// Son campos de la sección «Modalidad de activación». La pantalla los captura en una matriz (modalidad × opción, con interruptores): `enMatriz` = no se pintan sueltos.
const OPCIONES_COBRO = () => [
  req('pos_propina', 'Terminal POS física: ¿necesita propina?', 'select', { enMatriz: true, options: SI_NO, show_if: { key: 'modalidad', any_of: ['Terminal POS física'] }, hint: 'La terminal pedirá la propina antes de cobrar.' }),
  req('pos_msi', 'Terminal POS física: ¿necesita meses sin intereses (MSI)?', 'select', { enMatriz: true, options: SI_NO, show_if: { key: 'modalidad', any_of: ['Terminal POS física'] } }),
  req('pos_msi_plazos', 'Terminal POS física: plazos de MSI', 'checkbox_group', { enMatriz: true, options: PLAZOS_MSI, show_if: { all: [{ key: 'modalidad', any_of: ['Terminal POS física'] }, { key: 'pos_msi', equals: 'Sí' }] } }),
  req('pos_checkin', 'Terminal POS física: ¿necesita Check-in / Check-out?', 'select', { enMatriz: true, options: SI_NO, show_if: { key: 'modalidad', any_of: ['Terminal POS física'] }, hint: 'Pre-autorización al entrar (hoteles, renta, etc.) y cierre del cobro al salir.' }),
  req('link_msi', 'Link de pago: ¿necesita MSI?', 'select', { enMatriz: true, options: SI_NO, show_if: { key: 'modalidad', any_of: ['Link de pago'] } }),
  req('link_msi_plazos', 'Link de pago: plazos de MSI', 'checkbox_group', { enMatriz: true, options: PLAZOS_MSI, show_if: { all: [{ key: 'modalidad', any_of: ['Link de pago'] }, { key: 'link_msi', equals: 'Sí' }] } }),
  req('api_msi', 'API e-commerce: ¿necesita MSI?', 'select', { enMatriz: true, options: SI_NO, show_if: { key: 'modalidad', any_of: API_ECOM } }),
  req('api_msi_plazos', 'API e-commerce: plazos de MSI', 'checkbox_group', { enMatriz: true, options: PLAZOS_MSI, show_if: { all: [{ key: 'modalidad', any_of: API_ECOM }, { key: 'api_msi', equals: 'Sí' }] } }),
];

// Descripción de la matriz de modalidades: una fila por modalidad y una columna por opción de cobro (la pantalla solo la dibuja; los datos son los campos de arriba).
const COLUMNAS_COBRO = [['propina', 'Propina'], ['msi', 'MSI'], ['checkin', 'Check-in/out']];
const FILA_COBRO = v => v === 'Terminal POS física' ? { prefijo: 'pos', opciones: ['propina', 'msi', 'checkin'] } : v === 'Link de pago' ? { prefijo: 'link', opciones: ['msi'] } : API_ECOM.includes(v) ? { prefijo: 'api', opciones: ['msi'] } : { prefijo: null, opciones: [] };
const MATRIZ_COBRO = modalidades => ({ campo: 'modalidad', columnas: COLUMNAS_COBRO, plazos: PLAZOS_MSI, filas: modalidades.map(v => Object.assign({ valor: v }, FILA_COBRO(v))) });

// Datos de contacto y del comercio que se repiten entre formatos.
const SECCION_COMERCIO = (titulo, ref) => ({ id: 'comercio', titulo, llena: 'cliente', campos: [
  ...(ref ? [] : [req('razon_social', 'Razón social', 'text')]),
  req('nombre_comercial', 'Nombre comercial', 'text', { hint: 'Como se le conoce y como saldrá en el ticket.' }),
  ...(ref ? [] : [req('rfc', 'RFC', 'rfc')]),
  req('domicilio', 'Domicilio fiscal', 'textarea'),
  req('cp', 'C.P.', 'cp'),
  req('estado_mun', 'Estado / Municipio', 'text'),
  f('tel', 'Teléfono', 'tel', { required: !ref }),
  req('email', 'Correo electrónico', 'email'),
  f('web', 'Sitio web / App', 'text'),
] });

const TIPOS = [
  /* ------------------------------------------------------------------ Alta de sub afiliado (P03 / F03) */
  {
    id: 'alta_subafiliado', codigo: 'POL-OP-P03', formato: 'POL-OP-F03', nombre: 'Alta de comercio sub afiliado', corto: 'Alta de sub afiliado', icono: 'ic_11', sla_dias: 3,
    descripcion: 'Una sucursal nueva que opera bajo una afiliación principal que ya está activa. Hereda la tasa y la CLABE de liquidación de esa afiliación.',
    requiere_afiliacion: true,
    secciones: [
      { id: 'afiliacion', titulo: 'Afiliación principal', llena: 'cliente', campos: [
        f('unidad_negocio', 'Grupo de afiliaciones', 'unidad', { hint: 'Si eliges una, se propone su afiliación principal.' }),
        req('afil_principal', 'Afiliación principal', 'afiliacion', { hint: 'Solo aparecen las afiliaciones activas de tu grupo. El sub afiliado hereda de ella los datos fiscales, la tasa y la CLABE.' }),
      ] },
      { id: 'liquidacion', titulo: 'Cuenta de liquidación', llena: 'cliente', campos: [
        req('liq_destino', '¿Dónde se liquida este comercio?', 'radio', { variante: 'liquidacion', options: [DEST_CONC, DEST_BANCA], hint: 'Los datos de la concentradora salen de las cuentas de liquidación de POS.' }),
        // Se llenan solos desde POS al enviar (no se capturan): quedan en el formato.
        f('liq_banco', 'Banco de la concentradora', 'text', { oculto_ui: true, show_if: { key: 'liq_destino', equals: DEST_CONC } }),
        f('liq_clabe', 'CLABE de la concentradora', 'text', { oculto_ui: true, show_if: { key: 'liq_destino', equals: DEST_CONC } }),
        f('liq_titular', 'Titular de la cuenta', 'text', { oculto_ui: true, show_if: { key: 'liq_destino', equals: DEST_CONC } }),
        // Cuenta nueva en Suite Banca: ¿va en una unidad de negocio (UN) nueva o debajo de una que ya existe? y su nombre.
        req('banca_un_modo', '¿La cuenta va en una unidad de negocio nueva o en una existente?', 'radio', { options: [UN_NUEVA, UN_EXISTENTE], show_if: { key: 'liq_destino', equals: DEST_BANCA } }),
        req('banca_un_nombre_nueva', 'Nombre de la nueva unidad de negocio', 'text', { show_if: { all: [{ key: 'liq_destino', equals: DEST_BANCA }, { key: 'banca_un_modo', equals: UN_NUEVA }] }, hint: 'Se creará con este nombre en Suite Banca.' }),
        req('banca_un_nombre_existente', 'Nombre de la unidad de negocio donde va la cuenta', 'text', { show_if: { all: [{ key: 'liq_destino', equals: DEST_BANCA }, { key: 'banca_un_modo', equals: UN_EXISTENTE }] }, hint: 'La cuenta se abrirá debajo de esta unidad de negocio.' }),
        f('banca_nota', 'Otras indicaciones (opcional)', 'textarea', { show_if: { key: 'liq_destino', equals: DEST_BANCA }, hint: 'Por ejemplo, el nombre con el que debe aparecer la cuenta.' }),
      ] },
      SECCION_COMERCIO('Datos del ticket (sub afiliado)', true),
      { id: 'contacto', titulo: 'Datos de contacto', llena: 'cliente', campos: [
        req('contacto_nombre', 'Nombre completo', 'text'), f('contacto_puesto', 'Puesto', 'text'),
        req('contacto_tel', 'Teléfono', 'tel'), req('contacto_email', 'Correo electrónico', 'email'),
      ] },
      { id: 'modalidad', titulo: 'Modalidad de activación', llena: 'cliente', matriz: MATRIZ_COBRO(MODALIDADES_SUB), campos: [
        req('modalidad', 'Modalidad', 'checkbox_group', { enMatriz: true, options: MODALIDADES_SUB }),
        ...OPCIONES_COBRO(),
      ] },
      // Tasas, CLABE y datos de la afiliación ya vienen de POS (grupo de cliente → afiliación principal): Comercial solo revisa y libera.
      // Operación ejecuta y confirma que quedó realizado; solo captura algo si el comercio pidió una cuenta nueva en Suite Banca.
      { id: 'banca', titulo: 'Cuenta en Suite Banca (Operación)', llena: 'operacion', omitir_si: { key: 'liq_destino', equals: DEST_CONC }, campos: [
        req('banca_clabe', 'CLABE de la cuenta creada en Suite Banca', 'clabe', { hint: 'La cuenta donde se liquidará este comercio.' }),
        f('obs_operacion', 'Observaciones', 'textarea'),
      ] },
    ],
    docs: [
      { id: 'catalogo', nombre: 'Catálogo de productos o servicios (PDF)', requerido: false },
      { id: 'contrato_anexo', nombre: 'Anexo de sub afiliación firmado', requerido: false, etapa: 'comercial' },
    ],
    monitoreo_dias: 30,
  },

  /* ------------------------------------------------------------------ Alta de afiliación (P02 / F02) */
  {
    id: 'alta_afiliacion', codigo: 'POL-OP-P02', formato: 'POL-OP-F02', nombre: 'Alta de afiliación (comercio nuevo)', corto: 'Alta de afiliación', icono: 'ic_09', sla_dias: 3,
    descripcion: 'Un comercio nuevo que se afilia al gateway: datos fiscales, representante legal, cuenta de liquidación y modalidad de cobro.',
    secciones: [
      SECCION_COMERCIO('Datos generales del comercio', false),
      { id: 'rep', titulo: 'Representante legal', llena: 'cliente', campos: [
        req('rl_nombre', 'Nombre completo', 'text'), req('rl_curp', 'CURP', 'curp'), req('rl_rfc', 'RFC personal', 'rfc'),
        req('rl_id_tipo', 'Tipo de identificación', 'select', { options: ['INE', 'Pasaporte', 'Cédula profesional'] }), req('rl_id_num', 'Número de identificación', 'text'),
        req('rl_nacionalidad', 'Nacionalidad', 'text'), req('rl_tel', 'Teléfono', 'tel'), req('rl_email', 'Correo electrónico', 'email'),
      ] },
      { id: 'liquidacion', titulo: 'Cuenta de liquidación', llena: 'cliente', campos: [
        req('liq_banco', 'Banco', 'banco'), req('liq_clabe', 'CLABE interbancaria (18 dígitos)', 'clabe'),
        req('liq_titular', 'Titular de la cuenta', 'text', { hint: 'Debe ser la misma razón social del comercio.' }), req('liq_rfc', 'RFC del titular', 'rfc'),
      ] },
      { id: 'modalidad', titulo: 'Modalidad de activación', llena: 'cliente', matriz: MATRIZ_COBRO(MODALIDADES_AFIL), campos: [
        req('modalidad', 'Modalidad', 'checkbox_group', { enMatriz: true, options: MODALIDADES_AFIL }),
        ...OPCIONES_COBRO(),
      ] },
      { id: 'condiciones', titulo: 'Condiciones comerciales (Ejecutivo Comercial)', llena: 'comercial', campos: [
        req('tasa_debito', 'Débito (TDD) %', 'porcentaje'), req('tasa_credito', 'Crédito (TDC) %', 'porcentaje'),
        req('tasa_internacional', 'Internacional (INT) %', 'porcentaje'), req('tasa_amex', 'AMEX %', 'porcentaje'),
        f('monto_fijo_txn', 'Monto fijo por transacción (MXN)', 'number', { show_if: COBRO_LINK }),
        req('cotizacion_broxel', 'Referencia de la cotización Broxel', 'text'),
        req('checklist', 'Verificaciones previas', 'checkbox_group', { options: ['Expediente de onboarding aprobado por Cumplimiento', 'Cotización Broxel aprobada', 'Contrato de servicios firmado'], hint: 'Marca las tres para liberar a Operación.' }),
      ] },
      { id: 'operacion', titulo: 'Datos de afiliación (Operación POS)', llena: 'operacion', campos: [
        req('numero_afiliacion', 'Número de afiliación', 'text'), req('token_activacion', 'Token de activación', 'text', { privado: true }),
        req('mcc', 'Giro / MCC asignado', 'text'), req('giro_desc', 'Descripción del giro', 'text'),
        req('modalidad_confirmada', 'Modalidad confirmada', 'checkbox_group', { options: MODALIDADES_AFIL }),
        f('opciones_habilitadas', 'Opciones habilitadas (propina, MSI, check-in / check-out)', 'textarea', { hint: 'Confirma lo que activaste según lo que pidió el cliente.' }),
        req('prueba', 'Transacción de prueba', 'select', { options: ['Exitosa', 'Fallida'] }),
        f('fecha_activacion', 'Fecha de activación', 'date'), f('obs_operacion', 'Observaciones', 'textarea'),
      ] },
    ],
    docs: [
      { id: 'acta', nombre: 'Acta constitutiva', requerido: true, ayuda: 'Copia certificada por notario, con apéndices y addenda.' },
      { id: 'poder', nombre: 'Poder del representante legal', requerido: true },
      { id: 'csf_pm', nombre: 'Constancia de situación fiscal (persona moral)', requerido: true, ayuda: 'Vigente, no mayor a 3 meses; RFC activo ante el SAT.' },
      { id: 'csf_rl', nombre: 'Constancia de situación fiscal del representante legal', requerido: true, ayuda: 'No mayor a 3 meses.' },
      { id: 'id_rl', nombre: 'Identificación oficial vigente del representante legal', requerido: true },
      { id: 'domicilio', nombre: 'Comprobante de domicilio', requerido: true, ayuda: 'Luz, agua, teléfono o estado de cuenta; máximo 3 meses.' },
      { id: 'caratula', nombre: 'Carátula o estado de cuenta de la CLABE de liquidación', requerido: true },
      { id: 'foto_fachada', nombre: 'Fotografía de fachada', requerido: true, ayuda: 'Nítida, sin marcas de agua, tomada en el establecimiento real (no se aceptan imágenes generadas con IA).' },
      { id: 'foto_interior', nombre: 'Fotografía del interior', requerido: true },
      { id: 'catalogo', nombre: 'Catálogo de productos o servicios (PDF)', requerido: true },
      { id: 'foto_catalogo', nombre: 'Fotografía del catálogo exhibido en el establecimiento', requerido: false },
    ],
    dato_requerido_ejecutar: { campo: 'prueba', valor: 'Exitosa', mensaje: 'La activación exige una transacción de prueba exitosa.' },
    monitoreo_dias: 30,
  },

  /* ------------------------------------------------------------------ Usuario en Suite Polipay (P11 / F11) */
  {
    id: 'usuario_suite', codigo: 'POL-OP-P11', formato: 'POL-OP-F11', nombre: 'Usuario en Suite Polipay (módulo TPV)', corto: 'Usuario en Suite', icono: 'ic_20', sla_dias: 2,
    descripcion: 'Alta, cambio de permisos o niveles, baja o reactivación de un usuario de Suite Polipay, con sus niveles Empresa, Unidad de Negocio y Comercio.',
    secciones: [
      // Los datos del solicitante NO se capturan: el servidor los toma de la persona que inicia sesión (usuario + su ficha de contacto).
      { id: 'solicitante', titulo: 'Datos del solicitante', llena: 'cliente', auto: true, campos: [
        f('sol_nombre', 'Nombre completo', 'text'), f('sol_puesto', 'Puesto', 'text'), f('sol_area', 'Área / Departamento', 'text'),
        f('sol_email', 'Correo electrónico', 'email'), f('sol_tel', 'Teléfono / Extensión', 'tel'),
      ] },
      { id: 'autoriza', titulo: 'Autorización del jefe inmediato', llena: 'cliente', campos: [
        req('jefe_nombre', 'Jefe inmediato (quien autoriza en tu empresa)', 'text'), req('jefe_email', 'Correo del jefe inmediato', 'email'),
      ] },
      { id: 'tipo', titulo: 'Tipo de solicitud', llena: 'cliente', campos: [
        req('tipo_solicitud', 'Tipo', 'radio', { options: ['Alta de usuario nuevo', 'Modificación de permisos / niveles', 'Baja de usuario', 'Reactivación'] }),
      ] },
      { id: 'usuario', titulo: 'Datos del usuario a crear o modificar', llena: 'cliente', campos: [
        req('usuario_nombre', 'Nombre completo del usuario', 'text'), req('usuario_email', 'Correo asociado (será su usuario)', 'email'),
        f('usuario_existente', 'Usuario existente (en modificación, baja o reactivación)', 'text', { show_if: { key: 'tipo_solicitud', any_of: ['Modificación de permisos / niveles', 'Baja de usuario', 'Reactivación'] } }),
      ] },
      { id: 'niveles', titulo: 'Niveles de acceso', llena: 'cliente', campos: [
        f('nivel_empresas', 'Empresa(s)', 'catalogo_multi', { fuente: 'empresas', hint: 'La empresa o grupo de cliente al que pertenece.' }),
        f('nivel_udn', 'Unidad(es) de negocio', 'catalogo_multi', { fuente: 'unidades', hint: 'Las unidades de negocio que tienes definidas.' }),
        f('nivel_comercios', 'Comercio(s)', 'catalogo_multi', { fuente: 'comercios', hint: 'Los comercios de tus unidades de negocio.' }),
      ], minimo_uno_de: ['nivel_empresas', 'nivel_udn', 'nivel_comercios'], aviso_minimo: 'Indica al menos un nivel de acceso: empresa, unidad de negocio o comercio.', omitir_si: { key: 'tipo_solicitud', any_of: ['Baja de usuario'] } },
      { id: 'perfil', titulo: 'Perfil y permisos', llena: 'cliente', campos: [
        req('perfil', 'Perfil solicitado', 'radio', { options: ['Administrador', 'Supervisor', 'Operador', 'Consulta'], hint: 'Administrador requiere además la firma de la Dirección de Operaciones.', show_if: { key: 'tipo_solicitud', any_of: ['Alta de usuario nuevo', 'Modificación de permisos / niveles', 'Reactivación'] } }),
        f('permisos', 'Permisos específicos requeridos', 'checkbox_group', { options: ['Consulta de transacciones', 'Generación de reportes', 'Gestión de contracargos', 'Configuración de comercios', 'Liquidaciones', 'Administración de usuarios'] }),
        f('permiso_otro', 'Otro permiso', 'text'),
        req('justificacion', 'Justificación del acceso', 'textarea'),
      ] },
      { id: 'condiciones', titulo: 'Verificación del Ejecutivo Comercial', llena: 'comercial', campos: [
        req('checklist', 'Verificaciones', 'checkbox_group', { options: ['El solicitante es contacto autorizado del cliente', 'El jefe inmediato autoriza el acceso'], hint: 'Marca ambas para liberar a Operación.' }),
      ] },
      { id: 'operacion', titulo: 'Uso exclusivo de Operación Polipay', llena: 'operacion', campos: [
        req('usuario_creado', 'Usuario creado / modificado', 'text'), req('perfil_asignado', 'Perfil asignado', 'text'), f('fecha_alta', 'Fecha de alta', 'date'),
        req('credencial_entregada', 'Credencial temporal entregada por un canal seguro', 'select', { options: SI_NO, hint: 'No escribas la contraseña: solo confirma que se entregó.' }),
        f('niveles_asignados', 'Niveles asignados', 'textarea'), f('obs_operacion', 'Observaciones', 'textarea'),
      ] },
    ],
    docs: [],
    firma_direccion: ctx => ctx.datos.perfil === 'Administrador' || contarNiveles(ctx.datos) > 3,
    motivo_direccion: ctx => ctx.datos.perfil === 'Administrador' ? 'El perfil Administrador requiere firma de la Dirección de Operaciones.' : 'Más de 3 niveles de acceso requieren firma de la Dirección de Operaciones.',
  },

  /* ------------------------------------------------------------------ Cambio de datos del sub afiliado (P07 / F07) */
  {
    id: 'cambio_datos_sub', codigo: 'POL-OP-P07', formato: 'POL-OP-F07', nombre: 'Cambio de datos de un sub afiliado', corto: 'Cambio de datos de sub afiliado', icono: 'ic_16', sla_dias: 2,
    descripcion: 'Cambio de nombre comercial, domicilio de la sucursal o contacto de un sub afiliado. Si el cambio es de tasa o esquema de cobro, usa «Cambio de condiciones comerciales».',
    requiere_afiliacion: true,
    secciones: [
      { id: 'afiliacion', titulo: 'Afiliación principal y sub afiliado', llena: 'cliente', campos: [
        req('afil_principal', 'Afiliación principal', 'afiliacion'), req('id_sub', 'ID de sub comercio', 'text'), f('nombre_actual', 'Nombre comercial actual', 'text'),
      ] },
      { id: 'cambio', titulo: 'Detalle del cambio', llena: 'cliente', campos: [
        req('tipo_mod', 'Tipo de modificación', 'checkbox_group', { options: ['Nombre comercial (ticket)', 'Domicilio de la sucursal', 'Teléfono / correo / contacto'] }),
        req('campo', 'Campo a modificar', 'text'), req('dato_actual', 'Dato actual', 'textarea'), req('dato_nuevo', 'Dato nuevo', 'textarea'), req('justificacion', 'Justificación', 'textarea'),
      ] },
      { id: 'condiciones', titulo: 'Verificación del Ejecutivo Comercial', llena: 'comercial', campos: [
        req('checklist', 'Verificaciones', 'checkbox_group', { options: ['El dato es propio del sub afiliado (no es tasa ni esquema de cobro)', 'El solicitante es contacto autorizado del cliente'] }),
      ] },
      { id: 'operacion', titulo: 'Uso exclusivo de Operaciones', llena: 'operacion', campos: [
        req('cambio_ejecutado', 'Cambio ejecutado', 'select', { options: SI_NO }), req('afil_no_afectada', 'La afiliación principal no se afectó', 'select', { options: SI_NO }),
        f('fecha_cambio', 'Fecha del cambio', 'date'), f('obs_operacion', 'Observaciones', 'textarea'),
      ] },
    ],
    docs: [],
  },

  /* ------------------------------------------------------------------ Cambio de condiciones comerciales (P08 / F08) */
  {
    id: 'cambio_condiciones', codigo: 'POL-OP-P08', formato: 'POL-OP-F08', nombre: 'Cambio de condiciones comerciales', corto: 'Cambio de condiciones', icono: 'ic_14', sla_dias: 5,
    descripcion: 'Cambio de la tasa pactada o del esquema de cobro. Se aplica a la afiliación principal y afecta a todos sus sub afiliados. Es una solicitud crítica: la autoriza la Dirección de Operaciones.',
    requiere_afiliacion: true, critica: true,
    secciones: [
      { id: 'afiliacion', titulo: 'Afiliación principal', llena: 'cliente', campos: [
        req('afil_principal', 'Afiliación principal', 'afiliacion', { hint: 'El cambio afecta a todos los sub afiliados que operan bajo ella.' }),
      ] },
      { id: 'cambio', titulo: 'Cambio solicitado', llena: 'cliente', campos: [
        req('concepto', 'Qué quieres cambiar', 'checkbox_group', { options: ['Cambio de tasa pactada', 'Cambio de esquema de cobro'] }),
        f('esquema_nuevo', 'Esquema de cobro que propones', 'text', { show_if: { key: 'concepto', any_of: ['Cambio de esquema de cobro'] } }),
        req('justificacion', 'Justificación del cambio', 'textarea'),
      ] },
      { id: 'condiciones', titulo: 'Tasa nueva (Ejecutivo Comercial)', llena: 'comercial', campos: [
        req('dir_comercial', 'Director Comercial que autoriza', 'text'),
        req('tasa_nueva_debito', 'Débito (TDD) % nuevo', 'porcentaje'), req('tasa_nueva_credito', 'Crédito (TDC) % nuevo', 'porcentaje'),
        req('tasa_nueva_internacional', 'Internacional (INT) % nuevo', 'porcentaje'), req('tasa_nueva_amex', 'AMEX % nuevo', 'porcentaje'),
        f('cotizacion_broxel', 'Cotización Broxel nueva (si aplica)', 'text'),
        req('impacto', 'Análisis de impacto', 'textarea', { hint: 'Qué sub afiliados se afectan y el efecto estimado en el margen.' }),
        req('checklist', 'Verificaciones', 'checkbox_group', { options: ['Firman el Director Comercial y el Account Manager', 'El cliente aceptó el cambio'] }),
      ] },
      { id: 'operacion', titulo: 'Uso exclusivo de Operaciones', llena: 'operacion', campos: [
        req('cambio_ejecutado', 'Cambio ejecutado en la afiliación principal', 'select', { options: SI_NO }), req('herencia', 'Herencia verificada en los sub afiliados', 'select', { options: SI_NO }),
        f('fecha_ejecucion', 'Fecha de ejecución', 'date'), f('obs_operacion', 'Observaciones', 'textarea'),
      ] },
    ],
    docs: [],
    ventana: 'Se recibe el lunes y se ejecuta el viernes de esa semana (POL-OP-P08).',
  },

  /* ------------------------------------------------------------------ Cambio de CLABE liquidadora (P13 / F13) */
  {
    id: 'cambio_clabe', codigo: 'POL-OP-P13', formato: 'POL-OP-F13', nombre: 'Cambio de CLABE liquidadora', corto: 'Cambio de CLABE', icono: 'ic_12', sla_dias: 3,
    descripcion: 'Cambia la cuenta donde se liquida una afiliación. La nueva cuenta debe estar a nombre del mismo titular.',
    requiere_afiliacion: true, critica: true,
    secciones: [
      { id: 'afiliacion', titulo: 'Afiliación', llena: 'cliente', campos: [
        req('afil_principal', 'Afiliación', 'afiliacion'),
      ] },
      { id: 'nueva', titulo: 'Nueva cuenta de liquidación', llena: 'cliente', campos: [
        req('clabe_nueva', 'Nueva CLABE (18 dígitos)', 'clabe'), req('banco_nuevo', 'Banco de la nueva cuenta', 'banco'),
        req('nuevo_titular', 'Titular de la nueva cuenta', 'text', { hint: 'Debe estar a nombre del mismo titular de la afiliación.' }), req('nuevo_rfc', 'RFC del titular de la nueva cuenta', 'rfc'),
        req('justificacion', 'Justificación del cambio', 'textarea'),
      ] },
      { id: 'condiciones', titulo: 'Verificación del Ejecutivo Comercial', llena: 'comercial', campos: [
        req('checklist', 'Verificaciones', 'checkbox_group', { options: ['La nueva cuenta es del mismo titular de la afiliación', 'La carátula bancaria tiene 90 días o menos', 'La identificación del representante legal está vigente'] }),
      ] },
      { id: 'operacion', titulo: 'Uso exclusivo de Operaciones', llena: 'operacion', campos: [
        req('catalogo_actualizado', 'CLABE actualizada en el catálogo de cuentas de liquidación', 'select', { options: SI_NO }),
        f('fecha_cambio', 'Fecha desde la que liquida a la nueva CLABE', 'date'), f('obs_operacion', 'Observaciones', 'textarea'),
      ] },
    ],
    docs: [
      { id: 'caratula', nombre: 'Carátula o constancia bancaria de la nueva CLABE', requerido: true, ayuda: 'Con antigüedad máxima de 90 días.' },
      { id: 'id_rl', nombre: 'Identificación oficial vigente del representante legal o apoderado', requerido: true },
    ],
    firma_direccion: () => true, motivo_direccion: () => 'Un cambio de CLABE liquidadora es una operación crítica: requiere firma de la Dirección de Operaciones.',
  },
];

function contarNiveles(d) {
  const n = k => (Array.isArray(d[k]) ? d[k].length : (d[k] ? String(d[k]).split(/[\n,;]+/).filter(x => x.trim()).length : 0));
  return n('nivel_empresas') + n('nivel_udn') + n('nivel_comercios');
}

const porId = new Map(TIPOS.map(t => [t.id, t]));
const tipo = id => porId.get(id) || null;
// ¿Esta solicitud exige además la firma de la Dirección de Operaciones? (por tipo o por sus datos)
function requiereDireccion(t, datos) {
  if (!t) return { si: false };
  if (t.critica && !t.firma_direccion) return { si: true, motivo: 'Es una solicitud crítica: requiere firma de la Dirección de Operaciones.' };
  if (t.firma_direccion && t.firma_direccion({ datos })) return { si: true, motivo: t.motivo_direccion ? t.motivo_direccion({ datos }) : 'Requiere firma de la Dirección de Operaciones.' };
  return { si: false };
}
// Secciones de una etapa ('cliente' | 'comercial' | 'operacion') con sus campos.
const seccionesDe = (t, llena) => t.secciones.filter(s => s.llena === llena);
// Versión para la pantalla (sin funciones).
function publico(t) {
  return { id: t.id, codigo: t.codigo, formato: t.formato, nombre: t.nombre, corto: t.corto, icono: t.icono, sla_dias: t.sla_dias, descripcion: t.descripcion, requiere_afiliacion: !!t.requiere_afiliacion, critica: !!t.critica, ventana: t.ventana || null,
    monitoreo_dias: t.monitoreo_dias || null, secciones: t.secciones, docs: t.docs };
}

module.exports = { DEST_CONC, DEST_BANCA, TIPOS, tipo, publico, seccionesDe, requiereDireccion, contarNiveles, MODALIDADES_SUB, MODALIDADES_AFIL };
