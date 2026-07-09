# Esquema de la landing (schema `public`) — referencia

> **Solo lectura / referencia.** Estas tablas son de la **página web**, no del bot. Viven en el
> schema `public` de la base **compartida**. El bot vive en el schema `bot` (ver
> [migrations/001_fundaciones.sql](migrations/001_fundaciones.sql)).
>
> Para qué sirve este documento:
> 1. **No chocar nombres** al crear tablas del bot (ojo: la landing ya tiene una tabla `promociones`,
>    que **no** es la promoción por vencimiento del bot).
> 2. Conocer los **destinos** del futuro puente "el bot publica una oferta en la web"
>    (ver `docs/arquitectura.md` §13).
>
> ⚠️ **El bot NO corre migraciones ni DDL sobre `public`.** Si alguna vez escribe acá (puente a la
> web), es solo `insert`/`update` de filas, con mucho cuidado. La fuente de verdad de este esquema
> es la base de la landing; esto es un snapshot al **2026-07-08** y puede cambiar.

---

## Tablas de contenido (las candidatas para el puente a la web)

### `promociones` — banners de ofertas
| columna | tipo | null | default |
|---|---|---|---|
| id | uuid | no | auto (PK) |
| titulo | text | sí | |
| descripcion | text | sí | |
| imagen_url | text | no | |
| fecha_inicio / fecha_fin | date | sí | |
| activo | boolean | sí | true |
| orden | int | sí | 0 |
| badge / badge_tipo | text | sí | 'Oferta' / 'oferta' |

### `banners` — banner de descuentos
| columna | tipo | null | default |
|---|---|---|---|
| id | uuid | no | auto (PK) |
| nombre | text | sí | (referencia interna) |
| imagen_url | text | no | |
| link | text | sí | |
| orden | int | no | 0 |
| activo | boolean | no | true |

### `productos_seleccion` — filas tipo Netflix
| columna | tipo | null | default |
|---|---|---|---|
| id | uuid | no | auto (PK) |
| tematica | text | no | slug: `ticket` \| `rotacion` \| `temporada` \| `novedades` |
| nombre | text | no | |
| imagen_url | text | sí | |
| link | text | sí | |
| orden | int | no | 0 |
| activo | boolean | no | true |

### `categorias`
`id` uuid PK · `nombre` (no) · `descripcion` · `imagen_url` · `link` · `orden` int no 0 · `activo` bool no true

### `temporadas` — festividades
`id` uuid PK · `nombre` (no) · `slug` (no: halloween, navidad, enamorados, dia-del-nino, pascuas, fin-de-ano) · `emoji` · `activa` bool false · `en_desarrollo` bool false · `mensaje` · `fecha_evento` date · `mostrar_countdown` bool false

### `ofertas_temporada` — imágenes por temporada
`id` uuid PK · `temporada_id` uuid FK → `temporadas.id` · `tipo` (no: banner \| producto) · `imagen_url` (no) · `orden` int 0 · `activo` bool true

### `social_cards` — TikTok / Instagram
`id` uuid PK · `plataforma` (no: tiktok \| instagram) · `titulo` / `url` / `thumbnail_url` (no) · `activo` bool true · `orden` int 0

### `faqs`
`id` uuid PK · `pregunta` (no) · `respuesta` (no) · `activo` bool true · `orden` int 0

### `folletos`
`id` uuid PK · `titulo` (no) · `descripcion` · `archivo_url` (no) · `fecha_inicio` / `fecha_fin` date · `activo` · `orden`

### `site_config` — clave/valor
`key` text PK · `value` text (no) · `descripcion`
Ejemplos de `key`: `whatsapp_number`, `cart_url`, `folleto_drive_url`, `form_ventas`, …

---

## Tablas de sistema de la landing (el bot NO las toca)

- **`profiles`** — `id` (PK, = auth user) · `email` · `full_name` · `role` (`superadmin`\|`admin`\|`vendedor`\|`visualizador`) · `active` (boolean).
- **`registro_codigos`** — `codigo` · `role` · `tipo` (`registro`\|`reset`) · `usado` · `usado_por` · `email_destino` · `expires_at`.

---

## Storage (buckets públicos)

Los campos `imagen_url` / `archivo_url` / `thumbnail_url` guardan la **URL pública completa**. Buckets:
`promociones` · `social` · `temporadas` · `folletos` · `categorias` · `selecciones` · `banners`.
→ Se pueden mandar directo a Telegram como URL de imagen.

---

## Gotchas (importantes si el bot alguna vez lee/escribe acá)

- **`profiles` usa `active`** (booleano). **Todas las demás usan `activo`.** No confundirlos.
- Para "lo que se muestra en la web": filtrar `activo = true` (y en `promociones`/`folletos`, `fecha_fin >= hoy`).
- `productos_seleccion.tematica` es un **slug de texto** (no FK): `ticket`, `rotacion`, `temporada`, `novedades`.
- `profiles.role` tiene default `'editor'` en la DB, pero es **legacy** — la app usa los 4 roles de arriba.
- Todos los `id` son **uuid**; fechas de evento/oferta son `date`; los timestamps son `timestamptz`.
