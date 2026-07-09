// Autorización por área / por rol de admin. Se usa envolviendo cada comando.
// Asume que el middleware de auth ya dejó el usuario en ctx.state.usuario.

// Deja pasar solo si el usuario es admin o pertenece al área pedida.
function requiereArea(codigo) {
  return async (ctx, next) => {
    const u = ctx.state.usuario;
    if (u && (u.es_admin || (u.areas && u.areas.includes(codigo)))) {
      return next();
    }
    await ctx.reply(`No tenés acceso al área "${codigo}".`);
  };
}

// Deja pasar solo si el usuario es admin.
function requiereAdmin() {
  return async (ctx, next) => {
    if (ctx.state.usuario && ctx.state.usuario.es_admin) return next();
    await ctx.reply('Este comando es solo para administradores.');
  };
}

module.exports = { requiereArea, requiereAdmin };
