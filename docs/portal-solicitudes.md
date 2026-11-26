# Portal de solicitudes de clientes (POS)

Los clientes de Polipay piden aquí altas y cambios en lugar de mandar formatos por correo, y Comercial no pierde la trazabilidad: cada solicitud tiene su folio, su
estado, quién hizo cada paso y cuándo. Usa lo que ya sabe POS (grupos de cliente, afiliaciones, tasas pactadas, cuentas de liquidación y bancos).

## Qué se puede pedir (primera entrega: POS)
| Solicitud | Procedimiento / formato | Reglas que revisa el sistema |
|---|---|---|
| Alta de comercio sub afiliado | POL-OP-P03 / F03 | La afiliación principal se elige de las de su grupo; **hereda tasa, CLABE y datos de la afiliación** (no se capturan ni por Comercial ni por Operación); no pide fotografías (esas son de la alta de afiliación). **Cuenta de liquidación:** el cliente elige si se liquida a la **concentradora de la afiliación** (banco, CLABE y titular salen de las cuentas de liquidación de POS) o si se **crea una cuenta nueva en Suite Banca** (entonces el cliente indica si va en una **unidad de negocio nueva** o **debajo de una existente** y escribe su nombre; Operación registra la CLABE creada). Comercial solo revisa y libera; Operación ejecuta y confirma que quedó realizado |
| Alta de afiliación | POL-OP-P02 / F02 | RFC, CURP y CLABE válidos; el banco debe coincidir con la CLABE; avisa de razón social parecida a una existente o CLABE ya registrada; checklist de 10 documentos |
| Usuario en Suite Polipay | POL-OP-P11 / F11 | Alta, modificación, baja o reactivación con niveles Empresa / Unidad de Negocio / Comercio; **perfil Administrador o más de 3 niveles requiere firma de la Dirección** |
| Cambio de datos de sub afiliado | POL-OP-P07 / F07 | Solo datos propios del sub afiliado (no tasa ni esquema) |
| Cambio de condiciones comerciales | POL-OP-P08 / F08 | Crítica: firma de la Dirección; muestra la diferencia contra la tasa pactada en POS |
| Cambio de CLABE liquidadora | POL-OP-P13 / F13 | Misma CLABE o banco que no corresponde se rechazan; **avisa si el titular no coincide**; pide carátula (≤ 90 días) e identificación; firma de la Dirección |

## Flujo
Cliente captura y sube documentos → **Comercial revisa** (completa condiciones, puede devolver al cliente) y libera → **Operación POS** toma, ejecuta y registra la Parte 2
(afiliación, token, MCC, prueba…) → **Coordinación** valida (y la **Dirección** si aplica) → Completada. Se puede rechazar o cancelar con motivo.
El cliente ve estados simples («En revisión», «Necesita tu información», «En proceso», «Completada») y solo lo que le corresponde; el token de activación nunca se le muestra.

## Unidades de negocio (= grupos de cliente de POS) y acceso por correo
**Una unidad de negocio es un grupo de cliente de POS**, y su estructura (grupo → afiliaciones / razones sociales, con sus tasas y cuentas de liquidación) sale tal cual del módulo de Grupos de cliente y afiliaciones. El personal (administrador, Dirección Comercial, Comercial) ve **todas** en «Unidades de negocio» y en «Nueva solicitud» (aunque todavía no tengan el portal activo).
- En «Unidades de negocio» cada una tiene tres pestañas: **General** (Ejecutivo Comercial y portal activo), **Grupos de afiliaciones (opcional)** y **Contactos**.
- A cada contacto (correo de Google) se le da acceso a la unidad de negocio; al pedir una solicitud elige **bajo cuál de sus afiliaciones o razones sociales** va. Su nombre, correo, puesto y teléfono se precargan.
- **Una afiliación puede estar en varias unidades de negocio** (como en Grupos y afiliaciones de POS): cada grupo ve sus propias tasas pactadas, su cuenta de liquidación y sus comercios para esa afiliación, y las solicitudes y avisos de duplicado se separan por grupo. En el formulario, **al cambiar de unidad de negocio** se muestran las afiliaciones con las que opera; lo ya capturado se conserva, menos lo que depende de la afiliación.
- Opcional: si alguien debe ver solo parte de las afiliaciones (por ejemplo una sucursal), se crea un grupo de afiliaciones y se le asigna; el servidor **rechaza** lo que salga de ese alcance. Por defecto no existe ninguno.

## Elegir afiliación y ver sus costos
Al pedir un sub comercio (y en los cambios de datos, condiciones y CLABE), el cliente elige **bajo cuál de sus afiliaciones** y ve al instante su **vista previa**: razón social, giro/MCC, cuenta donde liquida, **tasas pactadas** (débito, crédito, internacional, AMEX, costo por transacción) y los comercios que ya operan bajo ella. Esas tasas son las que hereda el comercio nuevo. En su Inicio, el cliente tiene el resumen «Mis afiliaciones y condiciones». Los costos internos de Polipay (interredes, fee del adquirente) no se muestran.

## Opciones de cobro según la modalidad
En «Modalidad de activación» (alta de sub afiliado y de afiliación) se captura en una **matriz**: una fila por modalidad, una columna por opción de cobro y un **interruptor** en cada celda.
- **Terminal POS física:** Propina, MSI y Check-in/out.
- **Link de pago** y **API e-commerce** (Hosted o Server-to-Server): MSI.
- Al marcar una modalidad se encienden sus filas; el interruptor apagado cuenta como «No». Si activa MSI aparecen debajo los plazos (3, 6, 9, 12, 18 o 24 meses).
- Las modalidades sin opciones (MOTO, SPEI, CoDi) solo se marcan. Si se eligen las dos API, la opción de MSI se captura una sola vez.
Operación confirma en su parte lo que dejó habilitado («Opciones habilitadas»); todo sale en el PDF, el formato imprimible y el Registro.

## Registro de todas las solicitudes
Menú **Registro** (personal): todas las solicitudes, de cualquier tipo y estado, con filtros (fechas, tipo, estado, cliente, búsqueda) y **descarga a Excel** (hoja general + una hoja por tipo con todos sus datos, sin el token) para las bitácoras de los procedimientos. Cada solicitud conserva además su historial inalterable.

## Formatos en PDF
- Menú **Formatos (PDF)**: los 6 formatos oficiales (F02, F03, F07, F08, F11, F13) en blanco, para imprimir y llenar a mano. También hay un botón «Formato en blanco» al capturar cada solicitud.
- En el detalle de cada solicitud, **«Descargar formato (PDF)»** baja el formato ya lleno: datos de cada parte, documentos, constancia electrónica de quién dio cada paso y cuándo (en lugar de firma de papel) y, para el personal, la huella de la bitácora. El token de activación nunca sale en el PDF.
- El cliente descarga el PDF de sus propias solicitudes, sin datos internos (condiciones, verificaciones, historial interno). Cada descarga del personal queda en la bitácora.

## Roles (se asignan en Administración → Usuarios → «Rol en Solicitudes de clientes»)
`dir_comercial` · `comercial` · `operacion` · `coordinacion` · `direccion` · `consulta` (el administrador de POS es administrador del portal).
Los **clientes** no se dan de alta en Administración: Comercial los registra en «Unidades de negocio» (correo de Google de cada persona) y entran con «Entrar con Google».
Cada cliente (grupo de POS) tiene un Ejecutivo Comercial asignado por la Dirección Comercial; ese Ejecutivo solo ve lo de sus clientes.

## Reglas que hace cumplir el servidor
- Cada quien solo ve su alcance (cliente: su grupo; Comercial: sus clientes; Operación, Coordinación y Dirección: lo ya liberado).
- Cada paso exige su rol, el estado correcto y la parte que le toca completa; versión por solicitud (409 si alguien más la cambió).
- Quien ejecuta no valida; con firma de Dirección, Coordinación y Dirección son personas distintas. El **único administrador activo** puede autoaprobar con comentario ≥ 20 caracteres (queda marcado y en alerta).
- Tiempos de atención por tipo (días hábiles, con los feriados de POS): Comercial 1 día, Operación según el tipo (2-5), validación 1 día; el reloj se detiene mientras la solicitud está con el cliente.
- Bitácora de cada solicitud inalterable y encadenada con hashes; archivos cifrados; **formato oficial imprimible** (F02/F03/F07/F08/F11/F13) con quién dio cada paso en lugar de firma de papel y la huella de la bitácora.
- Correos automáticos (mismo SES de POS y Cards) a quien le toca actuar y al solicitante.

## Pendiente de definir
- **Registro de usuarios en TDM** (aún sin procedimiento ni formato).
- Aplicar automáticamente en POS lo ejecutado (alta de cuenta, cambio de tasas y de CLABE): hoy Operación lo aplica y lo marca como ejecutado.
- Pantalla propia para recuperar/mostrar la huella de bitácora y exportar reportes de SLA.

Código: `lib/solicitudes/` (catalogo, flujo, validar, pos, correos, impresion, routes), `db/schema-solicitudes.sql`, `public/solicitudes/ui.js`, pruebas `test/solicitudes-api.test.js`.
