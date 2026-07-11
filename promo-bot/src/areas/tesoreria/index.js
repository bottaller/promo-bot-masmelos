// Área Tesorería.
//  /flujos  — recibe el Excel del "Diario de movimientos" de Sigma y devuelve el HTML del
//             flujo del dinero (el motor corre en Python, ver arqueo/runner.py).
//  /cierre  — cierre diario: recibe el Excel "Existencias al cierre" y guarda los saldos del
//             día en la DB, con control de cambios (confirmación + aviso a admins). El libro
//             diario + la conciliación se suman en la próxima fase.
const flujosWizard = require('../../scenes/flujos');
const cierreWizard = require('../../scenes/cierre');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'tesoreria';

const comandos = [
  { comando: 'flujos', descripcion: 'Flujo del dinero (mandás el Excel de Sigma, te devuelve el dashboard del flujo)' },
  { comando: 'cierre', descripcion: 'Cierre diario: cargar los saldos del día (Excel "Existencias al cierre")' },
];

function registrar(bot) {
  bot.command('flujos', requiereArea(CODIGO), (ctx) => ctx.scene.enter('flujos-wizard'));
  bot.command('cierre', requiereArea(CODIGO), (ctx) => ctx.scene.enter('cierre-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Tesorería',
  scenes: [flujosWizard, cierreWizard],
  comandos,
  registrar,
};
