// Mensajes de /carteleria hacia Marketing. Separado del wizard para poder reusarlo tanto al
// cargar el diseño (scenes/carteleria.js, corregir-carteleria.js) como después de que
// Marketing aprueba el diseño (acciones-deposito.js).
const { telegramIdsPorRol } = require('../db/usuarios');
const { LABELS_TIPO_PRECIO } = require('./carteleria-plantillas');

const TIPOS = {
  a4: { label: 'A4', interno: true },
  a4_color: { label: 'A4 Color', interno: true },
  cartel_simple: { label: 'Cartel simple', interno: false },
  ciguena: { label: 'Gráfica cigüeña', interno: false },
};

function linkWhatsApp(texto) {
  const numero = (process.env.GRAFICA_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

// Aviso final a Marketing (imprimir A4, o pedir a la gráfica) con el diseño ya aprobado —
// se dispara desde acciones-deposito.js cuando Marketing toca "✅ Está bien". `destinatarios`
// es un override explícito de a quién avisar — lo usa /carteleria_prueba para que un pedido de
// prueba NUNCA le llegue a Marketing real. Si no se pasa, va a Marketing como siempre.
async function avisarAMarketingFinal(telegram, { id, fileIdParaEnviar, tipo, cantidadCopias, destinatarios, esPrueba }) {
  const { label, interno } = TIPOS[tipo];
  const prefijo = esPrueba ? '🧪 PRUEBA (esto no salió para Marketing) — ' : '';
  let avisados = 0;
  for (const tid of destinatarios || (await telegramIdsPorRol('marketing'))) {
    try {
      if (interno) {
        const copias = cantidadCopias === 1 ? '1 copia' : `${cantidadCopias} copias`;
        await telegram.sendPhoto(tid, fileIdParaEnviar, { caption: `${prefijo}🖨️ Imprimir ${label} — ${copias}.` });
      } else {
        const texto = `Buenos días, solicito ${label} a continuación les adjunto el diseño`;
        await telegram.sendPhoto(tid, fileIdParaEnviar, {
          caption: `${prefijo}🖼️ ${label} — pedido para la gráfica.`,
          reply_markup: {
            inline_keyboard: [
              [{ text: '📲 Pedir por WhatsApp', url: linkWhatsApp(texto) }],
              [{ text: '✅ Ya pedí los carteles', callback_data: `carteleria_pedido:${id}` }],
            ],
          },
        });
      }
      avisados++;
    } catch (e) { console.error('No pude avisarle a marketing (cartelería):', e.message); }
  }
  return avisados;
}

// Diseño generado (+ la foto del código de barras escaneado, si Depósito mandó una — puede no
// haber ninguna si lo cargó a mano) con los botones de verificación. Sube el diseño (Buffer)
// una sola vez y reutiliza el file_id que devuelve Telegram para el resto de los destinatarios.
// Si `carteleria.es_prueba` es true (viene de /carteleria_prueba), esto NUNCA sale para
// Marketing real — vuelve solo a quien lo probó (usuario_telegram_id), botones incluidos.
async function avisarVerificacionMarketing(telegram, { carteleria, disenoBuffer }) {
  const {
    id, foto_file_id: fotoFileId, tipo, tipo_precio: tipoPrecio, cantidad_copias: cantidadCopias,
    producto, precio, es_prueba: esPrueba, usuario_telegram_id: usuarioTelegramId,
  } = carteleria;
  const { label } = TIPOS[tipo];
  const copiasTexto = cantidadCopias ? `, ${cantidadCopias === 1 ? '1 copia' : `${cantidadCopias} copias`}` : '';
  // "nuevo_ingreso" no lleva precio — precio viene null en ese caso.
  const precioTexto = precio === null || precio === undefined ? '' : ` — $${Number(precio).toFixed(2)}`;
  const prefijo = esPrueba ? '🧪 PRUEBA (solo vos ves esto) — ' : '';
  const captionDiseno = `${prefijo}🖼️ Diseño generado: ${producto}${precioTexto} (${label}, ${LABELS_TIPO_PRECIO[tipoPrecio]}${copiasTexto}). Revisalo antes de aprobar.`;
  const botones = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Está bien', callback_data: `carteleria_ok:${id}` }],
        [{ text: '✏️ Corregir', callback_data: `carteleria_corregir:${id}` }],
      ],
    },
  };

  let avisados = 0;
  let disenoFileId = null;
  for (const tid of esPrueba ? [usuarioTelegramId] : await telegramIdsPorRol('marketing')) {
    try {
      if (fotoFileId) {
        await telegram.sendPhoto(tid, fotoFileId, { caption: `📷 Código de barras escaneado — pedido #${id}` });
      }
      const enviado = await telegram.sendPhoto(tid, disenoFileId || { source: disenoBuffer }, { caption: captionDiseno, ...botones });
      if (!disenoFileId) {
        const fotos = enviado.photo || [];
        disenoFileId = fotos.length ? fotos[fotos.length - 1].file_id : null;
      }
      avisados++;
    } catch (e) { console.error('No pude mandarle la verificación a marketing (cartelería):', e.message); }
  }
  return { avisados, disenoFileId };
}

module.exports = { TIPOS, linkWhatsApp, avisarAMarketingFinal, avisarVerificacionMarketing };
