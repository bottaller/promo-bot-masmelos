// Acceso a datos de /ajuste (Calidad -> dueño del bot).
const { pool } = require('./pool');

async function crearAjuste({ archivoFileId, archivoNombre, usuarioId, usuarioNombre, usuarioTelegramId }) {
  const { rows } = await pool.query(
    `insert into bot.calidad_ajustes
       (archivo_file_id, archivo_nombre, usuario_id, usuario_nombre, usuario_telegram_id)
     values ($1,$2,$3,$4,$5)
     returning id`,
    [archivoFileId, archivoNombre ?? null, usuarioId ?? null, usuarioNombre ?? null, usuarioTelegramId]
  );
  return rows[0].id;
}

async function ajustePorId(id) {
  const { rows } = await pool.query('select * from bot.calidad_ajustes where id = $1', [id]);
  return rows[0] || null;
}

// Marca como realizado. Devuelve la fila, o null si ya estaba realizado (evita doble-aviso).
async function marcarAjusteRealizado(id) {
  const { rows } = await pool.query(
    `update bot.calidad_ajustes set estado = 'realizado', realizado_en = now()
      where id = $1 and estado = 'pendiente'
      returning *`,
    [id]
  );
  return rows[0] || null;
}

module.exports = { crearAjuste, ajustePorId, marcarAjusteRealizado };
