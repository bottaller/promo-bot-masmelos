// Acceso a datos de /carteleria (Depósito -> Marketing).
const { pool } = require('./pool');

async function crearCarteleria({
  fotoFileId, tipo, tipoPrecio, cantidadCopias, vencimiento,
  usuarioId, usuarioNombre, usuarioTelegramId, esPrueba,
}) {
  const { rows } = await pool.query(
    `insert into bot.carteleria
       (foto_file_id, tipo, tipo_precio, cantidad_copias, vencimiento, usuario_id, usuario_nombre, usuario_telegram_id, es_prueba)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [fotoFileId, tipo, tipoPrecio, cantidadCopias ?? null, vencimiento ?? null, usuarioId ?? null, usuarioNombre ?? null, usuarioTelegramId, !!esPrueba]
  );
  return rows[0].id;
}

async function carteleriaPorId(id) {
  const { rows } = await pool.query('select * from bot.carteleria where id = $1', [id]);
  return rows[0] || null;
}

// Guarda lo que extrajo la IA + el file_id del diseño generado. Se usa tanto la
// primera vez (después de generar) como en cada corrección de Marketing
// (sobrescribe con los datos nuevos y el diseño regenerado).
async function guardarDiseno(id, { producto, precio, disenoFileId }) {
  const { rows } = await pool.query(
    `update bot.carteleria set producto = $2, precio = $3, diseno_file_id = $4
      where id = $1
      returning *`,
    [id, producto, precio, disenoFileId]
  );
  return rows[0] || null;
}

// Marketing confirma el diseño ("Está bien"). Guarda atómica: null si ya lo
// había verificado otra persona de Marketing (evita doble-disparo del aviso de
// impresión/pedido si dos tocan el botón casi al mismo tiempo).
async function marcarVerificado(id) {
  const { rows } = await pool.query(
    `update bot.carteleria set verificado_en = now()
      where id = $1 and verificado_en is null
      returning *`,
    [id]
  );
  return rows[0] || null;
}

// Marketing confirma que ya pidió los carteles a la gráfica. Guarda atómica: null si ya estaba
// confirmado (evita avisarle dos veces a quien lo pidió, por un doble-tap).
async function marcarPedidoConfirmado(id) {
  const { rows } = await pool.query(
    `update bot.carteleria set pedido_confirmado_en = now()
      where id = $1 and pedido_confirmado_en is null
      returning *`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  crearCarteleria,
  carteleriaPorId,
  guardarDiseno,
  marcarVerificado,
  marcarPedidoConfirmado,
};
