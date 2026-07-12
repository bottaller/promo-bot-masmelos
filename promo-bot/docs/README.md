# Documentación — Bot Más Melos

Índice de la documentación del proyecto. Regla: el documento largo vive acá en `docs/`;
al lado del código va un `README.md` corto que apunta acá.

## Índice

- [**arquitectura.md**](arquitectura.md) — visión del sistema, decisiones tomadas y por qué, stack,
  fuentes de datos, flujo del dinero, modelo de datos, multi-área, hosting y plan por fases.
  **Empezá por acá.**
- [**convenciones.md**](convenciones.md) — reglas transversales (ej.: todo reporte lleva la fecha de generación).
- [**areas/calidad.md**](areas/calidad.md) — el área Calidad: `/alta`, `/reposicion`, `/cambiopromocion`, `/baja`, `/control` y los avisos de vencimiento.
- [**areas/tesoreria.md**](areas/tesoreria.md) — el área Tesorería: `/flujos` (motor Python), el puente Node→Python y la copia vendoreada del motor.
- [**conciliacion.md**](conciliacion.md) — plan de la **conciliación diaria** de Tesorería (`/cierre`, saldos vs libro, semanal/mensual, `/reportecierre`).

**Estado (2026-07-12):** Fases 0–3 (MVP) hechas — control de acceso, maestro de artículos, Compras en
Postgres (sin Google Sheets), área **Calidad** operativa y endurecida, y **Tesorería** con `/flujos`
integrado (recibe el Excel de Sigma, corre el motor Python y devuelve el HTML del flujo). Detalle en
§6, §9, §12 y §14 de [arquitectura.md](arquitectura.md). **Nuevo (en `dev`):** el **sistema de control
diario** de Tesorería — `/cierre` (saldos + libro → concilia con tolerancia al timing, alerta por
acumulado, seguridad y auditoría), `/semanal`, `/mensual` y `/reportecierre`. Tablas aplicadas en
Supabase; validado con una semana real. Falta mergear a `main` para deployar. Ver
[conciliacion.md](conciliacion.md).

## Por venir (se escriben cuando se construye cada parte)

- `modulos/base-de-datos.md` — esquema detallado y migraciones.
- `modulos/auth-y-permisos.md` — cómo funciona el control de acceso.
- `modulos/cola-y-worker.md` — la tabla `jobs` y el worker (si el arqueo pasa a snapshot acumulativo).
- `areas/compras.md` — el área Compras y sus tablas.
- `runbooks/` — operación del día a día (backups, alta de usuarios, deploy en Railway).

> No se documentan por adelantado áreas sin comandos reales (hoy: Ventas): sería documentación de humo.
