-- ============================================================
-- Migración 016 — Libro diario CENTRALIZADO
--   Hoy /cierre, /semanal, /mensual, /flujos y /mp piden CADA UNO el mismo Excel de
--   Sigma. Acá se carga UNA sola vez por día (comando /libro, admin) y todos lo consumen.
--
--   Se guarda el archivo CRUDO además de los movimientos parseados, porque no a todos
--   les alcanza con los datos:
--     - /flujos se lo pasa por RUTA al motor Python → necesita el .xlsx en sí,
--     - /mp lo parsea con OTRO parser (mayor-excel, acepta Diario o Mayor).
--   Los movimientos parseados NO se duplican acá: siguen yendo a bot.tesoreria_movimientos
--   (misma función guardarMovimientos que ya usa /cierre).
--
--   Peso: el export ronda los 280 KB por día (~100 MB al año). Va en la base y no en disco
--   porque el filesystem de Railway es efímero (se borra en cada deploy).
-- Idempotente.
-- ============================================================

create table if not exists bot.libro_diario (
  id             bigint      generated always as identity primary key,
  fecha          date        not null,             -- la JORNADA que cubre ("el libro del día")
  empresa        text        not null default 'HONRE',
  archivo        bytea       not null,             -- el .xlsx tal cual lo exportó Sigma
  nombre_archivo text        not null default '',
  bytes          integer     not null default 0,   -- tamaño, para monitorear el crecimiento
  desde          date        not null,             -- rango REAL del export (puede abarcar varios días)
  hasta          date        not null,
  filas          integer     not null default 0,   -- movimientos parseados que trajo
  cargado_por    bigint      references bot.usuarios(id),
  cargado_en     timestamptz not null default now(),
  -- Re-subir el libro de un día lo PISA: así se corrige un export incompleto sin duplicar.
  unique (fecha, empresa)
);

create index if not exists libro_diario_fecha_idx on bot.libro_diario (fecha);
-- Para resolver "¿qué libro cubre tal día?" cuando el export abarca un rango (13→17).
create index if not exists libro_diario_rango_idx on bot.libro_diario (empresa, desde, hasta);
