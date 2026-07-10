// Área Tesorería. /arqueo recibe el Excel del "Diario de movimientos" de Sigma y devuelve
// el HTML del flujo del dinero (el motor corre en Python, ver arqueo/runner.py).
const arqueoWizard = require('../../scenes/arqueo');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'tesoreria';

const comandos = [
  { comando: 'arqueo', descripcion: 'Procesar el arqueo de caja (mandás el Excel de Sigma, te devuelve el flujo)' },
];

function registrar(bot) {
  bot.command('arqueo', requiereArea(CODIGO), (ctx) => ctx.scene.enter('arqueo-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Tesorería',
  scenes: [arqueoWizard],
  comandos,
  registrar,
};
