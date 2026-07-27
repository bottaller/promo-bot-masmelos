// Wizard /imagenes (área Marketing): entrega las imágenes pedidas para el ciclo de /promoprecios
// activo. Exige la cantidad exacta pedida por el dueño; al completarla se dispara solo hacia
// Compras — no hace falta que Marketing confirme nada aparte.
const { Scenes } = require('telegraf');
const {
  promoPreciosActivo, promoPreciosPorId, agregarImagenPromo, imagenesDePromo,
  reiniciarImagenesPromo, marcarMarketingCompletado,
} = require('../db/promoprecios');
const { telegramIdsPorRol } = require('../db/usuarios');
const { esCancelar } = require('../lib/wizard');

function fotoDeMensaje(ctx) {
  const fotos = ctx.message && ctx.message.photo;
  if (!fotos || !fotos.length) return null;
  return fotos[fotos.length - 1].file_id; // la de mayor resolución
}

async function avisarADueno(ctx, texto) {
  try { await ctx.telegram.sendMessage(process.env.OWNER_TELEGRAM_ID, texto); } catch (e) { console.error('No pude avisarle al dueño:', e.message); }
}

async function mandarImagenes(telegram, chatId, imagenes) {
  if (imagenes.length === 1) {
    await telegram.sendPhoto(chatId, imagenes[0].file_id);
  } else {
    await telegram.sendMediaGroup(chatId, imagenes.map((img) => ({ type: 'photo', media: img.file_id })));
  }
}

async function entregarACompras(ctx, promo, imagenes) {
  let avisados = 0;
  for (const tid of await telegramIdsPorRol('compras_promo')) {
    try {
      await mandarImagenes(ctx.telegram, tid, imagenes);
      await ctx.telegram.sendMessage(tid, '💲 Imágenes de promociones y precios. Marcá cuando las revises.', {
        reply_markup: { inline_keyboard: [[{ text: '✅ VALIDADO', callback_data: `promo_imgs_compras_ok:${promo.id}` }]] },
      });
      avisados++;
    } catch (e) { console.error('No pude avisarle a compras_promo:', e.message); }
  }
  return avisados;
}

async function pedirEstado(ctx, promo) {
  const actuales = await imagenesDePromo(promo.id);
  await ctx.reply(
    `Llevás ${actuales.length} de ${promo.imagenes_requeridas}.\n` +
    'Mandame la siguiente imagen, escribí "reiniciar" para empezar de nuevo, o "cancelar" para salir.'
  );
}

const imagenesWizard = new Scenes.WizardScene(
  'imagenes-wizard',
  // 0: buscar el ciclo activo
  async (ctx) => {
    const promo = await promoPreciosActivo();
    if (!promo || !promo.imagenes_requeridas) {
      await ctx.reply('No hay ninguna entrega de imágenes pendiente en este momento.');
      return ctx.scene.leave();
    }
    if (promo.marketing_completado_en) {
      await ctx.reply('Ya entregaste las imágenes de este ciclo.');
      return ctx.scene.leave();
    }
    ctx.wizard.state.promoId = promo.id;
    await pedirEstado(ctx, promo);
    return ctx.wizard.next();
  },
  // 1: recibir imágenes de a una (o "reiniciar"), hasta completar la cantidad pedida
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Cancelado. Lo que ya mandaste queda guardado — corré /imagenes de nuevo para seguir.');
      return ctx.scene.leave();
    }

    const promo = await promoPreciosPorId(ctx.wizard.state.promoId);
    if (!promo || promo.marketing_completado_en) {
      await ctx.reply('Este ciclo ya no está esperando imágenes.');
      return ctx.scene.leave();
    }

    if (ctx.message && typeof ctx.message.text === 'string' && /^reiniciar$/i.test(ctx.message.text.trim())) {
      await reiniciarImagenesPromo(promo.id);
      await ctx.reply('Listo, arrancamos de nuevo.');
      await pedirEstado(ctx, promo);
      return;
    }

    const fileId = fotoDeMensaje(ctx);
    if (!fileId) {
      await ctx.reply('Mandame una imagen, escribí "reiniciar" o "cancelar".');
      return;
    }

    await agregarImagenPromo({ promoprecioId: promo.id, fileId });
    const actuales = await imagenesDePromo(promo.id);

    if (actuales.length < promo.imagenes_requeridas) {
      await pedirEstado(ctx, promo);
      return;
    }

    // Se completó: dispara solo, no hace falta que confirme nada.
    await marcarMarketingCompletado(promo.id);
    const avisados = await entregarACompras(ctx, promo, actuales);
    await avisarADueno(ctx, `📦 Marketing terminó de mandar las ${promo.imagenes_requeridas} imagen(es) de promociones y precios.`);
    await ctx.reply(`Listo, mandé las ${actuales.length} imágenes a Compras (${avisados} persona(s)).`);
    return ctx.scene.leave();
  }
);

module.exports = imagenesWizard;
