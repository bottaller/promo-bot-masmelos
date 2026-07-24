-- ============================================================
-- Migración 022 — Liquidaciones de plataforma EN ESPERA (para el arqueo de las 08:00)
--   El admin sube de noche (con /carga) las liquidaciones de MP y Talo del día. NO se
--   concilian en el momento: quedan acá en espera hasta que el barrido de las 08:00
--   (src/entrega-arqueo.js) las cruza contra el libro, arma los PDFs y los manda a
--   Tesorería + Caja Central. Procesado el día, sus filas se borran.
--
--   A diferencia del libro (bot.libro_diario, permanente), estas liquidaciones son
--   EFÍMERAS: solo sirven para el cálculo del día. Lo que queda archivado es el RESULTADO
--   del arqueo (bot.mp_conciliacion), no el archivo crudo.
--
--   Re-subir la liquidación de una plataforma para un día la PISA (upsert por
--   fecha+empresa+plataforma): la última subida es la que vale.
-- Idempotente.
-- ============================================================

create table if not exists bot.liquidaciones_pendientes (
  id             bigint      generated always as identity primary key,
  fecha          date        not null,             -- el DÍA que cubre la liquidación (se deduce de ella)
  empresa        text        not null default 'HONRE',
  plataforma     text        not null,             -- 'mp' | 'talo' (codigo de lib/plataformas.js)
  archivo        bytea       not null,             -- el .xlsx tal cual lo bajó del panel de la plataforma
  nombre_archivo text        not null default '',
  bytes          integer     not null default 0,
  n_operaciones  integer     not null default 0,   -- cuántas operaciones trajo (para el mensaje de /carga)
  cargado_por    bigint      references bot.usuarios(id),
  cargado_en     timestamptz not null default now(),
  unique (fecha, empresa, plataforma)
);

create index if not exists liquidaciones_pendientes_fecha_idx on bot.liquidaciones_pendientes (empresa, fecha);
