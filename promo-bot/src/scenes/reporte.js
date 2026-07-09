const { Scenes, Markup } = require('telegraf');
const { reportePorProducto, reportePorProveedor } = require('../db/compras');

function texto(ctx) {
  const t = ctx.message && ctx.message.text;
  return typeof t === 'string' ? t.trim() : null;
}

// Telegram corta los mensajes de más de 4096 caracteres.
function recortar(msg) {
  return msg.length > 4000 ? msg.slice(0, 4000) + '\n…(reporte cortado, afiná la búsqueda)' : msg;
}

const reporteWizard = new Scenes.WizardScene(
  'reporte-wizard',
  // 0: elegir tipo
  async (ctx) => {
    await ctx.reply('¿Reporte por producto o por proveedor?', Markup.keyboard([['Producto'], ['Proveedor']]).oneTime().resize());
    return ctx.wizard.next();
  },
  // 1: rutear
  async (ctx) => {
    const t = (texto(ctx) || '').toLowerCase();
    if (t === 'producto') {
      await ctx.reply('¿Qué producto? (EAN, código o nombre)', Markup.removeKeyboard());
      return ctx.wizard.next();
    }
    if (t === 'proveedor') {
      await ctx.reply('¿Qué proveedor?', Markup.removeKeyboard());
      return ctx.wizard.selectStep(3);
    }
    await ctx.reply('Elegí "Producto" o "Proveedor" con los botones.');
    return;
  },
  // 2: reporte por producto
  async (ctx) => {
    const q = texto(ctx);
    if (!q) { await ctx.reply('Escribí el producto (EAN, código o nombre).'); return; }

    const r = await reportePorProducto(q);
    if (!r) {
      await ctx.reply(`No hay registros de promoción para "${q}".`, Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const m = r.metricas;
    const tasa = Math.round(m.tasaDescarte * 100);
    const msg =
      `📦 Reporte — ${r.producto}\n` +
      `Proveedor: ${r.proveedor || '-'}\n\n` +
      `Veces en promoción: ${m.veces}\n` +
      `Unidades puestas: ${m.puestasTotal}\n` +
      `Unidades vendidas en promo: ${m.vendidas}\n` +
      `Unidades descartadas: ${m.descartadas}\n` +
      `Efectividad: ${m.efectividad}%\n` +
      `Tasa de descarte: ${tasa}%\n` +
      (m.abiertas > 0 ? `\n⏳ Hay ${m.abiertas} alta(s) todavía abierta(s) en góndola.\n` : '') +
      `\nSugerencia: al recomprar, reducí la cantidad habitual en aproximadamente ${tasa}% respecto del consumo normal.`;
    await ctx.reply(recortar(msg), Markup.removeKeyboard());
    return ctx.scene.leave();
  },
  // 3: reporte por proveedor
  async (ctx) => {
    const q = texto(ctx);
    if (!q) { await ctx.reply('Escribí el proveedor.'); return; }

    const r = await reportePorProveedor(q);
    if (!r) {
      await ctx.reply(`No hay registros de promoción para el proveedor "${q}".`, Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const m = r.metricas;
    const tasa = Math.round(m.tasaDescarte * 100);
    const detalle = r.porProducto
      .map((p) => `• ${p.producto}: ${p.altas} alta(s), ${p.efectividad}% efectividad`)
      .join('\n');
    const msg =
      `📦 Reporte — proveedor ${r.proveedor}\n\n` +
      `Productos distintos en promoción: ${r.productos}\n` +
      `Unidades puestas (total): ${m.puestasTotal}\n` +
      `Unidades vendidas en promo: ${m.vendidas}\n` +
      `Unidades descartadas: ${m.descartadas}\n` +
      `Efectividad global: ${m.efectividad}%\n` +
      `Tasa de descarte: ${tasa}%\n` +
      (m.abiertas > 0 ? `\n⏳ Hay ${m.abiertas} alta(s) todavía abierta(s) en góndola.\n` : '') +
      `\nDetalle por producto:\n${detalle}`;
    await ctx.reply(recortar(msg), Markup.removeKeyboard());
    return ctx.scene.leave();
  }
);

module.exports = reporteWizard;
