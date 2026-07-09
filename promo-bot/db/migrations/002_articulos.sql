-- ============================================================
-- Migración 002 — Maestro de artículos (schema bot)
-- Se llena con el comando /actartic (subir el Excel "Listado de Articulos Detallado" de Sigma).
-- Idempotente.
-- ============================================================

create table if not exists bot.articulos (
  codigo         text primary key,          -- columna "Codigo" del Excel
  nombre         text,
  ean_unidad     text,
  ean_display    text,
  ean_bulto      text,
  rubro_cod      text,                       -- "Cod" a la izquierda de Rubro
  rubro          text,
  proveedor_cod  text,                       -- "Cod" a la izquierda de Proveedor
  proveedor      text,
  actualizado_en timestamptz not null default now()
);
comment on table bot.articulos is 'Maestro de artículos importado del Excel de Sigma (comando /actartic).';

-- Índices para búsqueda por EAN exacta o por prefijo (primeros N dígitos con LIKE 'xxx%').
create index if not exists idx_articulos_ean_unidad  on bot.articulos (ean_unidad  text_pattern_ops);
create index if not exists idx_articulos_ean_display on bot.articulos (ean_display text_pattern_ops);
create index if not exists idx_articulos_ean_bulto   on bot.articulos (ean_bulto   text_pattern_ops);
