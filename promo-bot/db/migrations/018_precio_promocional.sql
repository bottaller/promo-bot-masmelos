-- ============================================================
-- Migración 018 — Promoción por precio fijo, como alternativa al % de descuento.
-- Una camada es una cosa O la otra (se valida en el código, no acá); ambas quedan nullable.
-- Idempotente.
-- ============================================================

alter table bot.compras_altas
  add column if not exists precio_promocional numeric check (precio_promocional is null or precio_promocional > 0);
