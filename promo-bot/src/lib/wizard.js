// Helpers compartidos para los wizards.
const { Markup } = require('telegraf');

// Texto del mensaje, o null si no vino texto (foto, sticker, etc.).
function texto(ctx) {
  const t = ctx.message && ctx.message.text;
  return typeof t === 'string' ? t.trim() : null;
}

// Envía un mensaje y, si lleva botones, recuerda su message_id como "el teclado activo".
// Así después sabemos si un tap corresponde al paso actual o a un botón viejo.
async function preguntar(ctx, texto, keyboard) {
  const msg = await ctx.reply(texto, keyboard);
  if (keyboard && ctx.wizard && ctx.wizard.state) {
    ctx.wizard.state.kbMsgId = msg.message_id;
  }
  return msg;
}

// Respuesta del usuario: la data del botón que tocó, o el texto que escribió.
// - Un tap sobre un botón que NO es el del paso actual (botón viejo) se ignora (devuelve null),
//   pero igual se responde el callback y se le sacan los botones para que no quede "cargando".
// - Si responde escribiendo, se le sacan los botones al prompt actual (para que no queden vivos).
async function respuesta(ctx) {
  const espera = ctx.wizard && ctx.wizard.state ? ctx.wizard.state.kbMsgId : undefined;

  if (ctx.callbackQuery) {
    try { await ctx.answerCbQuery(); } catch (e) { /* callback viejo */ }
    const msgId = ctx.callbackQuery.message && ctx.callbackQuery.message.message_id;
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    if (!espera || msgId !== espera) return null; // botón que no corresponde al paso -> ignorar
    if (ctx.wizard && ctx.wizard.state) ctx.wizard.state.kbMsgId = undefined;
    return (ctx.callbackQuery.data || '').trim();
  }

  // Respondió por texto: si había un teclado activo, se lo sacamos para que no quede vivo.
  if (espera) {
    try { await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, espera, undefined, undefined); } catch (e) { /* ignorar */ }
    if (ctx.wizard && ctx.wizard.state) ctx.wizard.state.kbMsgId = undefined;
  }
  return texto(ctx);
}

function esCancelar(valor) {
  return typeof valor === 'string' && /^\/?cancelar$/i.test(valor);
}

// Teclado inline: botones pegados al mensaje (se ven igual en celu, PC y web).
// items: array de strings, o de [label, data]. Un botón por fila.
function opciones(items) {
  return Markup.inlineKeyboard(
    items.map((it) => {
      const [label, data] = Array.isArray(it) ? it : [it, it];
      return [Markup.button.callback(label, data)];
    })
  );
}

// Atajo para el clásico Sí / No.
const SI_NO = opciones([['Sí', 'si'], ['No', 'no']]);

module.exports = { texto, respuesta, preguntar, esCancelar, opciones, SI_NO };
