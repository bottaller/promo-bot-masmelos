-- ============================================================
-- Migración 035 — /carteleria: cuando el matcheo automático de fotos del
-- catálogo queda ambiguo entre 2-4 candidatas igual de buenas, en vez de
-- adivinar le mandamos a Marketing las opciones (cada una ya renderizada en
-- su propio cartel) para que elija cuál es la correcta. `disenos_candidatos`
-- guarda los file_id de Telegram de esas opciones mientras está pendiente de
-- elegir; se vacía (null) apenas se resuelve. Idempotente.
-- ============================================================

alter table bot.carteleria
  add column if not exists disenos_candidatos jsonb;
