/* ============================================================================
   Catálogo de tipos de entregable / solicitud para el módulo Agregador.
   Basado en los procedimientos POL-OP-P01..P13 con sus formatos POL-OP-F##.
   ========================================================================= */
'use strict';

// Cada tipo tiene un form_schema con secciones y campos.
// Tipos de campo: text, textarea, number, date, select, checkbox_group, radio.
// Cada campo puede tener `required`, `options` (para select/radio/checkbox_group), `hint`.
const CATALOGO = [
  {
    codigo: 'POL-OP-P01', nombre: 'Alta de Usuario en Gateway', sla_dias: 2,
    descripcion: 'Solicitud de creación/modificación/baja de usuario del Gateway Memphis.',
    form_schema: {
      secciones: [
        { titulo: 'Datos del solicitante', campos: [
          { key: 'sol_nombre', label: 'Nombre completo', tipo: 'text', required: true },
          { key: 'sol_puesto', label: 'Puesto', tipo: 'text', required: true },
          { key: 'sol_area', label: 'Área / Departamento', tipo: 'text', required: true },
          { key: 'sol_email', label: 'Correo electrónico', tipo: 'text', required: true },
          { key: 'sol_tel', label: 'Teléfono / Extensión', tipo: 'text' },
          { key: 'sol_jefe', label: 'Jefe inmediato', tipo: 'text' },
        ]},
        { titulo: 'Tipo de solicitud', campos: [
          { key: 'tipo_solicitud', label: 'Tipo', tipo: 'radio', required: true,
            options: ['Alta de usuario nuevo','Modificación de permisos','Baja de usuario','Reactivación'] },
        ]},
        { titulo: 'Datos del usuario a crear / modificar', campos: [
          { key: 'usuario_propuesto', label: 'Nombre de usuario propuesto', tipo: 'text', required: true },
          { key: 'usuario_email', label: 'Correo asociado', tipo: 'text', required: true },
          { key: 'usuario_existente', label: 'En caso de modificación/baja, usuario existente', tipo: 'text' },
        ]},
        { titulo: 'Perfil y permisos solicitados', campos: [
          { key: 'perfil', label: 'Perfil solicitado', tipo: 'select', required: true,
            options: ['Administrador','Supervisor','Operador','Consulta','Otro'] },
          { key: 'permisos', label: 'Permisos específicos requeridos', tipo: 'checkbox_group',
            options: ['Consulta de transacciones','Generación de reportes','Gestión de contracargos','Configuración de comercios','Liquidaciones','Administración de usuarios'] },
        ]},
        { titulo: 'Justificación', campos: [
          { key: 'justificacion', label: 'Justificación del acceso', tipo: 'textarea', required: true },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P02', nombre: 'Activación de Afiliación en Gateway', sla_dias: 3,
    descripcion: 'Solicitud de activación de una afiliación (nivel principal) en el Gateway.',
    form_schema: {
      secciones: [
        { titulo: 'Ejecutivo Comercial · Datos generales del comercio', campos: [
          { key: 'razon_social', label: 'Razón Social', tipo: 'text', required: true },
          { key: 'nombre_comercial', label: 'Nombre Comercial', tipo: 'text', required: true },
          { key: 'rfc', label: 'RFC', tipo: 'text', required: true },
          { key: 'domicilio', label: 'Domicilio Fiscal', tipo: 'textarea', required: true },
          { key: 'cp', label: 'C.P.', tipo: 'text', required: true },
          { key: 'estado_mun', label: 'Estado / Municipio', tipo: 'text' },
          { key: 'tel', label: 'Teléfono', tipo: 'text' },
          { key: 'email', label: 'Correo electrónico', tipo: 'text' },
          { key: 'web', label: 'Sitio Web / App', tipo: 'text' },
        ]},
        { titulo: 'Datos del representante legal', campos: [
          { key: 'rl_nombre', label: 'Nombre completo', tipo: 'text', required: true },
          { key: 'rl_curp', label: 'CURP', tipo: 'text' },
          { key: 'rl_rfc', label: 'RFC Personal', tipo: 'text' },
          { key: 'rl_id_tipo', label: 'Tipo de ID', tipo: 'select', options: ['INE','Pasaporte','Cédula'] },
          { key: 'rl_id_num', label: 'No. de Identificación', tipo: 'text' },
          { key: 'rl_nacionalidad', label: 'Nacionalidad', tipo: 'text' },
          { key: 'rl_tel', label: 'Teléfono', tipo: 'text' },
          { key: 'rl_email', label: 'Correo electrónico', tipo: 'text' },
        ]},
        { titulo: 'Datos de liquidación', campos: [
          { key: 'liq_banco', label: 'Banco', tipo: 'text', required: true },
          { key: 'liq_clabe', label: 'CLABE Interbancaria (18 díg.)', tipo: 'text', required: true },
          { key: 'liq_titular', label: 'Titular de la Cuenta', tipo: 'text' },
          { key: 'liq_rfc', label: 'RFC del Titular', tipo: 'text' },
        ]},
        { titulo: 'Tasa pactada con el cliente', campos: [
          { key: 'tasa_debito', label: 'Débito (TDD)', tipo: 'text', required: true, hint: 'Ej. 1.85% + IVA' },
          { key: 'tasa_credito', label: 'Crédito (TDC)', tipo: 'text', required: true, hint: 'Ej. 2.50% + IVA' },
          { key: 'tasa_internacional', label: 'Internacional (INT)', tipo: 'text', required: true, hint: 'Ej. 3.20% + IVA' },
          { key: 'tasa_amex', label: 'AMEX', tipo: 'text', required: true, hint: 'Ej. 3.50% + IVA' },
        ]},
        { titulo: 'Modalidad de activación', campos: [
          { key: 'modalidad', label: 'Modalidad', tipo: 'checkbox_group',
            options: ['Terminal POS física','Link de pago','API e-commerce'] },
          { key: 'monto_fijo_txn', label: 'Monto fijo por transacción (MXN)', tipo: 'number',
            hint: 'Cargo fijo adicional en pesos por cada transacción procesada.',
            show_if: { key: 'modalidad', any_of: ['Link de pago','API e-commerce'] } },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P03', nombre: 'Activación de Comercio Sub Afiliado', sla_dias: 3,
    descripcion: 'Solicitud para dar de alta un sub afiliado bajo una afiliación principal existente.',
    form_schema: {
      secciones: [
        { titulo: 'Datos de la afiliación principal', campos: [
          { key: 'afil_principal_razon', label: 'Razón Social de la Afiliación Principal', tipo: 'text', required: true },
        ]},
        { titulo: 'Datos del ticket (sub afiliado)', campos: [
          { key: 'nombre_comercial', label: 'Nombre Comercial', tipo: 'text', required: true },
          { key: 'domicilio', label: 'Domicilio Fiscal', tipo: 'textarea' },
          { key: 'cp', label: 'C.P.', tipo: 'text' },
          { key: 'estado_mun', label: 'Estado / Municipio', tipo: 'text' },
          { key: 'tel', label: 'Teléfono', tipo: 'text' },
          { key: 'email', label: 'Correo electrónico', tipo: 'text' },
          { key: 'web', label: 'Sitio Web / App', tipo: 'text' },
        ]},
        { titulo: 'Datos de contacto', campos: [
          { key: 'contacto_nombre', label: 'Nombre completo', tipo: 'text', required: true },
          { key: 'contacto_puesto', label: 'Puesto', tipo: 'text' },
          { key: 'contacto_tel', label: 'Teléfono', tipo: 'text' },
          { key: 'contacto_email', label: 'Correo electrónico', tipo: 'text' },
        ]},
        { titulo: 'Datos de liquidación', campos: [
          { key: 'esquema_liq', label: 'Esquema de Liquidación', tipo: 'textarea',
            hint: 'La liquidación del sub afiliado se realiza a través de la CLABE de la afiliación principal.' },
        ]},
        { titulo: 'Tasa pactada con el cliente', campos: [
          { key: 'tasa_debito', label: 'Débito (TDD)', tipo: 'text', required: true, hint: 'Ej. 1.85% + IVA' },
          { key: 'tasa_credito', label: 'Crédito (TDC)', tipo: 'text', required: true, hint: 'Ej. 2.50% + IVA' },
          { key: 'tasa_internacional', label: 'Internacional (INT)', tipo: 'text', required: true, hint: 'Ej. 3.20% + IVA' },
          { key: 'tasa_amex', label: 'AMEX', tipo: 'text', required: true, hint: 'Ej. 3.50% + IVA' },
        ]},
        { titulo: 'Modalidad de activación', campos: [
          { key: 'modalidad', label: 'Modalidad', tipo: 'checkbox_group', required: true,
            options: ['Terminal POS física','Link de pago','API e-commerce'] },
          { key: 'monto_fijo_txn', label: 'Monto fijo por transacción (MXN)', tipo: 'number',
            hint: 'Cargo fijo adicional en pesos por cada transacción procesada.',
            show_if: { key: 'modalidad', any_of: ['Link de pago','API e-commerce'] } },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P05', nombre: 'Deployment de Actualización POS', sla_dias: 7,
    descripcion: 'Solicitud para dictaminar y desplegar una nueva versión del aplicativo en la flota POS.',
    form_schema: {
      secciones: [
        { titulo: 'Tipo de versión', campos: [
          { key: 'tipo_version', label: 'Tipo', tipo: 'radio', required: true,
            options: ['Marca Blanca (Proveedor Externo)','Desarrollo In-House (Polimentes)'] },
        ]},
        { titulo: 'Datos de la versión', campos: [
          { key: 'version_anterior', label: 'Versión anterior (actual en producción)', tipo: 'text', required: true },
          { key: 'nueva_version', label: 'Nueva versión (a deployar)', tipo: 'text', required: true },
          { key: 'proveedor', label: 'Proveedor (si Marca Blanca)', tipo: 'text' },
          { key: 'fecha_recepcion', label: 'Fecha de Recepción / Desarrollo', tipo: 'date' },
          { key: 'descripcion', label: 'Descripción general de la actualización', tipo: 'textarea', required: true },
          { key: 'modulos', label: 'Módulos / funcionalidades incluidas', tipo: 'textarea' },
        ]},
        { titulo: 'Dictamen técnico', campos: [
          { key: 'dictamen', label: 'Dictamen', tipo: 'radio', options: ['Aprobado — todos los módulos funcionan','Rechazado — se identificaron observaciones'] },
          { key: 'dictamen_obs', label: 'Observaciones (si rechazado)', tipo: 'textarea' },
          { key: 'valido_por', label: 'Validó (Tecnología / PM)', tipo: 'text' },
        ]},
        { titulo: 'Plan de deployment', campos: [
          { key: 'fecha_inicio', label: 'Fecha de inicio', tipo: 'date' },
          { key: 'fecha_fin', label: 'Fecha de fin estimada', tipo: 'date' },
          { key: 'total_terminales', label: 'No. total de terminales a actualizar', tipo: 'number' },
          { key: 'comercios_afectados', label: 'Comercios afectados', tipo: 'textarea' },
          { key: 'ventana', label: 'Ventana de actualización (horario)', tipo: 'text' },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P05B', nombre: 'Deployment Específico (Terminales Puntuales)', sla_dias: 3,
    descripcion: 'Solicitud de actualización del aplicativo en terminales específicas (no masivo).',
    form_schema: {
      secciones: [
        { titulo: 'Solicitud', campos: [
          { key: 'area', label: 'Área solicitante', tipo: 'text', required: true },
          { key: 'solicitante', label: 'Nombre del solicitante', tipo: 'text', required: true },
          { key: 'aplicativo', label: 'Aplicativo / versión a instalar', tipo: 'text', required: true },
          { key: 'motivo', label: 'Motivo de la actualización', tipo: 'textarea', required: true },
          { key: 'terminales', label: 'Terminales objetivo (No. de serie, Grupo, Comercio — una por línea)', tipo: 'textarea', required: true },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P06', nombre: 'Cálculo de Compensación + Layout Dispersión (Marca Blanca)', sla_dias: 1,
    descripcion: 'Solicitud del ciclo diario de compensación + generación del layout SPEI.',
    form_schema: {
      secciones: [
        { titulo: 'Ciclo solicitado', campos: [
          { key: 'fecha_liq', label: 'Fecha de liquidación', tipo: 'date', required: true },
          { key: 'observaciones', label: 'Observaciones', tipo: 'textarea' },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P07', nombre: 'Cambio de Datos de Sub Afiliado', sla_dias: 2,
    descripcion: 'Cambio a datos propios del sub afiliado (nombre comercial, domicilio, contacto, MCC).',
    form_schema: {
      secciones: [
        { titulo: 'Solicitante', campos: [
          { key: 'am', label: 'Account Manager', tipo: 'text', required: true },
        ]},
        { titulo: 'Afiliación principal', campos: [
          { key: 'razon_social', label: 'Razón Social', tipo: 'text', required: true },
          { key: 'no_afil', label: 'No. de Afiliación', tipo: 'text', required: true },
        ]},
        { titulo: 'Sub afiliado', campos: [
          { key: 'id_sub', label: 'ID Sub Comercio', tipo: 'text', required: true },
          { key: 'nombre_actual', label: 'Nombre Comercial Actual', tipo: 'text' },
        ]},
        { titulo: 'Tipo de modificación', campos: [
          { key: 'tipo_mod', label: 'Tipo', tipo: 'checkbox_group', required: true,
            options: ['Nombre Comercial (ticket)','Domicilio de la sucursal','Teléfono / Correo / Contacto'],
            hint: 'Si el cambio es de tasa o esquema de cobro, use POL-OP-P08 en su lugar.' },
        ]},
        { titulo: 'Detalle del cambio', campos: [
          { key: 'campo', label: 'Campo a modificar', tipo: 'text', required: true },
          { key: 'dato_actual', label: 'Dato actual', tipo: 'textarea', required: true },
          { key: 'dato_nuevo', label: 'Dato nuevo', tipo: 'textarea', required: true },
          { key: 'justificacion', label: 'Justificación', tipo: 'textarea', required: true },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P08', nombre: 'Cambio de Condiciones Comerciales', sla_dias: 5,
    descripcion: 'Cambio de tasa pactada o esquema de cobro (afecta a la afiliación principal y sus sub afiliados).',
    form_schema: {
      secciones: [
        { titulo: 'Solicitante', campos: [
          { key: 'am', label: 'Account Manager', tipo: 'text', required: true },
          { key: 'dir_comercial', label: 'Director Comercial', tipo: 'text', required: true },
        ]},
        { titulo: 'Afiliación principal', campos: [
          { key: 'razon_social', label: 'Razón Social', tipo: 'text', required: true },
          { key: 'no_afil', label: 'No. de Afiliación', tipo: 'text', required: true },
          { key: 'grupo', label: 'Grupo de Cliente', tipo: 'text' },
          { key: 'esquema_actual', label: 'Esquema de cobro actual', tipo: 'text' },
        ]},
        { titulo: 'Tasa pactada actual', campos: [
          { key: 'tasa_actual_debito', label: 'Débito (TDD)', tipo: 'text', required: true },
          { key: 'tasa_actual_credito', label: 'Crédito (TDC)', tipo: 'text', required: true },
          { key: 'tasa_actual_internacional', label: 'Internacional (INT)', tipo: 'text', required: true },
          { key: 'tasa_actual_amex', label: 'AMEX', tipo: 'text', required: true },
        ]},
        { titulo: 'Cambio solicitado', campos: [
          { key: 'concepto', label: 'Cambio', tipo: 'checkbox_group', required: true,
            options: ['Cambio de tasa pactada','Cambio de esquema de cobro'] },
          { key: 'esquema_nuevo', label: 'Esquema de cobro nuevo', tipo: 'text' },
          { key: 'justificacion', label: 'Justificación del cambio', tipo: 'textarea', required: true },
        ]},
        { titulo: 'Tasa pactada nueva', campos: [
          { key: 'tasa_nueva_debito', label: 'Débito (TDD)', tipo: 'text' },
          { key: 'tasa_nueva_credito', label: 'Crédito (TDC)', tipo: 'text' },
          { key: 'tasa_nueva_internacional', label: 'Internacional (INT)', tipo: 'text' },
          { key: 'tasa_nueva_amex', label: 'AMEX', tipo: 'text' },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P09', nombre: 'Monitoreo, Suspensión o Baja de Merchant', sla_dias: 5,
    descripcion: 'Documenta acciones de monitoreo, suspensión, baja o reactivación de sub afiliados.',
    form_schema: {
      secciones: [
        { titulo: 'Identificación del sub afiliado', campos: [
          { key: 'no_afil_principal', label: 'No. de Afiliación Principal', tipo: 'text', required: true },
          { key: 'grupo', label: 'Grupo de Cliente', tipo: 'text' },
          { key: 'id_sub', label: 'ID Sub Comercio', tipo: 'text', required: true },
          { key: 'nombre', label: 'Nombre Comercial', tipo: 'text' },
          { key: 'razon_social_afil', label: 'Razón Social (afiliación principal)', tipo: 'text' },
        ]},
        { titulo: 'Tipo de acción', campos: [
          { key: 'accion', label: 'Acción', tipo: 'radio', required: true,
            options: [
              'Alerta preventiva (≥0.75% tasa CBK)',
              'Programa de Cumplimiento (≥1% c/≥100 CBK)',
              'Suspensión interna en gateway',
              'Baja del sub afiliado en gateway',
              'Reactivación',
              'Escalamiento a Broxel / Base Única',
              'Depuración por inactividad',
            ]},
        ]},
        { titulo: 'Indicadores de monitoreo (últimos 3 meses)', campos: [
          { key: 'periodo', label: 'Periodo de evaluación', tipo: 'text' },
          { key: 'total_txn', label: 'Total transacciones', tipo: 'number' },
          { key: 'total_cbk', label: 'Total contracargos', tipo: 'number' },
          { key: 'tasa_cbk', label: 'Tasa de contracargos (CBK/TXN)', tipo: 'text' },
          { key: 'tasa_afil', label: 'Tasa consolidada a nivel afiliación', tipo: 'text' },
          { key: 'meses_inactivo', label: 'Meses sin transaccionar (si aplica)', tipo: 'number' },
        ]},
        { titulo: 'Motivo', campos: [
          { key: 'motivo', label: 'Justificación / motivo', tipo: 'textarea', required: true },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P10', nombre: 'Gestión de Contracargos y Disputas', sla_dias: 2,
    descripcion: 'Registro y seguimiento de contracargos y disputas por comercio.',
    form_schema: {
      secciones: [
        { titulo: 'Identificación', campos: [
          { key: 'grupo', label: 'Grupo de Cliente', tipo: 'text', required: true },
          { key: 'afil', label: 'No. de Afiliación', tipo: 'text', required: true },
          { key: 'comercio', label: 'Comercio', tipo: 'text' },
          { key: 'marca', label: 'Marca', tipo: 'select', options: ['VISA','MASTERCARD','AMEX','CARNET'] },
        ]},
        { titulo: 'Datos del caso', campos: [
          { key: 'no_caso', label: 'No. de caso / ARN', tipo: 'text', required: true },
          { key: 'monto', label: 'Monto en disputa', tipo: 'number', required: true },
          { key: 'fecha_tx', label: 'Fecha de la transacción', tipo: 'date' },
          { key: 'codigo_razon', label: 'Código de razón', tipo: 'text' },
          { key: 'descripcion', label: 'Descripción del caso', tipo: 'textarea' },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P11', nombre: 'Alta de Usuario en Suite Polipay (TPV)', sla_dias: 2,
    descripcion: 'Alta/modificación/baja de usuario en el módulo TPV de Suite Polipay.',
    form_schema: {
      secciones: [
        { titulo: 'Datos del solicitante', campos: [
          { key: 'sol_nombre', label: 'Nombre completo', tipo: 'text', required: true },
          { key: 'sol_puesto', label: 'Puesto', tipo: 'text' },
          { key: 'sol_area', label: 'Área / Departamento', tipo: 'text' },
          { key: 'sol_email', label: 'Correo electrónico', tipo: 'text', required: true },
          { key: 'sol_tel', label: 'Teléfono / Extensión', tipo: 'text' },
        ]},
        { titulo: 'Tipo de solicitud', campos: [
          { key: 'tipo_solicitud', label: 'Tipo', tipo: 'radio', required: true,
            options: ['Alta de usuario nuevo','Modificación de permisos / niveles','Baja de usuario','Reactivación'] },
        ]},
        { titulo: 'Datos del usuario', campos: [
          { key: 'usuario_email', label: 'Correo asociado', tipo: 'text', required: true },
          { key: 'usuario_existente', label: 'En caso de modificación/baja, usuario existente', tipo: 'text' },
        ]},
        { titulo: 'Perfil y permisos', campos: [
          { key: 'perfil', label: 'Perfil solicitado', tipo: 'select', required: true,
            options: ['Administrador','Supervisor','Tesorería','Soporte Técnico','Cliente — Empresa','Cliente — UdeN','Cliente — Comercio'] },
          { key: 'modulos', label: 'Módulos del TPV a los que requiere acceso', tipo: 'checkbox_group',
            options: ['Empresas','Unidades de Negocio','Comercios','Usuarios','Transacciones','Terminales','Dispersiones','Liquidaciones'] },
          { key: 'justificacion', label: 'Justificación del acceso', tipo: 'textarea', required: true },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P12', nombre: 'Solicitud de Terminal (TPV)', sla_dias: 5,
    descripcion: 'Solicitud de asignación, reemplazo, reasignación o devolución de terminales POS.',
    form_schema: {
      secciones: [
        { titulo: 'Solicitante', campos: [
          { key: 'am', label: 'Account Manager', tipo: 'text', required: true },
          { key: 'dir_comercial', label: 'Director Comercial', tipo: 'text' },
        ]},
        { titulo: 'Datos del grupo de cliente', campos: [
          { key: 'grupo', label: 'Grupo de Cliente', tipo: 'text', required: true },
          { key: 'razon_social', label: 'Razón Social', tipo: 'text' },
          { key: 'contacto', label: 'Contacto del cliente', tipo: 'text' },
          { key: 'tel_email', label: 'Teléfono / Correo', tipo: 'text' },
          { key: 'cantidad', label: 'Cantidad de terminales solicitadas', tipo: 'number', required: true },
        ]},
        { titulo: 'Tipo de entrega', campos: [
          { key: 'entrega', label: 'Modalidad', tipo: 'radio', required: true,
            options: ['En mano al Account Manager','Por envío'] },
          { key: 'direccion', label: 'Dirección completa de envío (si aplica)', tipo: 'textarea' },
          { key: 'costo_envio', label: 'Costo de envío', tipo: 'radio',
            options: ['A cargo del cliente','A cargo de MCEB (requiere hoja firmada)'] },
        ]},
        { titulo: 'Forma de adquisición', campos: [
          { key: 'forma_adq', label: 'Forma', tipo: 'radio', required: true,
            options: ['CON PAGO — Nota de venta + comprobante','A COMODATO (préstamo) — Requiere Contrato'] },
          { key: 'nota_venta', label: 'No. de Nota de Venta (si CON PAGO)', tipo: 'text' },
          { key: 'monto', label: 'Monto pagado', tipo: 'number' },
          { key: 'contrato_comodato', label: 'No. de Contrato de Comodato (si COMODATO)', tipo: 'text' },
        ]},
        { titulo: 'Tipo de solicitud', campos: [
          { key: 'tipo', label: 'Tipo', tipo: 'radio', required: true,
            options: ['Nueva terminal','Reemplazo (por falla/daño)','Reasignación','Devolución'] },
        ]},
      ],
    },
  },
  {
    codigo: 'POL-OP-P13', nombre: 'Cambio de CLABE Liquidadora', sla_dias: 3,
    descripcion: 'Cambio de la CLABE liquidadora de una afiliación (la nueva cuenta debe ser del mismo titular).',
    form_schema: {
      secciones: [
        { titulo: 'Datos de la afiliación', campos: [
          { key: 'grupo', label: 'Grupo de Cliente', tipo: 'text', required: true },
          { key: 'no_afil', label: 'No. de Afiliación', tipo: 'text', required: true },
          { key: 'titular', label: 'Razón Social / Nombre del titular', tipo: 'text', required: true },
          { key: 'rfc_titular', label: 'RFC del titular', tipo: 'text', required: true },
          { key: 'am', label: 'Account Manager', tipo: 'text' },
        ]},
        { titulo: 'CLABE actual y nueva', campos: [
          { key: 'clabe_actual', label: 'CLABE actual (18 dígitos)', tipo: 'text', required: true },
          { key: 'banco_actual', label: 'Banco actual', tipo: 'text' },
          { key: 'clabe_nueva', label: 'NUEVA CLABE (18 dígitos)', tipo: 'text', required: true },
          { key: 'banco_nuevo', label: 'Banco de la nueva cuenta', tipo: 'text', required: true },
          { key: 'nuevo_titular', label: 'Titular de la nueva cuenta', tipo: 'text', required: true,
            hint: 'DEBE estar a nombre del mismo titular de la afiliación.' },
          { key: 'nuevo_rfc', label: 'RFC del titular de la nueva cuenta', tipo: 'text', required: true },
        ]},
        { titulo: 'Justificación', campos: [
          { key: 'justificacion', label: 'Justificación del cambio', tipo: 'textarea', required: true },
        ]},
        { titulo: 'Documentación', campos: [
          { key: 'docs', label: 'Adjuntos requeridos', tipo: 'checkbox_group',
            options: ['Carátula / constancia bancaria de la nueva CLABE (≤ 90 días)','Identificación oficial vigente del representante legal / apoderado'] },
        ]},
      ],
    },
  },
];

module.exports = { CATALOGO };
