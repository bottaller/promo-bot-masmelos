-- ============================================================
-- Migración 017 — Cierres PENDIENTES (cierre en dos tiempos)
--   El /cierre se parte en dos momentos:
--     1. El tesorero carga los SALDOS a la hora que cuenta (tarde). El cierre queda acá,
--        pendiente: todavía no hay con qué conciliar.
--     2. El admin carga el LIBRO de noche (/libro) → sus movimientos entran a
--        bot.tesoreria_movimientos (ya pasa hoy).
--     3. A las 08:00 ART un barrido toma cada pendiente, concilia contra el libro cargado
--        y le entrega el reporte al tesorero + admins. Si todavía falta el libro, avisa.
--
--   Esta tabla es la LISTA DE ESPERA: un renglón por cierre cuyos saldos están cargados
--   pero cuyo reporte no se entregó. Se borra cuando el barrido lo completa y entrega.
--   Persiste (no en memoria) porque entre los saldos de la tarde y el libro de la noche
--   Railway puede reiniciar (sus deploys son frecuentes).
--
--   NO duplica datos del cierre: los saldos ya están en bot.tesoreria_saldos y la
--   conciliación resultante va a bot.tesoreria_conciliacion como siempre. Acá solo se
--   guarda A QUIÉN entregarle (el tesorero que cargó) y de qué día.
-- Idempotente.
-- ============================================================

create table if not exists bot.cierres_pendientes (
  id           bigint      generated always as identity primary key,
  fecha        date        not null,             -- la jornada del cierre (día de los saldos)
  empresa      text        not null default 'HONRE',
  telegram_id  bigint      not null,             -- el tesorero que cargó los saldos (a quién entregar)
  usuario_id   bigint      references bot.usuarios(id),
  usuario_txt  text,                             -- nombre, para atribuir la conciliación y el reporte
  creado_en    timestamptz not null default now(),
  -- Re-cargar los saldos de un día ya pendiente actualiza el renglón (no duplica): el barrido
  -- vuelve a conciliar con los saldos nuevos.
  unique (fecha, empresa)
);

-- El barrido lista los pendientes de una empresa ordenados por día.
create index if not exists cierres_pendientes_barrido_idx on bot.cierres_pendientes (empresa, fecha);
