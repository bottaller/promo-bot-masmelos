// Wizard /imagenes (área Marketing): dos modos, según el estado del ciclo activo de /promoprecios.
//  - Entrega inicial: junta las N imágenes pedidas. Al completarlas, se despachan a Compras una
//    por una, cada una con sus propios botones (Validar / Revisar) — no es un lote con un solo
//    botón, cada imagen recorre su propio camino.
//  - Corrección: si Compras marcó alguna imagen para "revisar", pide la versión corregida de ESA
//    imagen puntual (no reinicia las demás) y la vuelve a mandar a Compras.
const { Scenes } = require('telegraf');
const {
  promoPreciosActivo, promoPreciosPorId, agregarImagenPromo, imagenesDePromo,
  reiniciarImagenesPromo, marcarMarketingCompletado, imagenRevisarPendiente, reemplazarImagenRevisar,
} = require('../db/promoprecios');
const { entregarImagenACompras } = require('../lib/promoprecios-mensajes');
const { esCancelar } = require('../lib/wizard');

function fotoDeMensaje(ctx) {
  const fotos = ctx.message && ctx.message.photo;
  if (!fotos || !fotos.length) return null;
  return fotos[fotos.length - 1].file_id; // la de mayor resolución
}

async function avisarADueno(ctx, texto) {
  try { await ctx.telegram.sendMessage(process.env.OWNER_TELEGRAM_ID, texto); } catch (e) { console.error('No pude avisarle al dueño:', e.message); }
}

async function pedirEstado(ctx, promo) {
  const actuales = await imagenesDePromo(promo.id);
  await ctx.reply(
    `Llevás ${actuales.length} de ${promo.imagenes_requeridas}.\n` +
    'Mandame la siguiente imagen, escribí "reiniciar" para empezar de nuevo, o "cancelar" para salir.'
  );
}

const imagenesWizard = new Scenes.WizardScene(
  'imagenes-wizard',
  // 0: buscar el ciclo activo y decidir el modo (entrega inicial vs. corrección puntual)
  async (ctx) => {
    const promo = await promoPreciosActivo();
    if (!promo || !promo.imagenes_requeridas) {
      await ctx.reply('No hay ninguna entrega de imágenes pendiente en este momento.');
      return ctx.scene.leave();
    }
    ctx.wizard.state.promoId = promo.id;

    if (!promo.marketing_completado_en) {
      await pedirEstado(ctx, promo);
      return ctx.wizard.next(); // -> paso 1: entrega inicial
    }

    const revisar = await imagenRevisarPendiente(promo.id);
    if (!revisar) {
      await ctx.reply('Ya entregaste todo. No hay ninguna corrección pendiente en este momento.');
      return ctx.scene.leave();
    }
    ctx.wizard.state.imagenRevisarId = revisar.id;
    await ctx.reply(
      `Corrección pendiente — imagen #${revisar.orden}:\n"${revisar.revisar_comentario}"\n\n` +
      'Mandame la imagen corregida (o "cancelar").'
    );
    return ctx.wizard.selectStep(2); // -> paso 2: corrección
  },
  // 1: entrega inicial — recibir imágenes de a una (o "reiniciar"), hasta completar la cantidad
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Cancelado. Lo que ya mandaste queda guardado — corré /imagenes de nuevo para seguir.');
      return ctx.scene.leave();
    }

    const promo = await promoPreciosPorId(ctx.wizard.state.promoId);
    if (!promo || promo.marketing_completado_en) {
      await ctx.reply('Este ciclo ya no está esperando la entrega inicial.');
      return ctx.scene.leave();
    }

    if (ctx.message && typeof ctx.message.text === 'string' && /^reiniciar$/i.test(ctx.message.text.trim())) {
      await reiniciarImagenesPromo(promo.id);
      await ctx.reply('Listo, arrancamos de nuevo.');
      await pedirEstado(ctx, promo);
      return;
    }

    const fileId = fotoDeMensaje(ctx);
    if (!fileId) {
      await ctx.reply('Mandame una imagen, escribí "reiniciar" o "cancelar".');
      return;
    }

    await agregarImagenPromo({ promoprecioId: promo.id, fileId });
    const actuales = await imagenesDePromo(promo.id);

    if (actuales.length < promo.imagenes_requeridas) {
      await pedirEstado(ctx, promo);
      return;
    }

    // Se completó. Cuando Marketing manda varias fotos "juntas", Telegram en realidad las entrega
    // como mensajes separados que pueden procesarse casi en simultáneo — por eso NO alcanza con
    // "actuales.length === requeridas" para disparar el reparto: marcarMarketingCompletado()
    // actualiza en la base con una guarda atómica, y solo la invocación que efectivamente ganó esa
    // carrera (la única que recibe la fila, no null) reparte las imágenes. Así, si las 5 fotos de
    // un envío múltiple se procesan en paralelo, el reparto a Compras se dispara una sola vez.
    const completado = await marcarMarketingCompletado(promo.id);
    if (completado) {
      for (const img of actuales) {
        await entregarImagenACompras(ctx.telegram, img);
      }
      await avisarADueno(ctx, `📦 Marketing terminó de mandar las ${promo.imagenes_requeridas} imagen(es) de promociones y precios.`);
      await ctx.reply(`Listo, mandé las ${actuales.length} imágenes a Compras (una por una).`);
    }
    return ctx.scene.leave();
  },
  // 2: corrección — recibir la imagen de reemplazo de UNA imagen marcada "revisar"
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Cancelado. Esa imagen sigue pendiente de corrección — corré /imagenes cuando la tengas lista.');
      return ctx.scene.leave();
    }
    const fileId = fotoDeMensaje(ctx);
    if (!fileId) {
      await ctx.reply('Mandame la imagen corregida (o "cancelar").');
      return;
    }
    const imagen = await reemplazarImagenRevisar(ctx.wizard.state.imagenRevisarId, fileId);
    if (!imagen) {
      await ctx.reply('Esa corrección ya se había resuelto.');
      return ctx.scene.leave();
    }
    const avisados = await entregarImagenACompras(ctx.telegram, imagen);
    await ctx.reply(`Listo, mandé la corrección de la imagen #${imagen.orden} a Compras (${avisados} persona(s)).`);
    return ctx.scene.leave();
  }
);

module.exports = imagenesWizard;
