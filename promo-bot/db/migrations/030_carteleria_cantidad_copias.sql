-- ============================================================
-- Migración 030 — /carteleria: para A4 y A4 Color (impresión interna) se guarda cuántas
-- copias se necesitan. Cartel simple / Gráfica cigüeña (van a la gráfica externa) no la usan.
-- Idempotente.
-- ============================================================

alter table bot.carteleria
  add column if not exists cantidad_copias integer;
