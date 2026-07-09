-- ============================================================
-- Migración 001 — Fundaciones (Fase 1: control de acceso + áreas)
-- Base: Supabase / PostgreSQL — proyecto COMPARTIDO con la landing.
--
-- IMPORTANTE: todas las tablas del bot viven en el schema "bot",
-- separado del schema "public" (que es de la landing). Como "bot" NO está
-- en la lista de "Exposed schemas" de Supabase y no se le dan permisos a los
-- roles anon/authenticated, la API pública / anon key de la web NO puede ver
-- ni tocar estas tablas. El bot se conecta por conexión directa de Postgres.
--
-- Cómo correrla: Supabase → SQL Editor → pegar todo → Run.
-- Idempotente: se puede volver a correr sin romper nada.
-- ============================================================

-- ---------- (OPCIONAL) Limpieza si ya corriste una versión vieja ----------
-- Solo si alguna vez corriste este archivo cuando las tablas iban a "public".
-- Descomentá estas 3 líneas UNA vez. Son tablas del bot (la landing NO tiene
-- usuarios/areas/usuario_area), así que es seguro borrarlas de public.
--
-- drop table if exists public.usuario_area;
-- drop table if exists public.usuarios;
-- drop table if exists public.areas;

-- ---------- Schema propio del bot ----------
create schema if not exists bot;

-- ---------- Función util: mantener "actualizado_en" al día ----------
create or replace function bot.set_actualizado_en()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en = now();
  return new;
end;
$$;

-- ---------- Áreas de la empresa ----------
create table if not exists bot.areas (
  id         bigint generated always as identity primary key,
  codigo     text        not null unique,     -- 'compras', 'tesoreria', ...
  nombre     text        not null,
  activa     boolean     not null default true,
  creado_en  timestamptz not null default now()
);
comment on table bot.areas is 'Áreas de la empresa. Cada comando del bot pertenece a un área.';

-- ---------- Usuarios (identidad = telegram_id) ----------
create table if not exists bot.usuarios (
  id             bigint generated always as identity primary key,
  telegram_id    bigint      not null unique,   -- ctx.from.id de Telegram
  nombre         text,
  activo         boolean     not null default true,
  es_admin       boolean     not null default false,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
comment on table bot.usuarios is 'Personas autorizadas a usar el bot. Sin fila activa = sin acceso.';
comment on column bot.usuarios.telegram_id is 'ID numérico de Telegram. Se obtiene escribiéndole a @userinfobot.';

drop trigger if exists trg_usuarios_actualizado on bot.usuarios;
create trigger trg_usuarios_actualizado
  before update on bot.usuarios
  for each row execute function bot.set_actualizado_en();

-- ---------- Pertenencia usuario <-> área (N:N) ----------
create table if not exists bot.usuario_area (
  usuario_id bigint      not null references bot.usuarios(id) on delete cascade,
  area_id    bigint      not null references bot.areas(id)    on delete cascade,
  creado_en  timestamptz not null default now(),
  primary key (usuario_id, area_id)
);
comment on table bot.usuario_area is 'Qué usuario pertenece a qué área. Una persona puede estar en varias.';

create index if not exists idx_usuario_area_area on bot.usuario_area (area_id);

-- ---------- Semilla: áreas activas hoy ----------
insert into bot.areas (codigo, nombre) values
  ('compras',   'Compras'),
  ('tesoreria', 'Tesorería')
on conflict (codigo) do nothing;
-- 'ventas' y 'calidad' se agregan cuando tengan comandos reales.

-- ============================================================
-- ADMIN INICIAL — completar a mano y descomentar
-- ------------------------------------------------------------
-- 1) Conseguí tu telegram_id: escribile a @userinfobot en Telegram.
-- 2) Reemplazá 123456789 por ese número (y el nombre si querés) y descomentá.
-- 3) Corré de nuevo. Queda como admin y en TODAS las áreas.
--
-- with nuevo as (
--   insert into bot.usuarios (telegram_id, nombre, activo, es_admin)
--   values (123456789, 'Renzo', true, true)
--   on conflict (telegram_id) do update set es_admin = true, activo = true
--   returning id
-- )
-- insert into bot.usuario_area (usuario_id, area_id)
-- select nuevo.id, bot.areas.id from nuevo, bot.areas
-- on conflict do nothing;
-- ============================================================
