// Mensajes del circuito de /promoprecios que se mandan por IMAGEN individual. Compartido entre
// scenes/imagenes.js (Marketing) y acciones-calidad.js (botones), para no duplicar el texto ni
// los callback_data.
const { telegramIdsPorRol } = require('../db/usuarios');
const { imagenesDePromo, todasLasImagenesEnviadas, marcarAvisoImpresionEnviado } = require('../db/promoprecios');

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
async function avisarImpresionAMarketing(telegram, promoId, { destinatarios, esPrueba } = {}) {
  const prefijo = esPrueba ? '🧪 PRUEBA — ' : '';
  let avisados = 0;
  for (const tid of destinatarios || (await telegramIdsPorRol('marketing'))) {
    try {
      await telegram.sendMessage(
        tid,
        `${prefijo}🖨️ Ya está todo validado. Imprimí todas las imágenes en hoja A4 a color — al menos una copia de cada una.`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ Ya imprimí y entregué en salón', callback_data: `promo_impreso:${promoId}` }]] } }
      );
      avisados++;
    } catch (e) { console.error('No pude avisarle a marketing (impresión):', e.message); }
  }
  return avisados;
}

// Manda TODAS las imágenes de un ciclo, juntas, a Ventas/Depósito/Calidad (un álbum por rol —
// Telegram permite hasta 10 fotos por álbum, así que se parte en bloques de a 10 si hace falta).
// Antes esto se mandaba una por una a medida que el dueño validaba cada imagen; ahora se espera
// a que estén TODAS listas (ver finalizarCicloSiCorresponde) y se manda de una sola vez.
async function entregarTodasAVentasDepositoCalidad(telegram, promoprecioId, { destinatarios, esPrueba } = {}) {
  const imagenes = await imagenesDePromo(promoprecioId);
  if (imagenes.length === 0) return 0;

  const bloques = [];
  for (let i = 0; i < imagenes.length; i += 10) bloques.push(imagenes.slice(i, i + 10));

  let avisados = 0;
  for (const tid of destinatarios || [...await telegramIdsPorRol('ventas'), ...await telegramIdsPorRol('deposito'), ...await telegramIdsPorRol('calidad')]) {
    try {
      for (const bloque of bloques) {
        await telegram.sendMediaGroup(tid, bloque.map((img) => ({ type: 'photo', media: img.file_id })));
      }
      avisados++;
    } catch (e) { console.error(`No pude mandarle el lote de imágenes a ${tid}:`, e.message); }
  }
  return avisados;
}

// Se llama cada vez que se termina de validar UNA imagen (por cualquiera de los dos caminos:
// Compras+dueño en el flujo manual viejo, o directo el dueño en el diseño automático). Si esa
// era la ÚLTIMA que faltaba, dispara TODO junto: el lote a Ventas/Depósito/Calidad y el aviso de
// impresión a Marketing. Guarda atómica (marcarAvisoImpresionEnviado) para no duplicar si dos
// validaciones casi simultáneas ven "ya no queda nada pendiente".
async function finalizarCicloSiCorresponde(telegram, promoprecioId, { esPrueba, usuarioTelegramId } = {}) {
  if (!(await todasLasImagenesEnviadas(promoprecioId))) return { disparado: false };
  if (!(await marcarAvisoImpresionEnviado(promoprecioId))) return { disparado: false };

  const destinatarios = esPrueba ? [usuarioTelegramId] : undefined;
  const avisadosVDC = await entregarTodasAVentasDepositoCalidad(telegram, promoprecioId, { destinatarios, esPrueba });
  const avisadosImpresion = await avisarImpresionAMarketing(telegram, promoprecioId, { destinatarios, esPrueba });
  return { disparado: true, avisadosVDC, avisadosImpresion };
}

module.exports = {
  entregarImagenACompras, mandarleImagenAlDueno, avisarImpresionAMarketing,
  entregarTodasAVentasDepositoCalidad, finalizarCicloSiCorresponde,
};
