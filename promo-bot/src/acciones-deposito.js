// Botones de /carteleria (área Depósito). Vive acá (no en el wizard) porque dispara desde una
// notificación proactiva — Marketing no tiene ninguna escena activa cuando lo toca.
// Se registra una sola vez en src/index.js, ANTES del catch-all de callbacks sueltos.
const { marcarPedidoConfirmado } = require('./db/carteleria');

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
}

module.exports = { registrarAccionesDeposito };
