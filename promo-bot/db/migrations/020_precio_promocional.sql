-- ============================================================
-- Migración 020 — Promoción por precio fijo, como alternativa al % de descuento.
-- (Renumerada de 018 a 020: Renzo usó el 018 para bot.mp_conciliacion en paralelo. Ya estaba
-- aplicada contra la base bajo el nombre viejo; el rename es solo prolijidad, no hace falta
-- volver a correrla.)
-- Una camada es una cosa O la otra (se valida en el código, no acá); ambas quedan nullable.
-- Idempotente.
-- ============================================================

alter table bot.compras_altas
  add column if not exists precio_promocional numeric check (precio_promocional is null or precio_promocional > 0);
