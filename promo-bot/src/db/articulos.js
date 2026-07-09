// Acceso a datos del maestro de artículos (bot.articulos).
const { pool } = require('./pool');

const COLS = ['codigo', 'nombre', 'ean_unidad', 'ean_display', 'ean_bulto', 'rubro_cod', 'rubro', 'proveedor_cod', 'proveedor'];

// Inserta/actualiza artículos en lote. Devuelve cuántos se guardaron/actualizaron.
async function upsertArticulos(articulos) {
  // Dedupe por codigo (gana el último), para no romper el ON CONFLICT dentro del mismo insert.
  const porCodigo = new Map();
  for (const a of articulos) porCodigo.set(a.codigo, a);
  const lista = [...porCodigo.values()];
  if (lista.length === 0) return 0;

  const CHUNK = 2000;
  let total = 0;
  for (let i = 0; i < lista.length; i += CHUNK) {
    const slice = lista.slice(i, i + CHUNK);
    const arrays = COLS.map((c) => slice.map((a) => a[c] ?? null));
    const res = await pool.query(
      `insert into bot.articulos (codigo, nombre, ean_unidad, ean_display, ean_bulto, rubro_cod, rubro, proveedor_cod, proveedor)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
       on conflict (codigo) do update set
         nombre = excluded.nombre,
         ean_unidad = excluded.ean_unidad,
         ean_display = excluded.ean_display,
         ean_bulto = excluded.ean_bulto,
         rubro_cod = excluded.rubro_cod,
         rubro = excluded.rubro,
         proveedor_cod = excluded.proveedor_cod,
         proveedor = excluded.proveedor,
         actualizado_en = now()`,
      arrays
    );
    total += res.rowCount;
  }
  return total;
}

// Busca artículos cuyo EAN (unidad, display o bulto) empiece con el texto dado.
// Sirve para EAN exacto (prefijo completo) o primeros N dígitos.
async function buscarPorEan(prefijo, limite = 10) {
  const patron = prefijo + '%';
  const { rows } = await pool.query(
    `select codigo, nombre, ean_unidad, ean_display, ean_bulto, rubro, proveedor
       from bot.articulos
      where ean_unidad like $1 or ean_display like $1 or ean_bulto like $1
      order by nombre
      limit $2`,
    [patron, limite]
  );
  return rows;
}

// Búsqueda flexible para /alta: por EAN (prefijo), código exacto o nombre (contiene).
async function buscarArticulos(texto, limite = 10) {
  const { rows } = await pool.query(
    `select codigo, nombre, ean_unidad, ean_display, ean_bulto, rubro, proveedor
       from bot.articulos
      where ean_unidad like $1 || '%' or ean_display like $1 || '%' or ean_bulto like $1 || '%'
         or codigo = $1 or nombre ilike '%' || $1 || '%'
      order by nombre
      limit $2`,
    [texto, limite]
  );
  return rows;
}

async function contarArticulos() {
  const { rows } = await pool.query('select count(*)::int as n from bot.articulos');
  return rows[0].n;
}

module.exports = { upsertArticulos, buscarPorEan, buscarArticulos, contarArticulos };
