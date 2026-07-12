-- ============================================================
-- Migración 011 — Tesorería: log de auditoría
--   Registra CADA acción del sistema de control (cierre diario, control semanal/mensual,
--   consulta de un cierre, cambio de saldos). Es el rastro para la dimensión de auditoría:
--   quién hizo qué, cuándo, sobre qué fecha, y un resumen del resultado.
--   Append-only (no se edita ni borra): eso es lo que lo hace auditable.
-- Idempotente.
-- ============================================================

create table if not exists bot.tesoreria_auditoria (
  id           bigint      generated always as identity primary key,
  creado_en    timestamptz not null default now(),
  usuario_id   bigint      references bot.usuarios(id),
  usuario_txt  text,                                  -- nombre/handle por si el usuario no está en la tabla
  accion       text        not null,                  -- 'cierre_diario' | 'control_semanal' | 'control_mensual' | 'reporte_cierre' | 'cambio_saldos'
  empresa      text        not null default 'HONRE',
  fecha        date,                                  -- fecha del cierre/control al que refiere
  periodo      text,                                  -- rango para semanal/mensual (ej. '01/07 → 10/07')
  nivel        text,                                  -- peor nivel del resultado: 'ok'|'timing'|'revisar'|'alerta'
  detalle      jsonb                                  -- resumen (conteos, cuentas en alerta, etc.)
);

create index if not exists tesoreria_auditoria_fecha_idx on bot.tesoreria_auditoria (fecha);
create index if not exists tesoreria_auditoria_creado_idx on bot.tesoreria_auditoria (creado_en);
