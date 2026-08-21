// Botones de /carteleria (área Depósito). Vive acá (no en el wizard) porque dispara desde una
// notificación proactiva — Marketing no tiene ninguna escena activa cuando lo toca.
// Se registra una sola vez en src/index.js, ANTES del catch-all de callbacks sueltos.
const { marcarPedidoConfirmado, marcarVerificado, elegirDisenoCandidato, descartarDisenosCandidatos, guardarDiseno } = require('./db/carteleria');
const { agregarImagenPromo } = require('./db/promoprecios');
const { avisarAMarketingFinal, avisarVerificacionMarketing } = require('./lib/carteleria-mensajes');
const { entregarImagenACompras } = require('./lib/promoprecios-mensajes');
const { generarCartel } = require('./lib/carteleria-render');
const { esDueno, esMarketingCarteleria } = require('./lib/owner');

function esMarketing(usuario) {
  return !!(usuario && usuario.areas && usuario.areas.includes('marketing'));
}

// El dueño del bot y la persona de /carteleria_marketing también pueden tocar estos botones —
// es lo único que les llega en su chat que no sea Marketing de verdad: sus propios pedidos de
// /carteleria_prueba o /carteleria_marketing (ver scenes/carteleria.js).
function puedeAccionar(ctx) {
  return esMarketing(ctx.state.usuario) || esDueno(ctx.from.id) || esMarketingCarteleria(ctx.from.id);
}

function registrarAccionesDeposito(bot) {
  // --- /carteleria: Marketing confirma que ya pidió los carteles -> avisa a quien lo pidió ---
  bot.action(/^carteleria_pedido:(\d+)$/, async (ctx) => {
    if (!puedeAccionar(ctx)) {
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
    if (!puedeAccionar(ctx)) {
      await ctx.answerCbQuery('Esto es solo para Marketing.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const carteleria = await marcarVerificado(Number(ctx.match[1]));
    if (!carteleria) { await ctx.reply('Ya estaba verificado.'); return; }
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
    await ctx.reply('Verificado. Gracias.');

    // Diseño generado automáticamente por /promoprecios (ver scenes/validar-promoprecios.js) en
    // vez de un pedido normal de /carteleria: no va a imprimir/pedir a la gráfica -> entra
    // directo al circuito de Compras que ya existe para las imágenes de promoprecios
    // (Validar/Revisar), y de ahí sigue la ruta de siempre (dueño, Ventas/Depósito/Calidad).
    if (carteleria.promoprecio_id) {
      const fileId = carteleria.diseno_file_id || carteleria.foto_file_id;
      try {
        const imagen = await agregarImagenPromo({ promoprecioId: carteleria.promoprecio_id, fileId });
        const destinatarios = carteleria.es_prueba ? [carteleria.usuario_telegram_id] : undefined;
        const avisadosCompras = await entregarImagenACompras(bot.telegram, imagen, { destinatarios, esPrueba: carteleria.es_prueba });
        await ctx.reply(`Diseño aprobado. Lo mandé a Compras para que lo valide (${avisadosCompras} persona(s)).`);
      } catch (e) {
        console.error('No pude mandar el diseño aprobado de promoprecios a Compras:', e.message);
        await ctx.reply('Verificado, pero no pude mandarlo a Compras. Avisale al admin.');
      }
      return;
    }

    // Un pedido de /carteleria_prueba o /carteleria_marketing (es_prueba) nunca dispara el
    // aviso final a Marketing real -> se lo mandamos solo a quien lo pidió, para completar el
    // circuito. mostrarPrueba (etiqueta_prueba) decide aparte si se ve el texto "🧪 PRUEBA".
    const avisados = await avisarAMarketingFinal(bot.telegram, {
      id: carteleria.id,
      fileIdParaEnviar: carteleria.diseno_file_id || carteleria.foto_file_id,
      tipo: carteleria.tipo,
      cantidadCopias: carteleria.cantidad_copias,
      esPrueba: carteleria.es_prueba,
      mostrarPrueba: carteleria.etiqueta_prueba,
      destinatarios: carteleria.es_prueba ? [carteleria.usuario_telegram_id] : undefined,
    });
    console.log(`Cartelería #${carteleria.id} verificada: avisados ${avisados}${carteleria.es_prueba ? ' (prueba)' : ' de marketing'}.`);

    try {
      await bot.telegram.sendMessage(
        carteleria.usuario_telegram_id,
        `✅ Tu pedido de cartelería #${carteleria.id} (${carteleria.producto || 'sin nombre'}) fue verificado${carteleria.es_prueba ? '' : ' por Marketing'}.`
      );
    } catch (e) { console.error('No pude avisarle a quien pidió la cartelería:', e.message); }
  });

  // --- /carteleria: el matcheo de fotos quedó ambiguo (ver carteleria-catalogo.js) y Marketing
  // elige cuál de las 2-4 opciones es la correcta -> esa queda como el diseño y sigue el flujo
  // de verificación de siempre (✅ Está bien / ✏️ Corregir), como si se hubiera generado 1 sola.
  // "ninguna" = ninguna opción sirve -> se regenera el cartel SIN foto (mismo resultado que si
  // el catálogo nunca hubiera encontrado nada) en vez de forzar a elegir la "menos mala". ---
  bot.action(/^carteleria_elegir_foto:(\d+):(\d+|ninguna)$/, async (ctx) => {
    if (!puedeAccionar(ctx)) {
      await ctx.answerCbQuery('Esto es solo para Marketing.', { show_alert: true });
      return;
    }
    const id = Number(ctx.match[1]);
    const esNinguna = ctx.match[2] === 'ninguna';

    if (esNinguna) {
      const carteleria = await descartarDisenosCandidatos(id);
      if (!carteleria) {
        await ctx.answerCbQuery('Ya se había resuelto la foto de este pedido.', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery('Listo, sigue sin foto.');
      try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }

      try {
        const disenoBuffer = await generarCartel({
          tipoGrafica: carteleria.tipo, tipoPrecio: carteleria.tipo_precio, producto: carteleria.producto,
          precio: carteleria.precio, vencimiento: carteleria.vencimiento, politica: carteleria.politica_texto,
          imagenProductoBuffer: null,
        });
        const { avisados, disenoFileId } = await avisarVerificacionMarketing(bot.telegram, { carteleria, disenoBuffer });
        if (disenoFileId) await guardarDiseno(id, { producto: carteleria.producto, precio: carteleria.precio, disenoFileId });
        console.log(`Cartelería #${id}: ninguna foto candidata servía, regenerado sin foto (${avisados}).`);
      } catch (e) {
        console.error('No pude regenerar el cartel sin foto:', e.message);
        await ctx.reply('No pude regenerar el diseño. Avisale al admin.');
      }
      return;
    }

    const indice = Number(ctx.match[2]);
    const carteleria = await elegirDisenoCandidato(id, indice);
    if (!carteleria) {
      await ctx.answerCbQuery('Ya se había elegido una foto para este pedido.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('Listo, esa es la elegida.');
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }

    const { avisados } = await avisarVerificacionMarketing(bot.telegram, { carteleria, disenoFileId: carteleria.diseno_file_id });
    console.log(`Cartelería #${id}: foto elegida por Marketing, reenviada a verificación (${avisados}).`);
  });

  // --- /carteleria: Marketing pide corregir el diseño -> abre el wizard de corrección ---
  bot.action(/^carteleria_corregir:(\d+)$/, async (ctx) => {
    if (!puedeAccionar(ctx)) {
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
