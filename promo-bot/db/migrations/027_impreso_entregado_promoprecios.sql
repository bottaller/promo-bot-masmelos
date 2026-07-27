-- ============================================================
-- Migración 027 — Botón para que Marketing confirme que ya imprimió y entregó las imágenes en
-- salón (avisa al dueño cuando lo toca).
-- Idempotente.
-- ============================================================

alter table bot.promoprecios
  add column if not exists impreso_entregado_en timestamptz;
