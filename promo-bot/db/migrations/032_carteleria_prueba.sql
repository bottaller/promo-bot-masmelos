-- ============================================================
-- Migración 032 — /carteleria_prueba: modo prueba personal (solo el dueño del
-- bot, ver OWNER_TELEGRAM_ID). Un pedido de prueba nunca le llega a Marketing
-- real: el diseño, la verificación y el aviso final vuelven todos a quien lo
-- probó. Idempotente.
-- ============================================================

alter table bot.carteleria
  add column if not exists es_prueba boolean not null default false;
