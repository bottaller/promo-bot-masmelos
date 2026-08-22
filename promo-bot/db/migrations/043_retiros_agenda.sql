-- ============================================================
-- Migración 043 — La PLANILLA RETIRA dejó de tener una sola agenda.
--
-- Desde agosto 2026 la planilla trae, además de la hoja del mes, hojas de NEGOCIOS
-- ("AGOSTO-NEGOCIOS", con una columna "NEGOCIO" que dice p.ej. "NEGOCIO PIÑATA").
-- Las dos agendas usan LOS MISMOS 16 turnos de 09:00 a 16:30, así que (fecha, turno)
-- dejó de identificar un pedido: el lunes 24/08 hay dos pedidos a las 09:00, uno de
-- cada agenda.
--
-- Con la clave vieja uno pisaba al otro y el cliente de la agenda regular
-- desaparecía de la pantalla. Se agrega `agenda` y pasa a ser parte de la clave.
--
-- `agenda` es NOT NULL con default a propósito: en Postgres dos NULL no se
-- consideran iguales, así que una columna nullable en un UNIQUE dejaría entrar
-- duplicados justo en la agenda regular, que es la que más pedidos tiene.
--
-- Idempotente.
-- ============================================================

alter table public.retiros
  add column if not exists agenda text not null default 'general';

-- Se reemplaza la clave: antes (fecha, turno), ahora con la agenda adentro.
alter table public.retiros drop constraint if exists retiros_turno_unico;
alter table public.retiros
  add constraint retiros_turno_unico unique (fecha, turno, agenda);

comment on column public.retiros.agenda is
  'Qué agenda de la planilla trajo el turno: "general" la hoja del mes, o el nombre del negocio (o de la hoja) para las agendas paralelas. Forma parte de la clave junto con fecha y turno.';
