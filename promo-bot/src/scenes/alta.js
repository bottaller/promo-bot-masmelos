const { Scenes, Markup } = require('telegraf');
const { TABS, appendRow, readAll } = require('../sheets');
const { notificarComprador } = require('../notificar');

function nuevoId() {
  return `A${Date.now()}`;
}

const altaWizard = new Scenes.WizardScene(
  'alta-wizard',
  async (ctx) => {
    await ctx.reply('Alta en promoción por vencimiento.\n\n¿SKU o descripción del producto?');
    ctx.wizard.state.data = {};
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.data.sku = ctx.message.text.trim();
    await ctx.reply('¿Categoría del producto? (ej: almacen, lacteos, bebidas, limpieza)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.data.categoria = ctx.message.text.trim().toLowerCase();
    await ctx.reply('¿Lote? (si no aplica, escribí "-")');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.data.lote = ctx.message.text.trim();
    await ctx.reply('¿Fecha de vencimiento? (formato DD/MM/AAAA)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.data.vencimiento = ctx.message.text.trim();
    await ctx.reply('¿Cantidad que se pasa a promoción?');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const cantidad = Number(ctx.message.text.trim().replace(',', '.'));
    if (Number.isNaN(cantidad) || cantidad <= 0) {
      await ctx.reply('Ingresá un número válido de cantidad.');
      return; // se queda en el mismo paso
    }
    ctx.wizard.state.data.cantidad = cantidad;
    await ctx.reply(
      '¿Motivo?',
      Markup.keyboard([['Vencimiento próximo'], ['Exceso de stock'], ['Otro']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.data.motivo = ctx.message.text.trim();
    const d = ctx.wizard.state.data;
    const resumen =
      `Confirmá el alta:\n\n` +
      `SKU: ${d.sku}\n` +
      `Categoría: ${d.categoria}\n` +
      `Lote: ${d.lote}\n` +
      `Vencimiento: ${d.vencimiento}\n` +
      `Cantidad: ${d.cantidad}\n` +
      `Motivo: ${d.motivo}\n\n` +
      `Escribí "si" para confirmar o "no" para cancelar.`;
    await ctx.reply(resumen, Markup.removeKeyboard());
    return ctx.wizard.next();
  },
  async (ctx) => {
    const respuesta = ctx.message.text.trim().toLowerCase();
    if (respuesta !== 'si' && respuesta !== 'sí') {
      await ctx.reply('Alta cancelada.');
      return ctx.scene.leave();
    }
    const d = ctx.wizard.state.data;
    const id = nuevoId();
    const fecha = new Date().toISOString();
    const usuario = ctx.from.username || ctx.from.first_name || String(ctx.from.id);

    await appendRow(TABS.ALTAS, [
      id, fecha, usuario, d.sku, d.sku, d.categoria, d.lote, d.vencimiento, d.cantidad, d.motivo, 'abierta',
    ]);

    // Historial: cuántas veces se remató este SKU antes
    const { records } = await readAll(TABS.ALTAS);
    const historial = records.filter((r) => r.sku.toLowerCase() === d.sku.toLowerCase());
    const vecesPrevias = historial.length; // incluye la que se acaba de crear
    const unidadesTotales = historial.reduce((acc, r) => acc + Number(r.cantidad || 0), 0);

    const mensajeComprador =
      `⚠️ Producto pasado a promoción por vencimiento\n\n` +
      `SKU: ${d.sku}\n` +
      `Cantidad: ${d.cantidad}\n` +
      `Motivo: ${d.motivo}\n` +
      `Vencimiento: ${d.vencimiento}\n\n` +
      `Historial: este SKU lleva ${vecesPrevias} alta(s) en promoción, ${unidadesTotales} unidades en total. ` +
      `Tenelo en cuenta al recomprar.`;

    await notificarComprador(d.categoria, mensajeComprador);
    await ctx.reply(`Alta registrada con id ${id}. Se notificó al comprador de la categoría "${d.categoria}".`);
    return ctx.scene.leave();
  }
);

module.exports = altaWizard;
