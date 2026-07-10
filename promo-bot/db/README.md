# Base de datos — migraciones

Migraciones SQL de la base del bot (Supabase / PostgreSQL). Ver el diseño en
[../docs/arquitectura.md](../docs/arquitectura.md) (§7 Modelo de datos).

> ⚠️ La base está **compartida con la landing**. Todas las tablas del bot viven en el schema
> **`bot`** (la landing usa `public`). No se tocan las tablas de `public`.
>
> Referencia del schema de la landing: [esquema-landing.md](esquema-landing.md) (para no chocar
> nombres y conocer los destinos del futuro puente a la web).

## Cómo correr una migración

1. Entrá a tu proyecto de Supabase (el compartido con la landing) → **SQL Editor**.
2. Abrí el archivo `.sql` de `migrations/`, copiá **todo** el contenido y pegalo en el editor.
3. **Run**. Están escritas para poder correrse más de una vez sin romper nada (idempotentes).
4. Corré las migraciones **en orden** (`001_`, `002_`, `003_`, …).

También podés correrlas desde la terminal: `node src/db/run-migration.js db/migrations/001_fundaciones.sql`.

## Migraciones

| Archivo | Qué crea | Fase |
|---|---|---|
| `migrations/001_fundaciones.sql` | `areas`, `usuarios`, `usuario_area` + semilla de áreas | Fase 1 — control de acceso |
| `migrations/002_articulos.sql` | `articulos` (maestro) + índices de búsqueda por EAN | Maestro de artículos |
| `migrations/003_compras.sql` | `compras_altas`, `compras_bajas` | Fase 2 — promociones |
| `migrations/004_calidad.sql` | área `calidad` | Área Calidad |
| `migrations/005_aviso_vencimiento.sql` | columnas de avisos de vencimiento | Avisos |
| `migrations/006_unificar_bajas.sql` | unifica la baja en `compras_altas` (elimina `compras_bajas` y `estado`) | Unificación |
| `migrations/007_descuento_promocion.sql` | columna `descuento_pct` en `compras_altas` | % de descuento en `/alta` |

## Después de correr `001`

Falta un paso manual: **cargar el admin inicial** (vos). Está explicado al final del propio
`001_fundaciones.sql` — necesitás tu `telegram_id` (te lo da [@userinfobot](https://t.me/userinfobot)),
lo completás en el bloque comentado y volvés a correr.

## Notas

- El bot se conecta con `pg` (node-postgres) usando SQL directo, sin ORM. Necesita **solo la
  connection string** de Postgres (Supabase → Settings → Database → Connection string), que incluye
  la contraseña de la base. Va en `.env` / Variables de Railway y **nunca** se commitea.
- **No** usamos `supabase-js` ni la API REST para el bot: eso obligaría a exponer el schema `bot`.
  La conexión directa de Postgres llega a `bot` sin exponerlo (así la web pública no lo ve).
