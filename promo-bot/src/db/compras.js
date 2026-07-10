// Acceso a datos de Compras: promociones por vencimiento en Postgres.
// Una fila de bot.compras_altas = una "camada" puesta en oferta.
//   fecha_baja IS NULL  -> sigue en góndola ("abierta")
//   fecha_baja NOT NULL -> cerrada, con cantidad_vendida / cantidad_remanente / motivo_baja
const { pool } = require('./pool');

// Escapa los comodines de LIKE/ILIKE (% _ \) para que el texto del usuario no sobre-matchee.
function escLike(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

// --- Altas ---

async function crearAlta(a) {
  const { rows } = await pool.query(
    `insert into bot.compras_altas
       (usuario_id, usuario_nombre, articulo_codigo, ean, producto, proveedor, lote, vencimiento, cantidad, motivo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id`,
    [
      a.usuarioId ?? null, a.usuarioNombre ?? null, a.articuloCodigo ?? null, a.ean ?? null,
      a.producto, a.proveedor ?? null, a.lote ?? null, a.vencimiento ?? null, a.cantidad, a.motivo ?? null,
    ]
  );
  return rows[0].id;
}

// Historial del producto: cuántas altas y cuántas unidades acumula (incluye la recién creada).
// Agrupa por código de artículo si lo hay; si no, por nombre.
async function historialProducto({ articuloCodigo, producto }) {
  const { rows } = await pool.query(
    `select count(*)::int as veces, coalesce(sum(cantidad),0)::float8 as unidades
       from bot.compras_altas
      where ($1::text is not null and articulo_codigo = $1)
         or ($1::text is null and lower(producto) = lower($2))`,
    [articuloCodigo ?? null, producto]
  );
  return { veces: rows[0].veces, unidades: rows[0].unidades };
}

// Altas ABIERTAS (camadas en góndola) que matchean el texto (código exacto, EAN por prefijo, o nombre contiene).
async function buscarAltasAbiertas(texto, limite = 15) {
  const like = escLike(texto);
  const { rows } = await pool.query(
    `select * from bot.compras_altas
      where fecha_baja is null
        and (articulo_codigo = $1 or ean like $2 or producto ilike $3)
      order by fecha
      limit $4`,
    [texto, like + '%', '%' + like + '%', limite]
  );
  return rows;
}

// Todas las altas en oferta actualmente, para el control de Calidad.
async function altasEnOferta() {
  const { rows } = await pool.query(
    `select * from bot.compras_altas where fecha_baja is null order by fecha`
  );
  return rows;
}

// Altas abiertas para el chequeo de avisos: trae el telegram_id del que la cargó
// y si ya se avisó "por vencer" hoy (lo decide SQL con current_date, para no depender de la zona horaria).
async function altasParaAviso() {
  const { rows } = await pool.query(
    `select ca.*, u.telegram_id as creador_telegram_id,
            (ca.aviso_vencimiento_fecha is null or ca.aviso_vencimiento_fecha < current_date) as puede_avisar_vencer
       from bot.compras_altas ca
       left join bot.usuarios u on u.id = ca.usuario_id
      where ca.fecha_baja is null`
  );
  return rows;
}

async function marcarAvisoPorVencer(altaIds) {
  if (!altaIds || altaIds.length === 0) return;
  await pool.query(
    `update bot.compras_altas set aviso_vencimiento_fecha = current_date where id = any($1::bigint[])`,
    [altaIds]
  );
}

async function marcarAvisoVencido(altaIds) {
  if (!altaIds || altaIds.length === 0) return;
  await pool.query(
    `update bot.compras_altas set aviso_vencido = true where id = any($1::bigint[])`,
    [altaIds]
  );
}

// --- Baja ---

// Cierra la camada: completa las columnas de resultado en la misma fila.
// Un solo UPDATE atómico; si ya estaba cerrada (doble tap / doble baja), rowCount = 0.
async function registrarBaja({ altaId, remanente, vendida, motivoBaja }) {
  const { rowCount } = await pool.query(
    `update bot.compras_altas
        set fecha_baja = now(),
            cantidad_vendida = $2,
            cantidad_remanente = $3,
            motivo_baja = $4
      where id = $1 and fecha_baja is null`,
    [altaId, vendida, remanente, motivoBaja ?? null]
  );
  return { ok: rowCount > 0 };
}

// --- Reportes ---

// Un remanente cuenta como "descartado" solo si el motivo indica descarte (no si volvió a góndola).
function esDescarte(motivo) {
  return typeof motivo === 'string' && /descart|vencid/i.test(motivo);
}

// Calcula métricas sobre un conjunto de altas (cada fila trae su propio resultado de baja).
// Efectividad y tasa de descarte usan como denominador SOLO las cerradas
// (las abiertas todavía no vendieron, no deben diluir el porcentaje).
function calcularMetricas(altas) {
  const cerradas = altas.filter((a) => a.fecha_baja);
  const abiertas = altas.filter((a) => !a.fecha_baja);
  const puestasTotal = altas.reduce((s, a) => s + Number(a.cantidad), 0);
  const puestasCerradas = cerradas.reduce((s, a) => s + Number(a.cantidad), 0);
  const puestasAbiertas = abiertas.reduce((s, a) => s + Number(a.cantidad), 0);
  const vendidas = cerradas.reduce((s, a) => s + Number(a.cantidad_vendida || 0), 0);
  const descartadas = cerradas.filter((a) => esDescarte(a.motivo_baja)).reduce((s, a) => s + Number(a.cantidad_remanente || 0), 0);
  const efectividad = puestasCerradas > 0 ? Math.round((vendidas / puestasCerradas) * 100) : 0;
  const tasaDescarte = puestasCerradas > 0 ? descartadas / puestasCerradas : 0;
  return {
    veces: altas.length,
    abiertas: abiertas.length,
    puestasTotal, puestasCerradas, puestasAbiertas, vendidas, descartadas, efectividad, tasaDescarte,
  };
}

// Reporte de un producto: matchea por código, EAN (prefijo) o nombre.
async function reportePorProducto(texto) {
  const like = escLike(texto);
  const { rows: altas } = await pool.query(
    `select * from bot.compras_altas
      where articulo_codigo = $1 or ean like $2 or producto ilike $3
      order by fecha`,
    [texto, like + '%', '%' + like + '%']
  );
  if (altas.length === 0) return null;

  // ¿La búsqueda matcheó más de un producto distinto? Devolvemos la lista para que afine.
  const distintos = new Map();
  for (const a of altas) {
    const clave = a.articulo_codigo || `n:${a.producto.toLowerCase()}`;
    if (!distintos.has(clave)) distintos.set(clave, a.producto);
  }
  if (distintos.size > 1) {
    return { varios: [...distintos.values()] };
  }

  const ultima = altas[altas.length - 1];
  return {
    producto: ultima.producto,
    proveedor: ultima.proveedor,
    metricas: calcularMetricas(altas),
  };
}

// Reporte de un proveedor: métricas globales + desglose por producto.
async function reportePorProveedor(texto) {
  const like = escLike(texto);
  const { rows: altas } = await pool.query(
    `select * from bot.compras_altas where proveedor ilike $1 order by fecha`,
    ['%' + like + '%']
  );
  if (altas.length === 0) return null;

  // Agrupar por producto (por código si existe, si no por nombre).
  const grupos = new Map();
  for (const a of altas) {
    const clave = a.articulo_codigo || `n:${a.producto.toLowerCase()}`;
    if (!grupos.has(clave)) grupos.set(clave, { producto: a.producto, altas: [] });
    grupos.get(clave).altas.push(a);
  }

  const porProducto = [...grupos.values()].map((g) => ({
    producto: g.producto,
    altas: g.altas.length,
    efectividad: calcularMetricas(g.altas).efectividad,
  }));

  return {
    proveedor: altas[altas.length - 1].proveedor,
    productos: grupos.size,
    metricas: calcularMetricas(altas),
    porProducto,
  };
}

module.exports = {
  crearAlta,
  historialProducto,
  buscarAltasAbiertas,
  altasEnOferta,
  altasParaAviso,
  marcarAvisoPorVencer,
  marcarAvisoVencido,
  registrarBaja,
  reportePorProducto,
  reportePorProveedor,
};
