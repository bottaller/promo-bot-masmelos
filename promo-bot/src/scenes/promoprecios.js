// Wizard /promoprecios (Calidad): sube el archivo final de promociones y precios, que le llega
// al DUEÑO del bot para validar. El resto de la cadena (validar-promoprecios, /imagenes,
// acciones-calidad) sigue desde ahí.
const { Scenes } = require('telegraf');
const { crearPromoPrecios } = require('../db/promoprecios');
const { esCancelar } = require('../lib/wizard');

async function notificarDueno(ctx, promoId, doc, nombreQuienSube) {
  await ctx.telegram.sendDocument(process.env.OWNER_TELEGRAM_ID, doc.file_id, {
    caption: `💲 Promociones y precios — subido por ${nombreQuienSube}`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Validar', callback_data: `promo_validar:${promoId}` }]] },
  });
}

const promoPreciosWizard = new Scenes.WizardScene(
  'promoprecios-wizard',
  // 0: pedir el archivo
  async (ctx) => {
    await ctx.reply('Mandame el archivo final de promociones y precios (o "cancelar").');
    return ctx.wizard.next();
  },
  // 1: recibirlo y mandárselo al dueño
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Cancelado.');
      return ctx.scene.leave();
    }
    const doc = ctx.message && ctx.message.document;
    if (!doc) {
      await ctx.reply('Mandame el archivo como documento (o "cancelar").');
      return;
    }

    const u = ctx.state.usuario;
    const nombre = (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id));
    const promoId = await crearPromoPrecios({
      archivoFileId: doc.file_id,
      archivoNombre: doc.file_name || null,
      usuarioId: u ? u.id : null,
      usuarioNombre: nombre,
      usuarioTelegramId: ctx.from.id,
    });

    try {
      await notificarDueno(ctx, promoId, doc, nombre);
      await ctx.reply('Listo, se lo mandé para que lo valide.');
    } catch (e) {
      console.error('No pude mandarle el archivo de promoprecios al dueño:', e.message);
      await ctx.reply('Lo guardé, pero hubo un problema mandándoselo al dueño. Avisale por las dudas.');
    }
    return ctx.scene.leave();
  }
);

module.exports = promoPreciosWizard;
