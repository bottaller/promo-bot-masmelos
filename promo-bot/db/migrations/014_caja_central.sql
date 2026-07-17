-- ============================================================
-- Migración 014 — Área / rol "Caja Central"
-- Es quien concilia Mercado Pago operación por operación (/mp).
-- El comando salió de Tesorería y pasó a este rol (los admins lo siguen viendo:
-- tienen acceso total). Ver docs/conciliacion-mp.md.
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('cajacentral', 'Caja Central')
on conflict (codigo) do nothing;

-- Asignarle el rol a alguien: /usuarios agregar <telegram_id> cajacentral
