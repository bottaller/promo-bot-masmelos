const { Scenes } = require('telegraf');
const { reportePorProveedor } = require('../db/compras');
const { buscarProveedorPorCodigo } = require('../db/articulos');
const { respuesta, esCancelar, opciones, preguntar } = require('../lib/wizard');
const { parseVencimiento } = require('../lib/fechas');
const { formatearReporteProveedor, recortarReporte } = require('../lib/reporte-proveedor');

// Arma y manda el reporte de un proveedor ya validado. `desde` (Date u null): si viene,
// el reporte es de ese lapso hasta hoy; si no, es histórico completo.
async function mostrarReporte(ctx, proveedor, desde) {
  const r = await reportePorProveedor(proveedor, { desde });
  if (!r) {
    const periodo = desde ? ' en el lapso elegido' : '';
    await ctx.reply(`El proveedor "${proveedor}" no tiene promociones${periodo}.`);
    return;
  }
  await ctx.reply(recortarReporte(formatearReporteProveedor(r, desde)));
}

const reporteWizard = new Scenes.WizardScene(
  'reporte-wizard',
  // 0: pedir código de proveedor
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply('Reporte de promociones por proveedor.\n\n¿Código de proveedor? (o "cancelar")');
    return ctx.wizard.next();
  },
  // 1: validar código contra el maestro de artículos
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Reporte cancelado.'); return ctx.scene.leave(); }
    if (!r) { await ctx.reply('Escribí el código de proveedor.'); return; }

    const prov = await buscarProveedorPorCodigo(r);
    if (!prov) {
      await ctx.reply(`El código de proveedor "${r}" es inexistente. Revisalo e intentá de nuevo con /reporte.`);
      return ctx.scene.leave();
    }
    ctx.wizard.state.data.proveedor = prov.proveedor;
    await preguntar(
      ctx,
      `Proveedor: ${prov.proveedor}\n\n¿Reporte histórico o de un lapso de tiempo?`,
      opciones([['Histórico', 'historico'], ['Lapso de tiempo', 'lapso']])
    );
    return ctx.wizard.next();
  },
  // 2: rutear histórico / lapso
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Reporte cancelado.'); return ctx.scene.leave(); }
    if (r === 'historico') {
      await mostrarReporte(ctx, ctx.wizard.state.data.proveedor, null);
      return ctx.scene.leave();
    }
    if (r === 'lapso') {
      await ctx.reply('¿Desde qué fecha querés el reporte? (DD/MM/AAAA, hasta hoy)');
      return ctx.wizard.next();
    }
    await ctx.reply('Elegí "Histórico" o "Lapso de tiempo".');
    return;
  },
  // 3: fecha desde -> generar reporte del lapso
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Reporte cancelado.'); return ctx.scene.leave(); }
    if (!r) { await ctx.reply('Escribí la fecha desde la que querés el reporte (DD/MM/AAAA).'); return; }
    const desde = parseVencimiento(r);
    if (!desde) {
      await ctx.reply('No entendí la fecha. Escribila como DD/MM/AAAA, por ejemplo 01/06/2026.');
      return;
    }
    await mostrarReporte(ctx, ctx.wizard.state.data.proveedor, desde);
    return ctx.scene.leave();
  }
);

module.exports = reporteWizard;
