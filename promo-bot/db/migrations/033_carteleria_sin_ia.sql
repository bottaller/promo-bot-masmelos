-- ============================================================
-- Migración 033 — /carteleria deja de depender de IA: el producto se identifica
-- escaneando el código de barras (EAN) contra bot.articulos, o escribiéndolo/
-- nombrándolo a mano si no hay foto o no matchea. La foto ahora es opcional
-- (antes era obligatoria: era la foto de producto+precio que leía la IA).
-- Idempotente.
-- ============================================================

alter table bot.carteleria
  alter column foto_file_id drop not null;
