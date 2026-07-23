// Autorización por área / por rol de admin. Se usa envolviendo cada comando.
// Asume que el middleware de auth ya dejó el usuario en ctx.state.usuario.

// Admin real, o el rol "sistemas" (ve y usa TODO — todas las áreas y los comandos admin-only que
// están gateados con requiereAdminOSistemas() — pero NO es admin de verdad: no recibe los avisos
// que van "a los admins" —eso sigue filtrando por es_admin=true, ver telegramIdsAdmins()— ni puede
// hacer/sacar admin a nadie desde /usuarios). Usarlo en vez de u.es_admin en cualquier chequeo de
// "¿pertenece a esta área?" — nunca en un chequeo de "¿es admin de verdad?" (para eso, requiereAdmin()).
function tieneAccesoTotal(usuario) {
  return !!(usuario && (usuario.es_admin || (usuario.areas && usuario.areas.includes('sistemas'))));
}

// Deja pasar solo si el usuario tiene acceso total (admin o "sistemas") o pertenece al área pedida.
function requiereArea(codigo) {
  return async (ctx, next) => {
    const u = ctx.state.usuario;
    if (u && (tieneAccesoTotal(u) || (u.areas && u.areas.includes(codigo)))) {
      return next();
    }
    await ctx.reply(`No tenés acceso al área "${codigo}".`);
  };
}

// Deja pasar solo si el usuario es admin DE VERDAD (no alcanza con "sistemas"). Para las acciones
// más sensibles: hacer/sacar admin a alguien.
function requiereAdmin() {
  return async (ctx, next) => {
    if (ctx.state.usuario && ctx.state.usuario.es_admin) return next();
    await ctx.reply('Este comando es solo para administradores.');
  };
}

// Deja pasar a admin real O al rol "sistemas". Para los comandos admin-only que "sistemas" sí
// puede ver y usar (/usuarios, /actartic, /avisos, /libro, /reportecierre).
function requiereAdminOSistemas() {
  return async (ctx, next) => {
    if (tieneAccesoTotal(ctx.state.usuario)) return next();
    await ctx.reply('Este comando es solo para administradores.');
  };
}

module.exports = { requiereArea, requiereAdmin, requiereAdminOSistemas, tieneAccesoTotal };
