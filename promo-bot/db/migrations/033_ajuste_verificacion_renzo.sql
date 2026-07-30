-- ============================================================
-- Migración 033 — /ajuste pasa a tener un paso intermedio: José sube -> el DUEÑO lo revisa/verifica
-- (ya no lo hace él mismo) -> se reenvía a quien tenga el rol "ajuste_ejecutor" (hoy Renzo,
-- asignado con /usuarios agregar, sin hardcodear el nombre) -> esa persona lo hace y confirma ->
-- se avisa a José Y al dueño. Si nadie con ese rol confirma en 36hs, se le avisa al dueño para
-- que reclame.
--
-- Rol nuevo: 'ajuste_ejecutor' (mismo patrón que 'compras_promo' en la migración 024: un rol
-- aparte, no "el equipo de calidad general", para que le llegue solo al responsable puntual).
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('ajuste_ejecutor', 'Ajustes (ejecuta)')
on conflict (codigo) do nothing;

alter table bot.calidad_ajustes
  add column if not exists verificado_en timestamptz,   -- el dueño lo revisó y lo mandó al ejecutor
  add column if not exists demora_avisada boolean not null default false; -- ya se avisó al dueño la demora >36h (no duplicar)

comment on column bot.calidad_ajustes.verificado_en is 'El dueño revisó el archivo y lo reenvió a quien tenga el rol ajuste_ejecutor.';
comment on column bot.calidad_ajustes.demora_avisada is 'Ya se le avisó al dueño que pasaron 36hs sin confirmación del ejecutor (evita reavisar).';
