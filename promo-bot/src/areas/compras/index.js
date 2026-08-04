// Área Compras. /ingreso carga el Excel de ingresos del día del proveedor a public.ingresos (la
// lee la web). (El /reporte va a pasar al rol "comprador" cuando se defina; alta/baja se movieron
// a Calidad.)
const reporteWizard = require('../../scenes/reporte');
const excelWizard = require('../../scenes/excel');
const ingresoWizard = require('../../scenes/ingreso');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'compras';

const comandos = [
  { comando: 'ingreso', descripcion: 'Cargar los ingresos de mercadería del día (subir el Excel)' },
  { comando: 'reporte', descripcion: 'Ver reporte de promociones por proveedor' },
  { comando: 'excel', descripcion: 'Excel con todas las promociones (histórico o por lapso) + informes de Depósito' },
];

function registrar(bot) {
  bot.command('ingreso', requiereArea(CODIGO), (ctx) => ctx.scene.enter('ingreso-wizard'));
  bot.command('reporte', requiereArea(CODIGO), (ctx) => ctx.scene.enter('reporte-wizard'));
  bot.command('excel', requiereArea(CODIGO), (ctx) => ctx.scene.enter('excel-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Compras',
  scenes: [ingresoWizard, reporteWizard, excelWizard],
  comandos,
  registrar,
};
