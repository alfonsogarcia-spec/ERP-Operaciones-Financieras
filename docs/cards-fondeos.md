# Polipay Cards Settlement (BSO) · Solicitud de fondeos, CEP y asignación de saldo

Tercer espacio de trabajo del sistema (junto a *Conciliación* y *Tareas Ops*). Control interno de tesorería de los fondeos de
Empresas, Unidades de negocio (UN) y Tarjetas, con el **CEP** como evidencia y la **confirmación de tesorería** como cierre.

Estado: **local, sin commit ni deploy.** Esquema `cards` (`db/schema-cards.sql`), rutas `lib/cards-routes.js`, reglas
`lib/cards-flujo.js`, lectura de CEP `lib/cards-cep-extract.js`, cálculo `lib/cards-fondeo.js`, correos `lib/cards-correo.js`,
pantallas al final del script de `index.html`.

## El flujo

```
 Comercial                         Sistema                                   Tesorería
 ─────────                         ───────                                   ─────────
 1. Solicita: empresa + monto  →   cotiza comisión + IVA = total a depositar
    a fondear                      estatus: ESPERANDO CEP
 2. La empresa deposita. El
    comercial sube el CEP     →    lee el CEP y lo compara con la solicitud
                                   ✗ no es CEP / CLABE distinta / rastreo repetido → se rechaza con el motivo
                                   ✓ pasa a POR ASIGNAR  ───── aviso por correo ───→  3. Revisa contra el estado de cuenta
                                                                                      y confirma "saldo asignado"
                                   ASIGNADO  ←──────────── aviso por correo ────────  (o RECHAZA con motivo)
```

Ejemplo del negocio: el comercial pide fondear **300,000**; el sistema cotiza comisión 0.5 % = 1,500 + IVA 16 % **de la comisión** = 240
→ la empresa debe depositar **301,740**. Se captura lo que llegó y se desglosa con la fórmula inversa
`fondeo = recibido / (1 + comisión% × (1 + IVA%))`.

| Estatus | Significado | Quién avanza |
|---|---|---|
| **Esperando CEP** | Cotizado; falta el comprobante del depósito | Comercial sube el CEP |
| **Por asignar** | CEP aceptado; en la bandeja de tesorería (con contador en el menú) | Tesorería asigna o rechaza |
| **Asignado** | Tesorería confirmó que el saldo se asignó. Queda congelado | — |
| **Rechazado** | Tesorería lo devolvió con motivo. El comercial quita el CEP, sube el correcto o cancela | Comercial |
| **Cancelado** | Con motivo. El comercial cancela lo suyo mientras no esté con tesorería; tesorería cualquiera salvo asignado; un asignado solo lo cancela un administrador | — |

Cada paso queda en el **historial** del fondeo (incluidos los intentos de CEP no aceptados) y en la bitácora general.

## “Solo se aceptan CEP”

Solo entra un archivo que el sistema **lee como CEP** (PDF o XML): el CEP de Banxico o el comprobante de dispersión de Polipay
(único soporte de las transferencias Polipay → Polipay; para exigir solo Banxico, quitar `dispersion_polipay` de
`FORMATOS_ACEPTADOS` en `lib/cards-flujo.js`). Se **rechaza**: imágenes, PDF escaneados, la *consulta de estado del pago* de Banxico
(el propio documento dice que no es un CEP), cualquier PDF de otro formato y cualquier archivo sin monto, clave de rastreo, CLABE o fecha legibles.

Además, el CEP debe corresponder a la solicitud:

| Revisión | Si falla |
|---|---|
| **CLABE beneficiaria** = la CLABE de la empresa/UN/tarjeta | Se rechaza |
| Clave de rastreo **no usada** en otro fondeo (misma fecha) y archivo no repetido | Se rechaza |
| Fecha de abono no futura | Se rechaza |
| Una solicitud = un depósito (un 2.º archivo solo si trae la misma clave de rastreo, p. ej. PDF + XML) | Se rechaza |
| Monto = total cotizado | Se acepta **con aviso**: se recalcula con lo recibido y tesorería lo ve marcado “≠ solicitado” |
| RFC del ordenante = RFC de la empresa | Se acepta **con aviso** (posible depósito de un tercero); tesorería debe anotar el motivo para asignar |
| **Beneficiario** del CEP = beneficiario definido para esa CLABE | Se acepta **con aviso**; tesorería debe anotar el motivo para asignar |
| **Banco** del CEP = banco definido para esa CLABE | Se acepta **con aviso**; tesorería debe anotar el motivo para asignar |

Tesorería no puede asignar un fondeo con alertas sin escribir una **nota** con el motivo.

Lectura de los documentos (probada con 43 PDF reales): CEP de Banxico vía su *cadena original* firmada, comprobante de Polipay,
XML (mejor esfuerzo; falta validarlo con un XML real). Dependencia: `unpdf`.

## Candado de asignación

**Sin un CEP validado por el sistema no se puede poner “saldo asignado”**, ni con nota, ni siendo administrador. Se exige en tres capas:

1. **Pantalla:** sobre los botones aparece una fila discreta de requisitos (✓ Solicitud creada · ○ CEP cargado · ○ CEP validado) y *Confirmar saldo asignado* queda deshabilitado, con el motivo al pasar el cursor. Sin recuadros de aviso.
2. **Servidor:** `POST /fondeos/:id/asignar` responde `409 candado` con el motivo y deja el intento en el historial (`asignacion_bloqueada`).
3. **Base de datos:** un *trigger* (`cards.candado_asignacion`) rechaza cualquier cambio a `ASIGNADO` si no hay un CEP con `validado = true` y el fondeo no tiene monto, fecha y clave de rastreo. Aplica aunque alguien use otra ruta, un script o SQL directo.

“Validado” lo marca el sistema al aceptar el archivo (es un CEP legible, la CLABE beneficiaria es la de la entidad, trae monto y clave de rastreo); un archivo rechazado nunca se guarda. Una vez asignado, el CEP **no se puede quitar ni alterar** (otro *trigger*).
Los CEP que ya existían al activar el candado se validaron con la misma regla en la migración.

## Cuenta de fondeo: CLABE, beneficiario y banco

Cada empresa, UN y tarjeta tiene su **cuenta de fondeo**, con tres datos:

| Dato | Cómo se captura |
|---|---|
| **CLABE** | 18 dígitos con verificador; única en todo Cards |
| **Beneficiario** | Obligatorio: el titular de la cuenta, como aparece en el banco |
| **Banco** | **Se identifica solo** con los 3 primeros dígitos de la CLABE (012 → BBVA MEXICO). Si el prefijo no está en el catálogo, se pide elegirlo; no se acepta un banco distinto al que marca la CLABE |

Los tres se **congelan en cada fondeo** al crearlo (igual que la CLABE y las tasas), de modo que cambiar la cuenta después no altera el historial.
Las entidades capturadas antes de existir estos campos quedan con su banco deducido de la CLABE y marcadas **“Sin beneficiario”** hasta completarlas; mientras tanto el detalle del fondeo avisa que no se pudo comparar.

**Comparación contra el CEP.** El beneficiario y el banco que trae el CEP se comparan con los de la cuenta:
- *Beneficiario*: tolera acentos, puntuación, “S.A. de C.V.” / “SAPI”, orden de las palabras, palabras de menos y nombres cortados por el banco (el CEP trunca). Un nombre realmente distinto es diferencia.
- *Banco*: “BBVA MEXICO”, “BBVA BANCOMER” y el nombre largo de Banxico (“Banco Mercantil del Norte, S.A., Institución de Banca Múltiple, Grupo Financiero Banorte”) cuentan como el mismo banco.
- Si el CEP no trae el dato, no se marca nada. Una diferencia **no rechaza** el archivo (la CLABE ya identifica la cuenta y los bancos escriben el nombre libremente): se acepta con aviso al subirlo, aparece como alerta ✓/≠ en el detalle y tesorería **debe escribir una nota** para asignar. Si se prefiere rechazar, se cambia a error en `evaluarCep` (`lib/cards-flujo.js`).

## Bancos (catálogo de Cards)

`cards.bancos` es una **copia del catálogo “Bancos SPEI” de MCEB** (tabla `bancos` del sistema), completada con los 113 participantes SPEI (`lib/cards-bancos.json`). Se carga al arrancar y es idempotente: nunca pisa lo que ya existe; si un código ya está en la semilla, manda la semilla. Cada banco guarda su **clave en la CLABE** (los 3 últimos dígitos del código SPEI: 40012 → 012; 90646 STP → 646). Los códigos 91xxx (segundas claves), Banxico, CLS, Indeval y CoDi no llevan cuentas y no tienen clave.
Pantalla **Cards → Bancos**: búsqueda, alta, edición y desactivación (no se desactiva un banco con cuentas activas). Es un catálogo propio de Cards: editarlo no cambia “Bancos SPEI” de Conciliación.

## Estructura y roles

`Empresa → Unidad de negocio → Tarjeta` (la tarjeta puede colgar de la empresa). Cada nivel tiene su **CLABE** única (con dígito
verificador) y su comisión/IVA (UN y tarjeta heredan de la empresa si no tienen).

| Rol | Qué puede |
|---|---|
| **Comercial** (nuevo) | Solo Cards: cotizar y solicitar a **cualquier empresa**, y subir/quitar el CEP y cancelar **solo lo que él solicitó** (no ve los fondeos de otros). La API lo limita (no ve Conciliación ni Tareas) |
| Tesorería · Admin | Todo lo anterior + **asignar / rechazar**, registrar un fondeo que ya llegó, editar la estructura y asignar comerciales |
| Operador | Solicitar, subir CEP y registrar fondeos ya recibidos; no asigna |
| Bancos · Consulta | Solo lectura de Cards |

**Roles propios de Cards** (solo entran a Polipay Cards Settlement; no ven POS Settlement ni Tareas, y la API lo bloquea):

| Rol | Qué puede |
|---|---|
| **Administrador Cards** (`cards_admin`) | Todo en Cards: usuarios de Cards, estructura, bancos, destinatarios, solicitar, asignar/rechazar y cancelar incluso un fondeo asignado |
| **Tesorería Cards** (`cards_tesoreria`) | Asignar o rechazar, registrar fondeos recibidos, mantener estructura y bancos; recibe el aviso de “por asignar” |
| **Comercial** (`comercial`) | Solicita y gestiona solo lo suyo |
| **Consulta Cards** (`cards_consulta`) | Solo lectura |

## Usuarios y accesos (panel de Administración)

Todos los usuarios —POS Settlement, Tareas Ops y Cards— se administran en **un solo lugar**: el espacio **Administración → Usuarios** (en el selector de espacios). Ya no hay pantallas de Usuarios sueltas en POS ni en Cards.
La lista muestra, por usuario, su **rol** y a **qué sistemas entra** (el rol define el acceso), con búsqueda y filtros por sistema y estado. Al dar de alta recibe el correo de bienvenida de su sistema (“Polipay Cards Settlement” para los roles de Cards).

- **Administrador**: ve y administra todos los usuarios y roles.
- **Administrador Cards**: entra al mismo panel, pero **solo ve y edita usuarios con rol de Cards** (no puede crear ni tocar administradores o usuarios de POS). Un correo que ya existe en POS no se puede dar de alta desde ahí.
- Nadie puede cambiarse el rol, desactivarse ni borrarse a sí mismo; no se puede dejar el sistema sin un administrador activo.
- **Los cambios de rol y las desactivaciones aplican al instante** (hasta 1 minuto): el servidor consulta el rol vigente en cada petición, no el que traía la sesión. La pantalla se entera sola (avisa “Tu rol cambió a…” y ajusta el menú); un usuario desactivado o borrado pierde la sesión.
- Si se usa `MFA_REQUIRED_ROLES`, agregar `cards_admin,cards_tesoreria` para exigir la verificación en dos pasos.

## Quién solicita

El **solicitante es quien tiene la sesión abierta** cuando registra la solicitud: si la captura Fátima, la solicitante es Fátima (queda en el fondeo, en el historial, en el correo y en el Excel). Ya no se asigna un comercial por empresa; cada comercial ve y gestiona únicamente sus propias solicitudes.

## Avisos por correo

Los correos tienen el diseño de los demás correos de MCEB (logo, barra azul, tabla y pie) y se identifican como **Polipay Cards Settlement** (pie: “Polipay Cards Settlement · BSO · ops.emisor@polipay.io”).
Los que ya tienen CEP (por asignar, asignado, rechazado, cancelado) **llevan el CEP adjunto** (hasta 6 MB en total; si no cabe, lo dice y se abre en el sistema) y una sección **“CEP y validación”**: si el sistema lo validó, cuántas diferencias trae y, dato por dato (monto, CLABE, clave de rastreo, fecha, beneficiario, banco), lo que dice el CEP contra lo registrado.

| Evento | A quién |
|---|---|
| **Nueva solicitud** registrada | Los **Destinatarios** configurados en Cards → Destinatarios (Para / CC / CCO, activos). Sin al menos uno “Para” no se envía y queda constancia en el historial |
| CEP aceptado → **Por asignar** | Usuarios con rol Tesorería (si no hay, administradores) |
| **Asignado** · **Rechazado** · **Cancelado** por otra persona | El comercial que solicitó |

Requiere el correo (SES) configurado en el servidor; si no lo está, el fondeo avanza igual y el historial deja constancia (“no se envió”).
El envío nunca bloquea la operación.

## Pantallas

- **Mis solicitudes** (comercial): sus fondeos, “+ Nueva solicitud” (cotiza en vivo y da las instrucciones para mandar a la empresa).
- **Por asignar** (tesorería): bandeja con contador; detalle con alertas, CEP leído (✓/≠) y botones Confirmar / Rechazar.
- **Fondeos**: todos, con filtros, totales y Excel; “+ Fondeo ya recibido” para registro manual de tesorería (con lectura automática del CEP).
- **Panel**: asignado del periodo, por empresa y pendientes de control.
- **Empresas, UN y tarjetas**: árbol con cuenta de fondeo (CLABE, beneficiario y banco), tasas.
- **Bancos**: catálogo de bancos de Cards.
- **Destinatarios**: quién recibe el correo de cada nueva solicitud. Correo y nombre se guardan cifrados.

## Pendiente de decidir

1. **Segregación de funciones**: hoy un administrador puede solicitar y asignar el mismo fondeo. Se puede exigir que asigne alguien distinto a quien solicitó.
2. **Vigencia**: aviso (o cancelación automática) de solicitudes que llevan N días esperando el CEP.
3. Validar la lectura del **XML del CEP** con un archivo real; leer imágenes (OCR) si se quisiera aceptarlas.
4. **Conciliación contra estado de cuenta** bancario por CLABE (hoy tesorería lo revisa a mano).
5. Reporte mensual de comisión e IVA por empresa (insumo contable).
6. ¿Rechazar (en vez de avisar) un CEP cuyo beneficiario o banco no coincide? Hoy avisa y exige nota.
7. Avisos por WhatsApp / aviso al comercial cuando su solicitud lleva días sin CEP.
