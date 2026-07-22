// Resumen SEMANAL del control de Mercado Pago (/mp).
// Los LUNES a las 8:00 (hora Argentina) junta cómo salió el control cada día de la semana
// pasada (lunes a domingo) y se lo manda a los admins + al rol Caja Central. Los días que
// no se corrió el control se marcan como tales (un control saltado es en sí un hallazgo).
//
// Mismo patrón que avisos.js: setTimeout que se re-agenda, y parte el mensaje si supera el
// tope de Telegram. Idempotente por diseño: releer y reenviar el mismo resumen no rompe nada.
const { conciliacionesDeRango } = require('./db/mp-conciliacion');
const { semanaAnterior, formatearResumenSemanal } = require('./lib/resumen-mp-semanal');
const { telegramIdsAdmins, telegramIdsPorRol } = require('./db/usuarios');
const { fechaHoyArgISO } = require('./lib/fechas');

const LIMITE_MSG = 3500; // margen bajo el tope de 4096 de Telegram

// telegram_ids que reciben el resumen: admins + rol Caja Central, sin repetir.
async function destinatarios() {
  const [admins, caja] = await Promise.all([telegramIdsAdmins(), telegramIdsPorRol('cajacentral')]);
  return [...new Set([...admins, ...caja].map(String))];
}

// Manda el título + las líneas, partiéndolas en varios mensajes si superan el tope.
async function enviarResumen(telegram, tid, titulo, lineas) {
  const bloques = [];
  let actual = titulo;
  for (const linea of lineas) {
    if ((actual + '\n' + linea).length > LIMITE_MSG) { bloques.push(actual); actual = linea; }
    else actual += '\n' + linea;
  }
  bloques.push(actual);
  for (const b of bloques) {
    try { await telegram.sendMessage(tid, b, { parse_mode: 'HTML' }); }
    catch (e) { console.error(`Resumen MP semanal: no pude avisar a ${tid}:`, e.message); }
  }
}

// Arma y manda el resumen de la semana anterior. `hoyISO` inyectable para test/recuperación.
async function enviarResumenSemanal(telegram, hoyISO = fechaHoyArgISO()) {
  const { desde, hasta } = semanaAnterior(hoyISO);
  const filas = await conciliacionesDeRango({ desde, hasta });
  const { titulo, lineas, stats } = formatearResumenSemanal({ desde, hasta, filas });
  const tids = await destinatarios();
  for (const tid of tids) await enviarResumen(telegram, tid, titulo, lineas);
  return { desde, hasta, destinatarios: tids.length, ...stats };
}

// --- Programador: los lunes a la hora indicada -----------------------------
const HORA_UTC_RAW = Number(process.env.RESUMEN_MP_HORA_UTC);
const HORA_UTC = (Number.isInteger(HORA_UTC_RAW) && HORA_UTC_RAW >= 0 && HORA_UTC_RAW <= 23) ? HORA_UTC_RAW : 11; // 11 UTC = 8:00 ART

// ms hasta el próximo LUNES a HORA_UTC. getUTCDay: 0=domingo..1=lunes. Se calcula en UTC (el
// proceso corre en UTC en Railway); el lunes 11:00 UTC = lunes 08:00 en Argentina (UTC-3).
function msHastaProximoLunes() {
  const ahora = Date.now();
  const d = new Date();
  let prox = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HORA_UTC, 0, 0);
  const diasHastaLunes = (1 - d.getUTCDay() + 7) % 7; // 0 si hoy es lunes
  prox += diasHastaLunes * 24 * 3600 * 1000;
  if (prox <= ahora) prox += 7 * 24 * 3600 * 1000; // ya pasó el lunes de esta semana → el que viene
  return prox - ahora;
}

function iniciarAvisoMpSemanal(bot) {
  const correr = async () => {
    try {
      const r = await enviarResumenSemanal(bot.telegram);
      console.log(`Resumen MP semanal (${r.desde}→${r.hasta}): ${r.ok} ok, ${r.conDif} con dif, ${r.sinCorrer} sin correr → ${r.destinatarios} destinatarios.`);
    } catch (e) {
      console.error('Error en el resumen MP semanal:', e);
    }
    setTimeout(correr, msHastaProximoLunes());
  };
  const ms = msHastaProximoLunes();
  console.log(`Resumen MP semanal programado: próxima corrida en ~${Math.round(ms / 3600000)}h.`);
  setTimeout(correr, ms);
}

module.exports = { enviarResumenSemanal, iniciarAvisoMpSemanal };
