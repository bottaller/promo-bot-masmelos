// Acceso a datos de faltantes / reposición (bot.faltantes): Ventas y Depósito avisan que un
// producto falta o queda poco (/falta); Compras baja el consolidado de las últimas 2 semanas
// (/faltantes). Ver también db/deposito.js (crearInforme), del que sale el molde.
const { pool } = require('./pool');

// Rango Unicode de marcas diacríticas combinantes (acentos/ñ sueltos tras normalize('NFD')).
// Construido por código de caracter (no literal) para no depender del encoding del archivo.
const RANGO_DIACRITICOS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

// Normaliza un nombre para dedupear cuando el reporte NO se resolvió al maestro: minúsculas,
// sin acentos/ñ, sin signos, espacios colapsados. Así "Coca 500" y "coca  500ml" caen juntas.
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(RANGO_DIACRITICOS, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Guarda un reporte de faltante. `articuloCodigo` null si no se resolvió al maestro. Devuelve el id.
async function registrarFaltante({ articuloCodigo, productoTexto, origenArea, situacion, nota, usuarioId, usuarioNombre }) {
  const { rows } = await pool.query(
    `insert into bot.faltantes
       (articulo_codigo, producto_texto, producto_norm, origen_area, situacion, nota, usuario_id, usuario_nombre)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id`,
    [
      articuloCodigo ?? null,
      productoTexto,
      normalizar(productoTexto),
      origenArea,
      situacion,
      nota ?? null,
      usuarioId ?? null,
      usuarioNombre ?? null,
    ]
  );
  return rows[0].id;
}

// Consolidado de los últimos `dias` (default 14): UNA fila por producto. Dedup por
// articulo_codigo si se resolvió al maestro; si no, por producto_norm. Junta las áreas que lo
// reportaron, las situaciones, las notas, el conteo de avisos y la última fecha. Orden: lo más
// grave arriba (falta > queda poco > se vende mucho), después por cantidad de avisos.
async function faltantesConsolidados(dias = 14) {
  const { rows } = await pool.query(
    `select
       coalesce(articulo_codigo, 'txt:' || producto_norm)                       as clave,
       max(articulo_codigo)                                                     as articulo_codigo,
       (array_agg(producto_texto order by fecha desc))[1]                       as producto,
       count(*)::int                                                            as avisos,
       max(fecha)                                                               as ultima,
       array_agg(distinct origen_area)                                          as origenes,
       array_agg(distinct situacion)                                            as situaciones,
       array_remove(array_agg(distinct nullif(btrim(coalesce(nota, '')), '')), null) as notas
     from bot.faltantes
     where fecha >= now() - make_interval(days => $1::int)
     group by coalesce(articulo_codigo, 'txt:' || producto_norm)
     order by
       (case when bool_or(situacion = 'falta') then 0
             when bool_or(situacion = 'poco')  then 1
             else 2 end),
       count(*) desc,
       max(fecha) desc`,
    [dias]
  );
  return rows;
}

module.exports = { registrarFaltante, faltantesConsolidados, normalizar };
