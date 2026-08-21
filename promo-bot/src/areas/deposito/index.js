// Área Depósito: /informe (informes en texto libre dirigidos a Calidad o Compras) y /carteleria
// (pedido de cartel a Marketing, ver scenes/carteleria.js). /carteleria_prueba es el mismo wizard
// en modo prueba (solo el dueño del bot, ver requiereDueno): el diseño y la verificación vuelven
// a quien lo prueba en vez de salir para Marketing real. /carteleria_marketing es análogo pero
// para una persona puntual de Marketing (ver requiereMarketingCarteleria) y sin el texto
// "🧪 PRUEBA". Ninguno de los dos está en `comandos` a propósito (no se anuncian en /menu para
// nadie más), se usan tipeándolos directo.
const informeWizard = require('../../scenes/informe');
const { carteleriaWizard, carteleriaPruebaWizard, carteleriaMarketingWizard } = require('../../scenes/carteleria');
const corregirCarteleriaWizard = require('../../scenes/corregir-carteleria');
const { requiereArea, requiereDueno, requiereMarketingCarteleria } = require('../../middleware/authz');

const CODIGO = 'deposito';

const comandos = [
  { comando: 'informe', descripcion: 'Cargar un informe sobre un proveedor o producto, para Calidad o Compras' },
  { comando: 'carteleria', descripcion: 'Pedir un cartel (foto de producto + precio) para Marketing' },
  // /falta lo comparte con Ventas: el handler se registra en areas/ventas (gateado a "ventas O
  // deposito"). Acá se lista solo para que aparezca en el /menu de Depósito.
  { comando: 'falta', descripcion: 'Avisar que un producto falta o queda poco (le llega a Compras)' },
];

function registrar(bot) {
  bot.command('informe', requiereArea(CODIGO), (ctx) => ctx.scene.enter('informe-wizard'));
  bot.command('carteleria', requiereArea(CODIGO), (ctx) => ctx.scene.enter('carteleria-wizard'));
  bot.command('carteleria_prueba', requiereDueno(), (ctx) => ctx.scene.enter('carteleria-prueba-wizard'));
  bot.command('carteleria_marketing', requiereMarketingCarteleria(), (ctx) => ctx.scene.enter('carteleria-marketing-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Depósito',
  scenes: [informeWizard, carteleriaWizard, carteleriaPruebaWizard, carteleriaMarketingWizard, corregirCarteleriaWizard],
  comandos,
  registrar,
};
