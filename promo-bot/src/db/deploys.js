// Acceso al log de deploys (bot.deploys, migración 023). Se usa para no re-anunciar el mismo
// commit cuando Railway reinicia el contenedor sin que haya un deploy nuevo.
const { pool } = require('./pool');

// SHA del último deploy anunciado, o null si no hay ninguno.
async function ultimoDeploySha() {
  const { rows } = await pool.query('select sha from bot.deploys order by id desc limit 1');
  return rows[0] ? rows[0].sha : null;
}

// Registra que se anunció este commit.
async function registrarDeploy({ sha, autor, mensaje }) {
  await pool.query(
    'insert into bot.deploys (sha, autor, mensaje) values ($1, $2, $3)',
    [sha, autor || null, (mensaje || '').slice(0, 500) || null]
  );
}

module.exports = { ultimoDeploySha, registrarDeploy };
