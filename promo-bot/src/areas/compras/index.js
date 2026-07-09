// Área Compras. Promociones por vencimiento (Postgres) + búsqueda de artículos.
const altaWizard = require('../../scenes/alta');
const bajaWizard = require('../../scenes/baja');
const reporteWizard = require('../../scenes/reporte');
const { requiereArea } = require('../../middleware/authz');
const { buscarPorEan } = require('../../db/articulos');

const CODIGO = 'compras';

const comandos = [
  { comando: 'alta', descripcion: 'Registrar producto en promoción por vencimiento' },
  { comando: 'baja', descripcion: 'Registrar retiro de góndola (vendido o descartado)' },
  { comando: 'reporte', descripcion: 'Ver reporte por producto o proveedor' },
  { comando: 'buscar', descripcion: 'Buscar un artículo por EAN o primeros dígitos' },
];

// /buscar <ean o primeros dígitos>: busca en el maestro de artículos.
async function buscar(ctx) {
  const q = (ctx.message.text || '').trim().split(/\s+/).slice(1).join('');
  if (!q || !/^\d+$/.test(q)) {
    return ctx.reply('Uso: /buscar <EAN o primeros dígitos>\nEjemplo: /buscar 779007');
  }
  const resultados = await buscarPorEan(q, 10);
  if (resultados.length === 0) {
    return ctx.reply(`No encontré artículos con EAN que empiece en "${q}".`);
  }
  const lineas = resultados.map((a) =>
    `• ${a.nombre}\n   EAN ${a.ean_unidad || '-'} · ${a.rubro || ''} · ${a.proveedor || ''}`
  );
  const extra = resultados.length === 10 ? '\n\n(hay más resultados; agregá más dígitos)' : '';
  return ctx.reply(`Resultados para "${q}":\n\n${lineas.join('\n')}${extra}`);
}

function registrar(bot) {
  bot.command('alta', requiereArea(CODIGO), (ctx) => ctx.scene.enter('alta-wizard'));
  bot.command('baja', requiereArea(CODIGO), (ctx) => ctx.scene.enter('baja-wizard'));
  bot.command('reporte', requiereArea(CODIGO), (ctx) => ctx.scene.enter('reporte-wizard'));
  bot.command('buscar', requiereArea(CODIGO), buscar);
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Compras',
  scenes: [altaWizard, bajaWizard, reporteWizard],
  comandos,
  registrar,
};
