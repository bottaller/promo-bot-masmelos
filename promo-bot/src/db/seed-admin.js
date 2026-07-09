// Da de alta (o actualiza) un usuario como ADMIN, en todas las áreas.
// Uso:  node src/db/seed-admin.js <telegram_id> [nombre]
// Es el bootstrap inicial, hasta que exista el comando /usuarios dentro del bot.
require('dotenv').config();
const { pool } = require('./pool');

(async () => {
  const telegramId = process.argv[2];
  const nombre = process.argv[3] || null;

  if (!telegramId || !/^\d+$/.test(telegramId)) {
    console.error('Uso: node src/db/seed-admin.js <telegram_id> [nombre]');
    process.exitCode = 1;
    return;
  }

  try {
    // Un solo statement atómico: crea/actualiza el usuario y lo mete en todas las áreas.
    await pool.query(
      `with nuevo as (
         insert into bot.usuarios (telegram_id, nombre, activo, es_admin)
         values ($1, $2, true, true)
         on conflict (telegram_id) do update set es_admin = true, activo = true
         returning id
       )
       insert into bot.usuario_area (usuario_id, area_id)
       select nuevo.id, bot.areas.id from nuevo, bot.areas
       on conflict do nothing`,
      [telegramId, nombre]
    );

    const { rows } = await pool.query(
      `select u.telegram_id, u.nombre, u.es_admin,
              array_agg(a.codigo order by a.codigo) as areas
         from bot.usuarios u
         left join bot.usuario_area ua on ua.usuario_id = u.id
         left join bot.areas a on a.id = ua.area_id
        where u.telegram_id = $1
        group by u.id`,
      [telegramId]
    );

    const u = rows[0];
    console.log(`✅ Usuario listo: ${u.nombre || '(sin nombre)'} — telegram_id ${u.telegram_id}`);
    console.log(`   admin: ${u.es_admin} · áreas: ${u.areas.filter(Boolean).join(', ')}`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
