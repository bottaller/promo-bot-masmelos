// Área Calidad. Registra en promoción por vencimiento (alta), suma cantidad a una promoción ya
// abierta (reposición), cambia el % de descuento de una promoción vigente (cambio de promoción),
// retira de góndola (baja) y genera el control de lo que está en oferta. También sube los
// archivos de ajustes y de promociones/precios, que le llegan al dueño del bot (ver
// scenes/ajuste.js, scenes/promoprecios.js y acciones-calidad.js).
const altaWizard = require('../../scenes/alta');
const reposicionWizard = require('../../scenes/reposicion');
const cambioPromocionWizard = require('../../scenes/cambiopromocion');
const bajaWizard = require('../../scenes/baja');
const ajusteWizard = require('../../scenes/ajuste');
const { promoPreciosWizard, promoPreciosPruebaWizard } = require('../../scenes/promoprecios');
const validarPromoPreciosWizard = require('../../scenes/validar-promoprecios');
const revisarImagenWizard = require('../../scenes/revisar-imagen');
const { requiereArea, requiereDueno } = require('../../middleware/authz');
const { altasEnOferta } = require('../../db/compras');
const { construirExcelControl } = require('../../lib/control-excel');
const { fechaHoyArgISO } = require('../../lib/fechas');

const CODIGO = 'calidad';

const comandos = [
  { comando: 'alta', descripcion: 'Registrar producto en promoción por vencimiento' },
  { comando: 'reposicion', descripcion: 'Sumar cantidad a una promoción ya abierta (mismo producto y vencimiento)' },
  { comando: 'cambiopromocion', descripcion: 'Cambiar el % de descuento de una promoción vigente' },
  { comando: 'baja', descripcion: 'Registrar retiro de góndola (vendido o descartado)' },
  { comando: 'control', descripcion: 'Excel de lo que está en oferta, por vencimiento' },
  { comando: 'ajuste', descripcion: 'Subir el archivo de ajuste para que sea revisado' },
  { comando: 'promoprecios', descripcion: 'Subir el archivo final de promociones y precios' },
];

// /promoprecios_prueba no se lista en `comandos` (solo el dueño la usa, ver requiereDueno) — no
// aparece en /menu ni en el menú "/" de Telegram para nadie más, igual que /carteleria_prueba.

// /control: genera y manda un Excel con todo lo que está en oferta, ordenado por vencimiento.
async function control(ctx) {
  const altas = await altasEnOferta();
  if (altas.length === 0) {
    return ctx.reply('No hay productos en oferta en este momento.');
  }
  const buffer = construirExcelControl(altas);
  await ctx.replyWithDocument(
    { source: buffer, filename: `control_ofertas_${fechaHoyArgISO()}.xlsx` },
    { caption: `Control — ${altas.length} producto(s) en oferta, ordenados por vencimiento.` }
  );
}

function registrar(bot) {
  bot.command('alta', requiereArea(CODIGO), (ctx) => ctx.scene.enter('alta-wizard'));
  bot.command('reposicion', requiereArea(CODIGO), (ctx) => ctx.scene.enter('reposicion-wizard'));
  bot.command('cambiopromocion', requiereArea(CODIGO), (ctx) => ctx.scene.enter('cambiopromocion-wizard'));
  bot.command('baja', requiereArea(CODIGO), (ctx) => ctx.scene.enter('baja-wizard'));
  bot.command('control', requiereArea(CODIGO), control);
  bot.command('ajuste', requiereArea(CODIGO), (ctx) => ctx.scene.enter('ajuste-wizard'));
  bot.command('promoprecios', requiereArea(CODIGO), (ctx) => ctx.scene.enter('promoprecios-wizard'));
  bot.command('promoprecios_prueba', requiereDueno(), (ctx) => ctx.scene.enter('promoprecios-prueba-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Calidad',
  scenes: [altaWizard, reposicionWizard, cambioPromocionWizard, bajaWizard, ajusteWizard, promoPreciosWizard, promoPreciosPruebaWizard, validarPromoPreciosWizard, revisarImagenWizard],
  comandos,
  registrar,
};
