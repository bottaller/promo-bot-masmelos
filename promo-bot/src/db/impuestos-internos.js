// Acceso a datos del maestro de impuestos internos (bot.impuestos_internos, ver /actimpint).
const { pool } = require('./pool');

// Reemplaza la tabla entera (mismo criterio que /actartic con bot.articulos): los impuestos
// internos cambian pocas veces, y un artículo que dejó de tener impuesto interno no debe
// quedar con un monto viejo dando vueltas.
async function reemplazarImpuestosInternos(impuestos) {
  const porCodigo = new Map();
  for (const i of impuestos) porCodigo.set(i.codigo, i);
  const lista = [...porCodigo.values()];

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from bot.impuestos_internos');
    if (lista.length) {
      const codigos = lista.map((i) => i.codigo);
      const montos = lista.map((i) => i.monto);
      await client.query(
        `insert into bot.impuestos_internos (codigo, monto)
         select * from unnest($1::text[], $2::numeric[])`,
        [codigos, montos]
      );
    }
    await client.query('commit');
    return lista.length;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// Mapa código -> monto, para el cálculo del .txt de Sigma (lib/promoprecios-sigma.js).
async function mapaImpuestosInternos() {
  const { rows } = await pool.query('select codigo, monto from bot.impuestos_internos');
  const mapa = new Map();
  for (const r of rows) mapa.set(r.codigo, Number(r.monto));
  return mapa;
}

async function contarImpuestosInternos() {
  const { rows } = await pool.query('select count(*)::int as total from bot.impuestos_internos');
  return rows[0].total;
}

module.exports = { reemplazarImpuestosInternos, mapaImpuestosInternos, contarImpuestosInternos };
