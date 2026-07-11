-- ============================================================
-- Migración 008 — Tesorería: saldos diarios (Fase 2 del arqueo / conciliación)
--   El tesorero sube cada día el Excel "Existencias al cierre" (caja fuerte,
--   bancos, Mercado Pago, cheques, caja dólar). Se guarda UNA fila por cuenta y
--   día: es el lado "realidad" de la conciliación (contra el libro diario).
--   El lado "libro" (movimientos) se agrega cuando se arme la conciliación.
-- Idempotente.
-- ============================================================

create table if not exists bot.tesoreria_saldos (
  id           bigint      generated always as identity primary key,
  fecha        date        not null,
  empresa      text        not null default 'HONRE',   -- por si más adelante suma Skyceo
  cuenta       text        not null,                    -- 'Caja Fuerte Moreno', 'Santander', ...
  moneda       text        not null default 'ARS',      -- 'ARS' | 'USD'
  monto        numeric     not null,
  cargado_por  bigint      references bot.usuarios(id),
  cargado_en   timestamptz not null default now(),
  -- Re-subir el mismo día pisa el saldo anterior de esa cuenta (upsert por esta clave).
  unique (fecha, empresa, cuenta)
);

create index if not exists tesoreria_saldos_fecha_idx on bot.tesoreria_saldos (fecha);
