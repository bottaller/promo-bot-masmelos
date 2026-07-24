// Wizard /ajuste (Calidad): sube un archivo de ajustes que le llega al DUEÑO del bot para que lo
// revise. Cuando lo marca como "realizado" (botón, ver src/acciones-calidad.js), se le avisa a
// quien lo subió.
const { Scenes } = require('telegraf');
const { crearAjuste } = require('../db/ajustes');
const { esCancelar } = require('../lib/wizard');

async function notificarDueno(ctx, ajusteId, doc, nombreQuienSube) {
  await ctx.telegram.sendDocument(process.env.OWNER_TELEGRAM_ID, doc.file_id, {
    caption: `📎 Ajuste — subido por ${nombreQuienSube}`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Ajuste realizado', callback_data: `ajuste_ok:${ajusteId}` }]] },
  });
}

const ajusteWizard = new Scenes.WizardScene(
  'ajuste-wizard',
  // 0: pedir el archivo
  async (ctx) => {
    await ctx.reply('Mandame el archivo de ajustes (o "cancelar").');
    return ctx.wizard.next();
  },
  // 1: recibirlo y mandárselo al dueño
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Cancelado.');
      return ctx.scene.leave();
    }
    const doc = ctx.message && ctx.message.document;
    if (!doc) {
      await ctx.reply('Mandame el archivo como documento (o "cancelar").');
      return;
    }

    const u = ctx.state.usuario;
    const nombre = (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id));
    const ajusteId = await crearAjuste({
      archivoFileId: doc.file_id,
      archivoNombre: doc.file_name || null,
      usuarioId: u ? u.id : null,
      usuarioNombre: nombre,
      usuarioTelegramId: ctx.from.id,
    });

    try {
      await notificarDueno(ctx, ajusteId, doc, nombre);
      await ctx.reply('Listo, se lo mandé para que lo revise.');
    } catch (e) {
      console.error('No pude mandarle el ajuste al dueño:', e.message);
      await ctx.reply('Lo guardé, pero hubo un problema mandándoselo al dueño. Avisale por las dudas.');
    }
    return ctx.scene.leave();
  }
);

module.exports = ajusteWizard;
