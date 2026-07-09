// Middleware de identidad: corre antes que todo. Identifica al usuario por su
// telegram_id. Si no está registrado o está inactivo, corta acá. Si está, deja
// el usuario en ctx.state.usuario para que lo usen los demás handlers.
const { buscarPorTelegramId, completarNombreSiFalta } = require('../db/usuarios');

async function auth(ctx, next) {
  // Updates sin remitente (channel_post, etc.): los ignoramos.
  if (!ctx.from) return;

  const usuario = await buscarPorTelegramId(ctx.from.id);

  if (!usuario || !usuario.activo) {
    // Solo respondemos en chats privados, para no molestar en grupos.
    if (ctx.chat && ctx.chat.type === 'private') {
      await ctx.reply(
        'No tenés acceso a este bot.\n\n' +
        `Pedile el alta al administrador y pasale tu ID: ${ctx.from.id}`
      );
    }
    return; // no continúa
  }

  // Si entró sin nombre (lo cargó el admin por ID), lo completamos con el de Telegram.
  if (!usuario.nombre) {
    const nombre = ctx.from.username || ctx.from.first_name || null;
    if (nombre) {
      usuario.nombre = nombre;
      completarNombreSiFalta(ctx.from.id, nombre).catch(() => {});
    }
  }

  ctx.state.usuario = usuario;
  return next();
}

module.exports = { auth };
