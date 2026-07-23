-- ============================================================
-- Migración 018 — Caja Central: resultado de la conciliación de MP (/mp)
--   Una fila por DÍA con cómo salió el control de Mercado Pago: veredicto,
--   totales, diferencia y las operaciones que no cerraron (con su rastreo).
--   Lo consume el RESUMEN SEMANAL que se manda a los admins + Caja Central
--   los lunes (src/aviso-mp-semanal.js).
--
--   Re-correr /mp de un día PISA su fila (upsert por fecha+empresa): la última
--   corrida es la verdad, igual que /cierre.
-- Idempotente.
-- ============================================================

create table if not exists bot.mp_conciliacion (
  id                  bigint      generated always as identity primary key,
  fecha               date        not null,
  empresa             text        not null default 'HONRE',
  veredicto           text        not null,                 -- 'ok' | 'diferencias'
  fuente              text,                                 -- 'diario' | 'mayor' (con Diario hay rastreo)
  total_sistema       numeric,
  total_mp            numeric,
  diferencia          numeric,                              -- total_sistema − total_mp
  n_pares             integer     not null default 0,       -- apareadas 1 a 1
  n_aviso             integer     not null default 0,       -- apareadas con aviso menor (redondeo/hora)
  n_solo_mp           integer     not null default 0,       -- cobró MP y no está asentado
  n_solo_sistema      integer     not null default 0,       -- asentado y MP no lo tiene
  n_con_contrapartida integer     not null default 0,       -- huérfanas cuyo importe apareció en otra cuenta
  -- Las huérfanas con su rastreo, para que el resumen semanal muestre el detalle sin recalcular.
  -- [{ lado:'mp'|'sistema', hora, importe, ref, contrapartida:{cuentas, concepto, usuario}|null }]
  huerfanas           jsonb       not null default '[]'::jsonb,
  generado_por        bigint      references bot.usuarios(id),
  generado_en         timestamptz not null default now(),
  unique (fecha, empresa)
);

create index if not exists mp_conciliacion_fecha_idx on bot.mp_conciliacion (fecha);
