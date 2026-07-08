const { Scenes, Markup } = require('telegraf');
const { TABS, readAll } = require('../sheets');

function calcularMetricas(altasSku, bajasSku) {
  const unidadesPuestas = altasSku.reduce((acc, r) => acc + Number(r.cantidad || 0), 0);
  const unidadesVendidas = bajasSku.reduce((acc, r) => acc + Number(r.cantidad_vendida || 0), 0);
  const unidadesDescartadas = bajasSku.reduce((acc, r) => acc + Number(r.cantidad_remanente || 0), 0);
  const efectividad = unidadesPuestas > 0 ? Math.round((unidadesVendidas / unidadesPuestas) * 100) : 0;
  const tasaDescarte = unidadesPuestas > 0 ? unidadesDescartadas / unidadesPuestas : 0;
  return { unidadesPuestas, unidadesVendidas, unidadesDescartadas, efectividad, tasaDescarte };
}

const reporteWizard = new Scenes.WizardScene(
  'reporte-wizard',
  async (ctx) => {
    await ctx.reply(
      '¿Reporte por SKU o por proveedor?',
      Markup.keyboard([['SKU'], ['Proveedor']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const eleccion = ctx.message.text.trim().toLowerCase();
    if (eleccion === 'sku') {
      await ctx.reply('¿Qué SKU?', Markup.removeKeyboard());
      return ctx.wizard.next();
    }
    if (eleccion === 'proveedor') {
      await ctx.reply('¿Qué proveedor? (escribilo tal cual lo cargaste en las altas)', Markup.removeKeyboard());
      return ctx.wizard.selectStep(3);
    }
    await ctx.reply('Elegí "SKU" o "Proveedor" con los botones.');
    return;
  },
  // 2: reporte por SKU
  async (ctx) => {
    const sku = ctx.message.text.trim();
    const [{ records: altas }, { records: bajas }] = await Promise.all([
      readAll(TABS.ALTAS),
      readAll(TABS.BAJAS),
    ]);

    const altasSku = altas.filter((r) => r.sku.toLowerCase() === sku.toLowerCase());
    if (altasSku.length === 0) {
      await ctx.reply(`No hay registros de promoción para el SKU "${sku}".`, Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const bajasSku = bajas.filter((r) => r.sku.toLowerCase() === sku.toLowerCase());
    const m = calcularMetricas(altasSku, bajasSku);
    const ultima = altasSku[altasSku.length - 1];
    const abiertas = altasSku.filter((r) => r.estado === 'abierta').length;

    const mensaje =
      `📦 Reporte — SKU ${sku}\n\n` +
      `Producto: ${ultima.producto}\n` +
      `Proveedor: ${ultima.proveedor}\n\n` +
      `Veces en promoción: ${altasSku.length}\n` +
      `Unidades puestas: ${m.unidadesPuestas}\n` +
      `Unidades vendidas en promo: ${m.unidadesVendidas}\n` +
      `Unidades descartadas: ${m.unidadesDescartadas}\n` +
      `Efectividad: ${m.efectividad}%\n` +
      `Tasa de descarte histórica: ${Math.round(m.tasaDescarte * 100)}%\n` +
      (abiertas > 0 ? `\n⏳ Hay ${abiertas} alta(s) todavía abierta(s) en góndola.\n` : '') +
      `\nSugerencia: al recomprar, reducí la cantidad habitual en aproximadamente ${Math.round(m.tasaDescarte * 100)}% ` +
      `respecto del consumo normal.`;

    await ctx.reply(mensaje, Markup.removeKeyboard());
    return ctx.scene.leave();
  },
  // 3: reporte por proveedor
  async (ctx) => {
    const proveedorTexto = ctx.message.text.trim();

    const [{ records: altas }, { records: bajas }] = await Promise.all([
      readAll(TABS.ALTAS),
      readAll(TABS.BAJAS),
    ]);

    const altasProveedor = altas.filter((r) => r.proveedor.toLowerCase() === proveedorTexto.toLowerCase());
    if (altasProveedor.length === 0) {
      await ctx.reply(`No hay registros de promoción para el proveedor "${proveedorTexto}". Fijate que esté escrito igual que en las altas.`);
      return ctx.scene.leave();
    }
    const proveedor = altasProveedor[0].proveedor;

    const skusUnicos = [...new Set(altasProveedor.map((r) => r.sku))];
    const bajasProveedor = bajas.filter((r) => skusUnicos.includes(r.sku));
    const m = calcularMetricas(altasProveedor, bajasProveedor);
    const abiertas = altasProveedor.filter((r) => r.estado === 'abierta').length;

    const detallePorSku = skusUnicos
      .map((sku) => {
        const altasDelSku = altasProveedor.filter((r) => r.sku === sku);
        const bajasDelSku = bajasProveedor.filter((r) => r.sku === sku);
        const ms = calcularMetricas(altasDelSku, bajasDelSku);
        return `• ${altasDelSku[0].producto} (SKU ${sku}): ${altasDelSku.length} alta(s), ${ms.efectividad}% efectividad`;
      })
      .join('\n');

    const mensaje =
      `📦 Reporte — proveedor ${proveedor}\n\n` +
      `SKUs distintos en promoción: ${skusUnicos.length}\n` +
      `Unidades puestas (total): ${m.unidadesPuestas}\n` +
      `Unidades vendidas en promo: ${m.unidadesVendidas}\n` +
      `Unidades descartadas: ${m.unidadesDescartadas}\n` +
      `Efectividad global: ${m.efectividad}%\n` +
      `Tasa de descarte histórica: ${Math.round(m.tasaDescarte * 100)}%\n` +
      (abiertas > 0 ? `\n⏳ Hay ${abiertas} alta(s) todavía abierta(s) en góndola.\n` : '') +
      `\nDetalle por producto:\n${detallePorSku}`;

    await ctx.reply(mensaje, Markup.removeKeyboard());
    return ctx.scene.leave();
  }
);

module.exports = reporteWizard;
