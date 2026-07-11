-- ============================================================
-- Migración 009 — Tesorería: movimientos del libro diario (lado "libro")
--   Del export "Diario de movimientos contables" de Sigma se guarda, por día y
--   por CUENTA CONTABLE (cuenta_id de Sigma), el total de Debe y Haber. Es el
--   lado "libro" de la conciliación: contra el saldo real (tesoreria_saldos),
--       saldo_teorico = saldo_ayer + Σdebe − Σhaber.
--   (Convención confirmada por el motor de /flujos: arqueo/core.py::cascada_diaria.)
--
--   Se guarda CRUDO por cuenta_id (no pre-agregado a "Caja Fuerte Moreno",
--   "Santander", etc.): el mapeo cuenta→saldo y las sumas (la caja fuerte junta
--   varias cajas) se resuelven al conciliar. Así, si el mapeo se corrige, no hay
--   que re-importar el libro.
--
--   Debe/Haber en ARS; debe_nominal/haber_nominal en la moneda original (para la
--   caja dólar, que se arquea en USD con las columnas *Nominal* del export).
-- Idempotente.
-- ============================================================

create table if not exists bot.tesoreria_movimientos (
  id             bigint      generated always as identity primary key,
  fecha          date        not null,
  empresa        text        not null default 'HONRE',
  cuenta_id      bigint      not null,                   -- código de cuenta de Sigma (del libro)
  cuenta         text        not null default '',        -- nombre tal como viene en el libro
  debe           numeric     not null default 0,         -- Σ Debe del día (ARS)
  haber          numeric     not null default 0,         -- Σ Haber del día (ARS)
  debe_nominal   numeric     not null default 0,         -- Σ Debe Nominal (USD, para caja dólar)
  haber_nominal  numeric     not null default 0,         -- Σ Haber Nominal (USD)
  cargado_por    bigint      references bot.usuarios(id),
  cargado_en     timestamptz not null default now(),
  -- Re-subir el libro de un día pisa los totales de esa cuenta (upsert por esta
  -- clave): capta los ajustes retroactivos (un asiento backdateado a ese día).
  unique (fecha, empresa, cuenta_id)
);

create index if not exists tesoreria_movimientos_fecha_idx on bot.tesoreria_movimientos (fecha);
