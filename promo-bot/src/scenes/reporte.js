const { TABS, readAll } = require('../sheets');

async function reportePorSku(ctx) {
  const texto = ctx.message.text.replace('/reporte', '').trim();
  if (!texto) {
    await ctx.reply('Usá: /reporte SKU  (ej: /reporte gaseosa cola 2.25l)');
    return;
  }

  const [{ records: altas }, { records: bajas }] = await Promise.all([
    readAll(TABS.ALTAS),
    readAll(TABS.BAJAS),
  ]);

  const altasSku = altas.filter((r) => r.sku.toLowerCase() === texto.toLowerCase());
  if (altasSku.length === 0) {
    await ctx.reply(`No hay registros de promoción para "${texto}".`);
    return;
  }

  const bajasSku = bajas.filter((r) => r.sku.toLowerCase() === texto.toLowerCase());

  const unidadesPuestas = altasSku.reduce((acc, r) => acc + Number(r.cantidad || 0), 0);
  const unidadesVendidas = bajasSku.reduce((acc, r) => acc + Number(r.cantidad_vendida || 0), 0);
  const unidadesDescartadas = bajasSku.reduce((acc, r) => acc + Number(r.cantidad_remanente || 0), 0);
  const efectividad = unidadesPuestas > 0 ? Math.round((unidadesVendidas / unidadesPuestas) * 100) : 0;
  const tasaDescarte = unidadesPuestas > 0 ? unidadesDescartadas / unidadesPuestas : 0;
  const abiertas = altasSku.filter((r) => r.estado === 'abierta').length;

  const mensaje =
    `📦 Reporte de promoción — ${texto}\n\n` +
    `Veces en promoción: ${altasSku.length}\n` +
    `Unidades puestas: ${unidadesPuestas}\n` +
    `Unidades vendidas en promo: ${unidadesVendidas}\n` +
    `Unidades descartadas: ${unidadesDescartadas}\n` +
    `Efectividad: ${efectividad}%\n` +
    `Tasa de descarte histórica: ${Math.round(tasaDescarte * 100)}%\n` +
    (abiertas > 0 ? `\n⏳ Hay ${abiertas} alta(s) todavía abierta(s) en góndola.\n` : '') +
    `\nSugerencia: al recomprar, reducí la cantidad habitual en aproximadamente ${Math.round(tasaDescarte * 100)}% ` +
    `respecto del consumo normal, para compensar la tasa de descarte histórica.`;

  await ctx.reply(mensaje);
}

module.exports = { reportePorSku };
