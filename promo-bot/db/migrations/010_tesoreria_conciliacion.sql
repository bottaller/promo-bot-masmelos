-- ============================================================
-- Migración 010 — Tesorería: resultado de la conciliación diaria
--   Una fila por cuenta y día con el cruce realidad vs libro:
--       saldo_teorico = saldo_ayer + ingresos − egresos
--       diferencia    = saldo_real − saldo_teorico
--   Queda REGISTRADO para que el admin recupere un cierre pasado con
--   /reportecierre <fecha> sin recalcular.
--
--   `acumulada` (la diferencia corrida por cuenta) NO se guarda: se calcula al
--   leer, como suma de `diferencia` por cuenta hasta esa fecha. Materializarla
--   se rompería con cargas retroactivas (cargar el día 8 hoy cambiaría el
--   acumulado de todos los días siguientes) — mejor derivarla.
--
--   La caja dólar se concilia en USD (moneda='USD'); el resto en ARS.
-- Idempotente.
-- ============================================================

-- Los numéricos son NULLABLE a propósito: una cuenta sin saldo del día anterior (primer
-- día) o sin saldo cargado hoy no tiene teórico/diferencia — guardar 0 mentiría.
create table if not exists bot.tesoreria_conciliacion (
  id             bigint      generated always as identity primary key,
  fecha          date        not null,
  empresa        text        not null default 'HONRE',
  cuenta         text        not null,                   -- 'Caja Fuerte Moreno', 'Santander', ...
  moneda         text        not null default 'ARS',     -- 'ARS' | 'USD'
  saldo_ayer     numeric,                                -- cierre del día anterior (null si no hay)
  ingresos       numeric,                                -- Σ Debe del libro mapeado a esta cuenta
  egresos        numeric,                                -- Σ Haber del libro mapeado a esta cuenta
  saldo_teorico  numeric,                                -- saldo_ayer + ingresos − egresos
  saldo_real     numeric,                                -- de tesoreria_saldos
  diferencia     numeric,                                -- saldo_real − saldo_teorico (null = no conciliada)
  estado         text,                                   -- 'ok'|'revisar'|'sin_saldo_ayer'|'sin_saldo_hoy'
  nivel          text,                                   -- 'ok'|'timing'|'revisar'|'alerta' (con el acumulado)
  generado_por   bigint      references bot.usuarios(id),
  generado_en    timestamptz not null default now(),
  -- Re-correr el cierre de un día pisa su conciliación (upsert por esta clave).
  unique (fecha, empresa, cuenta)
);

create index if not exists tesoreria_conciliacion_fecha_idx on bot.tesoreria_conciliacion (fecha);
