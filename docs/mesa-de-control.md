# Credit Solvendom · Mesa de control de una SOFOM (núcleo)

Reemplaza las pantallas de cartera que había en Credit Solvendom. Se diseñó a partir de lo que ofrecen Strappberry (autorización en mesa de control con
quién y cuándo), SIAC (originación → cartera → cobranza → fondeo → contabilidad → PLD → reportes), Credyra (mesa de control, trazabilidad, aprobaciones
en dos pasos) y Acendes (motor de decisión, PLD/KYC, scoring paramétrico, bitácora inmutable).

## Qué incluye esta primera entrega
| Pieza | Qué hace |
|---|---|
| Solicitud y expediente | Captura del solicitante (persona física o moral) y del crédito; checklist de documentos por tipo de persona y producto; archivos PDF/JPG/PNG cifrados |
| KYC / PLD | Consulta contra listas (SAT 69-B, UIF, OFAC, ONU, internas; las carga Cumplimiento), coincidencias por RFC/CURP/nombre aproximado, resolución con fundamento, riesgo del cliente por factores |
| Motor de decisión | Reglas paramétricas por producto (capacidad de pago, score, antigüedad, edad, rangos, PLD, expediente) → aprobar / revisión / rechazar / incompleta. **No decide**: la firma una persona |
| Autorización | Niveles: Cumplimiento (si riesgo PLD alto) → Mesa → Comité (si el monto rebasa la facultad de la mesa). Devolver con comentarios, rechazar con motivo, cancelar |
| Tablero | «Para hoy» por rol, embudo con tiempos de atención (semáforo), KPI de 30 días, motivos de rechazo, alertas |
| Trazabilidad | Bitácora inalterable con cadena de hashes + triggers (sin UPDATE/DELETE/TRUNCATE) y verificación de integridad |

## Reglas que hace cumplir el servidor
- Cada acción exige el permiso de su rol y el estado correcto de la solicitud.
- Quien captura no verifica ni firma; quien verifica no firma; cada nivel de firma lo da una persona distinta.
- Excepción: el **único** administrador activo puede autoaprobar con comentario ≥ 20 caracteres; queda marcado «autoaprobada» y en alerta. Con 2 o más administradores se prohíbe.
- Ir contra la recomendación del motor exige comentario ≥ 20 caracteres y queda marcado.
- Versión por solicitud: si alguien más la cambió, 409. Una solicitud autorizada o rechazada no se edita.
- Una coincidencia PLD confirmada impide autorizar. Quien sube un documento no lo valida.
- Todo asiento de bitácora se escribe en la misma transacción que el cambio.

## Roles (se asignan en Administración → Usuarios → «Rol en Credit Solvendom»)
`admin` · `ejecutivo` · `analista` · `cumplimiento` · `mesa` · `consulta`. La matriz completa está en «Facultades y política».

## Datos y seguridad
Tablas `mc_*` en el schema `credit_solvendom`; no toca las `cartera_*` ni el sistema anterior. RFC, CURP, domicilio, teléfono, correo y archivos van cifrados con
`lib/crypto.js` (**en producción deben existir `ENCRYPTION_KEY_V1` y `HMAC_PEPPER`; sin ellas se guardaría con prefijo `plain:`**). API: `/api/cartera/mc/*`.
Código: `lib/mesa/` (flujo, motor, pld, roles, config, core, bitácora, rutas, ejemplos), `public/mesa/ui.js`, `db/schema-mesa.sql`.

## Antes de usarla con clientes reales
1. Confirmar las llaves de cifrado en Render y que los respaldos de la base cubren las tablas `mc_*`.
2. Cargar las listas oficiales (hoy solo hay ejemplos) y definir quién de Cumplimiento las actualiza y con qué frecuencia.
3. Ajustar con la dirección: facultad de la mesa, política del motor por producto, tiempos de atención y documentos requeridos.
4. Revisión legal/regulatoria de PLD (CNBV/UIF) y de aviso de privacidad para datos y documentos personales.
5. Piloto con personas reales por rol; borrar los datos de ejemplo.
6. Traer la cartera actual (pendiente de la decisión del usuario cuando la mesa esté lista para producción).

## Ciclo completo (segunda entrega)
| Pieza | Qué hace |
|---|---|
| Formalización | De una solicitud autorizada se abre el crédito (condiciones autorizadas, CAT, tabla prevista); contrato imprimible con carátula y tabla; firmas con huella de la versión firmada (si cambian las condiciones, hay que firmar de nuevo); formaliza solo con firma del acreditado/representante y de la SOFOM |
| Desembolso | Tesorería solicita → la mesa autoriza (otra persona) → layout SPEI (mismo formato del sistema) → se envía → se confirma con clave de rastreo (otra persona que quien autorizó). Al confirmar el crédito queda vigente y la tabla se congela. Revisa disponible de la línea de fondeo y periodo contable |
| Cartera | Saldos, atraso, moratorios (tasa/360 sobre capital vencido) con IVA y aplicación de pagos moratorios → interés → IVA → capital, recalculados siempre desde la tabla y los pagos; estado de cuenta; cancelar un pago solo el administrador y con motivo |
| Cobranza | Bandeja por tramo (1-30, 31-60, 61-90, 91+), gestiones (llamada, visita…), promesas de pago que se marcan cumplidas o incumplidas solas |
| Conciliación bancaria | Importa el estado de cuenta (xlsx/csv), concilia solo por referencia y monto, sugiere el crédito por folio, registra pagos desde el movimiento, ignora con motivo y avisa de pagos sin movimiento |
| Fondeo | Líneas (institucional, friends & family, capital propio), disposiciones y pagos, colocado vs disponible, descalce |
| Contabilidad | Catálogo de cuentas y pólizas automáticas por periodo (desembolso, cobranza, devengo, traspaso a vencida, estimación preventiva); cierre en orden con pólizas cuadradas; un periodo cerrado bloquea pagos y desembolsos con fecha en él; balanza; CSV; reabrir solo el último y solo el administrador |
| Reportes | Cartera y morosidad (IMOR, ICOR, tramos), borrador para buró, comisiones cobradas |
| Ingresos por facturar | Corte de lo cobrado: **comisiones por apertura** (al desembolsar) e **intereses ordinarios y moratorios** (al recibir cada pago), con IVA y la razón social y RFC a quien se factura. Cada cobro entra a un solo corte; se manda por correo a contabilidad con Excel adjunto, **automáticamente cada semana** (día configurable, por omisión lunes; reintenta cada hora si falla) o a mano. Destinatarios Para/CC/BCC propios. Un pago ya cortado que se cancela deja un ajuste negativo para el siguiente corte |
| UIF | Detección de pagos en efectivo relevantes, fraccionamiento, pagos de terceros y liquidación anticipada; dictamen con fundamento y control del folio de acuse |

Roles nuevos: `tesoreria`, `cobranza`, `contador` (además de admin, ejecutivo, analista, cumplimiento, mesa, consulta).

## Lo que este sistema NO hace (requiere terceros o definiciones externas)
- **Enviar el SPEI**: genera el layout; lo sube una persona al banco (o se integra la API del banco cuando haya contrato y credenciales).
- **Buró de crédito en línea y scoring externo**: el score se captura a mano; el archivo para buró es un **borrador** sin el layout oficial de la sociedad contratada.
- **Avisos a la UIF/CNBV/CONDUSEF**: detecta, dictamina y exporta; la presentación se hace en los portales oficiales.
- **Firma electrónica con validez legal**: registra evidencia (firmante, fecha, huella del contrato, escaneo); la validez legal depende del proveedor que se contrate.
- **Portal del acreditado y cobranza en campo con GPS**: requieren identidad de usuarios externos y una app; no están.
- **Contabilidad oficial**: los criterios de las pólizas son simplificados (devengo lineal, traspaso por días de atraso, estimación por tramo); el contador los valida y ajusta antes de usarlos.
- **Texto del contrato**: es una base para revisión legal.
