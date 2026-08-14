-- ============================================================
-- Migración 041 — /arqueobanco pasa de comparar "día contra día" a un ACUMULADO DEL MES: cada
-- extracto bancario y cada Mayor/Diario que se sube queda guardado renglón por renglón, así un
-- cobro que el banco acredita hoy pero Sigma asienta recién unos días después se matchea solo en
-- cuanto llega el Mayor más nuevo, sin volver a subir nada de lo viejo.
--
-- Dos tablas, una por lado del apareo (mismo motor conciliacion-mp.js, ver src/db/arqueo-banco.js):
--   - arqueo_banco_movimientos: los renglones del extracto bancario (Santander/Supervielle).
--   - arqueo_banco_mayor:       los renglones del Mayor/Diario de Sigma de esas dos cuentas.
-- `fecha`/`ingreso` van como TEXTO (AAAA-MM-DD / ts canónico), no date/timestamp: se leen de
-- vuelta para armar los objetos que arma conciliarMP, y un date/timestamp de Postgres se
-- reconstruye como Date de JS corrido por el TZ del proceso (ver la "regla de oro" en
-- src/lib/fechas.js) — el texto evita ese problema de raíz.
--
-- Dedup por clave natural (ON CONFLICT DO NOTHING): re-subir un extracto o un Mayor que se pisa
-- con uno ya cargado no duplica filas. `ocurrencia` es el desempate: la posición (1, 2, 3…) de
-- esta fila entre las que comparten la MISMA clave DENTRO del archivo que se está subiendo, en
-- el orden en que aparecen. Sin esto, DOS filas genuinamente distintas con los mismos valores
-- —validado con datos reales: dos comisiones de $210 el mismo día, o un cliente (PRESARAS HNOS.)
-- con dos recibos de $3.000.000 idénticos el 29/07— colisionarían en la misma clave y se perdería
-- una de las dos. Re-subir el MISMO archivo reproduce el mismo orden → mismas `ocurrencia` → el
-- dedup de siempre sigue funcionando.
--
-- El apareo se acota al MES CALENDARIO actual (Argentina): no se compara contra meses anteriores.
-- Idempotente.
-- ============================================================

create table if not exists bot.arqueo_banco_movimientos (
  id             bigint  generated always as identity primary key,
  plataforma     text    not null,                 -- 'santander' | 'supervielle' (codigo de lib/plataformas.js)
  fecha          text    not null,                 -- 'AAAA-MM-DD'
  monto          numeric(14,2) not null,
  sentido        text    not null,                 -- 'credito' | 'debito'
  concepto       text    not null default '',
  referencia     text    not null default '',
  ocurrencia     integer not null default 1,        -- desempate de filas idénticas dentro del mismo archivo
  estado         text    not null default 'pendiente',   -- 'pendiente' | 'matcheado'
  matcheado_con  bigint,                            -- id de arqueo_banco_mayor cuando estado='matcheado'
  nombre_archivo text,
  usuario_id     bigint references bot.usuarios(id),
  creado_en      timestamptz not null default now(),
  matcheado_en   timestamptz,
  unique (plataforma, fecha, monto, sentido, concepto, referencia, ocurrencia)
);

create table if not exists bot.arqueo_banco_mayor (
  id             bigint  generated always as identity primary key,
  cuenta_id      bigint  not null,                  -- 111201014 (Santander) | 111201015 (Supervielle)
  asiento        integer not null,
  fecha          text    not null,                  -- 'AAAA-MM-DD'
  debe           numeric(14,2) not null default 0,
  haber          numeric(14,2) not null default 0,
  comprobante    text    not null default '',
  cliente        text    not null default '',
  usuario        text    not null default '',
  ingreso        text,                              -- ts canónico 'AAAA-MM-DD HH:MM:SS' (hora de pared)
  ocurrencia     integer not null default 1,        -- desempate de filas idénticas dentro del mismo archivo
  estado         text    not null default 'pendiente',
  matcheado_con  bigint,                             -- id de arqueo_banco_movimientos cuando estado='matcheado'
  nombre_archivo text,
  usuario_id     bigint references bot.usuarios(id),
  creado_en      timestamptz not null default now(),
  matcheado_en   timestamptz,
  unique (cuenta_id, asiento, fecha, debe, haber, comprobante, ocurrencia)
);

create index if not exists arqueo_banco_movimientos_pendientes_idx
  on bot.arqueo_banco_movimientos (plataforma, fecha) where estado = 'pendiente';
create index if not exists arqueo_banco_mayor_pendientes_idx
  on bot.arqueo_banco_mayor (cuenta_id, fecha) where estado = 'pendiente';
