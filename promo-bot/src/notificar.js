const compradores = require('../config/compradores');

let botInstance = null;
function setBot(bot) {
  botInstance = bot;
}

async function notificarComprador(categoria, mensaje) {
  const destinatarios = compradores[categoria.toLowerCase()];

  if (!destinatarios || destinatarios.length === 0) {
    console.warn(`No hay comprador configurado para la categoría "${categoria}". Revisar config/compradores.js`);
    return;
  }

  for (const dest of destinatarios) {
    if (!dest.chat_id || dest.chat_id === 'PENDIENTE') {
      console.warn(`Falta cargar el chat_id de ${dest.nombre} en config/compradores.js`);
      continue;
    }
    try {
      await botInstance.telegram.sendMessage(dest.chat_id, mensaje);
    } catch (err) {
      console.error(`No se pudo notificar a ${dest.nombre} (chat_id ${dest.chat_id}):`, err.message);
    }
  }
}

module.exports = { setBot, notificarComprador };
