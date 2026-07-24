// Botones de /ajuste y /promoprecios. Viven acá (no en un wizard) porque disparan desde
// notificaciones proactivas — el destinatario no tiene ninguna escena activa cuando los toca.
// Se registran una sola vez en src/index.js, ANTES del catch-all de callbacks sueltos.
const { esDueno } = require('./lib/owner');
const { telegramIdsPorRol } = require('./db/usuarios');
const { marcarAjusteRealizado } = require('./db/ajustes');
const {
  marcarComprasArchivoOk, marcarComprasImagenesOk, marcarAdminImagenesOk, imagenesDePromo,
} = require('./db/promoprecios');

async function avisarle(bot, telegramId, texto) {
  try { await bot.telegram.sendMessage(telegramId, texto); } catch (e) { console.error(`No pude avisarle a ${telegramId}:`, e.message); }
}

async function mandarImagenes(bot, telegramId, imagenes) {
  if (imagenes.length === 1) {
    await bot.telegram.sendPhoto(telegramId, imagenes[0].file_id);
  } else {
    await bot.telegram.sendMediaGroup(telegramId, imagenes.map((img) => ({ type: 'photo', media: img.file_id })));
  }
}

// Solo el rol compras_promo (NO el 'compras' general: esto es exclusivo del responsable que
// designe el dueño con /usuarios agregar).
function esComprasPromo(usuario) {
  return !!(usuario && usuario.areas && usuario.areas.includes('compras_promo'));
}

function registrarAccionesCalidad(bot) {
  // --- /ajuste: "Ajuste realizado" -> avisa a quien lo subió ---
  bot.action(/^ajuste_ok:(\d+)$/, async (ctx) => {
    if (!esDueno(ctx.from.id)) {
      await ctx.answerCbQuery('Esto es solo para el dueño del bot.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const ajuste = await marcarAjusteRealizado(Number(ctx.match[1]));
    if (!ajuste) { await ctx.reply('Ese ajuste ya estaba marcado como realizado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply('Marcado como realizado.');
    await avisarle(bot, ajuste.usuario_telegram_id, '✅ Tu ajuste ya fue realizado.');
  });

  // --- /promoprecios: "Validar" -> pregunta la cantidad de imágenes (validar-promoprecios-wizard) ---
  bot.action(/^promo_validar:(\d+)$/, async (ctx) => {
    if (!esDueno(ctx.from.id)) {
      await ctx.answerCbQuery('Esto es solo para el dueño del bot.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    ctx.session.promoIdParaValidar = Number(ctx.match[1]);
    await ctx.scene.enter('validar-promoprecios-wizard');
  });

  // --- /promoprecios, paso 1: Compras marca el archivo como hecho ---
  bot.action(/^promo_compras_ok:(\d+)$/, async (ctx) => {
    if (!esComprasPromo(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para el responsable de Compras de este ciclo.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const promo = await marcarComprasArchivoOk(Number(ctx.match[1]));
    if (!promo) { await ctx.reply('Ya estaba marcado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply('Marcado. Gracias.');
    await avisarle(bot, process.env.OWNER_TELEGRAM_ID, '💲 Compras ya marcó el archivo de precios como hecho.');
  });

  // --- /promoprecios, paso 2: Compras valida las imágenes de Marketing -> pasan al dueño ---
  bot.action(/^promo_imgs_compras_ok:(\d+)$/, async (ctx) => {
    if (!esComprasPromo(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para el responsable de Compras de este ciclo.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const id = Number(ctx.match[1]);
    const promo = await marcarComprasImagenesOk(id);
    if (!promo) { await ctx.reply('Ya estaba validado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply('Validado. Se lo mandé al dueño para la validación final.');

    const imagenes = await imagenesDePromo(id);
    if (imagenes.length) {
      try {
        await mandarImagenes(bot, process.env.OWNER_TELEGRAM_ID, imagenes);
        await bot.telegram.sendMessage(
          process.env.OWNER_TELEGRAM_ID,
          '💲 Compras ya validó estas imágenes de promociones y precios. Tu turno:',
          { reply_markup: { inline_keyboard: [[{ text: '✅ Validar imágenes', callback_data: `promo_imgs_admin_ok:${id}` }]] } }
        );
      } catch (e) { console.error('No pude mandarle las imágenes al dueño:', e.message); }
    }
  });

  // --- /promoprecios, paso 3: el dueño valida -> se reenvía a Ventas y Depósito ---
  bot.action(/^promo_imgs_admin_ok:(\d+)$/, async (ctx) => {
    if (!esDueno(ctx.from.id)) {
      await ctx.answerCbQuery('Esto es solo para el dueño del bot.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const id = Number(ctx.match[1]);
    const promo = await marcarAdminImagenesOk(id);
    if (!promo) { await ctx.reply('Ya estaba validado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }

    const imagenes = await imagenesDePromo(id);
    let enviados = 0;
    for (const rol of ['ventas', 'deposito']) {
      for (const tid of await telegramIdsPorRol(rol)) {
        try {
          if (imagenes.length) await mandarImagenes(bot, tid, imagenes);
          enviados++;
        } catch (e) { console.error(`No pude mandarle las imágenes a ${tid}:`, e.message); }
      }
    }
    await ctx.reply(`Validado. Reenviado a Ventas y Depósito (${enviados} persona(s)).`);
  });
}

module.exports = { registrarAccionesCalidad };
