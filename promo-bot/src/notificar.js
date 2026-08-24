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

// Telegram acepta hasta 50 MB por documento, pero acá el tope es por sensatez: si algo
// gigante llega a fallar, el aviso tiene que salir igual y no quedarse colgado subiendo.
const MAX_ADJUNTO = 20 * 1024 * 1024;

// Avisa a TODOS los admins de un problema. "Avisar siempre": no agrupa ni silencia repetidos
// (decisión del dueño: mejor ruido que perderse algo). Best-effort: si el bot no está seteado o
// falla el envío, queda en el log y NUNCA rompe al proceso que llamó (por eso todo va en try/catch).
// Devuelve a cuántos admins les llegó.
//
// opts.archivo = { buffer, nombre, leyenda } — OPCIONAL. Cuando el problema ES un archivo
// (una planilla que no se pudo procesar, por ejemplo), describirlo no alcanza: se manda el
// archivo atrás del mensaje, así el admin lo abre en el momento en vez de tener que ir hasta
// la PC donde se generó. Si falla el adjunto, el aviso de texto ya salió igual.
//
// opts.botones = [[{ text, callback_data }]] — OPCIONAL. Van pegados al archivo (o al texto
// si no hay archivo). Sirve para que el aviso no sea solo una mala noticia sino algo que se
// pueda resolver ahí mismo, sin cambiar de pantalla.
async function avisarProblema(opts) {
  const msg = formatearProblema(opts);
  // Siempre al log, aunque no llegue a Telegram (Railway guarda el log).
  console.error(`[PROBLEMA] ${opts.proceso}: ${opts.que}${opts.detalle ? ' — ' + opts.detalle : ''}`);
  if (!botInstance) { console.error('avisarProblema: bot no seteado, no puedo avisar por Telegram.'); return 0; }
  let admins = [];
  try { admins = await telegramIdsAdmins(); }
  catch (e) { console.error('avisarProblema: no pude leer los admins de la base:', e.message); return 0; }

  let adjunto = null;
  const a = opts.archivo;
  if (a && a.buffer && a.buffer.length) {
    if (a.buffer.length > MAX_ADJUNTO) {
      console.error(`avisarProblema: el archivo pesa ${Math.round(a.buffer.length / 1024)} KB, no lo adjunto.`);
    } else {
      adjunto = a;
    }
  }
  // Se sube UNA sola vez: al primer admin va el archivo y a los demás el file_id que
  // devuelve Telegram, en vez de resubir lo mismo tantas veces como admins haya.
  let fileId = null;

  let enviados = 0;
  for (const tid of new Set(admins.map(String))) {
    const opcionesMsg = { parse_mode: 'HTML' };
    // Si no hay archivo, los botones van pegados al texto; si hay, van con el archivo,
    // que es lo último que se ve en el chat.
    if (opts.botones && !adjunto) opcionesMsg.reply_markup = { inline_keyboard: opts.botones };
    try { await botInstance.telegram.sendMessage(tid, msg, opcionesMsg); enviados++; }
    catch (e) { console.error(`avisarProblema: no pude avisar al admin ${tid}:`, e.message); continue; }

    if (!adjunto) continue;
    try {
      const extra = {};
      if (adjunto.leyenda) extra.caption = String(adjunto.leyenda).slice(0, 1000);
      if (opts.botones) extra.reply_markup = { inline_keyboard: opts.botones };
      const r = await botInstance.telegram.sendDocument(
        tid,
        fileId || { source: adjunto.buffer, filename: adjunto.nombre || 'archivo' },
        Object.keys(extra).length ? extra : undefined
      );
      if (!fileId && r && r.document && r.document.file_id) fileId = r.document.file_id;
    } catch (e) {
      console.error(`avisarProblema: no pude mandarle el archivo al admin ${tid}:`, e.message);
    }
  }
  return enviados;
}

module.exports = { setBot, notificarPorRol, notificarComprador, avisarProblema, formatearProblema };
