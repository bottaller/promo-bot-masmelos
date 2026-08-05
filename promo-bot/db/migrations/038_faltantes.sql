-- ============================================================
-- Migración 038 — Faltantes / reposición.
-- Ventas y Depósito avisan que un producto falta o queda poco (comando /falta);
-- Compras baja el consolidado de las últimas 2 semanas en Excel (comando /faltantes).
-- Idempotente.
-- ============================================================

-- 'ventas' ya existía como rol de aviso (recibe los /promoprecios); ahora además tiene
-- comandos (área Ventas, ver src/areas/ventas). El insert es por las dudas / bases nuevas.
insert into bot.areas (codigo, nombre) values
  ('ventas', 'Ventas')
on conflict (codigo) do nothing;

create table if not exists bot.faltantes (
  id              bigint      generated always as identity primary key,
  fecha           timestamptz not null default now(),
  -- Si se resolvió contra el maestro, queda el código (dedup por acá); si no, null y se
  -- dedupea por producto_norm. on delete set null: si /actartic sacara el artículo, no rompe.
  articulo_codigo text        references bot.articulos(codigo) on delete set null,
  producto_texto  text        not null,   -- nombre del maestro, o lo que escribió el que reporta
  producto_norm   text        not null,   -- nombre normalizado (clave de dedup sin código)
  origen_area     text        not null check (origen_area in ('ventas', 'deposito')),
  situacion       text        not null check (situacion in ('falta', 'poco', 'vende_mucho')),
  nota            text,
  usuario_id      bigint      references bot.usuarios(id),
  usuario_nombre  text
);
comment on table bot.faltantes is 'Productos que faltan/quedan poco, reportados por Ventas y Depósito (/falta). Compras baja el consolidado de las últimas 2 semanas (/faltantes).';

-- El reporte filtra por ventana de 2 semanas -> índice por fecha.
create index if not exists idx_faltantes_fecha on bot.faltantes (fecha);
