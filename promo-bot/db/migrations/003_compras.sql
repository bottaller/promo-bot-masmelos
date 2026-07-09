-- ============================================================
-- Migración 003 — Compras: promociones por vencimiento en Postgres
-- Reemplaza las pestañas ALTAS/BAJAS de Google Sheets.
-- Idempotente.
-- ============================================================

create table if not exists bot.compras_altas (
  id              bigint generated always as identity primary key,
  fecha           timestamptz not null default now(),
  usuario_id      bigint references bot.usuarios(id),
  usuario_nombre  text,
  articulo_codigo text,            -- código del maestro si se eligió de ahí; null si carga manual
  ean             text,            -- EAN de referencia (si vino del maestro)
  producto        text not null,
  proveedor       text,
  lote            text,
  vencimiento     text,            -- DD/MM/AAAA (texto por ahora)
  cantidad        numeric not null check (cantidad > 0),
  motivo          text,
  estado          text not null default 'abierta'   -- 'abierta' | 'cerrada'
);
comment on table bot.compras_altas is 'Altas de productos en promoción por vencimiento.';

create index if not exists idx_compras_altas_estado   on bot.compras_altas (estado);
create index if not exists idx_compras_altas_codigo   on bot.compras_altas (articulo_codigo);
create index if not exists idx_compras_altas_producto on bot.compras_altas (lower(producto));

create table if not exists bot.compras_bajas (
  id                 bigint generated always as identity primary key,
  fecha              timestamptz not null default now(),
  alta_id            bigint not null references bot.compras_altas(id),
  cantidad_remanente numeric not null check (cantidad_remanente >= 0),
  cantidad_vendida   numeric not null check (cantidad_vendida >= 0),
  motivo_baja        text
);
comment on table bot.compras_bajas is 'Bajas (retiro de góndola) de una promoción. Cierra la alta correspondiente.';

create index if not exists idx_compras_bajas_alta on bot.compras_bajas (alta_id);
