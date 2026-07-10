// Comandos de administración (solo admin). Agrupa el /usuarios y el /actartic.
const usuarios = require('./usuarios');
const actArticWizard = require('./scenes/actArtic');
const { requiereAdmin } = require('../middleware/authz');
const { revisarVencimientos } = require('../avisos');

// Scenes de admin que hay que registrar en el Stage.
const scenes = [actArticWizard];

function registrar(bot) {
  usuarios.registrar(bot);
  bot.command('actartic', requiereAdmin(), (ctx) => ctx.scene.enter('actartic-wizard'));
}

module.exports = { scenes, registrar };
