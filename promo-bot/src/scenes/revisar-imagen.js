// Wizard corto: se entra al tocar "🔁 Revisar" en una imagen de /promoprecios (Compras, ver
// acciones-calidad.js). Pide qué hay que corregir, lo guarda, y le avisa a Marketing cuál imagen
// tiene que corregir y por qué — sin tocar las demás imágenes del mismo ciclo.
const { Scenes } = require('telegraf');
const { marcarImagenRevisar } = require('../db/promoprecios');
const { telegramIdsPorRol } = require('../db/usuarios');
const { respuesta, esCancelar } = require('../lib/wizard');

const revisarImagenWizard = new Scenes.WizardScene(
  'revisar-imagen-wizard',
  // 0: preguntar qué hay que corregir (el id de la imagen viene de ctx.session, ver acciones-calidad.js)
  async (ctx) => {
    ctx.wizard.state.imagenId = ctx.session.imagenIdParaRevisar;
    await ctx.reply('¿Qué hay que corregir de esta imagen? (o "cancelar" para no marcarla)');
    return ctx.wizard.next();
  },
  // 1: procesar el motivo -> guardar y avisar a Marketing
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado. La imagen sigue pendiente de tu validación.'); return ctx.scene.leave(); }
    if (!r) { await ctx.reply('Escribí qué hay que corregir.'); return; }

    const imagen = await marcarImagenRevisar(ctx.wizard.state.imagenId, r);
    if (!imagen) {
      await ctx.reply('Esa imagen ya no estaba pendiente (puede que ya la hayas validado).');
      return ctx.scene.leave();
    }

    let avisados = 0;
    for (const tid of await telegramIdsPorRol('marketing')) {
      try {
        await ctx.telegram.sendPhoto(tid, imagen.file_id, {
          caption: `🔁 La imagen #${imagen.orden} necesita una corrección:\n\n${r}\n\nMandame la versión corregida con /imagenes.`,
        });
        avisados++;
      } catch (e) { console.error('No pude avisarle a marketing:', e.message); }
    }
    await ctx.reply(`Listo, le avisé a Marketing (${avisados} persona(s)) qué hay que corregir.`);
    return ctx.scene.leave();
  }
);

module.exports = revisarImagenWizard;
