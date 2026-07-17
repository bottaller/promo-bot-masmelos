// Avisos por rol. Cualquier evento (movimiento de una promoción, informe de Depósito, etc.) se
// avisa a TODOS los que tienen el rol correspondiente en bot.usuarios/bot.usuario_area, sin
// mapeos puntuales por proveedor ni por persona.
const { telegramIdsPorRol } = require('./db/usuarios');

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

module.exports = { setBot, notificarPorRol, notificarComprador };
