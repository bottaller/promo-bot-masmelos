const { Scenes } = require('telegraf');
const { reportePorProveedor } = require('../db/compras');
const { buscarProveedorPorCodigo } = require('../db/articulos');
const { respuesta, esCancelar, opciones, preguntar } = require('../lib/wizard');
const { parseVencimiento, formatoVencimiento, fechaHoyArg } = require('../lib/fechas');

// Telegram corta los mensajes de más de 4096 caracteres.
function recortar(msg) {
  return msg.length > 4000 ? msg.slice(0, 4000) + '\n…(reporte cortado, afiná la búsqueda)' : msg;
}

// Arma y manda el reporte de un proveedor ya validado. `desde` (Date u null): si viene,
// el reporte es de ese lapso hasta hoy; si no, es histórico completo.
async function mostrarReporte(ctx, proveedor, desde) {
  const r = await reportePorProveedor(proveedor, { desde });
  if (!r) {
    const periodo = desde ? ' en el lapso elegido' : '';
    await ctx.reply(`El proveedor "${proveedor}" no tiene promociones${periodo}.`);
    return;
  }
  const m = r.metricas;
  const tasa = Math.round(m.tasaDescarte * 100);
  const hayCerradas = m.puestasCerradas > 0;
  const detalle = r.porProducto
    .map((p) => `• ${p.producto}: ${p.altas} alta(s), ${p.efectividad}% efectividad`)
    .join('\n');
  const enPromo = m.abiertas > 0
    ? `${m.puestasAbiertas} unidades (${m.abiertas} alta${m.abiertas > 1 ? 's' : ''} abierta${m.abiertas > 1 ? 's' : ''})`
    : 'nada (todo cerrado)';
  const msg =
    `📦 Reporte — proveedor ${r.proveedor}\n` +
    `Período: ${desde ? `desde ${formatoVencimiento(desde)} hasta hoy` : 'histórico completo'}\n` +
    `Generado: ${fechaHoyArg()}\n\n` +
    `🟢 En promoción ahora: ${enPromo}\n\n` +
    `📊 Resumen:\n` +
    `Productos distintos: ${r.productos}\n` +
    `Unidades puestas: ${m.puestasTotal}\n` +
    `Vendidas en promo: ${m.vendidas}\n` +
    `Descartadas: ${m.descartadas}\n` +
    `Efectividad global: ${hayCerradas ? m.efectividad + '%' : 'sin promociones cerradas todavía'}\n` +
    `Tasa de descarte: ${hayCerradas ? tasa + '%' : '—'}\n` +
    `\nDetalle por producto:\n${detalle}`;
  await ctx.reply(recortar(msg));
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
