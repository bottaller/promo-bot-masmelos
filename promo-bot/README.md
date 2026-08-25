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
│   ├── areas/                ← calidad · compras · tesoreria · cajacentral · carritoweb · deposito
│   ├── admin/                ← /usuarios, /actartic (solo admin)
│   ├── scenes/               ← wizards (carga, cierre, alta, informe, …)
│   ├── lib/                  ← lógica pura (conciliación, arqueo, parsers de Excel, reportes)
│   ├── entrega-arqueo.js     ← barrido 08:00: arquea MP/Talo y entrega los reportes
│   ├── api-planilla.js       ← ÚNICA puerta HTTP: recibe la PLANILLA RETIRA sola (ver abajo)
│   ├── aviso-planilla.js     ← cada 30min: avisa si la pantalla de recepción quedó vieja
│   └── notificar.js          ← avisos por rol (telegramIdsPorRol)
├── db/migrations/            ← 001…023 (acceso, artículos, tesorería, arqueo, deploys, …)
├── docs/                     ← documentación (empezá por arquitectura.md)
├── .env.example
└── package.json
```

## Comandos

- **Calidad:** `/alta`, `/reposicion`, `/cambiopromocion`, `/baja`, `/control` (promociones por vencimiento).
- **Compras:** `/reporte` (por proveedor), `/excel` (todas las promociones + informes de Depósito).
- **Tesorería:** `/carga` (documentos del día: el libro de Sigma + las liquidaciones de MP y Talo, admin),
  `/flujos` (dashboard del flujo de dinero), `/cierre`, `/semanal`, `/mensual`, `/reportecierre`.
- **Caja Central:** rol de notificación, **sin comando** — recibe el arqueo automático de cobros (MP + Talo)
  de las 08:00 y el resumen semanal de los lunes.
- **Depósito:** `/informe` (informe sobre un proveedor/producto para Calidad o Compras).
- **Admin:** `/usuarios` (accesos), `/actartic` (maestro de artículos), `/avisos` (chequear vencimientos ahora).

El detalle por área está en [`docs/`](docs/) — empezá por [`docs/arquitectura.md`](docs/arquitectura.md).

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

## La planilla de retiros entra sola

El bot habla con Telegram por **polling**, así que históricamente no necesitó ningún puerto. Desde
agosto 2026 escucha además **un solo endpoint**, para que la PLANILLA RETIRA que alimenta la pantalla
de recepción llegue sin que nadie se acuerde de subirla:

```
POST /planilla         header X-Sync-Token: <PLANILLA_SYNC_TOKEN>
                       body: el .xlsx crudo (application/octet-stream)
POST /planilla/latido  "sigo vivo", en cada vuelta del script (cada ~4 min)
GET  /salud            sin clave, no devuelve datos
```

**Por qué existe el latido.** El script solo manda el Excel cuando cambia, que es
lo correcto. Pero entonces "no llegó nada" significa dos cosas muy distintas a la
vez: que nadie tocó la planilla, o que el script se murió. Pasó de verdad un lunes
a la mañana y no hubo forma de saber cuál era sin ir hasta la máquina. Con el
latido, `aviso-planilla.js` vigila las dos cosas por separado:

| Señal | Pregunta que responde |
|---|---|
| ¿Hay latidos? | ¿El script sigue vivo? |
| ¿Entran planillas? | ¿Alguien está actualizando el Excel? |

El latido además trae el estado del propio script: si no llega al servidor de
archivos, lo dice, y el aviso sale en el momento en vez de deducirse tres horas
después.

Del otro lado hay un script de PowerShell en la PC de la sucursal (`Desktop/sync-planilla`) que mira
el archivo en el servidor cada pocos minutos y lo manda cuando cambia. **No parsea nada**: es una
máquina de empleado, sin admin y sin Node, y no tiene por qué tener credenciales de la base.

Tres cosas para no romperlo:

- **Sin `PLANILLA_SYNC_TOKEN` el endpoint no se levanta.** Es a propósito: un puerto que escribe en
  la base sin clave es peor que no tener endpoint. `chequear-env` lo avisa al arrancar.
- En Railway hay que **generar un dominio público** para el servicio (Settings → Networking). Sin
  eso el puerto existe pero nadie llega.
- Por esta puerta **solo** se puede subir la planilla, nunca el libro diario. Se exige
  `esPlanillaRetiros(buffer)` en vez de dejar que el registro de documentos elija, porque el libro es
  el catch-all y cualquier archivo terminaría ahí.

**¿Cómo se sabe si está andando?** Con **`/pantalla`** en el bot (área Retiros).
Contesta en una línea, desde el teléfono, juntando las dos señales: el latido dice
si el script vive, la base dice cuándo entró la última planilla. Existe porque
durante la puesta en marcha esa pregunta solo se podía contestar mirando la base o
yendo hasta la PC de la sucursal, y el que la necesita es quien mira la tele.
Usa los MISMOS umbrales que los avisos: si dijera "al día" mientras el vigilante
reclama, no habría a cuál creerle.

El parseo y la escritura son **los mismos** que usa `/carga` (`lib/documentos-carga.js` →
`lib/retiros-excel.js` → `db/retiros.js`), así que la subida manual y la automática no pueden
comportarse distinto.

## Notas

- Un mismo producto puede tener varias altas abiertas a la vez; `/baja` deja elegir cuál cerrar.
- El maestro de artículos se actualiza subiendo el Excel de Sigma con `/actartic`
  (en Sigma: Artículos → Listados → Listado de Artículos Detallado).
