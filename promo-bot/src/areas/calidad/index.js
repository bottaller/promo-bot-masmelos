// Área Calidad. Registra en promoción por vencimiento (alta), retira de góndola (baja)
// y control de calidad (por definir).
const altaWizard = require('../../scenes/alta');
const bajaWizard = require('../../scenes/baja');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'calidad';

const comandos = [
  { comando: 'alta', descripcion: 'Registrar producto en promoción por vencimiento' },
  { comando: 'baja', descripcion: 'Registrar retiro de góndola (vendido o descartado)' },
  { comando: 'control', descripcion: 'Control de calidad (próximamente)' },
];

function registrar(bot) {
  bot.command('alta', requiereArea(CODIGO), (ctx) => ctx.scene.enter('alta-wizard'));
  bot.command('baja', requiereArea(CODIGO), (ctx) => ctx.scene.enter('baja-wizard'));
  bot.command('control', requiereArea(CODIGO), (ctx) =>
    ctx.reply('El comando /control va a estar disponible pronto (control de calidad).')
  );
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Calidad',
  scenes: [altaWizard, bajaWizard],
  comandos,
  registrar,
};
