const proveedores = require('../config/proveedores');

let botInstance = null;
function setBot(bot) {
  botInstance = bot;
}

function buscarProveedor(nombreProveedor) {
  const clave = Object.keys(proveedores).find(
    (k) => k.toLowerCase() === nombreProveedor.trim().toLowerCase()
  );
  return clave ? proveedores[clave] : null;
}

async function notificarComprador(nombreProveedor, mensaje) {
  const proveedor = buscarProveedor(nombreProveedor);
  const destinatarios = proveedor ? proveedor.compradores : null;

  if (!destinatarios || destinatarios.length === 0) {
    console.warn(`No hay comprador configurado para el proveedor "${nombreProveedor}". Revisar config/proveedores.js`);
    return;
  }

  for (const dest of destinatarios) {
    if (!dest.chat_id || dest.chat_id === 'PENDIENTE') {
      console.warn(`Falta cargar el chat_id de ${dest.nombre} en config/proveedores.js`);
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
