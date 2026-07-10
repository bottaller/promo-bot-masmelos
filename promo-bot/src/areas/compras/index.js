// Área Compras. Por ahora solo el reporte de promociones.
// (El /reporte va a pasar al rol "comprador" cuando se defina; alta/baja se movieron a Calidad.)
const reporteWizard = require('../../scenes/reporte');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'compras';

const comandos = [
  { comando: 'reporte', descripcion: 'Ver reporte por producto o proveedor' },
];

function registrar(bot) {
  bot.command('reporte', requiereArea(CODIGO), (ctx) => ctx.scene.enter('reporte-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Compras',
  scenes: [reporteWizard],
  comandos,
  registrar,
};
