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

// Informes dirigidos a un área, del más viejo al más nuevo (para el Excel de Compras).
async function informesPorDestino(destinoArea) {
  const { rows } = await pool.query(
    `select fecha, referencia, mensaje, usuario_nombre
       from bot.deposito_informes
      where destino_area = $1
      order by fecha`,
    [destinoArea]
  );
  return rows;
}

module.exports = { crearInforme, informesPorDestino };
