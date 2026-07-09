// Helpers compartidos para los wizards.
const { Markup } = require('telegraf');

// Texto del mensaje, o null si no vino texto (foto, sticker, etc.).
function texto(ctx) {
  const t = ctx.message && ctx.message.text;
  return typeof t === 'string' ? t.trim() : null;
}

// Respuesta del usuario: el dato del botón inline que tocó, o el texto que escribió.
// Si tocó un botón: confirma el tap y le saca los botones a ese mensaje (para que no se re-toque).
async function respuesta(ctx) {
  if (ctx.callbackQuery) {
    const data = (ctx.callbackQuery.data || '').trim();
    try { await ctx.answerCbQuery(); } catch (e) { /* callback viejo, ignorar */ }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo, ignorar */ }
    return data;
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

module.exports = { texto, respuesta, esCancelar, opciones, SI_NO };
