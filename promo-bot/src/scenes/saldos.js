// Wizard /saldos (área Tesorería): recibe el Excel "Existencias al cierre", lo valida
// y guarda los saldos del día en bot.tesoreria_saldos (lado "realidad" de la conciliación).
const { Scenes } = require('telegraf');
const { esCancelar } = require('../lib/wizard');
const { parsearSaldos, SaldosError } = require('../lib/saldos-excel');
const { guardarSaldos } = require('../db/tesoreria');
const { formatoVencimiento } = require('../lib/fechas');

// El acceso lo garantiza requiereArea('tesoreria') al entrar; lo re-chequeamos en el paso
// del documento por si le quitan el rol a mitad de camino (es data financiera).
function tieneAccesoTesoreria(u) {
  return !!(u && (u.es_admin || (u.areas && u.areas.includes('tesoreria'))));
}

function fmt(monto) {
  return Math.round(monto).toLocaleString('es-AR');
}

const saldosWizard = new Scenes.WizardScene(
  'saldos-wizard',
  // 0: pedir el Excel
  async (ctx) => {
    await ctx.reply(
      'Carga de saldos del día.\n\n' +
      'Mandame el Excel de "Existencias al cierre" (la plantilla de saldos), como archivo .xlsx.\n' +
      '(o escribí "cancelar")'
    );
    return ctx.wizard.next();
  },
  // 1: recibir el Excel, validar y guardar
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Carga cancelada.');
      return ctx.scene.leave();
    }
    const doc = ctx.message && ctx.message.document;
    if (!doc) {
      await ctx.reply('Mandame el archivo .xlsx como documento (no como foto ni texto). O escribí "cancelar".');
      return;
    }
    if (!tieneAccesoTesoreria(ctx.state.usuario)) {
      await ctx.reply('Ya no tenés acceso al área Tesorería.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.guardando) return; // evita doble envío
    ctx.wizard.state.guardando = true;

    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const resp = await fetch(link.href);
      const buffer = Buffer.from(await resp.arrayBuffer());

      let datos;
      try {
        datos = parsearSaldos(buffer);
      } catch (e) {
        if (e instanceof SaldosError) { await ctx.reply(e.message); return ctx.scene.leave(); }
        throw e;
      }

      const u = ctx.state.usuario;
      await guardarSaldos({ fecha: datos.fecha, empresa: datos.empresa, saldos: datos.saldos, usuarioId: u ? u.id : null });

      const detalle = datos.saldos.map((s) => `• ${s.cuenta}: ${fmt(s.monto)} ${s.moneda}`).join('\n');
      await ctx.reply(
        `✅ Saldos guardados — ${datos.empresa}, ${formatoVencimiento(datos.fecha)}:\n\n${detalle}\n\n` +
        '(si re-subís el mismo día, pisa estos valores)'
      );
      return ctx.scene.leave();
    } catch (e) {
      console.error('Error en /saldos:', e.message);
      await ctx.reply('Hubo un problema procesando el Excel de saldos. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    }
  }
);

module.exports = saldosWizard;
