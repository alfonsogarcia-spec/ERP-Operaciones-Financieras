# Changelog — Sistema de Conciliación y Liquidación T+1 (BRD-OP-AGR-001)

## v0.5.0 — 2026-08-04 · Migración a backend real

Reescritura a **backend-driven**: toda la lógica y los datos se movieron al servidor; el front quedó
como espejo. Base de datos **Postgres** (Supabase en prod, independiente de gestion-operaciones;
pglite en dev). Se conservó el motor probado (ahora 15/15 con el caso de segundos).

- **`engine.js`**: motor puro (CommonJS), única fuente de verdad; lo consume el servidor y el test.
- **`db/`**: `schema.sql` normalizado (usuarios, catálogos, transacciones, cortes, calculos, params,
  bitácora) + adaptador `pg`/pglite con `migrate()` y siembra de usuarios.
- **`lib/excel.js`**: parseo (elige la hoja con más datos) y generación de .xlsx en el servidor. Se
  eliminó SheetJS del navegador.
- **`server.js`**: API REST, auth **JWT + bcrypt**, **roles forzados por endpoint** (Operador/
  Tesorería/Admin), subida de Excel con multer, **inmutabilidad** de cortes (Dispersado/Cerrado),
  layout/reporte generados por el server, `/api/estado` → `db:true`.
- **`index.html`**: cliente delgado (login por correo/contraseña, `api()` con Bearer, vistas que
  consultan y pintan). Se quitó motor, localStorage y xlsx del front.
- Corrección: lectura de columnas `date` con `::text` (evita corrimiento de zona horaria);
  `withBusy` usa `setTimeout` (rAF se pausa en pestañas en segundo plano).
- Verificado E2E: 942 trx / $1,104,510.37; segregación (operador→403); inmutabilidad; persistencia.

## v0.4.0 — 2026-08-04

Versión conciliada contra el cálculo manual (`EJEMPLO CALCULO MANUAL.xlsx`): el corte del
04/08/2026 reproduce el total del área (942 trx, $1,104,510.37) al centavo.

### Motor / reglas
- **Fecha de liquidación con precisión de segundos.** La hora de corte compara segundos
  (`parseHoraSeg`): una transacción a `23:00:06` cuenta como posterior a las `23:00` y pasa al
  día siguiente (antes se ignoraban los segundos y quedaba en el día del corte). Corrigió el
  descuadre de 2 AMEX de SFI operadas 6–8 s después del corte.
- **AMEX corte 23:00 por defecto** (T+3 se conserva). Coincide con la operación real. Migración
  automática en `load()` que actualiza el valor 20:00 ya guardado en el navegador a 23:00 y
  recalcula las fechas.
- **Cancelaciones (monto negativo) válidas y restan** en el corte, revirtiendo su comisión.
- Parámetros (IVA, tasas vigentes, desfase/corte por producto) editables por ciclo; al guardar
  se recalculan las fechas de liquidación cargadas.

### Ingesta / Excel
- Todo el I/O en **Excel (.xlsx)** vía SheetJS local (offline): plantillas, ingesta, importación
  de catálogos y exportaciones (layout SPEI, reporte por cliente).
- Lectura robusta: reconocimiento de producto insensible a acentos, alias de encabezados de
  columna, parseo de monto con distintos formatos ($, comas, europeo, paréntesis).
- **Panel de diagnóstico** de la carga (productos/clientes/afiliaciones no reconocidos, mapeo de
  columnas, monto por producto) y botón **Exportar cargadas** para auditar lo que hay en el sistema.

### Cuentas / catálogos
- Cuentas de liquidación ligadas **por afiliación** (varias cuentas por grupo).

### UX
- Spinner de carga en operaciones pesadas; el modal de carga cierra y refresca la vista al
  procesar (antes había que cambiar de sección). Botones para vaciar transacciones y cortes.

## v0.1.0 — 2026-08-04
- MVP inicial (Fase 1): catálogos, ingesta CSV, cálculo T+n, motor de compensación/dispersión
  (sección 6 / RN-01..16), cuadre bloqueante, layout SPEI, reporte por cliente, roles y bitácora.
