// Acceso a datos de Compras: promociones por vencimiento en Postgres.
// Una fila de bot.compras_altas = una "camada" puesta en oferta.
//   fecha_baja IS NULL  -> sigue en góndola ("abierta")
//   fecha_baja NOT NULL -> cerrada, con cantidad_vendida / cantidad_remanente / motivo_baja
const { pool } = require('./pool');
const { fechaISO } = require('../lib/fechas');

// Escapa los comodines de LIKE/ILIKE (% _ \) para que el texto del usuario no sobre-matchee.
function escLike(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

// --- Altas ---

// Nota: la columna "lote" existe en la tabla pero por ahora no se pide ni se completa (queda NULL).
async function crearAlta(a) {
  const { rows } = await pool.query(
    `insert into bot.compras_altas
       (usuario_id, usuario_nombre, articulo_codigo, ean, producto, proveedor, vencimiento, cantidad, motivo, descuento_pct, precio_promocional)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning id`,
    [
      a.usuarioId ?? null, a.usuarioNombre ?? null, a.articuloCodigo ?? null, a.ean ?? null,
      a.producto, a.proveedor ?? null, a.vencimiento ?? null, a.cantidad, a.motivo ?? null,
      a.descuentoPct ?? null, a.precioPromocional ?? null,
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

// Todas las altas, abiertas y cerradas, ordenadas por proveedor y fecha (para el Excel de
// promociones que puede ver Compras). `desde` (opcional): Date -> solo altas de ese lapso a hoy.
async function todasLasAltas({ desde } = {}) {
  const params = [];
  let condicion = '';
  if (desde) {
    params.push(fechaISO(desde));
    condicion = `where fecha >= $1::date`;
  }
  const { rows } = await pool.query(
    `select * from bot.compras_altas ${condicion} order by proveedor nulls last, fecha`,
    params
  );
  return rows;
}

// Una alta puntual, solo si sigue abierta. Se usa para revalidar justo antes de operar sobre
// ella (p. ej. al elegirla de un menú armado unos segundos antes, por si alguien la cerró
// mientras tanto con /baja).
async function altaAbiertaPorId(id) {
  const { rows } = await pool.query(
    `select * from bot.compras_altas where id = $1 and fecha_baja is null`,
    [id]
  );
  return rows[0] || null;
}

// Altas abiertas para el chequeo de avisos: trae el telegram_id del que la cargó (solo si sigue
// activo) y si ya se avisó "por vencer" hoy. La fecha de "hoy" se pasa desde JS en calendario
// ARGENTINO (hoyISO), no current_date del server (UTC), para que el dedup coincida con la
// categorización mañana/hoy (que también usa el calendario argentino).
async function altasParaAviso(hoyISO) {
  const { rows } = await pool.query(
    `select ca.*, u.telegram_id as creador_telegram_id,
            (ca.aviso_vencimiento_fecha is null or ca.aviso_vencimiento_fecha < $1::date) as puede_avisar_vencer
       from bot.compras_altas ca
       left join bot.usuarios u on u.id = ca.usuario_id and u.activo = true
      where ca.fecha_baja is null`,
    [hoyISO]
  );
  return rows;
}

async function marcarAvisoPorVencer(altaIds, hoyISO) {
  if (!altaIds || altaIds.length === 0) return;
  await pool.query(
    `update bot.compras_altas set aviso_vencimiento_fecha = $2::date where id = any($1::bigint[])`,
    [altaIds, hoyISO]
  );
}

async function marcarAvisoVencido(altaIds) {
  if (!altaIds || altaIds.length === 0) return;
  await pool.query(
    `update bot.compras_altas set aviso_vencido = true where id = any($1::bigint[])`,
    [altaIds]
  );
}

// --- Reposición ---

// Altas ABIERTAS que matchean el mismo producto (por código si hay, si no por nombre exacto)
// y la MISMA fecha de vencimiento (ya normalizada a DD/MM/AAAA). Se usa en /reposicion: en vez
// de crear otra alta, se le suma la cantidad nueva a la que ya está en promoción.
async function buscarAltasParaReponer({ articuloCodigo, producto, vencimiento }) {
  const { rows } = await pool.query(
    `select * from bot.compras_altas
      where fecha_baja is null
        and vencimiento = $1
        and (
          ($2::text is not null and articulo_codigo = $2)
          or ($2::text is null and lower(producto) = lower($3))
        )
      order by fecha`,
    [vencimiento, articuloCodigo ?? null, producto]
  );
  return rows;
}

// Suma cantidad a una alta abierta existente (reposición). Atómico y a prueba de carrera: si la
// alta ya se cerró justo antes de sumar (fecha_baja dejó de ser null), no actualiza nada y
// devuelve null en vez de un número, para que el wizard pueda avisar en vez de mentir el total.
async function sumarCantidadAlta({ altaId, cantidadAdicional }) {
  const { rows } = await pool.query(
    `update bot.compras_altas
        set cantidad = cantidad + $2
      where id = $1 and fecha_baja is null
      returning cantidad`,
    [altaId, cantidadAdicional]
  );
  return rows[0] ? rows[0].cantidad : null;
}

// --- Cambio de % de promoción ---

// Divide una alta abierta en dos: cierra la actual marcando la DIFERENCIA (cantidad actual menos
// las unidades que pasan al % nuevo) como vendida al % viejo, y crea una alta nueva —mismo
// producto/proveedor/vencimiento/motivo— con las unidades que siguen en promoción, ahora al %
// nuevo. Así, cuando se haga /baja más adelante, el histórico del producto queda con dos altas:
// una cerrada (lo que se vendió al % viejo) y otra que se cierra después con el resultado final
// al % nuevo.
// Transacción atómica con lock de fila: si la alta ya se cerró justo antes (carrera con /baja),
// no hace nada y devuelve null. Sirve tanto para cambiar el % de descuento como el precio
// promocional (exactamente uno de nuevoPct/nuevoPrecio viene con valor, el otro null).
async function cambiarPromocion({ altaId, unidadesNuevo, nuevoPct, nuevoPrecio, cantidadEsperada }) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const { rows } = await client.query(
      'select * from bot.compras_altas where id = $1 and fecha_baja is null for update',
      [altaId]
    );
    const alta = rows[0];
    if (!alta) {
      await client.query('rollback');
      return { cerrada: true }; // se cerró justo antes (carrera con /baja)
    }

    // Guard de concurrencia optimista: si la cantidad cambió desde que el usuario confirmó
    // (típicamente una /reposicion que sumó unidades entremedio), abortamos. Si no, recalcularíamos
    // la diferencia sobre un total distinto y marcaríamos como "vendidas" unidades recién repuestas.
    if (cantidadEsperada != null && Number(alta.cantidad) !== Number(cantidadEsperada)) {
      await client.query('rollback');
      return { cambiada: true, cantidadActual: Number(alta.cantidad) };
    }

    const diferencia = Number(alta.cantidad) - unidadesNuevo;

    // La alta vieja pasa a representar SOLO lo que se cerró a la promo vieja (la diferencia): por
    // eso se reduce `cantidad` a la diferencia además de marcarla como vendida. Si no, las unidades
    // que siguen en promoción (que se re-insertan abajo) quedarían contadas dos veces en
    // "unidades puestas" de los reportes, diluyendo la efectividad. Con esto la fila queda
    // consistente: cantidad == cantidad_vendida + cantidad_remanente (= diferencia + 0).
    await client.query(
      `update bot.compras_altas
          set fecha_baja = now(), cantidad = $2, cantidad_vendida = $2, cantidad_remanente = 0,
              motivo_baja = 'Cambio de promoción'
        where id = $1`,
      [altaId, diferencia]
    );

    const { rows: nuevaRows } = await client.query(
      `insert into bot.compras_altas
         (usuario_id, usuario_nombre, articulo_codigo, ean, producto, proveedor, vencimiento, cantidad, motivo, descuento_pct, precio_promocional)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id`,
      [
        alta.usuario_id, alta.usuario_nombre, alta.articulo_codigo, alta.ean,
        alta.producto, alta.proveedor, alta.vencimiento, unidadesNuevo, alta.motivo,
        nuevoPct ?? null, nuevoPrecio ?? null,
      ]
    );

    await client.query('commit');
    return { altaVieja: alta, altaNuevaId: nuevaRows[0].id, diferencia };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
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

// Reporte de un proveedor: métricas globales + desglose por producto.
// nombreProveedor tiene que ser el nombre EXACTO (viene del maestro de artículos, resuelto por
// código de proveedor), para no mezclar proveedores distintos por coincidencia parcial de nombre.
// `desde` (opcional): Date -> filtra altas con fecha >= esa fecha (reporte de un lapso, no histórico).
async function reportePorProveedor(nombreProveedor, { desde } = {}) {
  const params = [nombreProveedor];
  let condicion = 'lower(proveedor) = lower($1)';
  if (desde) {
    params.push(fechaISO(desde));
    condicion += ` and fecha >= $${params.length}::date`;
  }
  const { rows: altas } = await pool.query(
    `select * from bot.compras_altas where ${condicion} order by fecha`,
    params
  );
  if (altas.length === 0) return null;

  // Agrupar por producto (por código si existe, si no por nombre).
  const grupos = new Map();
  for (const a of altas) {
    const clave = a.articulo_codigo || `n:${a.producto.toLowerCase()}`;
    if (!grupos.has(clave)) grupos.set(clave, { producto: a.producto, altas: [] });
    grupos.get(clave).altas.push(a);
  }

  const porProducto = [...grupos.values()].map((g) => {
    const met = calcularMetricas(g.altas);
    return {
      producto: g.producto,
      altas: g.altas.length,
      efectividad: met.efectividad,
      hayCerradas: met.puestasCerradas > 0, // si no, la efectividad 0% no significa nada
      // Valores (sin repetidos, ordenados) aplicados en cada alta de este producto. Puede haber
      // más de uno: distintas camadas del mismo producto, o un /cambiopromocion que partió una
      // camada en dos con un valor distinto.
      descuentos: valoresUnicos(g.altas, 'descuento_pct'),
      precios: valoresUnicos(g.altas, 'precio_promocional'),
      // Unidades VENDIDAS (camadas cerradas), agrupadas por el valor que tenían.
      vendidoPorPct: vendidoPorValor(g.altas, 'descuento_pct'),
      vendidoPorPrecio: vendidoPorValor(g.altas, 'precio_promocional'),
    };
  });

  return {
    proveedor: altas[altas.length - 1].proveedor,
    productos: grupos.size,
    metricas: calcularMetricas(altas),
    porProducto,
    vendidoPorPct: vendidoPorValor(altas, 'descuento_pct'),
    vendidoPorPrecio: vendidoPorValor(altas, 'precio_promocional'),
  };
}

// Valores distintos (sin repetidos, ordenados) que tomó una columna (descuento_pct o
// precio_promocional) en un conjunto de altas.
function valoresUnicos(altas, campo) {
  return [...new Set(
    altas.map((a) => (a[campo] === null || a[campo] === undefined ? null : Number(a[campo]))).filter((v) => v !== null)
  )].sort((a, b) => a - b);
}

// Unidades vendidas (camadas cerradas), agrupadas por el valor de descuento_pct o
// precio_promocional que tenía cada una. [{ valor, unidades }], ordenado por valor.
function vendidoPorValor(altas, campo) {
  const mapa = new Map();
  for (const a of altas) {
    if (!a.fecha_baja || a[campo] === null || a[campo] === undefined) continue;
    const valor = Number(a[campo]);
    mapa.set(valor, (mapa.get(valor) || 0) + Number(a.cantidad_vendida || 0));
  }
  return [...mapa.entries()].sort((a, b) => a[0] - b[0]).map(([valor, unidades]) => ({ valor, unidades }));
}

module.exports = {
  crearAlta,
  historialProducto,
  buscarAltasAbiertas,
  buscarAltasParaReponer,
  sumarCantidadAlta,
  cambiarPromocion,
  altasEnOferta,
  todasLasAltas,
  altaAbiertaPorId,
  altasParaAviso,
  marcarAvisoPorVencer,
  marcarAvisoVencido,
  registrarBaja,
  reportePorProveedor,
};
