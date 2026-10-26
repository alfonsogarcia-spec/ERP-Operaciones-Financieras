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

## La ventana de un fondeo: pasos y mosaico

- **Tesorería con un fondeo por asignar** la ve **por pasos**: 1 Solicitud · 2 CEP y validación (cada dato en su recuadro) · 3 Comprobante del saldo (opcional) · 4 Confirmar (resumen con palomitas; si hay diferencias pide la nota ahí mismo). *Rechazar* y *Cancelar solicitud* están siempre a la mano.
- **Todos los demás casos** (comercial, consulta, y cualquier fondeo esperando CEP, asignado, rechazado o cancelado) la ven como un **mosaico de cuatro tarjetas** bajo el estatus y la fecha: *Cuenta de fondeo* (empresa, beneficiario, banco, CLABE), *Importes* (con el recibido destacado), *Depósito y validación* (CEP, veredicto, rastreo, abono, ordenante) y *Control* (quién solicitó y quién asignó o rechazó, con fecha, nota o motivo, y comprobantes). Cabe sin desplazarse. Las diferencias del CEP, si las hay, salen debajo en recuadros rojos.
- **Archivos** (CEP y comprobantes, con sus botones de subir, descargar y quitar) e **Historial** van en acordeones plegados con su resumen en una línea; *Archivos* se abre solo cuando hay que subir el CEP.

## Comprobante del saldo asignado

Tesorería puede subir, en el detalle del fondeo, el **comprobante del sistema donde se ve el saldo ya asignado** (captura PNG/JPG, PDF o Excel; hasta 5 por fondeo, 10 MB cada uno, cifrados igual que el CEP). Es **opcional** y se puede subir **antes de confirmar** (queda listo para el aviso) o **después**, con el saldo ya asignado.
Lo ve y descarga el comercial que solicitó; el correo de **“Saldo asignado”** lo lleva adjunto junto con el CEP. Quitarlo es libre mientras el fondeo está por asignar; una vez asignado, solo un administrador. Todo queda en el historial y en la bitácora.

## Archivos repetidos

Un archivo **no se acepta repetido**, ni como CEP ni como comprobante del sistema. Se compara el contenido del archivo (huella SHA-256) contra **todo lo cargado en el sistema**:
- Un CEP idéntico a otro CEP (en la misma solicitud o en otra) se rechaza. Además, un CEP con la **misma clave de rastreo y fecha** de otro fondeo también se rechaza, aunque el archivo sea distinto (por ejemplo el PDF y el XML del mismo pago en dos solicitudes).
- Un comprobante idéntico a otro comprobante (de este u otro fondeo) se rechaza, y el mensaje dice en qué fondeo está.
- Un archivo ya cargado como CEP no se acepta como comprobante, y al revés.
Cada intento rechazado queda en el historial del fondeo. Solo detecta archivos **idénticos**: una captura vuelta a tomar o guardada de nuevo es otro archivo distinto.

## Contabilidad: corte de comisiones (BSO Cards)

Cards → **Contabilidad → Corte de comisiones**. Funciona **como el corte de MCEB**: al hacer el corte entra **todo lo que ya está guardado** y no ha entrado a otro corte, y se manda a contabilidad con las **comisiones cobradas más IVA** y la **razón social y el RFC a los que se factura**, con el detalle en Excel.
- **Qué entra:** los fondeos **asignados** por tesorería, **según su fecha de depósito** (el corte lleva “depósitos hasta el…”; por defecto, hasta hoy). Cada fondeo entra a **un solo corte**. **Lo que no estaba guardado** (o se asigna después) **cae en el siguiente corte**, aunque su depósito sea anterior. Se suma por empresa (las UN y tarjetas se acumulan en su empresa): comisión + IVA = **total a facturar**, con la comisión y el IVA congelados en cada fondeo.
- **Cuándo se hace:** **junto con cada corte de POS Settlement** (al generarse el corte en POS se hace también el de Cards y se manda; es de mejor esfuerzo y nunca interfiere con el de POS; no repite si hace menos de 30 minutos que ya se hizo uno) o **a mano** con **Hacer corte** (con la fecha “Depósitos hasta el…” y la opción de enviarlo en el momento). Lo de “junto con el corte de POS” se puede apagar en Destinatarios.
- **Si no hay nada nuevo**, el corte se hace y **se envía igual, en ceros**.
- **Datos fiscales:** en Empresas, UN y tarjetas, cada empresa tiene **Razón social para facturar** y **RFC** (se valida: 12 caracteres persona moral, 13 persona física; se guarda en mayúsculas). Si falta alguno, el corte lo marca (“Falta razón social”, “Falta RFC”) y el correo lo lista en “Datos fiscales por completar”.
- **El correo** (“[BSO Cards] Corte de comisiones · al 26 de octubre de 2026 · $… a facturar”, remitente “Polipay · Operaciones · BSO”): la fecha del corte y el rango de depósitos, una tabla por empresa (razón social, RFC, comisión, IVA, total a facturar), el total, y el Excel adjunto (hoja de facturación y detalle por fondeo con su fecha de depósito). Se manda a los destinatarios del correo **“Corte de comisiones (contabilidad)”** en Destinatarios (Para/CC/CCO); **sin al menos un “Para” el corte se hace pero no se envía**.
- **La pantalla:** **Por cortar** (lo asignado que aún no entra a un corte, por empresa), la lista de **Cortes** (fecha, si fue con el de POS o a mano, depósitos, empresas, comisión, IVA, total, enviado), y el detalle de cada corte con **Excel**, **Reenviar** y **Deshacer corte** (solo si no se ha enviado: sus fondeos vuelven a quedar por cortar). Lo ven administradores y Consulta Cards; hacer, enviar y deshacer, solo administradores.

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

Cada persona tiene **dos accesos independientes**: un **rol en POS Settlement y Tareas Ops** (o ninguno) y un **rol en Polipay Cards Settlement** (o ninguno). Ejemplo: Omar es *Tesorería* en POS y *Tesorería Cards* en Cards. Quien no tiene rol de Cards **no entra a Cards**; la excepción es el **administrador de POS, que tiene acceso total a Cards** sin necesitar rol.

| Rol de Cards | Qué ve y qué puede |
|---|---|
| **Administrador de POS** | Todo en Cards (acceso total implícito) |
| **Administrador Cards** (`cards_admin`) | Todo en Cards: usuarios de Cards, empresas, UN y tarjetas, bancos, destinatarios, solicitar, registrar fondeos recibidos, asignar o rechazar, cancelar |
| **Tesorería Cards** (`cards_tesoreria`) | Solo **Por asignar** y **Fondeos**: revisa el CEP y su validación, **confirma o rechaza el saldo** y **sube el comprobante del sistema**. No solicita, no cancela, no edita CEP, empresas, bancos ni destinatarios. Recibe el aviso de “por asignar” |
| **Comercial** (`comercial`) | Solicita y sube el CEP; ve y gestiona solo lo que él solicitó |
| **Consulta Cards** (`cards_consulta`) | Solo lectura |

Los roles de POS (operador, tesorería, bancos, consulta) **no dan acceso a Cards por sí mismos**: hay que asignar el rol de Cards en Administración → Usuarios. Quien solo tiene rol de Cards no ve POS Settlement ni Tareas, y la API lo bloquea.
Al crearse la columna de acceso a Cards, los usuarios que ya eran *Tesorería* de POS quedaron como *Tesorería Cards* y los de *Consulta* como *Consulta Cards*; el resto, sin acceso a Cards hasta que un administrador se lo asigne.

## Usuarios y accesos (panel de Administración)

Todos los usuarios —POS Settlement, Tareas Ops y Cards— se administran en **un solo lugar**: el espacio **Administración → Usuarios** (en el selector de espacios). La lista muestra el **rol en POS** y el **rol en Cards** de cada persona, con búsqueda y filtros por sistema y estado; el formulario tiene un selector para cada sistema. Al dar de alta recibe el correo de bienvenida con lo que puede hacer en cada uno.

- **Administrador**: ve y administra todos los usuarios y asigna ambos roles.
- **Administrador Cards**: entra al mismo panel, pero **solo ve y edita usuarios que solo tienen rol de Cards** (no asigna roles de POS ni toca usuarios de POS).
- Nadie puede cambiarse los accesos, desactivarse ni borrarse a sí mismo; no se puede dejar el sistema sin un administrador activo.
- **Los cambios aplican al instante** (hasta 1 minuto): el servidor consulta los roles vigentes en cada petición, no los que traía la sesión. La pantalla se entera sola (avisa “Tus accesos cambiaron” y ajusta el menú); un usuario desactivado o borrado pierde la sesión.
- Si se usa `MFA_REQUIRED_ROLES`, agregar `cards_admin,cards_tesoreria` para exigir la verificación en dos pasos.

## Quién solicita

El **solicitante es quien tiene la sesión abierta** cuando registra la solicitud: si la captura Fátima, la solicitante es Fátima (queda en el fondeo, en el historial, en el correo y en el Excel). Ya no se asigna un comercial por empresa; cada comercial ve y gestiona únicamente sus propias solicitudes.

## Avisos por correo

Los correos tienen el diseño de los demás correos de MCEB (logo, barra azul, tabla y pie) y se identifican como **Polipay Cards Settlement** (pie: “Polipay Cards Settlement · BSO · ops.emisor@polipay.io”).
Los que ya tienen CEP (por asignar, asignado, rechazado, cancelado) **llevan el CEP adjunto** (hasta 6 MB en total; si no cabe, lo dice y se abre en el sistema) y una sección **“CEP y validación”**: si el sistema lo validó, cuántas diferencias trae y, dato por dato (monto, CLABE, clave de rastreo, fecha, beneficiario, banco), lo que dice el CEP contra lo registrado.

**Un solo hilo por fondeo.** El primer correo que sale de un fondeo (normalmente *Nueva solicitud*) abre el hilo; los de estatus posteriores (*Por asignar*, *Saldo asignado*, *Rechazado*, *Cancelada*) salen **como respuesta suya**: mismo asunto con “Re:” y los encabezados `In-Reply-To` y `References`, de modo que Gmail y Outlook los agrupan en una sola conversación. El asunto ya no cambia con el estatus (el título del cuerpo sí lo dice). Si “Nueva solicitud” está apagada o sin destinatarios, el primer correo que sí salga abre el hilo. Quien no recibió el inicial ve el correo suelto, sin el hilo. El Message-ID del primero se guarda en el fondeo.

**Quién sube qué.** El **solicitante** (el comercial) sube el **CEP**; **tesorería** sube el **comprobante del sistema**. Los correos y el mosaico lo nombran: “X cargó el CEP”, “subido por …”, y en *Control* “Subió el CEP” / “Subió el comprobante”.

**Remitente.** Los correos de Cards salen con el nombre **“Polipay · Operaciones · BSO”** (la dirección de envío sigue siendo la de SES, `ops.agregador@polipay.io`).

Cada correo tiene **sus propios destinatarios**, que se configuran en Cards → **Destinatarios** (una tarjeta por correo):

| Correo | Cuándo | Automático por defecto |
|---|---|---|
| **Nueva solicitud** | Alguien registra una solicitud | Nadie (solo los correos fijos que agregues) |
| **Por asignar** | Se sube el CEP y queda con tesorería | Usuarios con rol Tesorería Cards |
| **Saldo asignado** | Tesorería confirma el saldo | Quien solicitó |
| **Rechazado** | Tesorería lo rechaza | Quien solicitó |
| **Solicitud cancelada** | Se cancela una solicitud | Quien solicitó (no se avisa a quien cancela) |

Por cada correo se define: **Se envía** (se puede apagar; queda constancia en el historial), **Recibe automáticamente** (quien solicitó y/o los usuarios Tesorería Cards, en cualquier combinación) y **Además, estos correos** (fijos, cada uno Para, CC o CCO; el mismo correo puede estar en varios avisos). Se necesita al menos un destinatario “Para”; si “Por asignar” queda sin nadie, va a los administradores. Los correos y nombres fijos se guardan cifrados.

Requiere el correo (SES) configurado en el servidor; si no lo está, el fondeo avanza igual y el historial deja constancia (“no se envió”).
El envío nunca bloquea la operación.

## Pantallas

- **Mis solicitudes** (comercial): sus fondeos, “+ Nueva solicitud” (cotiza en vivo y da las instrucciones para mandar a la empresa).
- **Por asignar** (tesorería): bandeja con contador; detalle con alertas, CEP leído (✓/≠) y botones Confirmar / Rechazar.
- **Fondeos**: todos, con filtros, totales y Excel; “+ Fondeo ya recibido” para registro manual de tesorería (con lectura automática del CEP).
- **Panel**: asignado del periodo, por empresa y pendientes de control.
- **Empresas, UN y tarjetas**: árbol con cuenta de fondeo (CLABE, beneficiario y banco), tasas.
- **Bancos**: catálogo de bancos de Cards.
- **Corte de comisiones** (Contabilidad): lo por cortar y los cortes hechos, con Excel, reenvío y “Hacer corte”.
- **Destinatarios**: a quién se envía cada correo de Cards (automáticos y fijos, por correo). Correo y nombre se guardan cifrados.

## Pendiente de decidir

1. **Segregación de funciones**: hoy un administrador puede solicitar y asignar el mismo fondeo. Se puede exigir que asigne alguien distinto a quien solicitó.
2. **Vigencia**: aviso (o cancelación automática) de solicitudes que llevan N días esperando el CEP.
3. Validar la lectura del **XML del CEP** con un archivo real; leer imágenes (OCR) si se quisiera aceptarlas.
4. **Conciliación contra estado de cuenta** bancario por CLABE (hoy tesorería lo revisa a mano).
5. Reporte mensual de comisión e IVA por empresa (insumo contable).
6. ¿Rechazar (en vez de avisar) un CEP cuyo beneficiario o banco no coincide? Hoy avisa y exige nota.
7. Avisos por WhatsApp / aviso al comercial cuando su solicitud lleva días sin CEP.
