-- ============================================================
-- Migración 007 — % de descuento de la promoción
--   descuento_pct: % de descuento que se le aplicó al producto al pasarlo a oferta.
--   Se carga en /alta (área Calidad). Nullable: las altas viejas no lo tienen.
-- Idempotente.
-- ============================================================

alter table bot.compras_altas
  add column if not exists descuento_pct numeric check (descuento_pct is null or (descuento_pct >= 0 and descuento_pct <= 100));
