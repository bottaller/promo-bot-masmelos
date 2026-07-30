// Botones de /ajuste y /promoprecios. Viven acá (no en un wizard) porque disparan desde
// notificaciones proactivas — el destinatario no tiene ninguna escena activa cuando los toca.
// Se registran una sola vez en src/index.js, ANTES del catch-all de callbacks sueltos.
const { esDueno } = require('./lib/owner');
const { telegramIdsPorRol } = require('./db/usuarios');
const { marcarAjusteVerificado, marcarAjusteRealizado } = require('./db/ajustes');
const {
  marcarComprasArchivoOk, validarImagenCompras, validarImagenAdmin,
  todasLasImagenesEnviadas, marcarAvisoImpresionEnviado, marcarImpresoEntregado,
} = require('./db/promoprecios');
const { mandarleImagenAlDueno, avisarImpresionAMarketing } = require('./lib/promoprecios-mensajes');

async function avisarle(bot, telegramId, texto) {
  try { await bot.telegram.sendMessage(telegramId, texto); } catch (e) { console.error(`No pude avisarle a ${telegramId}:`, e.message); }
}

// Solo el rol compras_promo (NO el 'compras' general: esto es exclusivo del responsable que
// designe el dueño con /usuarios agregar).
function esComprasPromo(usuario) {
  return !!(usuario && usuario.areas && usuario.areas.includes('compras_promo'));
}

function esMarketing(usuario) {
  return !!(usuario && usuario.areas && usuario.areas.includes('marketing'));
}

// Rol aparte del "calidad" general: solo el responsable puntual que el dueño designe con
// /usuarios agregar recibe los archivos para ejecutar (hoy Renzo).
function esAjusteEjecutor(usuario) {
  return !!(usuario && usuario.areas && usuario.areas.includes('ajuste_ejecutor'));
}

function registrarAccionesCalidad(bot) {
  // --- /ajuste, paso 1: el dueño lo revisó -> se reenvía al rol "ajuste_ejecutor" ---
  bot.action(/^ajuste_verificado:(\d+)$/, async (ctx) => {
    if (!esDueno(ctx.from.id)) {
      await ctx.answerCbQuery('Esto es solo para el dueño del bot.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const ajuste = await marcarAjusteVerificado(Number(ctx.match[1]));
    if (!ajuste) { await ctx.reply('Ese ajuste ya estaba verificado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }

    const ejecutores = await telegramIdsPorRol('ajuste_ejecutor');
    if (ejecutores.length === 0) {
      await ctx.reply('⚠️ Lo marqué como verificado, pero no hay nadie con el rol "ajuste_ejecutor" (asignalo con /usuarios agregar <telegram_id> ajuste_ejecutor).');
      return;
    }
    let enviados = 0;
    for (const tid of ejecutores) {
      try {
        await bot.telegram.sendDocument(tid, ajuste.archivo_file_id, {
          caption: `📎 Ajuste verificado — subido por ${ajuste.usuario_nombre || ajuste.usuario_telegram_id}`,
          reply_markup: { inline_keyboard: [[{ text: '✅ Ajuste realizado', callback_data: `ajuste_ok:${ajuste.id}` }]] },
        });
        enviados++;
      } catch (e) { console.error(`No pude mandarle el ajuste a ${tid}:`, e.message); }
    }
    await ctx.reply(`Verificado. Se lo mandé al ejecutor (${enviados} persona(s)).`);
  });

  // --- /ajuste, paso 2: el ejecutor confirma -> avisa a quien lo subió y al dueño ---
  bot.action(/^ajuste_ok:(\d+)$/, async (ctx) => {
    if (!esAjusteEjecutor(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para quien tenga el rol "ajuste_ejecutor".', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const ajuste = await marcarAjusteRealizado(Number(ctx.match[1]));
    if (!ajuste) { await ctx.reply('Ese ajuste ya estaba marcado como realizado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply('Marcado como realizado.');
    await avisarle(bot, ajuste.usuario_telegram_id, '✅ Tu ajuste ya fue realizado.');
    await avisarle(bot, process.env.OWNER_TELEGRAM_ID, `✅ El ajuste subido por ${ajuste.usuario_nombre || ajuste.usuario_telegram_id} ya fue realizado.`);
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

  // --- /promoprecios: Compras valida UNA imagen -> pasa al dueño ---
  bot.action(/^promo_img_ok:(\d+)$/, async (ctx) => {
    if (!esComprasPromo(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para el responsable de Compras de este ciclo.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const imagen = await validarImagenCompras(Number(ctx.match[1]));
    if (!imagen) { await ctx.reply('Esa imagen ya no estaba pendiente.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply(`Imagen #${imagen.orden} validada. Se la mandé al dueño.`);
    try { await mandarleImagenAlDueno(bot.telegram, imagen); } catch (e) { console.error('No pude mandarle la imagen al dueño:', e.message); }
  });

  // --- /promoprecios: Compras pide revisar UNA imagen -> le pregunta qué corregir (ver
  // scenes/revisar-imagen.js) antes de avisarle a Marketing ---
  bot.action(/^promo_img_revisar:(\d+)$/, async (ctx) => {
    if (!esComprasPromo(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para el responsable de Compras de este ciclo.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    ctx.session.imagenIdParaRevisar = Number(ctx.match[1]);
    await ctx.scene.enter('revisar-imagen-wizard');
  });

  // --- /promoprecios: el dueño valida UNA imagen -> se reenvía a Ventas, Depósito y Calidad ---
  bot.action(/^promo_img_admin_ok:(\d+)$/, async (ctx) => {
    if (!esDueno(ctx.from.id)) {
      await ctx.answerCbQuery('Esto es solo para el dueño del bot.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const imagen = await validarImagenAdmin(Number(ctx.match[1]));
    if (!imagen) { await ctx.reply('Esa imagen ya no estaba pendiente de tu validación.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }

    let enviados = 0;
    for (const rol of ['ventas', 'deposito', 'calidad']) {
      for (const tid of await telegramIdsPorRol(rol)) {
        try {
          await bot.telegram.sendPhoto(tid, imagen.file_id);
          enviados++;
        } catch (e) { console.error(`No pude mandarle la imagen a ${tid}:`, e.message); }
      }
    }
    await ctx.reply(`Validado. Imagen #${imagen.orden} reenviada a Ventas, Depósito y Calidad (${enviados} persona(s)).`);

    // Si esta era la última imagen que faltaba validar, avisarle a Marketing que imprima todo.
    // Guarda atómica (marcarAvisoImpresionEnviado) para no duplicar el aviso si dos validaciones
    // casi simultáneas ven "ya no queda nada pendiente".
    if (await todasLasImagenesEnviadas(imagen.promoprecio_id)) {
      if (await marcarAvisoImpresionEnviado(imagen.promoprecio_id)) {
        const avisadosImpresion = await avisarImpresionAMarketing(bot.telegram, imagen.promoprecio_id);
        await ctx.reply(`🖨️ Le avisé a Marketing que imprima todo (${avisadosImpresion} persona(s)).`);
      }
    }
  });

  // --- Marketing confirma que ya imprimió y entregó las imágenes en salón -> avisa al dueño ---
  bot.action(/^promo_impreso:(\d+)$/, async (ctx) => {
    if (!esMarketing(ctx.state.usuario)) {
      await ctx.answerCbQuery('Esto es solo para Marketing.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const promo = await marcarImpresoEntregado(Number(ctx.match[1]));
    if (!promo) { await ctx.reply('Ya estaba confirmado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply('Marcado. Gracias.');
    await avisarle(bot, process.env.OWNER_TELEGRAM_ID, '🖨️ Marketing ya imprimió y entregó las imágenes de promociones y precios en salón.');
  });
}

module.exports = { registrarAccionesCalidad };
