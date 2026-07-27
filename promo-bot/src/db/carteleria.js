// Acceso a datos de /carteleria (Depósito -> Marketing).
const { pool } = require('./pool');

async function crearCarteleria({ fotoFileId, tipo, usuarioId, usuarioNombre, usuarioTelegramId }) {
  const { rows } = await pool.query(
    `insert into bot.carteleria (foto_file_id, tipo, usuario_id, usuario_nombre, usuario_telegram_id)
     values ($1,$2,$3,$4,$5)
     returning id`,
    [fotoFileId, tipo, usuarioId ?? null, usuarioNombre ?? null, usuarioTelegramId]
  );
  return rows[0].id;
}

async function carteleriaPorId(id) {
  const { rows } = await pool.query('select * from bot.carteleria where id = $1', [id]);
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

module.exports = { crearCarteleria, carteleriaPorId, marcarPedidoConfirmado };
