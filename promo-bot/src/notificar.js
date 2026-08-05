// Avisos por rol. Cualquier evento (movimiento de una promoción, informe de Depósito, etc.) se
// avisa a TODOS los que tienen el rol correspondiente en bot.usuarios/bot.usuario_area, sin
// mapeos puntuales por proveedor ni por persona.
const { telegramIdsPorRol, telegramIdsAdmins } = require('./db/usuarios');
const { fechaHoraArg } = require('./lib/fechas');

let botInstance = null;
function setBot(bot) {
  botInstance = bot;
}

// Devuelve a cuántos se les avisó realmente (0 si nadie tiene ese rol o si todos los envíos
// fallaron), para que el llamador no afirme "se avisó" cuando en realidad no llegó a nadie.
async function notificarPorRol(rolCodigo, mensaje) {
  const destinatarios = await telegramIdsPorRol(rolCodigo);
  if (destinatarios.length === 0) {
    console.warn(`No hay nadie con el rol "${rolCodigo}" para avisar. Revisar /usuarios.`);
    return 0;
  }
  let enviados = 0;
  for (const tid of destinatarios) {
    try {
      await botInstance.telegram.sendMessage(tid, mensaje);
      enviados++;
    } catch (err) {
      console.error(`No se pudo avisar al rol "${rolCodigo}" (chat_id ${tid}):`, err.message);
    }
  }
  return enviados;
}

// Avisos al equipo de Compras: cualquier movimiento de una promoción (alta, baja, reposición,
// cambio de %) se avisa a todos los que tienen el rol "compras", sin importar el proveedor.
function notificarComprador(mensaje) {
  return notificarPorRol('compras', mensaje);
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Arma el texto de un aviso de problema para los admins, con formato consistente. PURO (testeable
// sin bot ni base): el envío es aparte, en avisarProblema.
//   proceso:    dónde pasó (ej. 'arqueo Talo de las 21:00', 'arranque del bot')
//   que:        qué pasó, en una línea (ej. 'no pude bajar el extracto por API')
//   detalle:    el error crudo / la lista de lo que falta (opcional)
//   sugerencia: qué hacer (opcional)
//   nivel:      '⚠️' (default) o '❌' para lo más grave
function formatearProblema({ proceso, que, detalle = '', sugerencia = '', nivel = '⚠️' }) {
  const L = [`${nivel} <b>Problema en ${escapeHtml(proceso)}</b>`, escapeHtml(que)];
  if (detalle) L.push(`\n<i>${escapeHtml(String(detalle).slice(0, 1500))}</i>`);
  if (sugerencia) L.push(`\n👉 ${escapeHtml(sugerencia)}`);
  L.push(`\n<code>${escapeHtml(fechaHoraArg())}</code>`);
  return L.join('\n');
}

// Avisa a TODOS los admins de un problema. "Avisar siempre": no agrupa ni silencia repetidos
// (decisión del dueño: mejor ruido que perderse algo). Best-effort: si el bot no está seteado o
// falla el envío, queda en el log y NUNCA rompe al proceso que llamó (por eso todo va en try/catch).
// Devuelve a cuántos admins les llegó.
async function avisarProblema(opts) {
  const msg = formatearProblema(opts);
  // Siempre al log, aunque no llegue a Telegram (Railway guarda el log).
  console.error(`[PROBLEMA] ${opts.proceso}: ${opts.que}${opts.detalle ? ' — ' + opts.detalle : ''}`);
  if (!botInstance) { console.error('avisarProblema: bot no seteado, no puedo avisar por Telegram.'); return 0; }
  let admins = [];
  try { admins = await telegramIdsAdmins(); }
  catch (e) { console.error('avisarProblema: no pude leer los admins de la base:', e.message); return 0; }
  let enviados = 0;
  for (const tid of new Set(admins.map(String))) {
    try { await botInstance.telegram.sendMessage(tid, msg, { parse_mode: 'HTML' }); enviados++; }
    catch (e) { console.error(`avisarProblema: no pude avisar al admin ${tid}:`, e.message); }
  }
  return enviados;
}

module.exports = { setBot, notificarPorRol, notificarComprador, avisarProblema, formatearProblema };
