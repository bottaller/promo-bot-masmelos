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

// Ingresos de mercadería del día → tabla public.ingresos (la lee la web).
// Reemplaza los del mismo día (re-subir el Excel corrige lo cargado).
// fecha: 'AAAA-MM-DD'. nombres: string[]. Devuelve cuántos quedaron guardados.
async function registrarIngresos({ fecha, nombres }) {
  const limpios = (nombres || []).map((n) => String(n).trim()).filter(Boolean);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from public.ingresos where fecha = $1', [fecha]);
    if (limpios.length) {
      const values = limpios.map((_, i) => `($1, $${i + 2})`).join(',');
      await client.query(
        `insert into public.ingresos (fecha, nombre) values ${values}`,
        [fecha, ...limpios]
      );
    }
    await client.query('commit');
    return limpios.length;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { crearInforme, informesPorDestino, registrarIngresos };
