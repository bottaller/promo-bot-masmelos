// Acceso a datos de Compras: promociones por vencimiento (altas/bajas) en Postgres.
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

// Altas ABIERTAS que matchean el texto (código exacto, EAN por prefijo, o nombre contiene).
async function buscarAltasAbiertas(texto, limite = 15) {
  const like = escLike(texto);
  const { rows } = await pool.query(
    `select * from bot.compras_altas
      where estado = 'abierta'
        and (articulo_codigo = $1 or ean like $2 or producto ilike $3)
      order by fecha
      limit $4`,
    [texto, like + '%', '%' + like + '%', limite]
  );
  return rows;
}

async function getAlta(id) {
  const { rows } = await pool.query('select * from bot.compras_altas where id = $1', [id]);
  return rows[0] || null;
}

// --- Bajas ---

// Registra la baja y cierra la alta, en una transacción.
async function registrarBaja({ altaId, remanente, vendida, motivoBaja }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Cerramos la alta solo si estaba abierta. Si ya estaba cerrada (doble baja / doble tap),
    // rowCount = 0 y no registramos nada. Es idempotente.
    const upd = await client.query(
      `update bot.compras_altas set estado = 'cerrada' where id = $1 and estado = 'abierta'`,
      [altaId]
    );
    if (upd.rowCount === 0) {
      await client.query('rollback');
      return { ok: false };
    }
    await client.query(
      `insert into bot.compras_bajas (alta_id, cantidad_remanente, cantidad_vendida, motivo_baja)
       values ($1,$2,$3,$4)`,
      [altaId, remanente, vendida, motivoBaja ?? null]
    );
    await client.query('commit');
    return { ok: true };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// --- Reportes ---

// Un remanente cuenta como "descartado" solo si el motivo indica descarte (no si volvió a góndola).
function esDescarte(motivo) {
  return typeof motivo === 'string' && /descart|vencid/i.test(motivo);
}

// Calcula métricas sobre un conjunto de altas y sus bajas.
// Efectividad y tasa de descarte usan como denominador SOLO las altas cerradas
// (las abiertas todavía no vendieron, no deben diluir el porcentaje).
function calcularMetricas(altas, bajas) {
  const puestasTotal = altas.reduce((s, a) => s + Number(a.cantidad), 0);
  const puestasCerradas = altas.filter((a) => a.estado === 'cerrada').reduce((s, a) => s + Number(a.cantidad), 0);
  const vendidas = bajas.reduce((s, b) => s + Number(b.cantidad_vendida || 0), 0);
  const descartadas = bajas.filter((b) => esDescarte(b.motivo_baja)).reduce((s, b) => s + Number(b.cantidad_remanente || 0), 0);
  const efectividad = puestasCerradas > 0 ? Math.round((vendidas / puestasCerradas) * 100) : 0;
  const tasaDescarte = puestasCerradas > 0 ? descartadas / puestasCerradas : 0;
  return {
    veces: altas.length,
    abiertas: altas.filter((a) => a.estado === 'abierta').length,
    puestasTotal, puestasCerradas, vendidas, descartadas, efectividad, tasaDescarte,
  };
}

async function bajasDeAltas(altaIds) {
  if (altaIds.length === 0) return [];
  const { rows } = await pool.query(
    'select * from bot.compras_bajas where alta_id = any($1::bigint[])',
    [altaIds]
  );
  return rows;
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

  const bajas = await bajasDeAltas(altas.map((a) => a.id));
  const ultima = altas[altas.length - 1];
  return {
    producto: ultima.producto,
    proveedor: ultima.proveedor,
    metricas: calcularMetricas(altas, bajas),
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
  const bajas = await bajasDeAltas(altas.map((a) => a.id));
  const bajasPorAlta = new Map();
  for (const b of bajas) {
    if (!bajasPorAlta.has(b.alta_id)) bajasPorAlta.set(b.alta_id, []);
    bajasPorAlta.get(b.alta_id).push(b);
  }

  // Agrupar por producto (por código si existe, si no por nombre).
  const grupos = new Map();
  for (const a of altas) {
    const clave = a.articulo_codigo || `n:${a.producto.toLowerCase()}`;
    if (!grupos.has(clave)) grupos.set(clave, { producto: a.producto, altas: [], bajas: [] });
    const g = grupos.get(clave);
    g.altas.push(a);
    g.bajas.push(...(bajasPorAlta.get(a.id) || []));
  }

  const porProducto = [...grupos.values()].map((g) => ({
    producto: g.producto,
    altas: g.altas.length,
    efectividad: calcularMetricas(g.altas, g.bajas).efectividad,
  }));

  return {
    proveedor: altas[altas.length - 1].proveedor,
    productos: grupos.size,
    metricas: calcularMetricas(altas, bajas),
    porProducto,
  };
}

module.exports = {
  crearAlta,
  historialProducto,
  buscarAltasAbiertas,
  getAlta,
  registrarBaja,
  reportePorProducto,
  reportePorProveedor,
};
