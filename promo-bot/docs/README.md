# Documentación — Bot Más Melos

Índice de la documentación del proyecto. Regla: el documento largo vive acá en `docs/`;
al lado del código va un `README.md` corto que apunta acá.

## Índice

- [**arquitectura.md**](arquitectura.md) — visión del sistema, decisiones tomadas y por qué, stack,
  fuentes de datos, flujo del arqueo, modelo de datos, multi-área, hosting y plan por fases.
  **Empezá por acá.**
- [**convenciones.md**](convenciones.md) — reglas transversales (ej.: todo reporte lleva la fecha de generación).

**Estado (2026-07-09):** Fases 0–2 hechas — control de acceso, maestro de artículos y Compras en
Postgres (sin Google Sheets). Detalle en §12 de [arquitectura.md](arquitectura.md).

## Por venir (se escriben cuando se construye cada parte)

- `modulos/base-de-datos.md` — esquema detallado y migraciones.
- `modulos/auth-y-permisos.md` — cómo funciona el control de acceso.
- `modulos/cola-y-worker.md` — la tabla `jobs` y el worker.
- `areas/compras.md`, `areas/tesoreria.md`, … — un doc por área, con sus comandos y tablas.
- `runbooks/` — operación del día a día (backups, alta de usuarios, worker on-prem).

> No se documentan por adelantado áreas sin comandos reales (Ventas/Calidad): sería documentación de humo.
