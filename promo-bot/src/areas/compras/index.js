// Área Compras. /ingreso carga el Excel de ingresos del día del proveedor a public.ingresos (la
// lee la web). /faltantes baja el Excel de productos que Ventas y Depósito reportaron como
// faltantes o con poco stock (ver scenes/falta.js). (El /reporte va a pasar al rol "comprador"
// cuando se defina; alta/baja se movieron a Calidad.)
const reporteWizard = require('../../scenes/reporte');
const excelWizard = require('../../scenes/excel');
const ingresoWizard = require('../../scenes/ingreso');
const { requiereArea } = require('../../middleware/authz');
const { faltantesConsolidados } = require('../../db/faltantes');
const { construirExcelFaltantes } = require('../../lib/faltantes-excel');
const { fechaHoyArgISO } = require('../../lib/fechas');

const CODIGO = 'compras';
const DIAS_FALTANTES = 14; // ventana móvil del reporte de faltantes (2 semanas)

const comandos = [
  { comando: 'ingreso', descripcion: 'Cargar los ingresos de mercadería del día (subir el Excel)' },
  { comando: 'faltantes', descripcion: 'Bajar el Excel de faltantes reportados (últimas 2 semanas)' },
  { comando: 'reporte', descripcion: 'Ver reporte de promociones por proveedor' },
  { comando: 'excel', descripcion: 'Excel con todas las promociones (histórico o por lapso) + informes de Depósito' },
];

// /faltantes: consolida los reportes de /falta de las últimas 2 semanas (una fila por producto,
// dedupeado) y los manda como Excel para que Compras lo reenvíe con su anotación.
async function enviarFaltantes(ctx) {
  let grupos = [];
  try {
    grupos = await faltantesConsolidados(DIAS_FALTANTES);
  } catch (err) {
    console.error('Error armando /faltantes:', err);
    await ctx.reply('❌ No pude armar el reporte de faltantes. Probá de nuevo o avisá al admin.');
    return;
  }
  if (!grupos.length) {
    await ctx.reply('No hay faltantes reportados en las últimas 2 semanas.');
    return;
  }
  const buffer = construirExcelFaltantes(grupos, DIAS_FALTANTES);
  await ctx.replyWithDocument(
    { source: buffer, filename: `faltantes_${fechaHoyArgISO()}.xlsx` },
    { caption: `Faltantes — ${grupos.length} producto(s) reportado(s) en las últimas 2 semanas.` }
  );
}

function registrar(bot) {
  bot.command('ingreso', requiereArea(CODIGO), (ctx) => ctx.scene.enter('ingreso-wizard'));
  bot.command('faltantes', requiereArea(CODIGO), enviarFaltantes);
  bot.command('reporte', requiereArea(CODIGO), (ctx) => ctx.scene.enter('reporte-wizard'));
  bot.command('excel', requiereArea(CODIGO), (ctx) => ctx.scene.enter('excel-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Compras',
  scenes: [ingresoWizard, reporteWizard, excelWizard],
  comandos,
  registrar,
};
