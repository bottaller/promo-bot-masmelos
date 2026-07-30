-- ============================================================
-- Migración 031 — /carteleria: tipo de precio, datos extraídos por IA (producto,
-- precio, vencimiento) y diseño generado automáticamente, con verificación de
-- Marketing antes de imprimir/pedir. Idempotente.
-- ============================================================

alter table bot.carteleria
  add column if not exists tipo_precio text,
  add column if not exists producto text,
  add column if not exists precio numeric(12, 2),
  add column if not exists vencimiento date,
  add column if not exists diseno_file_id text,
  add column if not exists verificado_en timestamptz;
