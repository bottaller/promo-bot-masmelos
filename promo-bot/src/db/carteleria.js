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

module.exports = { crearCarteleria };
