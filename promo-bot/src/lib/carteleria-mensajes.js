// Mensajes de /carteleria hacia Marketing. Separado del wizard para poder
// reusarlo tanto al cargar (fallback si falla la IA) como después de que
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

// Aviso final a Marketing (imprimir A4, o pedir a la gráfica) — con el file_id que
// corresponda: el diseño aprobado, o la foto cruda si la IA no pudo generarlo.
async function avisarAMarketingFinal(telegram, { id, fileIdParaEnviar, tipo, cantidadCopias }) {
  const { label, interno } = TIPOS[tipo];
  let avisados = 0;
  for (const tid of await telegramIdsPorRol('marketing')) {
    try {
      if (interno) {
        const copias = cantidadCopias === 1 ? '1 copia' : `${cantidadCopias} copias`;
        await telegram.sendPhoto(tid, fileIdParaEnviar, { caption: `🖨️ Imprimir ${label} — ${copias}.` });
      } else {
        const texto = `Buenos días, solicito ${label} a continuación les adjunto el diseño`;
        await telegram.sendPhoto(tid, fileIdParaEnviar, {
          caption: `🖼️ ${label} — pedido para la gráfica.`,
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

// Foto original + diseño generado, con los botones de verificación. Sube el
// diseño (Buffer) una sola vez y reutiliza el file_id que devuelve Telegram
// para el resto de los destinatarios.
async function avisarVerificacionMarketing(telegram, { carteleria, disenoBuffer }) {
  const { id, foto_file_id: fotoFileId, tipo, tipo_precio: tipoPrecio, cantidad_copias: cantidadCopias, producto, precio } = carteleria;
  const { label } = TIPOS[tipo];
  const copiasTexto = cantidadCopias ? `, ${cantidadCopias === 1 ? '1 copia' : `${cantidadCopias} copias`}` : '';
  const captionDiseno = `🖼️ Diseño generado: ${producto} — $${Number(precio).toFixed(2)} (${label}, ${LABELS_TIPO_PRECIO[tipoPrecio]}${copiasTexto}). Verificalo contra la foto original.`;
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
  for (const tid of await telegramIdsPorRol('marketing')) {
    try {
      await telegram.sendPhoto(tid, fotoFileId, { caption: `📷 Foto original de Depósito — pedido #${id}` });
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
