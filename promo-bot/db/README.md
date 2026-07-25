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
| `migrations/008_tesoreria_saldos.sql` | `tesoreria_saldos` — el lado "realidad" del `/cierre` | Conciliación diaria |
| `migrations/009_tesoreria_movimientos.sql` | `tesoreria_movimientos` — el lado "libro" (Debe/Haber por cuenta de Sigma) | Conciliación diaria |
| `migrations/010_tesoreria_conciliacion.sql` | `tesoreria_conciliacion` — el resultado de cada cierre (lo lee `/reportecierre`) | Conciliación diaria |
| `migrations/011_tesoreria_auditoria.sql` | `tesoreria_auditoria` — log append-only de cada acción | Auditoría |
| `migrations/012_carrito_web.sql` | área `carritoweb` | Área Carrito Web |
| `migrations/013_cierre_por_hora.sql` | `contado_en` / `ingreso` — el `/cierre` corta por hora, no por día | Corte por hora |
| `migrations/014_caja_central.sql` | área `cajacentral` — hoy un **rol de notificación** (recibe el arqueo de cobros automático); antes era dueño de `/mp` | Área Caja Central |
| `migrations/015_deposito.sql` | área `deposito` + `deposito_informes` (informes de texto libre a Calidad/Compras) | Área Depósito |
| `migrations/016_libro_diario.sql` | `libro_diario` — el libro de Sigma centralizado (.xlsx crudo + rango real), cargado con `/carga` | Libro centralizado |
| `migrations/017_cierres_pendientes.sql` | `cierres_pendientes` — la lista de espera del cierre en dos tiempos (barrido de las 08:00) | Cierre diferido |
| `migrations/018_mp_conciliacion.sql` | `mp_conciliacion` — el resultado del arqueo de cobros por día (lo lee el resumen semanal) | Arqueo de cobros |
| `migrations/019_rol_sistemas.sql` | rol `sistemas` — ve/usa casi todos los comandos, pero no es admin real | Rol Sistemas |
| `migrations/020_precio_promocional.sql` | columna `precio_promocional` en `compras_altas` (promo por precio fijo) | Promo por precio |
| `migrations/021_arqueo_plataforma.sql` | columna `plataforma` en `mp_conciliacion` — el arqueo pasa a **multi-plataforma** (MP + Talo) | Arqueo multi-plataforma |
| `migrations/022_liquidaciones_pendientes.sql` | `liquidaciones_pendientes` — las liquidaciones de MP/Talo **en espera** (subidas con `/carga`) que el arqueo de las 08:00 cruza y borra | Arqueo automático |
| `migrations/023_deploys.sql` | `deploys` — log de deploys anunciados, para no re-avisar el mismo commit al reiniciar | Aviso de deploy |
| `migrations/024_ajustes_promoprecios.sql` | roles `marketing`, `ventas`, `compras_promo` (cadena de validación de `/ajuste` y `/promoprecios`) | /ajuste y /promoprecios |

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
