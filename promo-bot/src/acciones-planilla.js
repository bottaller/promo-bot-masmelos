// El botón "Intentar cargarla de nuevo" que viaja pegado al aviso cuando falla la
// carga automática de la PLANILLA RETIRA.
//
// La idea es que el aviso no sea solo una mala noticia. Sin esto, para recuperar
// una planilla que fallo por algo transitorio —la base que no respondió, un
// timeout— había que bajar el adjunto del chat, abrir /carga y volver a subirlo.
// Cuatro pasos con el celular en la mano, en el medio de otra cosa. Ahora es un
// toque, y corre EL MISMO `procesar` que usan /carga y el endpoint, así que el
// resultado no puede diferir del que se hubiera obtenido a mano.
//
// Se registra una sola vez desde index.js, ANTES del catch-all de callbacks.
const { DOCUMENTOS, DocumentoInvalido } = require('./lib/documentos-carga');
const reintento = require('./lib/reintento-planilla');

function registrarAccionesPlanilla(bot) {
  bot.action(/^planilla_reintentar:([A-Za-z0-9]{1,20})$/, async (ctx) => {
    // El aviso solo les llega a los admins, pero un callback_data se puede repetir
    // a mano: el permiso se chequea acá igual, no en quién recibió el mensaje.
    if (!ctx.state.usuario || !ctx.state.usuario.es_admin) {
      await ctx.answerCbQuery('Esto es solo para admins.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('Reintentando…');

    const pieza = reintento.tomar(ctx.match[1]);
    if (!pieza) {
      // Pasa si el bot se reinició entremedio: el archivo vivía en memoria. No es
      // un callejón sin salida — el adjunto sigue en el chat.
      try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }
      await ctx.reply(
        'Ya no tengo guardada esa planilla (el bot se reinició).\n'
        + 'Mandámela con /carga, que es exactamente lo mismo: el adjunto de arriba sirve.'
      );
      return;
    }

    // Se saca el botón antes de trabajar: si tarda, que nadie lo apriete dos veces.
    try { await ctx.editMessageReplyMarkup(); } catch (e) { /* mensaje viejo */ }

    const doc = DOCUMENTOS.find((d) => d.codigo === 'retiros');
    if (!doc) { await ctx.reply('No encuentro el tipo de documento "retiros". Avisale a sistemas.'); return; }

    try {
      const res = await doc.procesar({
        buffer: pieza.buffer,
        nombreArchivo: pieza.nombre,
        usuarioId: ctx.state.usuario.id,
      });
      // El mismo mensaje que muestra /carga: si la planilla entró, se ve igual que
      // si la hubiera subido una persona.
      await ctx.reply(res.mensaje, { parse_mode: 'HTML' });
    } catch (e) {
      if (e instanceof DocumentoInvalido) {
        await ctx.reply(`No se pudo usar esa planilla:\n\n${e.message}`, { parse_mode: 'HTML' });
        return;
      }
      console.error('Reintento de planilla falló:', e);
      await ctx.reply(
        `Volvió a fallar: ${e.message}\n\n`
        + 'Si es la base, esperá unos minutos y probá de nuevo con /carga.'
      );
    }
  });
}

module.exports = { registrarAccionesPlanilla };
