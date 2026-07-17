// Área Depósito. Por ahora solo /informe: informes en texto libre dirigidos a Calidad o Compras,
// que se avisan automáticamente a todos los que tengan el rol correspondiente.
const informeWizard = require('../../scenes/informe');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'deposito';

const comandos = [
  { comando: 'informe', descripcion: 'Cargar un informe sobre un proveedor o producto, para Calidad o Compras' },
];

function registrar(bot) {
  bot.command('informe', requiereArea(CODIGO), (ctx) => ctx.scene.enter('informe-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Depósito',
  scenes: [informeWizard],
  comandos,
  registrar,
};
