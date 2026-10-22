# DESIGN.md · Polipay POS Settlement (Conciliación y Liquidación)

Herramienta de back-office financiero para analistas de operaciones: cortes, dispersiones, contracargos y disputas.
Dirección: **vidrio translúcido (liquid glass)** — paneles semitransparentes con blur sobre una malla de color de
marca, con datos legibles y color de estado con significado.

Fuente de verdad en código: el `<style>` de [`index.html`](index.html) (tokens en `:root`). Guía visual generada:
`node scripts/build-styleguide.js` → [`docs/design-system.html`](docs/design-system.html). Detalle de componentes y
accesibilidad: [`docs/design-system.md`](docs/design-system.md).

## Principios

1. **El vidrio es la estructura, no el contenido.** Blur y transparencia en paneles, barras y modales; el texto y las
   cifras siempre sobre una capa lo bastante opaca para ≥4.5:1.
2. **La malla es de marca.** Tres manchas difusas del acento detrás de todo (`--mesh1…3`); nada de fotos ni ilustraciones.
3. **El color significa algo.** Azul para acción, enlace y foco; los semánticos solo para estado.
4. **Las cifras mandan.** Montos con `tabular-nums`, alineados a la derecha.
5. **Solo tokens.** Ningún hex ni `rgba()` suelto en CSS o `style=`.

## Color

| Token | Claro | Oscuro | Rol |
|---|---|---|---|
| `--bg` | `#EFF3F8` | `#090E1C` | Lienzo bajo la malla |
| `--mesh1/2/3` | acento 30% · violeta 16% · capri 22% | más tenues | Malla difusa de fondo (`body::before`, blur 60px) |
| `--panel` / `--panel-strong` | blanco 74% / 90% | `rgba(22,28,48,.74)` / `.93` | Paneles y tarjetas / modales, login, tarjetas internas |
| `--glass-1…4` | blanco 40 · 58 · 76 · 92% | blanco 4 · 7 · 11 · 16% | Fondo discreto · controles · hover · foco |
| `--bar` | blanco 80% | `rgba(20,26,46,.88)` | Cabeceras fijas: `thead`, cabecera/pie de modal |
| `--glass-border` / `--edge-hi` | blanco 60% | blanco 10% / 6% | Borde y brillo superior del vidrio |
| `--line` / `--line-strong` | tinta 10% / 16% | blanco 10% / 18% | Separadores / bordes de control |
| `--ink` / `--muted` | `#0B1220` / `#5A6580` | `#E8ECF8` / `#A3AECB` | Texto principal / secundario |
| `--brand` | `#04003A` Oxford | `#E8ECF8` | Énfasis de marca en títulos |
| `--sidebar-a → -b` | Oxford 94% → Dodger 86% | | Barra lateral flotante, degradado de marca |
| `--accent-fill` / `-hi` | `#1166DB` / `#1A70E2` | | **Primario:** relleno de botón y pestaña activa (texto blanco ≥4.5:1) |
| `--accent-ink` | `#0F56AC` | `#8DBEFF` | Enlaces y acento como texto |
| `--accent` / `--focus` | `#157BF6` Eléctrico | `#4C9BFF` | Borde activo, barra de fila en hover, anillo de foco |
| `--accent-glow` | acento 28% | | Halo del botón primario |
| `--ok` / `--ok-ink` | `#187A46` / `#14663B` | `#6FD9A0` | Éxito: conciliado, dispersado, ganado |
| `--warn-fill` / `--warn` | `#FFCC00` / `#7A5C00` | `#FFD84D` | Atención: por atender, por vencer |
| `--danger` / `--danger-ink` | `#D0273D` / `#A81D31` | `#FF8FA0` | Error, vencido, perdido, destructivo |
| `--violet`, `--c-teal`, `--c-orange`, `--c-indigo`, `--c-neutral` | | | Solo estados de disputa en badges |

Tres paletas de acento (Ártico por defecto, Violeta, Grafito) × tres modos (Sistema, Claro, Oscuro), desde el botón
flotante de abajo a la izquierda. Las paletas cambian solo la familia de acento, la malla y la barra lateral.

## Tipografía

Montserrat (`--font`) en toda la interfaz, con la fuente del sistema como respaldo; `--font-mono` para folios y código.

| Token | Tamaño | Uso |
|---|---|---|
| `--fs-xs` | 11px | Encabezado de tabla (MAYÚSCULAS, +0.07em), badges, etiquetas de menú |
| `--fs-sm` | 12px | Ayudas, etiquetas de KPI y de campo, `.btn.sm` |
| `--fs-md` | 13px | Celdas de tabla, botones, inputs, pestañas |
| `--fs-base` | 14px | Texto base |
| `--fs-lg` | 16px | Títulos de panel y de modal |
| `--fs-xl` | 20px | Título de login |
| `--fs-2xl` | 24px | Título de página |
| `--fs-3xl` | 28px | Cifra de KPI |

Pesos 400 · 500 · 600 · 700. Base 14px a propósito: es una herramienta de datos, no un sitio de lectura.

## Espaciado

Escala base 4: `--sp-1 4` · `-2 8` · `-3 12` · `-4 16` · `-5 20` · `-6 24` · `-8 32` · `-10 40`.
Contenido 30 × 40 de padding, máx. 1560px. Barra lateral 248px flotante (margen 14). Paneles 22 de padding y 20
entre sí; celdas 14 × 16; tarjetas KPI en rejilla de 178px mín.

## Forma y profundidad

Radios generosos: `--radius-xs 8` · `--radius-sm 12` (inputs, ítems de menú) · `--radius 18` (paneles, tarjetas,
tablas) · `--radius-lg 24` (modales, barra lateral, login) · `--radius-pill` (botones, pestañas, badges, pasos).

Profundidad: `--blur 22px` con `saturate(160–180%)` en paneles y modales; `--shadow` en paneles y `--shadow-lg` en lo
que flota. Las tarjetas suben 2px al pasar el cursor; se anula con `prefers-reduced-motion`.

## Componentes

| Componente | Reglas |
|---|---|
| **Botón** `.btn` | Primario: píldora con degradado `--accent-fill-hi → --accent-fill` y halo `--accent-glow`; hover sube 1px. `secondary`: vidrio `--glass-2`. `ghost` (quiet): `--glass-1` con borde, hover en acento. `danger`: contorno rojo, nunca relleno. Disabled 45%. Un solo primario por vista. |
| **Input / select** | Vidrio `--glass-2`, borde `--line-strong`; foco = `--glass-4` + borde `--accent`; error = borde `--danger` + `.field-err`. |
| **Tabla** | **Separada por espacio, sin líneas:** `.tablewrap` sin borde; `thead` fijo como franja suave `--strip` con esquinas de 12; filas sin divisores, cebra muy tenue `--zebra` y hover `--accent-tint`; montos `.num` a la derecha. |
| **Tarjeta KPI** `.card` | Vidrio `--panel`, cifra 28px bold tabular; `.ok`/`.alert` colorean la cifra. |
| **Panel** `.panel` | Vidrio `--panel` + `--glass-border` + `--shadow`; título 16px con acciones a la derecha. |
| **Badge** `.badge` | Píldora 11px semibold, tono por significado (ver `docs/design-system.md`). |
| **Pestañas** `.tabs` | Pista de vidrio en píldora; activa = relleno de acento con halo. |
| **Aviso** `.banner` | **Nota con ícono, sin contorno.** Informativo: sin fondo, texto `--muted` (negritas en `--ink`) y círculo "i" en `--accent-fill`. `warn`/`err`/`ok`: tinte del semántico **sin borde** y círculo "!"/"✓" de su color, para que no se pierdan. No poner emoji al inicio del texto: el ícono ya lo da el componente. |
| **Navegación** | Barra lateral flotante con degradado Oxford→Dodger y blur; activo = blanco 16% + borde interno. |
| **Modal** | `--panel-strong`, radio 24, cabecera y pie `--bar` fijos; `confirmar()` / `pedir()` en lugar de nativos. |
| **Toast** | Píldora oscura translúcida con blur, abajo a la derecha. |

## Iconos e imágenes

- Un solo set: PNG monocromos de `/public/brand-icons/`, invertidos a blanco en la barra lateral. Sin emoji como icono en controles nuevos.
- Logo `/public/logo.png`; `--logo-filter` lo invierte en oscuro.
- Sin fotos ni ilustraciones: el único fondo decorativo es la malla de marca.

## Estilo Fintech (en evaluación)

Variante del mismo vidrio, más cercana a una app financiera. Se activa en el selector de apariencia → **Estilo →
Fintech** (`data-estilo="fintech"` en `<html>`, guardado en `localStorage._estiloPreview`). Convive con los tres
modos y las tres paletas; si se aprueba, pasa a ser el estilo por defecto y se retira el Clásico.

| Qué | Clásico | Fintech |
|---|---|---|
| Malla de fondo | Acento + violeta + capri, blur 60px | Acento 18–20% + verde dinero `--money` 10% + navy/capri 8%, blur 80px, menos saturada |
| Lienzo | `#EFF3F8` / `#090E1C` | `#F2F5FA` / `#050814` (navy más profundo) |
| Vidrio | Panel 74% blanco, blur 22px | Panel 80% blanco (62% en oscuro), blur 18px, **filo de luz** superior (`inset 0 1px 0 --edge-hi`) y brillo `--sheen` en el primer 46% |
| Barra lateral | Degradado Oxford → Dodger | Navy liso `rgba(6,10,30,.94)` (vidrio 72% en oscuro); activo = barra de 2px en `--accent2` |
| Radios | 8 · 12 · 18 · 24 | 6 · 10 · 14 · 18 (botones y pestañas en 10, ya no píldora) |
| Cifras | 28px bold | 28px semibold, `letter-spacing -0.02em`, `tabular-nums slashed-zero` (también en `td.num`) |
| Etiquetas KPI | 12px | 11px MAYÚSCULAS, +0.06em |
| Botón primario | Píldora con halo grande; sube al pasar | Radio 10, brillo interior + halo corto; no se mueve |
| Pestañas | Activa = relleno de acento | Control segmentado: activa = vidrio sólido con sombra, texto `--ink` |
| Sombras | Difusas y amplias | Más cortas y con caída negativa (`0 10px 28px -10px`) |

Las variantes de botón (`secondary`, `ghost`, `danger`, `ok`…) conservan su color; Fintech solo cambia forma y relieve.

## Pendiente

- Montserrat está bloqueada por la CSP (hoy se ve la fuente del sistema). Opción: servir `.woff2` desde `/public/fonts`.
