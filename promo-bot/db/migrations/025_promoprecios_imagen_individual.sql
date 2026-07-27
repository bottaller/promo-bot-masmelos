-- ============================================================
-- Migración 025 — Validación de /promoprecios por IMAGEN individual, no por lote.
-- Cada fila de bot.promoprecios_imagenes pasa a tener su propio estado y puede ir a Compras,
-- pasar por una corrección ("revisar", con el comentario de qué corregir) y validarse por
-- separado, sin esperar a las demás imágenes del mismo ciclo.
--
-- Las columnas de validación POR LOTE que quedan en bot.promoprecios (compras_imagenes_ok,
-- admin_imagenes_ok, enviado_en) se dejan de usar en el código pero no se borran acá — es dato
-- de una función que recién se estrenó, no vale la pena una migración destructiva por eso.
-- Idempotente.
-- ============================================================

alter table bot.promoprecios_imagenes
  add column if not exists estado text not null default 'pendiente',
    -- 'pendiente' | 'revisar' | 'compras_ok' | 'enviada'
  add column if not exists revisar_comentario text,
  add column if not exists revisar_en timestamptz,
  add column if not exists compras_ok_en timestamptz,
  add column if not exists admin_ok_en timestamptz,
  add column if not exists enviada_en timestamptz;

create index if not exists idx_promoprecios_imagenes_estado on bot.promoprecios_imagenes (promoprecio_id, estado);
