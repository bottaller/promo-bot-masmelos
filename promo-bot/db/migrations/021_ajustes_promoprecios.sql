-- ============================================================
-- Migración 021 — /ajuste y /promoprecios (Calidad): dos flujos de archivos que le llegan al
-- DUEÑO del bot (OWNER_TELEGRAM_ID, no "admin" — puede haber varios admins reales) para revisar,
-- con reenvío en cadena a Compras, Marketing, Ventas y Depósito.
--
-- Roles nuevos: 'marketing', 'ventas' y 'compras_promo'. compras_promo es un rol APARTE del
-- 'compras' general: si usáramos 'compras' acá, esto le llegaría a todo el equipo de compras en
-- vez de solo al responsable que el dueño designe con /usuarios agregar.
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('marketing', 'Marketing'),
  ('ventas', 'Ventas'),
  ('compras_promo', 'Compras (promo/precios)')
on conflict (codigo) do nothing;

create table if not exists bot.calidad_ajustes (
  id                    bigint      generated always as identity primary key,
  fecha                 timestamptz not null default now(),
  archivo_file_id       text        not null,
  archivo_nombre        text,
  usuario_id            bigint      references bot.usuarios(id),
  usuario_nombre        text,
  usuario_telegram_id   bigint      not null,   -- para poder avisarle a quien lo subió, sin join
  estado                text        not null default 'pendiente',  -- 'pendiente' | 'realizado'
  realizado_en          timestamptz
);
comment on table bot.calidad_ajustes is 'Archivos de ajuste que sube Calidad para que el dueño del bot los revise.';

create table if not exists bot.promoprecios (
  id                       bigint      generated always as identity primary key,
  fecha                    timestamptz not null default now(),
  archivo_file_id          text        not null,
  archivo_nombre           text,
  usuario_id               bigint      references bot.usuarios(id),
  usuario_nombre           text,
  usuario_telegram_id      bigint      not null,
  imagenes_requeridas      integer,               -- lo fija el dueño al validar
  validado_en              timestamptz,           -- el dueño validó el archivo
  compras_archivo_ok       boolean     not null default false,
  compras_archivo_ok_en    timestamptz,
  marketing_completado_en  timestamptz,           -- Marketing mandó las imágenes pedidas
  compras_imagenes_ok      boolean     not null default false,
  compras_imagenes_ok_en   timestamptz,
  admin_imagenes_ok        boolean     not null default false,
  admin_imagenes_ok_en     timestamptz,
  enviado_en               timestamptz            -- reenviado a Ventas y Depósito
);
comment on table bot.promoprecios is 'Ciclo de promociones y precios: archivo -> dueño valida -> Compras/Marketing -> imágenes -> Compras valida -> dueño valida -> Ventas/Depósito.';

create table if not exists bot.promoprecios_imagenes (
  id              bigint      generated always as identity primary key,
  promoprecio_id  bigint      not null references bot.promoprecios(id),
  file_id         text        not null,
  orden           integer     not null,
  subido_en       timestamptz not null default now()
);
create index if not exists idx_promoprecios_imagenes_promo on bot.promoprecios_imagenes (promoprecio_id);
