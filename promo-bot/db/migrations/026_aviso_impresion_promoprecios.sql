-- ============================================================
-- Migración 026 — Aviso a Marketing para imprimir, cuando el dueño termina de validar TODAS las
-- imágenes de un ciclo de /promoprecios (última imagen que pasa a "enviada").
-- Idempotente.
-- ============================================================

alter table bot.promoprecios
  add column if not exists aviso_impresion_en timestamptz;
