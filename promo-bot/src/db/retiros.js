// Guarda los turnos de retiro que salen de la PLANILLA RETIRA. Los lee la
// pantalla /tv_recepcion del sitio (tabla public.retiros, ver db/retiros.sql en
// el repo de la web).
//
// LA REGLA QUE IMPORTA: la planilla manda sobre la AGENDA (qué pedido hay, de qué
// cliente y a qué hora) pero NO puede retroceder un estado. El depósito marca
// "listo" desde el panel del sitio en el momento, y la planilla se actualiza más
// tarde: si una subida posterior pisara ese estado con lo que todavía dice el
// Excel, un pedido que el cliente YA vio como listo volvería a "en preparación".
// Esa es la forma más rápida de que la gente deje de mirar la pantalla.
//
// Entonces, al reimportar:
//   - celda vacía en el Excel  → no toca el estado que ya había,
//   - estado que ADELANTA      → se aplica,
//   - estado que RETROCEDE     → se ignora (para corregir de verdad está el panel).
// El orden de avance lo definen retiros_rango_prep / retiros_rango_final en el SQL.
const { pool } = require('./pool');

const COLUMNAS = [
  'fecha', 'turno', 'codigo_cliente', 'cliente', 'n_pedido',
  'ordenes', 'canal', 'bultos', 'prep', 'estado_final',
];

/**
 * Reemplaza los días que trae la planilla.
 *
 * @param {Array}  filas       lo que devuelve parsearRetiros().filas
 * @param {string[]} diasVistos días armados en la planilla (incluidos los vacíos):
 *                              lo que no esté en `filas` para esos días se borra,
 *                              así un pedido dado de baja desaparece de la pantalla.
 * @returns {{guardados: number, borrados: number, porDia: Array}}
 */
async function registrarRetiros({ filas = [], diasVistos = [] }) {
  const dias = diasVistos.length
    ? [...new Set(diasVistos)]
    : [...new Set(filas.map((f) => f.fecha))];
  if (!dias.length) return { guardados: 0, borrados: 0, porDia: [] };

  const client = await pool.connect();
  try {
    await client.query('begin');

    if (filas.length) {
      const params = [];
      const values = filas.map((f) => {
        const base = params.length;
        params.push(
          f.fecha, f.turno, f.codigo_cliente, f.cliente ?? null, f.n_pedido ?? null,
          f.ordenes ?? [], f.canal, f.bultos ?? null, f.prep ?? null, f.estado_final ?? null
        );
        return `($${base + 1}::date, $${base + 2}::time, $${base + 3}, $${base + 4}, $${base + 5}::int,
                 $${base + 6}::text[], $${base + 7}, $${base + 8}::int, $${base + 9}, $${base + 10})`;
      }).join(',');

      await client.query(
        `insert into public.retiros (${COLUMNAS.join(', ')})
         values ${values}
         on conflict (fecha, turno) do update set
           codigo_cliente = excluded.codigo_cliente,
           cliente        = excluded.cliente,
           n_pedido       = excluded.n_pedido,
           ordenes        = excluded.ordenes,
           canal          = excluded.canal,
           bultos         = excluded.bultos,
           -- el estado solo avanza (ver el comentario de arriba)
           prep = case
             when excluded.prep is null then retiros.prep
             when public.retiros_rango_prep(excluded.prep)
                  >= public.retiros_rango_prep(retiros.prep) then excluded.prep
             else retiros.prep end,
           estado_final = case
             when excluded.estado_final is null then retiros.estado_final
             when public.retiros_rango_final(excluded.estado_final)
                  >= public.retiros_rango_final(retiros.estado_final) then excluded.estado_final
             else retiros.estado_final end,
           -- queda registrado quién dejó el estado que se ve hoy
           origen = case
             when excluded.prep is not null
                  and public.retiros_rango_prep(excluded.prep)
                      >= public.retiros_rango_prep(retiros.prep) then 'planilla'
             else retiros.origen end,
           actualizado_en = now()`,
        params
      );
    }

    // Lo que ya no está en la planilla, para esos días, se va: es un pedido dado
    // de baja. Si un día quedó sin ningún turno cargado, se limpia entero.
    const { rowCount: borrados } = await client.query(
      `delete from public.retiros r
        where r.fecha = any($1::date[])
          and not exists (
            select 1 from unnest($2::date[], $3::time[]) as v(fecha, turno)
             where v.fecha = r.fecha and v.turno = r.turno
          )`,
      [dias, filas.map((f) => f.fecha), filas.map((f) => f.turno)]
    );

    // El resumen sale DESPUÉS del merge, no de lo que traía el Excel: es lo que
    // realmente va a mostrar la pantalla, que es lo que el bot tiene que contarle
    // a quien subió el archivo.
    const { rows: porDia } = await client.query(
      `select to_char(fecha, 'YYYY-MM-DD') as fecha,
              count(*)::int as total,
              count(*) filter (
                where prep = 'listo' and estado_final is distinct from 'retirado'
              )::int as listos,
              count(*) filter (where prep = 'preparando')::int as preparando,
              count(*) filter (where estado_final = 'retirado')::int as retirados,
              count(*) filter (where prep is null and estado_final is null)::int as sin_estado
         from public.retiros
        where fecha = any($1::date[])
        group by fecha
        order by fecha`,
      [dias]
    );

    await client.query('commit');
    return { guardados: filas.length, borrados, porDia };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { registrarRetiros };
