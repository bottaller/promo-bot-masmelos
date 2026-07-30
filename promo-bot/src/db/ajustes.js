// Acceso a datos de /ajuste (Calidad -> dueño del bot -> rol "ajuste_ejecutor").
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

// El dueño lo revisó y lo reenvía al rol "ajuste_ejecutor". Devuelve la fila, o null si ya
// estaba verificado (evita reenviarlo dos veces por un doble-tap).
async function marcarAjusteVerificado(id) {
  const { rows } = await pool.query(
    `update bot.calidad_ajustes set estado = 'verificado', verificado_en = now()
      where id = $1 and estado = 'pendiente'
      returning *`,
    [id]
  );
  return rows[0] || null;
}

// El ejecutor (rol "ajuste_ejecutor") confirma que lo hizo. Devuelve la fila, o null si ya
// estaba realizado (evita doble-aviso).
async function marcarAjusteRealizado(id) {
  const { rows } = await pool.query(
    `update bot.calidad_ajustes set estado = 'realizado', realizado_en = now()
      where id = $1 and estado = 'verificado'
      returning *`,
    [id]
  );
  return rows[0] || null;
}

// Ajustes verificados hace más de `horas` que el ejecutor todavía no confirmó, y de los que
// no se avisó ya la demora (para no reavisar en cada corrida).
async function ajustesDemorados(horas) {
  const { rows } = await pool.query(
    `select * from bot.calidad_ajustes
      where estado = 'verificado'
        and demora_avisada = false
        and verificado_en < now() - (interval '1 hour' * $1)
      order by verificado_en`,
    [horas]
  );
  return rows;
}

// Marca la demora como avisada para no repetir el aviso al dueño en la próxima corrida.
async function marcarDemoraAvisada(ids) {
  if (!ids || ids.length === 0) return;
  await pool.query(
    'update bot.calidad_ajustes set demora_avisada = true where id = any($1::bigint[])',
    [ids]
  );
}

module.exports = {
  crearAjuste, ajustePorId, marcarAjusteVerificado, marcarAjusteRealizado,
  ajustesDemorados, marcarDemoraAvisada,
};
