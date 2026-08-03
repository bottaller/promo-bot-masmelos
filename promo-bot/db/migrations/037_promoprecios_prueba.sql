-- ============================================================
-- Migración 037 — /promoprecios_prueba (solo el dueño del bot, ver middleware/authz.js
-- requiereDueno): mismo circuito que /promoprecios, pero marcado es_prueba — todos los avisos
-- que normalmente van a Compras, Marketing, Ventas/Depósito/Calidad quedan redirigidos a quien
-- lo probó (mismo criterio que bot.carteleria.es_prueba / /carteleria_prueba).
-- Idempotente.
-- ============================================================

alter table bot.promoprecios
  add column if not exists es_prueba boolean not null default false;
