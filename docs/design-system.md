# Sistema de diseño · Polipay POS Settlement

Fuente de verdad: el bloque `<style>` de [`index.html`](../index.html). La guía visual se genera con
`node scripts/build-styleguide.js` → `docs/design-system.html` (todos los componentes, claro/oscuro, 3 paletas y
una tabla de contraste que se recalcula en vivo).

Estilo: **vidrio translúcido** (paneles semitransparentes con blur sobre una malla de color). Tres modos
(Sistema · Claro · Oscuro) × tres paletas (Ártico · Violeta · Grafito), con el selector en el botón flotante
de abajo a la izquierda.

## Reglas

1. Los componentes **solo leen tokens** (`var(--…)`). Nada de hex ni `rgba()` sueltos en CSS ni en `style=`.
2. Texto ≥ **4.5:1** sobre su fondo (≥ 3:1 si es de 24px+). Un relleno con texto blanco usa `--*-fill`/`--ok`/`--danger`…, nunca `--accent`.
3. El acento como **texto** es `--accent-ink`; como borde o foco, `--accent`; como relleno, `--accent-fill`.
4. Una sola forma de nombrar el estado: por **significado** (`ok`, `danger`, `warn`, `info`…), no por letra.
5. Un tamaño de la escala tipográfica (mín. 11px). Un paso de la escala de espaciado (base 4px).
6. Nada de `confirm()` / `prompt()` nativos: usa `await confirmar(msg)` y `await pedir(msg)`.
7. Nada de `<input type="file">` sueltos: toda carga usa `zonaArchivos()` (arrastrar y soltar).
8. Nada de `<input type="date">` como **filtro**: todo filtro de fechas usa `filtroFechas()` (un solo campo con calendario y atajos). Los campos de fecha de un formulario de captura sí pueden ser nativos.

## Tokens

| Familia | Tokens |
|---|---|
| Acento | `--accent` · `--accent-fill` · `--accent-fill-hi` · `--accent-ink` · `--accent-soft` · `--accent-tint/-edge/-glow` · `--focus` · `--brand` |
| Vidrio | `--bg` · `--panel` · `--panel-strong` · `--glass-1…4` · `--bar` · `--glass-border` · `--edge-hi` · `--line` · `--line-strong` · `--scrim` · `--fade` |
| Texto | `--ink` · `--muted` · `--on-fill` |
| Semánticos | `--ok/-hi/-ink/-tint/-edge` · `--danger/-ink/-tint/-edge` · `--warn-fill/-on/--warn/-tint/-edge` · `--violet/-ink/-tint` · `--c-neutral/-teal/-orange/-indigo/-deep/-amber/-faint` · `--soft-bg/-ink` · `--t-d/s/m/u/e` (tipos de tarea) |
| Tipografía | `--font` · `--font-mono` · `--fs-xs 11` `-sm 12` `-md 13` `-base 14` `-lg 16` `-xl 20` `-2xl 24` `-3xl 28` · `--fw-regular/medium/semibold/bold` |
| Espaciado | `--sp-1 4` `-2 8` `-3 12` `-4 16` `-5 20` `-6 24` `-8 32` `-10 40` |
| Forma | `--radius-xs 8` `-sm 12` `--radius 18` `-lg 24` `-pill` |
| Elevación y movimiento | `--shadow` · `--shadow-lg` · `--ease` · `--dur-fast .12s` `--dur .15s` `--dur-slow .3s` |

El modo oscuro redefine los mismos tokens (`:root[data-theme="dark"]` y `@media (prefers-color-scheme: dark)` con
`:root:not([data-theme="light"])`). Las paletas cambian solo la familia de acento. El modo elegido se guarda en
`localStorage._modoPreview` y se aplica antes de pintar (sin parpadeo).

## Componentes

| Componente | Variantes | Notas |
|---|---|---|
| `.btn` | primario · `secondary` · `ghost` · `danger` (contorno) · `ok` · `deep` · `violet` · `amber` · `sm` · `loading` | `:hover`, `:active`, `:disabled`, `:focus-visible` |
| `.badge` / `.pill` | `neutral` `info` `ok` `warn` `danger` `violet` `teal` `orange` `indigo` `soft` | un solo componente; mapa estado→tono en `badgeEstadoDisp` |
| `.card`, `.panel`, `.cards` | `.card.ok`, `.card.alert` | cifras con `tabular-nums` |
| `table` / `.tablewrap` | filas clicables con `tabindex=0` (Enter/Espacio) | encabezado fijo con blur |
| Formularios | `label.field`, `input/select/textarea` | `:disabled`, `aria-invalid="true"` / `.field.invalid` + `.field-err` |
| `.banner` | `info` · `ok` · `warn` · `err` | |
| `.tabs` / `.tab` | `role=tablist` / `role=tab` + `aria-selected` | |
| `zonaArchivos({titulo, ayuda, accept, multiple, compacta, sinLista, onFiles})` | normal · `compacta` | **Todas** las cargas de archivos del sistema: se arrastra o se hace clic; solo acepta las extensiones de `accept` (también al soltar); lista los archivos con ✕ para quitarlos. `zona.input` es el `<input type=file>` (se lee `.files` y dispara `change`); `zona.limpiar()` lo vacía. Un archivo soltado fuera de una zona no abre el navegador |
| `filtroFechas({desde, hasta, modo, min, max, presets, permiteVacio, placeholder, titulo, onChange})` | `modo:'rango'` (default) · `modo:'dia'` | **Todos** los filtros de fechas: un campo (“1 oct 2026 – 23 oct 2026”) que abre un calendario con atajos (Hoy, Ayer, Últimos 7/30 días, Mes en curso, Mes anterior, Todas las fechas). Rango en dos clics (si van al revés se ordenan); `min`/`max` deshabilitan días; × limpia salvo `permiteVacio:false`. Teclado: flechas, AvPág/RePág, Enter, Escape (cierra solo el calendario, no el modal que lo contiene). En móvil el calendario sube como hoja inferior. Devuelve un elemento con `.desde` / `.hasta` que se leen y escriben con `.value` y disparan `change`, así que reemplaza a dos `<input type=date>` sin tocar el resto del código; `.fijar(d,h,notificar)` los cambia de golpe |
| `modal(título, cuerpo, pie, ancho)` | `.wide` | `role=dialog`, `aria-modal`, Escape, foco atrapado y devuelto |
| `confirmar(msg, {ok, cancelar, titulo, peligro})` | destructivo o neutro | `Promise<boolean>`. El botón toma el verbo del mensaje (“¿Eliminar…?” → **Eliminar**). Foco inicial en **Volver** si es destructivo |
| `pedir(msg, {titulo, ok, valor})` | texto libre | `Promise<string\|null>` (`null` = canceló). Ctrl/⌘+Enter envía |
| `toast(msg, 'ok'\|'err')` | | `role=status` (`alert` si es error) |

## Accesibilidad

- `:focus-visible` global (anillo `--focus`; blanco dentro de la barra lateral).
- Cualquier `div/span/li/a` creado con `el(…, {onclick})` queda con `role="button"` y `tabindex=0`; Enter y Espacio lo activan.
- Los grupos del menú lateral exponen `aria-expanded`.
- `prefers-reduced-motion`: sin transiciones ni elevaciones al pasar el cursor (el spinner solo se hace más lento).
- Contraste verificado (claro y oscuro, 3 paletas): ver la sección 7 de la guía.

## Migración (qué cambió respecto a la versión anterior)

| Antes | Ahora |
|---|---|
| `badge g / b / w / d / v / t / o / i / g2 / err` | `badge neutral / info / warn / danger / violet / teal / orange / indigo / soft / danger` |
| `style="background:#0F56AC;color:#fff"` en botones | `class="btn deep"` (también `violet`, `amber`, `ok`) |
| `confirm('…')` / `prompt('…')` | `await confirmar('…')` / `await pedir('…')` |
| 66 colores hex distintos | tokens; ver `--c-*` y `--t-*` |
| 15 tamaños de fuente | escala de 8 pasos (mín. 11px) |

> Cambio de comportamiento: con `prompt()` nativo, **Cancelar** igual enviaba el correo / registraba el cambio (devolvía `null` y se usaba `''`).
> Con `pedir()`, Cancelar **aborta** la acción. Afecta a: notificar contracargo, cambio de estado de contracargo,
> notificar devolución y notificar duplicada.

## Pendiente

- Montserrat no se carga hoy: la CSP (`server.js`, `styleSrc`/`fontSrc`) bloquea Google Fonts, así que la app se ve en la fuente del sistema. Opción sin tocar la CSP: servir los `.woff2` desde `/public/fonts` con `@font-face`.
- Estilos en línea con tamaños/espaciados fijos dentro del JS (`font:700 15px …`, `padding:12px 0`) aún no usan `--fs-*`/`--sp-*`.
- Fusionar `.dept` con `.badge` (hoy es un tono más).
