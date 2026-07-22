// Wizard /excel (área Compras): Excel con todas las promociones (abiertas y cerradas) + los
// informes de Depósito para Compras. Histórico completo o de un lapso, igual que /reporte.
const { Scenes } = require('telegraf');
const { todasLasAltas } = require('../db/compras');
const { informesPorDestino } = require('../db/deposito');
const { construirExcelCompras } = require('../lib/excel-compras');
const { respuesta, esCancelar, opciones, preguntar } = require('../lib/wizard');
const { parseVencimiento, fechaHoyArgISO } = require('../lib/fechas');

async function generarYEnviar(ctx, desde) {
  const [altas, informes] = await Promise.all([todasLasAltas({ desde }), informesPorDestino('compras')]);
  if (altas.length === 0) {
    await ctx.reply('No hay ninguna promoción en ese período.');
    return;
  }
  const proveedores = new Set(altas.map((a) => a.proveedor || 'Sin proveedor')).size;
  const buffer = construirExcelCompras(altas, informes);
  await ctx.replyWithDocument(
    { source: buffer, filename: `promociones_compras_${fechaHoyArgISO()}.xlsx` },
    { caption: `Excel — ${altas.length} promoción(es) en ${proveedores} proveedor(es), ${informes.length} informe(s) de Depósito.` }
  );
}

const excelWizard = new Scenes.WizardScene(
  'excel-wizard',
  // 0: histórico o lapso
  async (ctx) => {
    ctx.wizard.state.data = {};
    await preguntar(
      ctx,
      'Excel de promociones para Compras.\n\n¿Histórico completo o un lapso de tiempo?',
      opciones([['Histórico', 'historico'], ['Lapso de tiempo', 'lapso']])
    );
    return ctx.wizard.next();
  },
  // 1: rutear histórico / lapso
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (r === 'historico') {
      await generarYEnviar(ctx, null);
      return ctx.scene.leave();
    }
    if (r === 'lapso') {
      await ctx.reply('¿Desde qué fecha querés el Excel? (DD/MM/AAAA, hasta hoy)');
      return ctx.wizard.next();
    }
    await ctx.reply('Elegí "Histórico" o "Lapso de tiempo".');
  },
  // 2: fecha desde -> generar
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!r) { await ctx.reply('Escribí la fecha desde la que querés el Excel (DD/MM/AAAA).'); return; }
    const desde = parseVencimiento(r);
    if (!desde) {
      await ctx.reply('No entendí la fecha. Escribila como DD/MM/AAAA, por ejemplo 01/06/2026.');
      return;
    }
    await generarYEnviar(ctx, desde);
    return ctx.scene.leave();
  }
);

module.exports = excelWizard;
