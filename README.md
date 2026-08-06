# Polipay POS Settlement (Conciliación y Liquidación T+1)

Automatiza el ciclo de **conciliación y liquidación T+1** del Agregador/POS (MCEB · Broxel BIN
Sponsor). Implementa el **BRD-OP-AGR-001**. Desde v0.5.0 es **backend-driven**: toda la lógica y los
datos viven en el servidor; el front es solo un espejo que consume la API.

## Arquitectura

```
navegador (index.html: solo fetch + render)  ──HTTP/JSON + JWT──▶  server.js (Express)
                                                                    ├─ engine.js    motor puro (única fuente de verdad)
                                                                    ├─ lib/excel.js parsea/genera .xlsx en el servidor
                                                                    └─ db/          Postgres: Supabase (prod) · pglite (dev)
```

- **`engine.js`** — motor de cálculo (sección 6 / RN-01..16): fecha de liquidación T+n con precisión
  de segundos, compensación, dispersión (RN-09), cuadre, utilidad, concepto.
- **`server.js`** — API REST con auth JWT + bcrypt, **roles forzados por endpoint**, subida de Excel
  (multer), generación de layout/reporte, **inmutabilidad de cortes**.
- **`db/`** — esquema normalizado (`schema.sql`) + adaptador (`index.js`): usa `pg`/Supabase si hay
  `DATABASE_URL`, o **pglite** (Postgres en proceso, `./.pgdata`) para desarrollo sin servicio externo.
- **`index.html`** — cliente delgado: login por correo/contraseña, vistas que consultan la API y
  pintan; ninguna lógica ni dato vive en el navegador.

## Qué hace

- **Ingesta** de transacciones del gateway por **Excel (.xlsx)** — el **servidor** parsea (elige la
  hoja con más datos), reconoce el producto (insensible a acentos), mapea columnas por alias,
  normaliza montos y calcula la **fecha de liquidación** (Nacional/INT T+1 · AMEX T+3, corte 23:00,
  con segundos; parámetros configurables).
- **Catálogos**: grupos/afiliaciones (tasas, %banca, costo x trx), estructura de costos, cuentas de
  liquidación **por afiliación** (CLABE), bancos SPEI, feriados, parámetros.
- **Cortes**: compensación/dispersión exacta, **cuadre** (diferencia 0), **layout SPEI** y **reporte
  por cliente** en Excel generados por el servidor. **Cancelaciones** (monto negativo) restan.
- **Segregación de funciones**: Operador calcula / Tesorería valida y dispersa / Admin catálogos —
  forzado en el servidor. **Inmutabilidad**: un corte Dispersado/Cerrado no se puede editar.
- **Bitácora** de acciones (usuario, rol, timestamp).

## Cómo correr

```bash
npm install
npm start
```

Abre http://localhost:4174. **Sin `DATABASE_URL`** corre con **pglite** (base local en `./.pgdata`) —
ideal para desarrollo. Usuarios sembrados (password inicial **`Polipay2026`**, cámbialo):

| Correo | Rol |
|---|---|
| `alfonso.garcia@polipay.io` | Administrador |
| `operador@polipay.io` | Operador |
| `tesoreria@polipay.io` | Tesorería |

### Producción (Supabase)

1. Crea un **proyecto Supabase NUEVO e independiente** (no el de gestion-operaciones).
2. Define en el entorno (p.ej. Render): `DATABASE_URL` (cadena de Supabase) y `JWT_SECRET`.
3. Al arrancar, `migrate()` crea el esquema y siembra los usuarios; `/api/estado` → `db:true`.

## Pruebas

```bash
node test/engine.test.js      # 15/15 — RF-02, anexo 13.3, RN-09, precisión de segundos
```

Verificado end-to-end contra el cálculo manual (`EJEMPLO CALCULO MANUAL.xlsx`): el corte del
04/08/2026 reproduce **942 transacciones / $1,104,510.37**.

## Referencia

BRD-OP-AGR-001 — Operaciones (Grupo BECM / Polipay). Ver `CHANGELOG.md`.
