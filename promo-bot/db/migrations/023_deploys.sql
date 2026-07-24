-- ============================================================
-- Migración 023 — Log de DEPLOYS anunciados
--   Al arrancar, el bot avisa a los admins "Deploy terminado: commit X por Y". Para NO
--   re-anunciar cuando Railway simplemente reinicia el MISMO commit (crash, mantenimiento),
--   se guarda acá el último commit anunciado: solo se avisa si el SHA es distinto al último.
--   De paso queda un historial de deploys (auditoría).
-- Idempotente.
-- ============================================================

create table if not exists bot.deploys (
  id           bigint      generated always as identity primary key,
  sha          text        not null,             -- RAILWAY_GIT_COMMIT_SHA
  autor        text,                             -- RAILWAY_GIT_AUTHOR
  mensaje      text,                             -- primera línea del commit
  anunciado_en timestamptz not null default now()
);

create index if not exists deploys_id_desc_idx on bot.deploys (id desc);
