// Área Marketing. Por ahora solo /imagenes: entrega las imágenes que pide /promoprecios
// (Calidad) para el ciclo activo. Ver src/scenes/imagenes.js.
const imagenesWizard = require('../../scenes/imagenes');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'marketing';

const comandos = [
  { comando: 'imagenes', descripcion: 'Entregar las imágenes pedidas para el ciclo de promociones y precios activo' },
];

function registrar(bot) {
  bot.command('imagenes', requiereArea(CODIGO), (ctx) => ctx.scene.enter('imagenes-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Marketing',
  scenes: [imagenesWizard],
  comandos,
  registrar,
};
