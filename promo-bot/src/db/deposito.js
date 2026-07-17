// Acceso a datos de Depósito: informes en texto libre dirigidos a Calidad o Compras.
const { pool } = require('./pool');

async function crearInforme({ destinoArea, referencia, mensaje, usuarioId, usuarioNombre }) {
  const { rows } = await pool.query(
    `insert into bot.deposito_informes (destino_area, referencia, mensaje, usuario_id, usuario_nombre)
     values ($1,$2,$3,$4,$5)
     returning id`,
    [destinoArea, referencia, mensaje, usuarioId ?? null, usuarioNombre ?? null]
  );
  return rows[0].id;
}

module.exports = { crearInforme };
