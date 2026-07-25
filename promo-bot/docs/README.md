# Documentación — Bot Más Melos

Índice de la documentación del proyecto. Regla: el documento largo vive acá en `docs/`;
al lado del código va un `README.md` corto que apunta acá.

## Índice

- [**arquitectura.md**](arquitectura.md) — visión del sistema, decisiones tomadas y por qué, stack,
  fuentes de datos, flujo del dinero, modelo de datos, multi-área, hosting y plan por fases.
  **Empezá por acá.**
- [**convenciones.md**](convenciones.md) — reglas transversales (ej.: todo reporte lleva la fecha de generación).
- [**areas/calidad.md**](areas/calidad.md) — el área Calidad: `/alta`, `/reposicion`, `/cambiopromocion`, `/baja`, `/control` y los avisos de vencimiento.
- [**areas/tesoreria.md**](areas/tesoreria.md) — el área Tesorería: `/carga` (libro + liquidaciones), `/cierre`, `/flujos` (motor Python), el arqueo automático de cobros, el puente Node→Python y la copia vendoreada del motor.
- [**areas/caja-central.md**](areas/caja-central.md) — el área Caja Central: un **rol de notificación sin comando** que recibe el arqueo automático de cobros (MP + Talo) de las 08:00 y el resumen semanal.
- [**conciliacion.md**](conciliacion.md) — plan de la **conciliación diaria** de Tesorería (`/cierre`, saldos vs libro, semanal/mensual, `/reportecierre`).
- [**conciliacion-mp.md**](conciliacion-mp.md) — el **arqueo de cobros operación por operación** (MP + Talo): automático a las 08:00, aparea cada cobranza con su cobro en la plataforma y marca las que no cierran.

**Estado (2026-07-12):** Fases 0–3 (MVP) hechas — control de acceso, maestro de artículos, Compras en
Postgres (sin Google Sheets), área **Calidad** operativa y endurecida, y **Tesorería** con `/flujos`
integrado (recibe el Excel de Sigma, corre el motor Python y devuelve el HTML del flujo). Detalle en
§6, §9, §12 y §14 de [arquitectura.md](arquitectura.md). **Nuevo (en `dev`):** el **sistema de control
diario** de Tesorería — `/cierre` (saldos + libro → concilia con tolerancia al timing, alerta por
acumulado, seguridad y auditoría), `/semanal`, `/mensual` y `/reportecierre`. Tablas aplicadas en
Supabase; validado con una semana real. Falta mergear a `main` para deployar. Ver
[conciliacion.md](conciliacion.md). **Nuevo (2026-07-25, en `dev`):** el **arqueo de cobros
automático** — el nivel de abajo del `/cierre`, que dice **cuál** es la venta que no cierra. El admin
sube el libro y las liquidaciones de **Mercado Pago y Talo** de noche con `/carga` (que reemplazó a
`/libro`); a las **08:00** un barrido las cruza contra el libro y le manda a **Tesorería + Caja
Central** un texto + un PDF por plataforma; los lunes va el resumen semanal. **Caja Central** dejó de
tener comando (`/mp`) y pasó a ser un **rol de notificación**. MP acepta el reporte de **Cobros
(collection)**, disponible el mismo día, además del settlement. **Falta correr las migraciones 014,
018/021, 022 y 023.** Ver [conciliacion-mp.md](conciliacion-mp.md) y
[areas/caja-central.md](areas/caja-central.md).

## Por venir (se escriben cuando se construye cada parte)

- `modulos/base-de-datos.md` — esquema detallado y migraciones.
- `modulos/auth-y-permisos.md` — cómo funciona el control de acceso.
- `modulos/cola-y-worker.md` — la tabla `jobs` y el worker (si el arqueo pasa a snapshot acumulativo).
- `areas/compras.md` — el área Compras y sus tablas.
- `runbooks/` — operación del día a día (backups, alta de usuarios, deploy en Railway).

> No se documentan por adelantado áreas sin comandos reales (hoy: Ventas): sería documentación de humo.
