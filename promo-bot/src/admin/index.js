// Comandos de administración (admin o rol "sistemas"). Agrupa el /usuarios y el /actartic.
const usuarios = require('./usuarios');
const actArticWizard = require('./scenes/actArtic');
const { requiereAdminOSistemas } = require('../middleware/authz');
const { revisarVencimientos } = require('../avisos');

// Scenes de admin que hay que registrar en el Stage.
const scenes = [actArticWizard];

function registrar(bot) {
  usuarios.registrar(bot);
  bot.command('actartic', requiereAdminOSistemas(), (ctx) => ctx.scene.enter('actartic-wizard'));

  // Dispara el chequeo de vencimientos al instante (para probar sin esperar la corrida diaria).
  bot.command('avisos', requiereAdminOSistemas(), async (ctx) => {
    const r = await revisarVencimientos(ctx.telegram);
    await ctx.reply(
      'Chequeo de vencimientos hecho.\n' +
      `Por vencer (mañana/hoy): ${r.porVencer} → ${r.avisosPorVencer} aviso(s) a Calidad.\n` +
      `Vencidos: ${r.vencido} → ${r.avisosVencido} aviso(s) a creador + admins.`
    );
  });
}

module.exports = { scenes, registrar };
