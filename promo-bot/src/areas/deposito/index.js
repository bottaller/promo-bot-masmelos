// Área Depósito: /informe (informes en texto libre dirigidos a Calidad o Compras) y /carteleria
// (pedido de cartel a Marketing, ver scenes/carteleria.js).
const informeWizard = require('../../scenes/informe');
const carteleriaWizard = require('../../scenes/carteleria');
const corregirCarteleriaWizard = require('../../scenes/corregir-carteleria');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'deposito';

const comandos = [
  { comando: 'informe', descripcion: 'Cargar un informe sobre un proveedor o producto, para Calidad o Compras' },
  { comando: 'carteleria', descripcion: 'Pedir un cartel (foto de producto + precio) para Marketing' },
];

function registrar(bot) {
  bot.command('informe', requiereArea(CODIGO), (ctx) => ctx.scene.enter('informe-wizard'));
  bot.command('carteleria', requiereArea(CODIGO), (ctx) => ctx.scene.enter('carteleria-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Depósito',
  scenes: [informeWizard, carteleriaWizard, corregirCarteleriaWizard],
  comandos,
  registrar,
};
