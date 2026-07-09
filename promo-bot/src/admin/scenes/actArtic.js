// Wizard /actartic (solo admin): recibe el Excel del maestro de artículos, lo parsea y lo guarda en la DB.
const { Scenes } = require('telegraf');
const { parsearArticulos } = require('../../lib/articulos-excel');
const { upsertArticulos, contarArticulos } = require('../../db/articulos');

const actArticWizard = new Scenes.WizardScene(
  'actartic-wizard',
  async (ctx) => {
    await ctx.reply(
      'Actualizar maestro de artículos.\n\n' +
      'Primero, en Sigma exportá el listado:\n' +
      '  Artículos → Listados → Listado de Artículos Detallado → exportar a Excel.\n\n' +
      'Después adjuntá acá ese archivo (.xlsx).\n' +
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
      return; // sigue esperando en este paso
    }
    if (!/\.xlsx$/i.test(doc.file_name || '')) {
      await ctx.reply('El archivo tiene que ser un .xlsx. Probá de nuevo o escribí "cancelar".');
      return;
    }

    await ctx.reply('Recibido. Procesando el archivo, aguantá unos segundos... ⏳');
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const resp = await fetch(link.href);
      if (!resp.ok) throw new Error(`No pude descargar el archivo (HTTP ${resp.status})`);
      const buffer = Buffer.from(await resp.arrayBuffer());

      const { articulos, filasLeidas } = parsearArticulos(buffer);
      if (articulos.length === 0) {
        await ctx.reply('El archivo no tenía artículos válidos. ¿Es el Excel correcto?');
        return ctx.scene.leave();
      }

      const guardados = await upsertArticulos(articulos);
      const total = await contarArticulos();
      await ctx.reply(
        '✅ Maestro actualizado.\n\n' +
        `Filas leídas: ${filasLeidas}\n` +
        `Guardados/actualizados: ${guardados}\n` +
        `Total de artículos en la base: ${total}`
      );
    } catch (err) {
      console.error('Error procesando artículos:', err);
      await ctx.reply('❌ Hubo un error procesando el Excel. Fijate que sea el archivo correcto y probá de nuevo.');
    }
    return ctx.scene.leave();
  }
);

module.exports = actArticWizard;
