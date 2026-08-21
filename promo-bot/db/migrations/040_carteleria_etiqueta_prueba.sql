-- /carteleria_marketing (ver scenes/carteleria.js) reusa el mecanismo de es_prueba (todo el
-- circuito vuelve a quien lo pidió en vez de salir a Marketing/Compras/dueño reales) pero sin
-- mostrar el texto "🧪 PRUEBA" -- a diferencia de /carteleria_prueba, que sí lo muestra.
-- etiqueta_prueba controla solo eso: si mostrar o no ese texto. Default true = comportamiento
-- actual de /carteleria_prueba sin cambios.
alter table bot.carteleria
  add column if not exists etiqueta_prueba boolean not null default true;
