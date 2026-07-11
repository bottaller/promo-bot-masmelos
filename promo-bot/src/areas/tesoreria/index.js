// Área Tesorería.
//  /flujos  — recibe el Excel del "Diario de movimientos" de Sigma y devuelve el HTML del
//             flujo del dinero (el motor corre en Python, ver arqueo/runner.py).
//  /saldos  — recibe el Excel "Existencias al cierre" y guarda los saldos del día en la DB
//             (lado "realidad" de la conciliación).
const flujosWizard = require('../../scenes/flujos');
const saldosWizard = require('../../scenes/saldos');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'tesoreria';

const comandos = [
  { comando: 'flujos', descripcion: 'Flujo del dinero (mandás el Excel de Sigma, te devuelve el dashboard del flujo)' },
  { comando: 'saldos', descripcion: 'Cargar los saldos del día (mandás el Excel de "Existencias al cierre")' },
];

function registrar(bot) {
  bot.command('flujos', requiereArea(CODIGO), (ctx) => ctx.scene.enter('flujos-wizard'));
  bot.command('saldos', requiereArea(CODIGO), (ctx) => ctx.scene.enter('saldos-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Tesorería',
  scenes: [flujosWizard, saldosWizard],
  comandos,
  registrar,
};
