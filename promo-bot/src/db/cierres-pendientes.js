// Lista de espera de CIERRES PENDIENTES (ver migración 017). Un renglón por cierre cuyos
// saldos ya se cargaron pero cuyo reporte todavía no se entregó (falta conciliar contra el
// libro). El barrido de las 08:00 (entrega-cierres.js) los toma, concilia y entrega; al
// entregar, borra el renglón.
const { pool } = require('./pool');
const { fechaISO } = require('../lib/fechas');

// Marca un cierre como pendiente de entrega. Upsert: si el día ya estaba pendiente (p. ej. el
// tesorero recargó los saldos), actualiza a quién entregar y reabre el reloj.
async function registrarCierrePendiente({ fecha, empresa = 'HONRE', telegramId, usuarioId = null, usuarioTxt = null }) {
  await pool.query(
    `insert into bot.cierres_pendientes (fecha, empresa, telegram_id, usuario_id, usuario_txt)
       values ($1::date, $2, $3, $4, $5)
     on conflict (fecha, empresa) do update set
       telegram_id = excluded.telegram_id, usuario_id = excluded.usuario_id,
       usuario_txt = excluded.usuario_txt, creado_en = now()`,
    [fechaISO(fecha), empresa, telegramId, usuarioId, usuarioTxt]
  );
}

// Todos los cierres pendientes de una empresa, más viejo primero (para entregarlos en orden).
// `fecha` vuelve como Date (node-pg parsea `date` a medianoche local, igual criterio que fechaISO).
async function cierresPendientes({ empresa = 'HONRE' } = {}) {
  const { rows } = await pool.query(
    `select fecha, empresa, telegram_id, usuario_id, usuario_txt
       from bot.cierres_pendientes where empresa = $1 order by fecha`,
    [empresa]
  );
  return rows;
}

// Saca un cierre de la lista de espera (se entregó, o dejó de tener sentido).
async function borrarCierrePendiente({ fecha, empresa = 'HONRE' }) {
  await pool.query(
    'delete from bot.cierres_pendientes where fecha = $1::date and empresa = $2',
    [fechaISO(fecha), empresa]
  );
}

module.exports = { registrarCierrePendiente, cierresPendientes, borrarCierrePendiente };
