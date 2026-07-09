// Área Compras. Los comandos de promociones por vencimiento (lo que ya existía),
// ahora detrás del control de acceso por área.
//
// Nota: las scenes siguen en src/scenes/ y los datos en Google Sheets. Eso se migra
// a Postgres en la Fase 3; por ahora se mantiene funcionando tal cual.
const altaWizard = require('../../scenes/alta');
const bajaWizard = require('../../scenes/baja');
const reporteWizard = require('../../scenes/reporte');
const { requiereArea } = require('../../middleware/authz');
const { estaConfigurado } = require('../../sheets');

const CODIGO = 'compras';

const comandos = [
  { comando: 'alta', descripcion: 'Registrar producto en promoción por vencimiento' },
  { comando: 'baja', descripcion: 'Registrar retiro de góndola (vendido o descartado)' },
  { comando: 'reporte', descripcion: 'Ver historial por SKU o proveedor' },
];

// Si Google Sheets todavía no está configurado, avisamos en vez de romper.
function conSheets(handler) {
  return (ctx) => {
    if (!estaConfigurado()) {
      return ctx.reply(
        'El área de Compras todavía no está conectada a la planilla. ' +
        'Faltan las credenciales de Google Sheets — avisale al admin.'
      );
    }
    return handler(ctx);
  };
}

function registrar(bot) {
  bot.command('alta', requiereArea(CODIGO), conSheets((ctx) => ctx.scene.enter('alta-wizard')));
  bot.command('baja', requiereArea(CODIGO), conSheets((ctx) => ctx.scene.enter('baja-wizard')));
  bot.command('reporte', requiereArea(CODIGO), conSheets((ctx) => ctx.scene.enter('reporte-wizard')));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Compras',
  scenes: [altaWizard, bajaWizard, reporteWizard],
  comandos,
  registrar,
};
