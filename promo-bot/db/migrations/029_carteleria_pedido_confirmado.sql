-- ============================================================
-- Migración 029 — Botón para que Marketing confirme que ya pidió los carteles a la gráfica
-- (Cartel simple / Gráfica cigüeña). Avisa a quien hizo el pedido original con /carteleria.
-- Idempotente.
-- ============================================================

alter table bot.carteleria
  add column if not exists pedido_confirmado_en timestamptz;
