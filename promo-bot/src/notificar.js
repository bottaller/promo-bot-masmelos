// Avisos al equipo de Compras. No hay mapeo por proveedor: cualquier movimiento de una promoción
// (alta, baja, reposición, cambio de %) se avisa a TODOS los que tienen el rol "compras" en
// bot.usuarios/bot.usuario_area, sin importar de qué proveedor se trate.
const { telegramIdsPorRol } = require('./db/usuarios');

let botInstance = null;
function setBot(bot) {
  botInstance = bot;
}

// Devuelve a cuántos se les avisó realmente (0 si no hay rol "compras" o si todos los envíos
// fallaron), para que el llamador no afirme "se avisó" cuando en realidad no llegó a nadie.
async function notificarComprador(mensaje) {
  const destinatarios = await telegramIdsPorRol('compras');
  if (destinatarios.length === 0) {
    console.warn('No hay nadie con el rol "compras" para avisar. Revisar /usuarios.');
    return 0;
  }
  let enviados = 0;
  for (const tid of destinatarios) {
    try {
      await botInstance.telegram.sendMessage(tid, mensaje);
      enviados++;
    } catch (err) {
      console.error(`No se pudo avisar al comprador (chat_id ${tid}):`, err.message);
    }
  }
  return enviados;
}

module.exports = { setBot, notificarComprador };
