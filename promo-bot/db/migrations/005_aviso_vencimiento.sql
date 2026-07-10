-- ============================================================
-- Migración 005 — Avisos de vencimiento
--   aviso_vencimiento_fecha: fecha del último aviso "por vencer" (para no repetir
--     el mismo día; permite avisar 1 día antes y de nuevo el mismo día).
--   aviso_vencido: si ya se mandó el aviso de "vencido" (se manda una sola vez).
-- Idempotente.
-- ============================================================

alter table bot.compras_altas
  add column if not exists aviso_vencimiento_fecha date,
  add column if not exists aviso_vencido boolean not null default false;
