-- ============================================================
-- Migración 040 — Rol "Administración": distinto de admin del bot (es_admin). Es un área más
-- (bot.areas + bot.usuario_area, mismo patrón que 'sistemas' o 'ajuste_ejecutor'), pensada para
-- la persona que va a usar /arqueobanco (arqueo de cobros de Santander/Supervielle, a demanda).
-- Un admin real sigue teniendo acceso igual (bypass de siempre, ver middleware/authz.js), pero
-- esto permite darle el comando a alguien que NO es admin del bot.
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('administracion', 'Administración')
on conflict (codigo) do nothing;
