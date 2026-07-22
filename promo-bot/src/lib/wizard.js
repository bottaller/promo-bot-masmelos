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
// - Un tap sobre un botón que NO es el del paso actual (botón viejo, doble-tap) se ignora
//   (devuelve null); el paso lo trata como "seguir esperando" y el teclado vigente queda intacto.
// - Si responde escribiendo, se le sacan los botones al prompt actual (para que no queden vivos).
//
// Anti doble-tap: telegraf procesa el batch de getUpdates con Promise.all, así que dos taps del
// mismo botón corren "a la par". Por eso el teclado activo se "consume" (kbMsgId = undefined)
// de forma SÍNCRONA, antes de cualquier await: el segundo tap ya lo encuentra consumido y devuelve
// null, en vez de avanzar el wizard dos veces.
async function respuesta(ctx) {
  const st = ctx.wizard && ctx.wizard.state;
  const espera = st ? st.kbMsgId : undefined;

  if (ctx.callbackQuery) {
    const msgId = ctx.callbackQuery.message && ctx.callbackQuery.message.message_id;
    const corresponde = !!espera && msgId === espera;
    if (corresponde && st) st.kbMsgId = undefined; // consumir YA, sin await en el medio
    try { await ctx.answerCbQuery(); } catch (e) { /* callback viejo */ }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    if (!corresponde) return null; // botón que no corresponde al paso (o doble-tap) -> ignorar
    return (ctx.callbackQuery.data || '').trim();
  }

  // Respondió por texto: solo si REALMENTE es texto le sacamos el teclado activo.
  // (Una foto/sticker parado en un paso con botones devuelve null y deja el teclado vivo
  //  para que el usuario todavía pueda tocarlo.)
  const t = texto(ctx);
  if (t !== null && espera) {
    if (st) st.kbMsgId = undefined;
    try { await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, espera, undefined, undefined); } catch (e) { /* ignorar */ }
  }
  return t;
}

function esCancelar(valor) {
  return typeof valor === 'string' && /^\/?cancelar$/i.test(valor);
}

// Parsea una cantidad de UNIDADES (entero >= 0). Saca los separadores de miles y los espacios
// para que "1.000" (mil, notación argentina) no se lea como 1, y "10.500" sea 10500.
// Rechaza (devuelve null) cualquier cosa que no sea un entero: comas decimales, letras, signos,
// vacío o null (p. ej. cuando el usuario manda una foto en un paso que espera un número).
function parseUnidades(valor) {
  const limpio = (valor || '').trim().replace(/[.\s]/g, '');
  if (limpio === '' || /\D/.test(limpio)) return null;
  const n = Number(limpio);
  return Number.isInteger(n) ? n : null;
}

// Parsea un precio (número > 0, con decimales). Acepta "$" y coma decimal ("1500", "1500,50",
// "$1500"). Rechaza (null) cualquier cosa que no sea un número positivo.
function parsePrecio(valor) {
  const limpio = (valor || '').trim().replace(/\$/g, '').replace(',', '.');
  if (limpio === '') return null;
  const n = Number(limpio);
  return Number.isFinite(n) && n > 0 ? n : null;
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

module.exports = { texto, respuesta, preguntar, esCancelar, parseUnidades, parsePrecio, opciones, SI_NO };
