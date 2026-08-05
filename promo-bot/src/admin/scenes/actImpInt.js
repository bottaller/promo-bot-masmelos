// Wizard /actimpint (solo admin): recibe el Excel de impuestos internos y lo guarda en la DB
// (bot.impuestos_internos, ver db/impuestos-internos.js) — lo usa /promoprecios para calcular
// el precio neto del .txt de Sigma (lib/promoprecios-sigma.js).
const { Scenes } = require('telegraf');
const { parsearImpuestosInternos } = require('../../lib/impuestos-internos-excel');
const { reemplazarImpuestosInternos, contarImpuestosInternos } = require('../../db/impuestos-internos');

const actImpIntWizard = new Scenes.WizardScene(
  'actimpint-wizard',
  async (ctx) => {
    await ctx.reply(
      'Actualizar impuestos internos.\n\n' +
      'Adjuntá el Excel de "art impuestos internos" exportado de Sigma (.xlsx).\n' +
      'Para cancelar, escribí "cancelar".'
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.message && ctx.message.text && /^cancelar$/i.test(ctx.message.text.trim())) {
      await ctx.reply('Cancelado.');
      return ctx.scene.leave();
    }

    const doc = ctx.message && ctx.message.document;
    if (!doc) {
      await ctx.reply('Necesito que adjuntes el archivo .xlsx. Probá de nuevo o escribí "cancelar".');
      return;
    }
    if (!/\.xlsx$/i.test(doc.file_name || '')) {
      await ctx.reply('El archivo tiene que ser un .xlsx. Probá de nuevo o escribí "cancelar".');
      return;
    }

    await ctx.reply('Recibido. Procesando el archivo... ⏳');
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const resp = await fetch(link.href);
      if (!resp.ok) throw new Error(`No pude descargar el archivo (HTTP ${resp.status})`);
      const buffer = Buffer.from(await resp.arrayBuffer());

      const { impuestos, filasLeidas } = parsearImpuestosInternos(buffer);
      if (impuestos.length === 0) {
        await ctx.reply('El archivo no tenía artículos con impuesto interno. ¿Es el Excel correcto?');
        return ctx.scene.leave();
      }

      await reemplazarImpuestosInternos(impuestos);
      const total = await contarImpuestosInternos();
      await ctx.reply(
        '✅ Impuestos internos actualizados.\n\n' +
        `Filas leídas: ${filasLeidas}\n` +
        `Total en la base: ${total}`
      );
    } catch (err) {
      console.error('Error procesando impuestos internos:', err);
      await ctx.reply('❌ Hubo un error procesando el Excel. Fijate que sea el archivo correcto y probá de nuevo.');
    }
    return ctx.scene.leave();
  }
);

module.exports = actImpIntWizard;
