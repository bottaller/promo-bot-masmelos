// Acceso a datos de usuarios y áreas (schema "bot").
const { pool } = require('./pool');

// Devuelve el usuario (con la lista de códigos de sus áreas) o null si no existe.
async function buscarPorTelegramId(telegramId) {
  const { rows } = await pool.query(
    `select u.id, u.telegram_id, u.nombre, u.activo, u.es_admin,
            coalesce(array_agg(a.codigo) filter (where a.codigo is not null), '{}'::text[]) as areas
       from bot.usuarios u
       left join bot.usuario_area ua on ua.usuario_id = u.id
       left join bot.areas a on a.id = ua.area_id
      where u.telegram_id = $1
      group by u.id`,
    [telegramId]
  );
  return rows[0] || null;
}

// Lista todos los usuarios con sus áreas.
async function listarUsuarios() {
  const { rows } = await pool.query(
    `select u.telegram_id, u.nombre, u.activo, u.es_admin,
            coalesce(array_agg(a.codigo order by a.codigo) filter (where a.codigo is not null), '{}'::text[]) as areas
       from bot.usuarios u
       left join bot.usuario_area ua on ua.usuario_id = u.id
       left join bot.areas a on a.id = ua.area_id
      group by u.id
      order by u.creado_en`
  );
  return rows;
}

// Da de alta (o reactiva) un usuario y lo asigna a un área.
// Devuelve { ok } o { ok:false, motivo:'area_inexistente' }.
async function agregarUsuarioAArea(telegramId, nombre, areaCodigo) {
  const area = await pool.query('select id from bot.areas where codigo = $1', [areaCodigo]);
  if (area.rowCount === 0) return { ok: false, motivo: 'area_inexistente' };
  const areaId = area.rows[0].id;

  await pool.query(
    `with nuevo as (
       insert into bot.usuarios (telegram_id, nombre, activo)
       values ($1, $2, true)
       on conflict (telegram_id) do update set activo = true
       returning id
     )
     insert into bot.usuario_area (usuario_id, area_id)
     select nuevo.id, $3 from nuevo
     on conflict do nothing`,
    [telegramId, nombre, areaId]
  );
  return { ok: true };
}

// Le quita un rol (área) a un usuario. Devuelve false si no lo tenía.
async function quitarUsuarioDeArea(telegramId, areaCodigo) {
  const { rowCount } = await pool.query(
    `delete from bot.usuario_area ua
      using bot.usuarios u, bot.areas a
      where ua.usuario_id = u.id and ua.area_id = a.id
        and u.telegram_id = $1 and a.codigo = $2`,
    [telegramId, areaCodigo]
  );
  return rowCount > 0;
}

// Guarda el nombre de Telegram si el usuario todavía no tenía uno cargado.
async function completarNombreSiFalta(telegramId, nombre) {
  if (!nombre) return;
  await pool.query(
    'update bot.usuarios set nombre = $2 where telegram_id = $1 and (nombre is null or nombre = \'\')',
    [telegramId, nombre]
  );
}

async function listarAreas() {
  const { rows } = await pool.query('select codigo, nombre from bot.areas where activa order by codigo');
  return rows;
}

// Convierte a alguien en admin (acceso total). Lo crea si no existía.
async function hacerAdmin(telegramId, nombre) {
  await pool.query(
    `insert into bot.usuarios (telegram_id, nombre, activo, es_admin)
     values ($1, $2, true, true)
     on conflict (telegram_id) do update set es_admin = true, activo = true`,
    [telegramId, nombre]
  );
}

// Le saca el rol de admin (sigue como usuario normal con sus áreas). Devuelve false si no existe.
async function quitarAdmin(telegramId) {
  const { rowCount } = await pool.query(
    'update bot.usuarios set es_admin = false where telegram_id = $1',
    [telegramId]
  );
  return rowCount > 0;
}

module.exports = {
  buscarPorTelegramId,
  listarUsuarios,
  agregarUsuarioAArea,
  quitarUsuarioDeArea,
  completarNombreSiFalta,
  listarAreas,
  hacerAdmin,
  quitarAdmin,
};
