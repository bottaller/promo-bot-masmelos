-- ============================================================
-- Migración 038 — Maestro de impuestos internos (export de Sigma, columna "Imp.Interno"),
-- para calcular el precio neto que se sube al .txt de "precio al piso" de Sigma
-- (ver lib/promoprecios-sigma.js). Se reemplaza entero cada vez que se sube un Excel
-- nuevo con /actimpint — mismo patrón que bot.articulos (/actartic).
-- Idempotente.
-- ============================================================

create table if not exists bot.impuestos_internos (
  codigo         text        primary key,
  monto          numeric     not null,
  actualizado_en timestamptz not null default now()
);
comment on table bot.impuestos_internos is 'Códigos de artículo con impuesto interno (Sigma) y su monto — solo están los que tienen impuesto interno.';
