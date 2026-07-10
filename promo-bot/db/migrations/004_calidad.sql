-- ============================================================
-- Migración 004 — Área Calidad (Alta / Baja / Control)
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('calidad', 'Calidad')
on conflict (codigo) do nothing;
