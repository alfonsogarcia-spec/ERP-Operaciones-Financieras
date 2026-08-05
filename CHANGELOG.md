# Changelog — Sistema de Conciliación y Liquidación T+1 (BRD-OP-AGR-001)

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
