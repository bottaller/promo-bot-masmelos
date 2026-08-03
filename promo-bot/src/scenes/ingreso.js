// Wizard /ingreso (área Depósito): el empleado sube el Excel de ingresos del día
// (resumen por proveedor) y guardamos la columna de nombres en public.ingresos,
// que lee la web. Ignora Bultos/Total (ver lib/ingresos-excel.js).
const { Scenes } = require('telegraf');
const { parsearIngresos } = require('../lib/ingresos-excel');
const { registrarIngresos } = require('../db/deposito');
const { respuesta, esCancelar, opciones, preguntar, SI_NO } = require('../lib/wizard');
const { fechaHoyArgISO, sumarDias, fechaISO, formatoVencimiento, parseVencimiento } = require('../lib/fechas');

function hoyDate() {
  const [y, m, d] = fechaHoyArgISO().split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fechaLinda(iso) {
  return formatoVencimiento(new Date(iso + 'T00:00:00'));
}

async function cancelar(ctx) {
  await ctx.reply('Carga de ingresos cancelada.');
  return ctx.scene.leave();
}

const ingresoWizard = new Scenes.WizardScene(
  'ingreso-wizard',
  // 0: elegir el día
  async (ctx) => {
    ctx.wizard.state.data = {};
    const hoy = hoyDate();
    const ayer = sumarDias(hoy, -1);
    ctx.wizard.state.hoyISO = fechaISO(hoy);
    ctx.wizard.state.ayerISO = fechaISO(ayer);
    await preguntar(
      ctx,
      'Ingreso de mercadería.\n\n¿De qué día es lo que entró? (o "cancelar")',
      opciones([
        [`Hoy (${formatoVencimiento(hoy)})`, 'hoy'],
        [`Ayer (${formatoVencimiento(ayer)})`, 'ayer'],
        ['Otra fecha', 'otra'],
      ])
    );
    return ctx.wizard.next();
  },
  // 1: resolver la fecha -> pedir el Excel
  async (ctx) => {
    const r = await respuesta(ctx);
    if (r === null) return;
    if (esCancelar(r)) return cancelar(ctx);

    if (ctx.wizard.state.esperaFecha) {
      const d = parseVencimiento(r);
      if (!d) { await ctx.reply('Fecha inválida. Escribila como DD/MM/AAAA (o "cancelar").'); return; }
      ctx.wizard.state.data.fecha = fechaISO(d);
    } else if (r === 'hoy') {
      ctx.wizard.state.data.fecha = ctx.wizard.state.hoyISO;
    } else if (r === 'ayer') {
      ctx.wizard.state.data.fecha = ctx.wizard.state.ayerISO;
    } else if (r === 'otra') {
      ctx.wizard.state.esperaFecha = true;
      await ctx.reply('Escribí la fecha (DD/MM/AAAA):');
      return; // sigue en este paso esperando el texto
    } else {
      const d = parseVencimiento(r);
      if (!d) { await ctx.reply('Elegí una opción o escribí la fecha DD/MM/AAAA.'); return; }
      ctx.wizard.state.data.fecha = fechaISO(d);
    }

    await ctx.reply(
      `Fecha: ${fechaLinda(ctx.wizard.state.data.fecha)}.\n\n` +
      'Ahora adjuntá el Excel (.xlsx) con los ingresos del día. (o "cancelar")'
    );
    return ctx.wizard.next();
  },
  // 2: recibir el Excel -> parsear -> pedir confirmación
  async (ctx) => {
    if (ctx.message && ctx.message.text && esCancelar(ctx.message.text.trim())) return cancelar(ctx);

    const doc = ctx.message && ctx.message.document;
    if (!doc) { await ctx.reply('Necesito el archivo .xlsx adjunto. Probá de nuevo o "cancelar".'); return; }
    if (!/\.xlsx$/i.test(doc.file_name || '')) {
      await ctx.reply('El archivo tiene que ser un .xlsx. Probá de nuevo o "cancelar".');
      return;
    }

    await ctx.reply('Recibido. Procesando el Excel... ⏳');
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const resp = await fetch(link.href);
      if (!resp.ok) throw new Error(`No pude descargar el archivo (HTTP ${resp.status})`);
      const buffer = Buffer.from(await resp.arrayBuffer());

      const { nombres } = parsearIngresos(buffer);
      if (!nombres.length) {
        await ctx.reply('No encontré nombres en el Excel. ¿Es el archivo correcto?');
        return ctx.scene.leave();
      }
      ctx.wizard.state.data.nombres = nombres;

      const muestra = nombres.slice(0, 10).map((n) => `• ${n}`).join('\n');
      const extra = nombres.length > 10 ? `\n…y ${nombres.length - 10} más` : '';
      await preguntar(
        ctx,
        `Encontré ${nombres.length} ingresos para el ${fechaLinda(ctx.wizard.state.data.fecha)}:\n\n` +
        `${muestra}${extra}\n\n¿Guardo?`,
        SI_NO
      );
      return ctx.wizard.next();
    } catch (err) {
      console.error('Error procesando ingresos:', err);
      await ctx.reply('❌ Hubo un error procesando el Excel. Fijate que sea el correcto y probá de nuevo.');
      return ctx.scene.leave();
    }
  },
  // 3: confirmar -> guardar
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return;
    if (esCancelar(raw)) return cancelar(ctx);
    const r = raw.toLowerCase();
    if (r !== 'si' && r !== 'sí') { await ctx.reply('Carga cancelada.'); return ctx.scene.leave(); }
    if (ctx.wizard.state.guardando) return; // anti doble-tap
    ctx.wizard.state.guardando = true;

    const { fecha, nombres } = ctx.wizard.state.data;
    try {
      const n = await registrarIngresos({ fecha, nombres });
      await ctx.reply(`✅ Listo. Guardé ${n} ingresos del ${fechaLinda(fecha)}. Ya se ven en la web.`);
    } catch (err) {
      console.error('Error guardando ingresos:', err);
      await ctx.reply('❌ No pude guardar los ingresos. Probá de nuevo o avisá al admin.');
    }
    return ctx.scene.leave();
  }
);

module.exports = ingresoWizard;
