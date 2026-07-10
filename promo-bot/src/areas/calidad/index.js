// Área Calidad. Registra en promoción por vencimiento (alta), suma cantidad a una promoción ya
// abierta (reposición), retira de góndola (baja) y genera el control de lo que está en oferta.
const altaWizard = require('../../scenes/alta');
const reposicionWizard = require('../../scenes/reposicion');
const bajaWizard = require('../../scenes/baja');
const { requiereArea } = require('../../middleware/authz');
const { altasEnOferta } = require('../../db/compras');
const { construirExcelControl } = require('../../lib/control-excel');
const { fechaHoyArgISO } = require('../../lib/fechas');

const CODIGO = 'calidad';

const comandos = [
  { comando: 'alta', descripcion: 'Registrar producto en promoción por vencimiento' },
  { comando: 'reposicion', descripcion: 'Sumar cantidad a una promoción ya abierta (mismo producto y vencimiento)' },
  { comando: 'baja', descripcion: 'Registrar retiro de góndola (vendido o descartado)' },
  { comando: 'control', descripcion: 'Excel de lo que está en oferta, por vencimiento' },
];

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
  bot.command('baja', requiereArea(CODIGO), (ctx) => ctx.scene.enter('baja-wizard'));
  bot.command('control', requiereArea(CODIGO), control);
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Calidad',
  scenes: [altaWizard, reposicionWizard, bajaWizard],
  comandos,
  registrar,
};
