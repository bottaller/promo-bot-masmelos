// Wizard corto: se entra al tocar "✅ Validar" en el archivo de /promoprecios (ver
// src/acciones-calidad.js). Pregunta cuántas imágenes tiene que hacer Marketing y, con eso,
// reparte el archivo a Compras (compras_promo) y la consigna a Marketing.
const { Scenes } = require('telegraf');
const { validarPromoPrecios } = require('../db/promoprecios');
const { telegramIdsPorRol } = require('../db/usuarios');
const { respuesta, esCancelar, parseUnidades } = require('../lib/wizard');

async function repartir(ctx, promo) {
  let avisadosCompras = 0;
  for (const tid of await telegramIdsPorRol('compras_promo')) {
    try {
      await ctx.telegram.sendDocument(tid, promo.archivo_file_id, {
        caption: '💲 Promociones y precios, ya validado.',
        reply_markup: { inline_keyboard: [[{ text: '✅ Ya hice mi parte', callback_data: `promo_compras_ok:${promo.id}` }]] },
      });
      avisadosCompras++;
    } catch (e) { console.error('No pude avisarle a compras_promo:', e.message); }
  }

  let avisadosMarketing = 0;
  for (const tid of await telegramIdsPorRol('marketing')) {
    try {
      await ctx.telegram.sendDocument(tid, promo.archivo_file_id, {
        caption: `💲 Promociones y precios.\n\nTenés que mandar ${promo.imagenes_requeridas} imagen(es). Usá /imagenes para entregarlas.`,
      });
      avisadosMarketing++;
    } catch (e) { console.error('No pude avisarle a marketing:', e.message); }
  }

  return { avisadosCompras, avisadosMarketing };
}

const validarPromoPreciosWizard = new Scenes.WizardScene(
  'validar-promoprecios-wizard',
  // 0: preguntar la cantidad (el id del promoprecios viene de ctx.session, ver acciones-calidad.js)
  async (ctx) => {
    ctx.wizard.state.promoId = ctx.session.promoIdParaValidar;
    await ctx.reply('¿Cuántas imágenes tiene que hacer Marketing?');
    return ctx.wizard.next();
  },
  // 1: procesar la cantidad -> validar y repartir
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado. El archivo sigue sin validar.'); return ctx.scene.leave(); }
    const n = parseUnidades(r);
    if (n === null || n <= 0) { await ctx.reply('Ingresá un número entero mayor a 0.'); return; }

    const promoId = ctx.wizard.state.promoId;
    const promo = await validarPromoPrecios(promoId, { imagenesRequeridas: n });
    if (!promo) {
      await ctx.reply('Ese archivo ya estaba validado.');
      return ctx.scene.leave();
    }

    const { avisadosCompras, avisadosMarketing } = await repartir(ctx, promo);
    await ctx.reply(
      `Listo. Le pedí ${n} imagen(es) a Marketing (${avisadosMarketing} persona(s)) y avisé a Compras (${avisadosCompras} persona(s)).`
    );
    return ctx.scene.leave();
  }
);

module.exports = validarPromoPreciosWizard;
