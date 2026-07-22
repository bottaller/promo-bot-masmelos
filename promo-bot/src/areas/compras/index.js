// Área Compras.
// (El /reporte va a pasar al rol "comprador" cuando se defina; alta/baja se movieron a Calidad.)
const reporteWizard = require('../../scenes/reporte');
const { requiereArea } = require('../../middleware/authz');
const { todasLasAltas } = require('../../db/compras');
const { informesPorDestino } = require('../../db/deposito');
const { construirExcelCompras } = require('../../lib/excel-compras');
const { fechaHoyArgISO } = require('../../lib/fechas');

const CODIGO = 'compras';

const comandos = [
  { comando: 'reporte', descripcion: 'Ver reporte de promociones por proveedor' },
  { comando: 'excel', descripcion: 'Excel con todas las promociones por proveedor + informes de Depósito' },
];

// /excel: todas las altas (abiertas y cerradas), una hoja por proveedor, más los informes de
// Depósito dirigidos a Compras. Complementa a /reporte, que resume un solo proveedor por vez.
async function excel(ctx) {
  const [altas, informes] = await Promise.all([todasLasAltas(), informesPorDestino('compras')]);
  if (altas.length === 0) {
    return ctx.reply('Todavía no hay ninguna promoción cargada.');
  }
  const proveedores = new Set(altas.map((a) => a.proveedor || 'Sin proveedor')).size;
  const buffer = construirExcelCompras(altas, informes);
  await ctx.replyWithDocument(
    { source: buffer, filename: `promociones_compras_${fechaHoyArgISO()}.xlsx` },
    { caption: `Excel — ${altas.length} promoción(es) en ${proveedores} proveedor(es), ${informes.length} informe(s) de Depósito.` }
  );
}

function registrar(bot) {
  bot.command('reporte', requiereArea(CODIGO), (ctx) => ctx.scene.enter('reporte-wizard'));
  bot.command('excel', requiereArea(CODIGO), excel);
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Compras',
  scenes: [reporteWizard],
  comandos,
  registrar,
};
