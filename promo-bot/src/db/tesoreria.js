// Acceso a datos de Tesorería: saldos diarios (lado "realidad" de la conciliación).
const { pool } = require('./pool');
const { fechaISO } = require('../lib/fechas');

// Guarda (upsert) los saldos de un día. Re-subir el mismo día pisa los montos de esa
// fecha/empresa/cuenta. Transacción: o entran todas las cuentas o ninguna.
async function guardarSaldos({ fecha, empresa, saldos, usuarioId }) {
  const fISO = fechaISO(fecha); // YYYY-MM-DD sin corrimiento de zona horaria
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const s of saldos) {
      await client.query(
        `insert into bot.tesoreria_saldos (fecha, empresa, cuenta, moneda, monto, cargado_por)
           values ($1::date, $2, $3, $4, $5, $6)
         on conflict (fecha, empresa, cuenta)
           do update set moneda = excluded.moneda, monto = excluded.monto,
                         cargado_por = excluded.cargado_por, cargado_en = now()`,
        [fISO, empresa, s.cuenta, s.moneda, s.monto, usuarioId ?? null]
      );
    }
    await client.query('commit');
    return { cantidad: saldos.length };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// Saldos guardados de una fecha (para la conciliación / consultas).
async function saldosDeFecha({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select cuenta, moneda, monto from bot.tesoreria_saldos
      where fecha = $1::date and empresa = $2 order by cuenta`,
    [fechaISO(fecha), empresa]
  );
  return rows;
}

module.exports = { guardarSaldos, saldosDeFecha };
