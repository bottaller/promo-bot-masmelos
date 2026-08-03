// Wizard /promoprecios (Calidad): sube el archivo final de promociones y precios, que le llega
// al DUEÑO del bot para validar. El resto de la cadena (validar-promoprecios, /imagenes,
// acciones-calidad) sigue desde ahí.
//
// Fábrica en vez de una sola escena: /promoprecios_prueba (solo el dueño del bot, ver
// middleware/authz.js requiereDueno) usa exactamente el mismo wizard, pero con esPrueba=true —
// el ciclo entero queda marcado (bot.promoprecios.es_prueba) y todos los avisos que normalmente
// van a Compras, Marketing, Ventas/Depósito/Calidad quedan redirigidos a quien lo probó (mismo
// criterio que /carteleria_prueba, ver scenes/validar-promoprecios.js y acciones-calidad.js).
const { Scenes } = require('telegraf');
const { crearPromoPrecios } = require('../db/promoprecios');
const { esCancelar } = require('../lib/wizard');

async function notificarDueno(ctx, promoId, doc, nombreQuienSube, esPrueba) {
  await ctx.telegram.sendDocument(process.env.OWNER_TELEGRAM_ID, doc.file_id, {
    caption: `${esPrueba ? '🧪 PRUEBA — ' : ''}💲 Promociones y precios — subido por ${nombreQuienSube}`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Validar', callback_data: `promo_validar:${promoId}` }]] },
  });
}

function crearPromoPreciosWizard({ id, esPrueba }) {
  return new Scenes.WizardScene(
    id,
    // 0: pedir el archivo
    async (ctx) => {
      await ctx.reply(
        (esPrueba ? '🧪 Modo prueba (todo el circuito te va a volver a vos): ' : '') +
        'Mandame el archivo final de promociones y precios (o "cancelar").'
      );
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
        esPrueba,
      });

      try {
        await notificarDueno(ctx, promoId, doc, nombre, esPrueba);
        await ctx.reply('Listo, se lo mandé para que lo valide.');
      } catch (e) {
        console.error('No pude mandarle el archivo de promoprecios al dueño:', e.message);
        await ctx.reply('Lo guardé, pero hubo un problema mandándoselo al dueño. Avisale por las dudas.');
      }
      return ctx.scene.leave();
    }
  );
}

const promoPreciosWizard = crearPromoPreciosWizard({ id: 'promoprecios-wizard', esPrueba: false });
const promoPreciosPruebaWizard = crearPromoPreciosWizard({ id: 'promoprecios-prueba-wizard', esPrueba: true });

module.exports = { promoPreciosWizard, promoPreciosPruebaWizard };
