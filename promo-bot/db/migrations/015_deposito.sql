-- ============================================================
-- Migración 015 — Área Depósito: informes en texto libre dirigidos a Calidad o Compras.
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('deposito', 'Depósito')
on conflict (codigo) do nothing;

create table if not exists bot.deposito_informes (
  id              bigint      generated always as identity primary key,
  fecha           timestamptz not null default now(),
  destino_area    text        not null check (destino_area in ('calidad', 'compras')),
  referencia      text        not null,  -- proveedor o producto sobre el que es el informe (texto libre)
  mensaje         text        not null,
  usuario_id      bigint      references bot.usuarios(id),
  usuario_nombre  text
);
comment on table bot.deposito_informes is 'Informes cargados desde Depósito, dirigidos a Calidad o Compras.';

create index if not exists idx_deposito_informes_destino on bot.deposito_informes (destino_area);
