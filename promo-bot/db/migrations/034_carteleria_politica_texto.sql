-- ============================================================
-- Migración 034 — /carteleria: para tipo_precio='politica', Depósito escribe
-- cuál es la política (ej. "3x2", "2da unidad al 50%") y se dibuja en el
-- cartel en vez del texto genérico fijo de la plantilla ("DTO. X VOL" /
-- "DESCUENTO POR VOLUMEN"). Idempotente.
-- ============================================================

alter table bot.carteleria
  add column if not exists politica_texto text;
