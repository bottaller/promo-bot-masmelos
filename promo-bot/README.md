# Bot Más Melos

Bot de Telegram **multi-área** para la empresa (mayorista Más Melos). Un solo bot; cada área
(Compras, Tesorería, …) ve y usa **solo sus comandos**. Corre en **Node.js + telegraf** con base en
**Supabase / PostgreSQL**. Sin Google Sheets.

> Diseño completo, decisiones y plan por fases: **[docs/arquitectura.md](docs/arquitectura.md)**.

## Estructura

```
promo-bot/
├── src/
│   ├── index.js              ← arranque: middlewares + registro de áreas
│   ├── middleware/           ← auth (identidad por telegram_id) + authz (permisos por área)
│   ├── db/                   ← pool (pg) + acceso a datos + scripts (migración, seed-admin)
│   ├── areas/
│   │   ├── compras/          ← /alta /baja /reporte /buscar
│   │   └── tesoreria/        ← /arqueo (esqueleto)
│   ├── admin/                ← /usuarios, /actartic (solo admin)
│   ├── scenes/               ← wizards de Compras (alta, baja, reporte)
│   ├── lib/                  ← parser del Excel de artículos
│   └── notificar.js          ← avisos a compradores (config/proveedores.js)
├── db/migrations/            ← 001 acceso · 002 artículos · 003 compras
├── docs/                     ← documentación (empezá por arquitectura.md)
├── .env.example
└── package.json
```

## Comandos

- **Compras:** `/alta` (producto en promoción por vencimiento — busca en el maestro por EAN/código/nombre),
  `/baja` (retiro de góndola), `/reporte` (por producto o proveedor), `/buscar` (artículo por EAN).
- **Tesorería:** `/arqueo` (próximamente).
- **Admin:** `/usuarios` (gestionar accesos), `/actartic` (subir el maestro de artículos).

## Puesta en marcha (local)

1. **Bot de Telegram:** creá uno con [@BotFather](https://t.me/BotFather) y guardá el token.
   Conviene tener uno de PRUEBA (local) y otro de PRODUCCIÓN (Railway).
2. **Base:** proyecto en [Supabase](https://supabase.com). La connection string sale de
   Settings → Database → Connection string (usá la del **Session pooler**).
3. **Variables:**
   ```bash
   cp .env.example .env
   # completar BOT_TOKEN y DATABASE_URL
   ```
4. **Instalar y migrar:**
   ```bash
   npm install
   node src/db/run-migration.js db/migrations/001_fundaciones.sql
   node src/db/run-migration.js db/migrations/002_articulos.sql
   node src/db/run-migration.js db/migrations/003_compras.sql
   ```
5. **Darte de alta como admin** (tu telegram_id te lo da [@userinfobot](https://t.me/userinfobot)):
   ```bash
   node src/db/seed-admin.js <tu_telegram_id> Renzo
   ```
6. **Correr:**
   ```bash
   npm start
   ```
   ⚠️ **Una sola instancia por token** a la vez: si corren dos, Telegram tira error 409.

## Deploy en Railway

Conectar el repo a un proyecto de Railway y cargar las variables (`BOT_TOKEN`, `DATABASE_URL`) en la
sección Variables. Las migraciones se corren una vez contra Supabase (SQL Editor o el script de arriba).

## Notas

- Un mismo producto puede tener varias altas abiertas a la vez; `/baja` deja elegir cuál cerrar.
- El maestro de artículos se actualiza subiendo el Excel de Sigma con `/actartic`
  (en Sigma: Artículos → Listados → Listado de Artículos Detallado).
