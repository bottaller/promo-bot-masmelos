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

    // ── Lo que ya no está en la planilla ────────────────────────────────────
    //
    // Un turno que desaparece del Excel suele ser un pedido dado de baja, y hay
    // que sacarlo de la pantalla. Pero borrar es la única operación de acá que no
    // se puede deshacer, así que va con dos frenos que costaron caro:
    //
    // FRENO 1 — una planilla que no aporta NINGÚN turno no borra nada. Antes el
    // `if (filas.length)` de arriba envolvía solo al INSERT y este DELETE corría
    // igual: reenviar por error una versión vieja del archivo (dos .xlsx con el
    // mismo nombre en la misma carpeta, algo que pasa) parseaba cero filas pero
    // igual traía los días armados en `diasVistos`, y vaciaba el día entero. Con
    // la planilla real de prueba eso borraba 28 pedidos, 16 de ellos ya listos.
    //
    // FRENO 2 — no se borra lo que alguien ya tocó. Si el pedido está marcado
    // (desde el panel, o con un estado que la planilla ya había avanzado), se
    // deja y se informa: que un pedido marcado listo desaparezca del Excel es
    // raro y lo tiene que mirar una persona, no resolverlo un DELETE en silencio.
    // Acá `origen` deja de ser decorativo y pasa a decidir de verdad.
    let borrados = 0;
    let conservados = [];
    if (filas.length) {
      const condicionSobra = `
        r.fecha = any($1::date[])
          and not exists (
            select 1 from unnest($2::date[], $3::time[]) as v(fecha, turno)
             where v.fecha = r.fecha and v.turno = r.turno
          )`;
      const args = [dias, filas.map((f) => f.fecha), filas.map((f) => f.turno)];

      // Intocados: nadie los marcó nunca. Esos sí se van.
      const sinTocar = `r.origen = 'planilla' and r.prep is null and r.estado_final is null`;

      const { rows: quedan } = await client.query(
        `select to_char(r.fecha, 'YYYY-MM-DD') as fecha, to_char(r.turno, 'HH24:MI') as turno,
                r.codigo_cliente, r.cliente, r.prep, r.estado_final, r.origen
           from public.retiros r
          where ${condicionSobra} and not (${sinTocar})
          order by r.fecha, r.turno`,
        args
      );
      conservados = quedan;

      const res = await client.query(
        `delete from public.retiros r where ${condicionSobra} and ${sinTocar}`,
        args
      );
      borrados = res.rowCount;
    }

    // El resumen sale DESPUÉS del merge, no de lo que traía el Excel: es lo que
    // realmente va a mostrar la pantalla, que es lo que el bot tiene que contarle
    // a quien subió el archivo.
    const { rows: porDia } = await client.query(
      `select to_char(fecha, 'YYYY-MM-DD') as fecha,
              count(*)::int as total,
              count(*) filter (
                where prep = 'listo' and estado_final is distinct from 'retirado'
              )::int as listos,
              count(*) filter (
                where prep in ('preparando', 'faltante') and estado_final is distinct from 'retirado'
              )::int as preparando,
              count(*) filter (where estado_final = 'retirado')::int as retirados,
              -- Todo lo que no cayó en los tres de arriba. Se calcula por descarte a
              -- propósito: antes 'faltante' y 'agendado' no entraban en ningún
              -- contador y los números del mensaje no cerraban con el total.
              count(*) filter (
                where estado_final is distinct from 'retirado'
                  and (prep is null or prep in ('agendado'))
              )::int as sin_estado
         from public.retiros
        where fecha = any($1::date[])
        group by fecha
        order by fecha`,
      [dias]
    );

    await client.query('commit');
    return { guardados: filas.length, borrados, conservados, porDia };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { registrarRetiros };
