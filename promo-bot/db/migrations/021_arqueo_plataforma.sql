-- ============================================================
-- Migración 021 — El arqueo de cobros pasa a ser MULTI-PLATAFORMA
--   Hasta acá bot.mp_conciliacion guardaba una fila por día, asumiendo que la única
--   plataforma era Mercado Pago. Al sumar Talo (cuenta 42210108) esa clave se queda
--   corta: el arqueo de Talo de un día PISARÍA el de MP del mismo día.
--
--   Se agrega `plataforma` y pasa a formar parte de la clave. Lo ya guardado es de
--   Mercado Pago, así que el default 'mp' deja la historia consistente sin tocarla.
-- Idempotente.
-- ============================================================

alter table bot.mp_conciliacion
  add column if not exists plataforma text not null default 'mp';   -- 'mp' | 'talo' | ...

-- La clave vieja (fecha, empresa) permitía UNA sola plataforma por día. La nueva las separa.
alter table bot.mp_conciliacion drop constraint if exists mp_conciliacion_fecha_empresa_key;
create unique index if not exists mp_conciliacion_dia_plataforma_uidx
  on bot.mp_conciliacion (fecha, empresa, plataforma);

comment on column bot.mp_conciliacion.plataforma is
  'Plataforma de cobro arqueada (código de src/lib/plataformas.js): mp, talo, …';
