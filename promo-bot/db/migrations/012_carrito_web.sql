-- ============================================================
-- Migración 012 — Área Carrito Web (sección + permisos, sin comandos todavía)
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('carritoweb', 'Carrito Web')
on conflict (codigo) do nothing;
