-- ============================================================
-- Migración 040 — Área Retiros: quien mantiene la PLANILLA RETIRA y la sube por
-- /carga para que alimente la pantalla /tv_recepcion del sitio.
--
-- Va como área propia y no dentro de 'deposito' a propósito: el que carga la
-- planilla no tiene por qué acceder al resto de los comandos de Depósito, y al
-- revés, Depósito no tiene por qué poder pisar la agenda de retiros.
--
-- La tabla de datos (public.retiros) NO se crea acá: vive en el schema public
-- junto con lo que lee el sitio, y su SQL está en el repo de la web
-- (db/retiros.sql), igual que public.ingresos.
--
-- Idempotente.
-- ============================================================

insert into bot.areas (codigo, nombre) values
  ('retiros', 'Retiros')
on conflict (codigo) do nothing;
