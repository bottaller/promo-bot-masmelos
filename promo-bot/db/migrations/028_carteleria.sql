-- ============================================================
-- Migración 028 — /carteleria (área Depósito): pedido de cartel para Marketing.
-- No es un rol nuevo (vive dentro de Depósito, que ya existe), solo la tabla de registro.
-- Idempotente.
-- ============================================================

create table if not exists bot.carteleria (
  id                    bigint      generated always as identity primary key,
  fecha                 timestamptz not null default now(),
  usuario_id            bigint      references bot.usuarios(id),
  usuario_nombre        text,
  usuario_telegram_id   bigint      not null,
  foto_file_id          text        not null,
  tipo                  text        not null   -- 'a4' | 'a4_color' | 'cartel_simple' | 'ciguena'
);
comment on table bot.carteleria is 'Pedidos de cartelería (Depósito -> Marketing): foto de producto+precio + tipo de gráfica.';
