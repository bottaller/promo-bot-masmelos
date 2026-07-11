// Área Tesorería.
//  /arqueo  — recibe el Excel del "Diario de movimientos" de Sigma y devuelve el HTML del flujo
//             (el motor corre en Python, ver arqueo/runner.py).
//  /saldos  — recibe el Excel "Existencias al cierre" y guarda los saldos del día en la DB
//             (lado "realidad" de la conciliación).
const arqueoWizard = require('../../scenes/arqueo');
const saldosWizard = require('../../scenes/saldos');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'tesoreria';

const comandos = [
  { comando: 'arqueo', descripcion: 'Procesar el arqueo de caja (mandás el Excel de Sigma, te devuelve el flujo)' },
  { comando: 'saldos', descripcion: 'Cargar los saldos del día (mandás el Excel de "Existencias al cierre")' },
];

function registrar(bot) {
  bot.command('arqueo', requiereArea(CODIGO), (ctx) => ctx.scene.enter('arqueo-wizard'));
  bot.command('saldos', requiereArea(CODIGO), (ctx) => ctx.scene.enter('saldos-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Tesorería',
  scenes: [arqueoWizard, saldosWizard],
  comandos,
  registrar,
};
