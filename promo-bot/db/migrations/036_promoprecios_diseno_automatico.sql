-- ============================================================
-- Migración 036 — /promoprecios: diseño de cartel generado automáticamente.
-- Cuando el archivo de /promoprecios marca productos con "x" en la columna Imagen, se genera
-- un pedido de bot.carteleria por producto (misma lógica que /carteleria: a4_color +
-- corto_vencimiento) para que Marketing lo verifique antes de que entre al circuito de
-- Compras/dueño de bot.promoprecios_imagenes. promoprecio_id liga ese pedido de vuelta al ciclo
-- que lo generó — null para los pedidos normales de /carteleria (sin cambios ahí).
-- Idempotente.
-- ============================================================

alter table bot.carteleria
  add column if not exists promoprecio_id bigint references bot.promoprecios(id);

create index if not exists idx_carteleria_promoprecio on bot.carteleria (promoprecio_id);
