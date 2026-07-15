-- ============================================================
-- Migración 013 — Tesorería: /cierre con corte por HORA
--   El tesorero cuenta los saldos a una hora (ej. 16:20) pero el negocio cierra
--   más tarde (17:00). Reconciliar por DÍA metía los movimientos de esa última
--   hora en el cálculo aunque el conteo no los vio → diferencias falsas.
--   Se pasa a reconciliar por VENTANA de tiempo (conteo_anterior, conteo_hoy].
--
--   Dos columnas de "reloj de pared" (timestamp SIN zona = hora argentina literal):
--     - tesoreria_saldos.contado_en  → momento del conteo (límite de la ventana).
--     - tesoreria_movimientos.ingreso → momento de cada movimiento (columna
--       "Ingreso" del libro de Sigma; antes se descartaba).
--   Se comparan SIEMPRE como ::timestamp en SQL, nunca como Date de JS.
--
--   Compatibilidad: el modelo por día es el caso particular "contar a las 23:59:59".
--   Por eso los datos viejos (sin hora) se backfillean a 23:59:59 y se comportan igual.
--
--   IMPORTANTE: aplicar en Supabase ANTES de mergear dev→main (igual que 008-011).
-- Idempotente.
-- ============================================================

-- --- Saldos: momento del conteo -------------------------------------------------
alter table bot.tesoreria_saldos
  add column if not exists contado_en timestamp;   -- reloj de pared ART; NULL = fila vieja / sin hora
-- Nota: NO se pone NOT NULL ni DEFAULT. El lector coalesce a (fecha + 23:59:59) para
-- distinguir "cargó sin hora" (avisar) de "23:59 real", sin romper filas ya cargadas.

-- --- Movimientos: hora de cada movimiento + grano fino --------------------------
alter table bot.tesoreria_movimientos
  add column if not exists ingreso timestamp;       -- reloj de pared ART (columna "Ingreso" del libro)

-- El grano pasa de (fecha, empresa, cuenta_id) a (fecha, empresa, cuenta_id, ingreso):
-- una misma cuenta tiene movimientos a distintas horas el mismo día, y eso es justo lo
-- que permite partir el día por el momento del conteo. Hay que soltar el unique viejo
-- (auto-nombrado en 009) antes de poder insertar varias filas por cuenta_id/día.
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'bot.tesoreria_movimientos'::regclass
     and contype = 'u'
     and array_length(conkey, 1) = 3        -- el viejo (fecha, empresa, cuenta_id); es el único unique de la tabla
   limit 1;
  if c is not null then
    execute format('alter table bot.tesoreria_movimientos drop constraint %I', c);
  end if;
end $$;

-- Backfill de filas viejas (grano diario, sin hora) → fin del día = comportamiento por día.
update bot.tesoreria_movimientos
   set ingreso = fecha + time '23:59:59'
 where ingreso is null;

-- Nuevo grano: una fila por (fecha, empresa, cuenta_id, ingreso). Los renglones del mismo
-- cuenta_id con el MISMO ingreso se suman (lossless: caen siempre en la misma ventana).
create unique index if not exists tesoreria_movimientos_grano_hora_uidx
  on bot.tesoreria_movimientos (fecha, empresa, cuenta_id, ingreso);

-- Índice para el filtro de ventana (empresa + ingreso).
create index if not exists tesoreria_movimientos_ingreso_idx
  on bot.tesoreria_movimientos (empresa, ingreso);
