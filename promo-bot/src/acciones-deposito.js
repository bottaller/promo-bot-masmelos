// Botones de /carteleria (área Depósito). Vive acá (no en el wizard) porque dispara desde una
// notificación proactiva — Marketing no tiene ninguna escena activa cuando lo toca.
// Se registra una sola vez en src/index.js, ANTES del catch-all de callbacks sueltos.
const { marcarPedidoConfirmado, marcarVerificado } = require('./db/carteleria');
const { avisarAMarketingFinal } = require('./lib/carteleria-mensajes');

function esMarketing(usuario) {
  return !!(usuario && usuario.areas && usuario.areas.includes('marketing'));
}

function registrarAccionesDeposito(bot) {
  // --- /carteleria: Marketing confirma que ya pidió los carteles -> avisa a quien lo pidió ---
  bot.action(/^carteleria_pedido:(\d+)$/, async (ctx) => {
    if (!esMarketing(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para Marketing.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const pedido = await marcarPedidoConfirmado(Number(ctx.match[1]));
    if (!pedido) { await ctx.reply('Ya estaba confirmado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply('Marcado. Gracias.');
    try {
      await bot.telegram.sendMessage(pedido.usuario_telegram_id, '✅ Ya se pidieron los carteles a la gráfica.');
    } catch (e) { console.error('No pude avisarle a quien pidió la cartelería:', e.message); }
  });

  // --- /carteleria: Marketing aprueba el diseño generado -> dispara impresión/pedido y avisa
  // a quien lo cargó. Guarda atómica (marcarVerificado) para que no lo aprueben dos veces. ---
  bot.action(/^carteleria_ok:(\d+)$/, async (ctx) => {
    if (!esMarketing(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para Marketing.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const carteleria = await marcarVerificado(Number(ctx.match[1]));
    if (!carteleria) { await ctx.reply('Ya estaba verificado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply('Verificado. Gracias.');

    const avisados = await avisarAMarketingFinal(bot.telegram, {
      id: carteleria.id,
      fileIdParaEnviar: carteleria.diseno_file_id || carteleria.foto_file_id,
      tipo: carteleria.tipo,
      cantidadCopias: carteleria.cantidad_copias,
    });
    console.log(`Cartelería #${carteleria.id} verificada: avisados ${avisados} de marketing.`);

    try {
      await bot.telegram.sendMessage(
        carteleria.usuario_telegram_id,
        `✅ Tu pedido de cartelería #${carteleria.id} (${carteleria.producto || 'sin nombre'}) fue verificado por Marketing.`
      );
    } catch (e) { console.error('No pude avisarle a quien pidió la cartelería:', e.message); }
  });

  // --- /carteleria: Marketing pide corregir el diseño -> abre el wizard de corrección ---
  bot.action(/^carteleria_corregir:(\d+)$/, async (ctx) => {
    if (!esMarketing(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para Marketing.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    ctx.session.carteleriaIdParaCorregir = Number(ctx.match[1]);
    await ctx.scene.enter('corregir-carteleria-wizard');
  });
}

module.exports = { registrarAccionesDeposito };
