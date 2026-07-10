-- ============================================================
-- Migración 006 — Unificar altas y bajas en una sola tabla
--
-- La relación alta<->baja es 1:1 (una promoción se cierra entera, de una vez),
-- así que las columnas de la baja pasan a vivir en la misma fila de la alta:
--   fecha_baja IS NULL  -> sigue en oferta ("abierta")
--   fecha_baja NOT NULL -> cerrada, con cantidad_vendida / cantidad_remanente / motivo_baja
-- Se elimina la columna "estado" (redundante) y la tabla compras_bajas.
-- Idempotente.
-- ============================================================

alter table bot.compras_altas
  add column if not exists fecha_baja         timestamptz,
  add column if not exists cantidad_vendida   numeric,
  add column if not exists cantidad_remanente numeric,
  add column if not exists motivo_baja        text;

-- Migrar las bajas existentes a la fila de su alta, y tirar la tabla vieja.
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'bot' and table_name = 'compras_bajas') then
    update bot.compras_altas ca
       set fecha_baja         = cb.fecha,
           cantidad_vendida   = cb.cantidad_vendida,
           cantidad_remanente = cb.cantidad_remanente,
           motivo_baja        = cb.motivo_baja
      from bot.compras_bajas cb
     where cb.alta_id = ca.id
       and ca.fecha_baja is null;
    drop table bot.compras_bajas;
  end if;
end $$;

-- "estado" queda redundante: abierta == fecha_baja is null.
alter table bot.compras_altas drop column if exists estado;

-- Índice parcial para las consultas de "qué está en oferta ahora".
create index if not exists idx_compras_altas_abiertas
  on bot.compras_altas (fecha) where fecha_baja is null;
