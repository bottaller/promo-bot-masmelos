-- ============================================================
-- Migración 019 — Rol "Sistemas": ve y usa TODOS los comandos (todas las áreas + /usuarios,
-- /actartic, /avisos, /libro, /reportecierre), pero NO es admin de verdad:
--   - no recibe los avisos proactivos que van "a los admins" (vencidos, libro diario
--     faltante, entrega de cierres — esos siguen filtrando por es_admin = true).
--   - dentro de /usuarios, NO puede hacer/sacar admin a nadie (subcomandos admin/quitaradmin),
--     para que no sea una forma indirecta de autopromoverse a admin real.
-- Se implementa como un rol más (bot.areas + bot.usuario_area), sin tabla ni columna nueva.
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('sistemas', 'Sistemas')
on conflict (codigo) do nothing;
