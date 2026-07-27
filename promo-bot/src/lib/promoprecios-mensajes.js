// Mensajes del circuito de /promoprecios que se mandan por IMAGEN individual. Compartido entre
// scenes/imagenes.js (Marketing) y acciones-calidad.js (botones), para no duplicar el texto ni
// los callback_data.
const { telegramIdsPorRol } = require('../db/usuarios');

// A Compras (compras_promo): la imagen con sus dos botones. `telegram` es ctx.telegram o
// bot.telegram, según quién llame — ambos exponen el mismo sendPhoto.
async function entregarImagenACompras(telegram, imagen) {
  let avisados = 0;
  for (const tid of await telegramIdsPorRol('compras_promo')) {
    try {
      await telegram.sendPhoto(tid, imagen.file_id, {
        caption: `💲 Imagen #${imagen.orden} de promociones y precios.`,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Validar', callback_data: `promo_img_ok:${imagen.id}` },
            { text: '🔁 Revisar', callback_data: `promo_img_revisar:${imagen.id}` },
          ]],
        },
      });
      avisados++;
    } catch (e) { console.error('No pude avisarle a compras_promo:', e.message); }
  }
  return avisados;
}

// Al dueño, ya validada por Compras.
async function mandarleImagenAlDueno(telegram, imagen) {
  await telegram.sendPhoto(process.env.OWNER_TELEGRAM_ID, imagen.file_id, {
    caption: `💲 Imagen #${imagen.orden} — validada por Compras. Tu turno:`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Validar', callback_data: `promo_img_admin_ok:${imagen.id}` }]] },
  });
}

// Cuando el dueño termina de validar TODAS las imágenes de un ciclo (ver
// db/promoprecios.js: todasLasImagenesEnviadas / marcarAvisoImpresionEnviado).
async function avisarImpresionAMarketing(telegram) {
  let avisados = 0;
  for (const tid of await telegramIdsPorRol('marketing')) {
    try {
      await telegram.sendMessage(
        tid,
        '🖨️ Ya está todo validado. Imprimí todas las imágenes en hoja A4 a color — al menos una copia de cada una.'
      );
      avisados++;
    } catch (e) { console.error('No pude avisarle a marketing (impresión):', e.message); }
  }
  return avisados;
}

module.exports = { entregarImagenACompras, mandarleImagenAlDueno, avisarImpresionAMarketing };
