// Comando /usuarios (solo admin): ver usuarios, gestionar roles y admins,
// sin tocar la base a mano ni redeployar.
const { requiereAdmin } = require('../middleware/authz');
const {
  listarUsuarios, agregarUsuarioAArea, quitarUsuarioDeArea, listarAreas, hacerAdmin, quitarAdmin,
} = require('../db/usuarios');

async function manejarUsuarios(ctx) {
  const args = (ctx.message.text || '').trim().split(/\s+/).slice(1); // saca "/usuarios"
  const sub = (args[0] || '').toLowerCase();

  // /usuarios roles -> lista los roles que existen
  if (sub === 'roles') {
    const roles = await listarAreas();
    if (roles.length === 0) return ctx.reply('No hay roles cargados.');
    const lineas = roles.map((r) => `• ${r.codigo} — ${r.nombre}`);
    return ctx.reply(`Roles disponibles:\n\n${lineas.join('\n')}\n\nPara asignar: /usuarios agregar <telegram_id> <rol>`);
  }

  // /usuarios agregar <id> <rol> -> suma un rol (se pueden sumar varios)
  if (sub === 'agregar') {
    const telegramId = args[1];
    const rol = (args[2] || '').toLowerCase();
    if (!telegramId || !/^\d+$/.test(telegramId) || !rol) {
      return ctx.reply('Uso: /usuarios agregar <telegram_id> <rol>\nEjemplo: /usuarios agregar 123456789 calidad');
    }
    const res = await agregarUsuarioAArea(telegramId, null, rol);
    if (!res.ok) {
      const roles = (await listarAreas()).map((r) => r.codigo).join(', ');
      return ctx.reply(`El rol "${rol}" no existe. Roles: ${roles}`);
    }
    return ctx.reply(`Listo ✅ El usuario ${telegramId} sumó el rol "${rol}". (Puede tener varios.)`);
  }

  // /usuarios quitar <id> <rol> -> saca un rol (deja los demás)
  if (sub === 'quitar') {
    const telegramId = args[1];
    const rol = (args[2] || '').toLowerCase();
    if (!telegramId || !/^\d+$/.test(telegramId) || !rol) {
      return ctx.reply('Uso: /usuarios quitar <telegram_id> <rol>\nEjemplo: /usuarios quitar 123456789 calidad');
    }
    const ok = await quitarUsuarioDeArea(telegramId, rol);
    return ctx.reply(ok
      ? `Listo. Al usuario ${telegramId} se le quitó el rol "${rol}".`
      : `El usuario ${telegramId} no tenía el rol "${rol}".`);
  }

  if (sub === 'admin') {
    const telegramId = args[1];
    if (!telegramId || !/^\d+$/.test(telegramId)) {
      return ctx.reply('Uso: /usuarios admin <telegram_id>');
    }
    await hacerAdmin(telegramId, null);
    return ctx.reply(`Listo ✅ El usuario ${telegramId} ahora es ADMIN (acceso total).`);
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
    const tags = [u.es_admin ? 'admin' : null, u.activo ? null : 'inactivo'].filter(Boolean);
    const tagTxt = tags.length ? ` [${tags.join(', ')}]` : '';
    let linea = `• ${u.nombre || '(sin nombre)'} — ${u.telegram_id}${tagTxt}`;
    // El rol solo se muestra para los NO admin (el admin accede a todo igual).
    if (!u.es_admin) {
      const roles = u.areas && u.areas.length ? u.areas.join(', ') : 'sin roles';
      linea += `\n   roles: ${roles}`;
    }
    return linea;
  });

  return ctx.reply(
    `Usuarios (${usuarios.length}):\n\n${lineas.join('\n')}\n\n` +
    'Comandos:\n' +
    '  /usuarios roles\n' +
    '  /usuarios agregar <telegram_id> <rol>\n' +
    '  /usuarios quitar <telegram_id> <rol>\n' +
    '  /usuarios admin <telegram_id>\n' +
    '  /usuarios quitaradmin <telegram_id>'
  );
}

function registrar(bot) {
  bot.command('usuarios', requiereAdmin(), manejarUsuarios);
}

module.exports = { registrar };
