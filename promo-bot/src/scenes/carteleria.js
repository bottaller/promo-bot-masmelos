// Wizard /carteleria (área Depósito): pide una foto del producto con el precio y el tipo de
// gráfica, y arma el aviso para Marketing.
//   - A4 / A4 Color: se hacen adentro -> solo un aviso con la foto ("Imprimir A4[/ Color]").
//   - Cartel simple / Gráfica cigüeña: van a la gráfica externa -> la foto + un botón que abre
//     WhatsApp con el número de la gráfica y el pedido ya escrito (Marketing solo adjunta la foto
//     y manda — WhatsApp no permite adjuntar archivos automáticamente desde un link).
const { Scenes } = require('telegraf');
const { crearCarteleria } = require('../db/carteleria');
const { telegramIdsPorRol } = require('../db/usuarios');
const { esCancelar, opciones, preguntar, respuesta } = require('../lib/wizard');

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

async function avisarAMarketing(telegram, { fotoFileId, tipo }) {
  const { label, interno } = TIPOS[tipo];
  let avisados = 0;
  for (const tid of await telegramIdsPorRol('marketing')) {
    try {
      if (interno) {
        await telegram.sendPhoto(tid, fotoFileId, { caption: `🖨️ Imprimir ${label}.` });
      } else {
        const texto = `Buenos días, solicito ${label} a continuación les adjunto el diseño`;
        await telegram.sendPhoto(tid, fotoFileId, {
          caption: `🖼️ ${label} — pedido para la gráfica.`,
          reply_markup: { inline_keyboard: [[{ text: '📲 Pedir por WhatsApp', url: linkWhatsApp(texto) }]] },
        });
      }
      avisados++;
    } catch (e) { console.error('No pude avisarle a marketing (cartelería):', e.message); }
  }
  return avisados;
}

const carteleriaWizard = new Scenes.WizardScene(
  'carteleria-wizard',
  // 0: pedir la foto
  async (ctx) => {
    await ctx.reply('Mandame la foto del producto con el precio (o "cancelar").');
    return ctx.wizard.next();
  },
  // 1: recibir la foto -> preguntar el tipo de gráfica
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const fotos = ctx.message && ctx.message.photo;
    if (!fotos || !fotos.length) {
      await ctx.reply('Mandame la foto (o "cancelar").');
      return;
    }
    ctx.wizard.state.fotoFileId = fotos[fotos.length - 1].file_id;
    await preguntar(
      ctx,
      '¿Qué tipo de gráfica necesitás?',
      opciones([
        ['A4', 'a4'],
        ['A4 Color', 'a4_color'],
        ['Cartel simple', 'cartel_simple'],
        ['Gráfica cigüeña', 'ciguena'],
      ])
    );
    return ctx.wizard.next();
  },
  // 2: procesar el tipo -> guardar y avisar a Marketing
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!r || !TIPOS[r]) { await ctx.reply('Elegí una de las opciones.'); return; }

    const u = ctx.state.usuario;
    await crearCarteleria({
      fotoFileId: ctx.wizard.state.fotoFileId,
      tipo: r,
      usuarioId: u ? u.id : null,
      usuarioNombre: u ? u.nombre : (ctx.from.username || ctx.from.first_name || null),
      usuarioTelegramId: ctx.from.id,
    });

    const avisados = await avisarAMarketing(ctx.telegram, { fotoFileId: ctx.wizard.state.fotoFileId, tipo: r });
    await ctx.reply(`Listo, le avisé a Marketing (${avisados} persona(s)).`);
    return ctx.scene.leave();
  }
);

module.exports = carteleriaWizard;
