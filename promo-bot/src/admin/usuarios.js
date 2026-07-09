// Comando /usuarios (solo admin): ver usuarios y darlos de alta en áreas,
// sin tocar la base a mano ni redeployar.
const { requiereAdmin } = require('../middleware/authz');
const { listarUsuarios, agregarUsuarioAArea, listarAreas, hacerAdmin, quitarAdmin } = require('../db/usuarios');

async function manejarUsuarios(ctx) {
  const args = (ctx.message.text || '').trim().split(/\s+/).slice(1); // saca "/usuarios"
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'agregar') {
    const telegramId = args[1];
    const areaCodigo = (args[2] || '').toLowerCase();
    if (!telegramId || !/^\d+$/.test(telegramId) || !areaCodigo) {
      return ctx.reply('Uso: /usuarios agregar <telegram_id> <area>\nEjemplo: /usuarios agregar 123456789 tesoreria');
    }
    const res = await agregarUsuarioAArea(telegramId, null, areaCodigo);
    if (!res.ok) {
      const areas = (await listarAreas()).map((a) => a.codigo).join(', ');
      return ctx.reply(`El área "${areaCodigo}" no existe. Áreas disponibles: ${areas}`);
    }
    return ctx.reply(`Listo ✅ El usuario ${telegramId} quedó habilitado en el área "${areaCodigo}".`);
  }

  if (sub === 'admin') {
    const telegramId = args[1];
    if (!telegramId || !/^\d+$/.test(telegramId)) {
      return ctx.reply('Uso: /usuarios admin <telegram_id>');
    }
    await hacerAdmin(telegramId, null);
    return ctx.reply(`Listo ✅ El usuario ${telegramId} ahora es ADMIN (acceso total a todas las áreas).`);
  }

  if (sub === 'quitaradmin') {
    const telegramId = args[1];
    if (!telegramId || !/^\d+$/.test(telegramId)) {
      return ctx.reply('Uso: /usuarios quitaradmin <telegram_id>');
    }
    if (telegramId === String(ctx.from.id)) {
      return ctx.reply('No te podés sacar el admin a vos mismo.');
    }
    const ok = await quitarAdmin(telegramId);
    return ctx.reply(ok
      ? `Listo. El usuario ${telegramId} ya no es admin.`
      : `No encontré ningún usuario con ID ${telegramId}.`);
  }

  // Sin subcomando: listar usuarios.
  const usuarios = await listarUsuarios();
  if (usuarios.length === 0) return ctx.reply('No hay usuarios cargados todavía.');

  const lineas = usuarios.map((u) => {
    const areas = u.areas && u.areas.length ? u.areas.join(', ') : 'sin áreas';
    const tags = [u.es_admin ? 'admin' : null, u.activo ? null : 'inactivo'].filter(Boolean);
    const tagTxt = tags.length ? ` [${tags.join(', ')}]` : '';
    return `• ${u.nombre || '(sin nombre)'} — ${u.telegram_id}${tagTxt}\n   áreas: ${areas}`;
  });

  return ctx.reply(
    `Usuarios (${usuarios.length}):\n\n${lineas.join('\n')}\n\n` +
    'Comandos:\n' +
    '  /usuarios agregar <telegram_id> <area>\n' +
    '  /usuarios admin <telegram_id>\n' +
    '  /usuarios quitaradmin <telegram_id>'
  );
}

function registrar(bot) {
  bot.command('usuarios', requiereAdmin(), manejarUsuarios);
}

module.exports = { registrar };
