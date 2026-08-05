# Polipay · Sistema de Conciliación y Liquidación T+1

Automatiza el ciclo de **conciliación y liquidación T+1** del Agregador/POS (MCEB · Broxel como
BIN Sponsor), reemplazando el Excel `ARCHIVO_DE_CONCILIACION_V7.xlsx`. Implementa el
**BRD-OP-AGR-001 v1.0** — Fase 1 (MVP + motor completo).

## Qué hace (Fase 1)

- **Ingesta** de transacciones del gateway por **Excel (.xlsx)** — subir archivo (o pegar CSV como
  respaldo), con normalización de tipos y marcado de filas inválidas.
- **Cálculo de fecha de liquidación T+n por producto** con hora de corte y días feriados (RN-12):
  Nacional/INT → T+1 corte 23:00; AMEX → T+3 corte 23:00 (parámetros configurables por ciclo
  en Sistema → Parámetros; el desfase T+3 y la hora de corte de AMEX se pueden ajustar cuando cambie la operación).
- **Catálogos**: grupos y afiliaciones (tasas pactadas, %banca, costo x trx), estructura de costos
  del adquirente (intercambio + Fee Broxel), cuentas de liquidación (CLABE), bancos SPEI, feriados.
- **Motor de compensación y dispersión** exacto (sección 6 / RN-01…RN-16), con IVA 16%.
- **Cuadre automático** (diferencia = 0, tolerancia ±0.01) que **bloquea** la dispersión si algún
  grupo no cuadra o si un grupo con importe carece de CLABE/banco.
- **Layout SPEI** exportable a **Excel** (concepto `DISPERSION <ult3>CPPX00<id_grupo>`, CLABE como
  texto, sin órdenes en 0).
- **Reporte por cliente** exportable a **Excel** (compensar por producto, banca, dispersar, con totales).
- Todas las **plantillas** de carga (transacciones, grupos, cuentas) se descargan en **.xlsx**;
  el sistema lee y escribe Excel de forma nativa y offline (SheetJS incluido en `public/vendor/`).
- **Segregación de funciones** (Operador calcula / Tesorería valida y dispersa / Admin catálogos)
  y **bitácora** de acciones.
- **Auto-pruebas del motor** embebidas: casos de aceptación RF-02 y control del anexo 13.3.

Fuera de esta fase: pólizas contables (MCEB/Telematic), cruce Broxel, evidencia inmutable
versionada y KPIs avanzados (Fase 2).

## Regla de dispersión (RN-09, confirmada con Operaciones)

Cada financiamiento/contracargo se aplica **una sola vez, en su propio bloque**:

```
base_dom  = comp_tdd + comp_tdc + comp_int
disp_dom  = base_dom  − banca_dom  − iva_banca_dom  − financiamientos − contracargos_dom
disp_amex = comp_amex − banca_amex − iva_banca_amex − contracargos_amex
disp_total = disp_dom + disp_amex        # comprobación ⇒ diferencia = 0
```

Corrige el doble descuento del Excel vigente: el cuadre da 0 aun con financiamientos/contracargos > 0.

## Cómo correr

```bash
npm install
npm start
```

Abre http://localhost:4174. Entra con tu nombre y un rol. En este MVP el estado se guarda en el
**localStorage** del navegador (modo sandbox); no requiere base de datos.

### Flujo típico

1. **Bancos SPEI** → "Cargar bancos comunes".
2. **Días feriados** → "Feriados MX 2026".
3. **Grupos y afiliaciones** → "Alta guiada" (o importar CSV con la plantilla).
4. **Cuentas de liquidación** → registrar CLABE **por afiliación** (una cuenta por afiliación; o
   “nivel grupo” como cuenta por defecto).
5. **Ingesta de transacciones** → subir el Excel del gateway (descarga la plantilla .xlsx como referencia).
6. **Cortes y liquidación** → "Nuevo corte" → elegir fecha objetivo → revisar compensación y
   cuadre → exportar **Layout SPEI** y **Reporte por cliente** → validar/dispersar según rol.

## Stack

`index.html` autocontenido (HTML/CSS/JS, sin framework) + `server.js` (Express) que lo sirve.
Marca Polipay (Montserrat, azul Oxford `#04003A`, azul Eléctrico `#157BF6`). Puerto 4174.
Modo dual preparado para Supabase en Fase 2 (`/api/estado` → `db:true`).

## Referencia

BRD-OP-AGR-001 v1.0 — Operaciones (Grupo BECM / Polipay).
