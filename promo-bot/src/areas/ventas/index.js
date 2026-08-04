// Área Ventas. Hasta ahora 'ventas' era solo un rol de aviso (recibe los /promoprecios); ahora
// estrena comando: /falta, para avisar que un producto falta o queda poco. El MISMO comando lo
// usa Depósito (ver areas/deposito), por eso se gatea a "ventas O deposito" con requiereAlgunaArea
// y también se lista en los `comandos` de Depósito — pero el handler se registra UNA sola vez, acá.
const faltaWizard = require('../../scenes/falta');
const { requiereAlgunaArea } = require('../../middleware/authz');

const CODIGO = 'ventas';

const comandos = [
  { comando: 'falta', descripcion: 'Avisar que un producto falta o queda poco (le llega a Compras)' },
];

function registrar(bot) {
  bot.command('falta', requiereAlgunaArea(['ventas', 'deposito']), (ctx) => ctx.scene.enter('falta-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Ventas',
  scenes: [faltaWizard],
  comandos,
  registrar,
};
