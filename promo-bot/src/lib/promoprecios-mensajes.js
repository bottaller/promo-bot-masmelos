// Mensajes del circuito de /promoprecios que se mandan por IMAGEN individual. Compartido entre
// scenes/imagenes.js (Marketing) y acciones-calidad.js (botones), para no duplicar el texto ni
// los callback_data.
const { telegramIdsPorRol } = require('../db/usuarios');
const { imagenesDePromo } = require('../db/promoprecios');

// A Compras (compras_promo): la imagen con sus dos botones. `telegram` es ctx.telegram o
// bot.telegram, según quién llame — ambos exponen el mismo sendPhoto. `destinatarios` es un
// override explícito de a quién avisar — lo usa un ciclo de /promoprecios_prueba (es_prueba, ver
// scenes/validar-promoprecios.js / acciones-deposito.js / scenes/imagenes.js) para que NUNCA le
// llegue a Compras real. Si no se pasa, va a compras_promo como siempre.
async function entregarImagenACompras(telegram, imagen, { destinatarios, esPrueba } = {}) {
  const prefijo = esPrueba ? '🧪 PRUEBA — ' : '';
  let avisados = 0;
  for (const tid of destinatarios || (await telegramIdsPorRol('compras_promo'))) {
    try {
      await telegram.sendPhoto(tid, imagen.file_id, {
        caption: `${prefijo}💲 Imagen #${imagen.orden} de promociones y precios.`,
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
// db/promoprecios.js: todasLasImagenesEnviadas / marcarAvisoImpresionEnviado). Lleva un botón
// para que Marketing confirme cuando ya imprimió y entregó en salón (marcarImpresoEntregado).
// A pedido: antes este aviso era solo texto, sin ninguna imagen adjunta — Marketing tenía que
// volver a buscar cada foto por separado en la conversación (le habían llegado una por una,
// mezcladas con el resto de la verificación). Ahora se le mandan TODAS agrupadas justo antes
// (álbum de Telegram, sendMediaGroup), para bajarlas/imprimirlas juntas de una — no cambia en
// nada el control de mercadería de antes (Compras + dueño siguen validando cada imagen una por
// una, esto solo agrupa la ENTREGA final a Marketing).
async function mandarAlbumImpresion(telegram, tid, imagenes) {
  // sendMediaGroup pide entre 2 y 10 items -- con 1 sola imagen no aplica (mandarla suelta), y
  // con más de 10 hay que partirlo en varios álbumes.
  if (imagenes.length === 1) {
    await telegram.sendPhoto(tid, imagenes[0].file_id, { caption: `Imagen #${imagenes[0].orden}` });
    return;
  }
  for (let i = 0; i < imagenes.length; i += 10) {
    const lote = imagenes.slice(i, i + 10);
    await telegram.sendMediaGroup(tid, lote.map((img) => ({ type: 'photo', media: img.file_id })));
  }
}

async function avisarImpresionAMarketing(telegram, promoId, { destinatarios, esPrueba } = {}) {
  const prefijo = esPrueba ? '🧪 PRUEBA — ' : '';
  const imagenes = await imagenesDePromo(promoId);
  let avisados = 0;
  for (const tid of destinatarios || (await telegramIdsPorRol('marketing'))) {
    try {
      if (imagenes.length) await mandarAlbumImpresion(telegram, tid, imagenes);
      await telegram.sendMessage(
        tid,
        `${prefijo}🖨️ Ya está todo validado. Imprimí las imágenes de arriba en hoja A4 a color — al menos una copia de cada una.`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ Ya imprimí y entregué en salón', callback_data: `promo_impreso:${promoId}` }]] } }
      );
      avisados++;
    } catch (e) { console.error('No pude avisarle a marketing (impresión):', e.message); }
  }
  return avisados;
}

module.exports = { entregarImagenACompras, mandarleImagenAlDueno, avisarImpresionAMarketing };
