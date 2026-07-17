// Wizard /mp (área Tesorería): conciliación de Mercado Pago OPERACIÓN POR OPERACIÓN.
//
// El tesorero manda 1) el export de Sigma con los movimientos de la cuenta de MP (sirve el
// "Diario de movimientos" que ya sube para /cierre, o el "Mayor de cuenta") y 2) la
// liquidación que baja del panel de MP. El bot aparea cada cobranza con su cobro y marca lo
// que no cierra: lo que MP cobró y no se asentó, y lo asentado que MP no tiene.
//
// Es el nivel de abajo de /cierre: aquel dice "Mercado Pago no cierra por $X", este dice
// cuáles son las operaciones. No toca la base: los dos archivos son la fuente de verdad y el
// control se rehace entero cada vez que se corre.
const { Scenes } = require('telegraf');
const { esCancelar } = require('../lib/wizard');
const { parsearMayor, MayorError } = require('../lib/mayor-excel');
const { parsearLiquidacion, LiquidacionError } = require('../lib/liquidacion-excel');
const { conciliarMP, CUENTA_MP } = require('../lib/conciliacion-mp');
const { formatearMP } = require('../lib/reporte-mp');
const { construirInformePDF } = require('../lib/informe-mp-pdf');
const { formatoVencimiento, fechaISO } = require('../lib/fechas');

// El acceso ya lo garantiza requiereArea('tesoreria') al entrar, pero lo re-chequeamos en
// cada paso con documento por si le quitan el rol a mitad de camino (es data financiera).
function tieneAccesoTesoreria(u) {
  return !!(u && (u.es_admin || (u.areas && u.areas.includes('tesoreria'))));
}

async function bajarDoc(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}

// Escapa texto libre (el nombre de la cuenta sale del Excel) antes de meterlo en un mensaje
// con parse_mode:'HTML': un & o un < harían que Telegram rechace el mensaje entero.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nombreOrigen(origen) {
  return origen === 'mayor' ? 'Mayor de cuenta' : 'Diario de movimientos';
}

// 'DD/MM/AAAA' o 'DD/MM/AAAA al DD/MM/AAAA' según el export cubra uno o varios días.
function textoRango(desde, hasta) {
  const d = formatoVencimiento(desde);
  const h = formatoVencimiento(hasta);
  return d === h ? d : `${d} al ${h}`;
}

// 'AAAA-MM-DD' -> 'DD/MM/AAAA' (al usuario se le habla en fecha argentina, no en ISO; el ISO
// queda para comparar — ver docs/convenciones.md).
function isoALinda(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

// Los dos archivos tienen que hablar del mismo día, si no el control es un sinsentido: los
// días que estén en uno y no en el otro caen como diferencias y tapan lo que importa.
// Devuelve { error } si no se pisan en ningún día, o { aviso } si se pisan solo en parte.
function chequearRangos({ mayor, operaciones }) {
  const diasMp = [...new Set(operaciones.map((o) => (o.hora || '').slice(0, 10)).filter(Boolean))].sort();
  if (!diasMp.length) return {};
  const desde = fechaISO(mayor.desde);
  const hasta = fechaISO(mayor.hasta);
  const rangoMp = diasMp.length === 1
    ? isoALinda(diasMp[0])
    : `${isoALinda(diasMp[0])} al ${isoALinda(diasMp[diasMp.length - 1])}`;
  const rangoSis = textoRango(mayor.desde, mayor.hasta);

  if (!diasMp.some((d) => d >= desde && d <= hasta)) {
    return {
      error: `Estos dos archivos no son del mismo día: el export del sistema es del ${rangoSis} ` +
        `y la liquidación de MP es del ${rangoMp}. Mandame los dos del mismo día.`,
    };
  }
  const sistemaFueraDeMp = desde < diasMp[0] || hasta > diasMp[diasMp.length - 1];
  if (sistemaFueraDeMp) {
    return {
      aviso: `⚠️ Ojo: el export del sistema abarca ${rangoSis} y la liquidación solo ${rangoMp}. ` +
        'Los días que no estén en los dos archivos te van a aparecer como diferencias.',
    };
  }
  return {};
}

const mpWizard = new Scenes.WizardScene(
  'mp-wizard',
  // 0: decir qué hace y qué necesita, y pedir el export del sistema
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      '🔎 <b>Conciliación de Mercado Pago</b>, operación por operación.\n' +
      'Aparea cada cobranza del sistema con su cobro en MP y te marca lo que no cierra.\n\n' +
      '<b>Necesito 2 archivos .xlsx, los dos del MISMO día:</b>\n' +
      '  1) los movimientos del sistema (export de Sigma)\n' +
      '  2) la liquidación de Mercado Pago (del panel de MP)\n\n' +
      `<b>Qué concilio:</b> las ventas cobradas por <b>QR o transferencia</b>, que es lo que recibe la cuenta ` +
      `${CUENTA_MP} (MERCADO PAGO MORENO). Lo de <b>Point</b> te lo listo aparte pero no se concilia acá: ` +
      'liquida en las cuentas de tarjetas, no en esa cuenta.\n\n' +
      '<b>1) Mandame el export de Sigma.</b> Me sirve cualquiera de los dos:\n' +
      '• el <b>"Diario de movimientos contables"</b> — el mismo que subís al /cierre, o\n' +
      `• el <b>"Mayor de cuenta"</b> de la ${CUENTA_MP} — este además trae el N° de recibo (REC8 …).\n` +
      '📅 Exportá <b>el día que querés conciliar</b>.\n\n' +
      '(o escribí "cancelar")',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  },
  // 1: recibir el export del sistema -> parsear -> pedir la liquidación
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const doc = ctx.message && ctx.message.document;
    if (!doc) { await ctx.reply('Mandame el export de Sigma como documento .xlsx (o "cancelar").'); return; }
    if (!tieneAccesoTesoreria(ctx.state.usuario)) { await ctx.reply('Ya no tenés acceso al área Tesorería.'); return ctx.scene.leave(); }
    if (ctx.wizard.state.procesando) return; // evita doble envío de archivo
    ctx.wizard.state.procesando = true;

    let mayor;
    try {
      const buffer = await bajarDoc(ctx, doc);
      try {
        mayor = parsearMayor(buffer, { cuentaId: CUENTA_MP });
      } catch (e) {
        if (e instanceof MayorError) { await ctx.reply(e.message); return ctx.scene.leave(); }
        throw e;
      }
    } catch (e) {
      console.error('Error en /mp (export del sistema):', e.message);
      await ctx.reply('Hubo un problema con el export de Sigma. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    } finally {
      ctx.wizard.state.procesando = false;
    }

    ctx.wizard.state.data.mayor = mayor;
    const cobranzas = mayor.movimientos.filter((m) => m.debe > 0).length;
    const rango = textoRango(mayor.desde, mayor.hasta);
    // Mismo criterio que el /cierre: ya sé de qué día es, así que le digo EXACTAMENTE qué
    // bajar y contra qué lo voy a conciliar, en vez de un "mandame la liquidación" a secas.
    await ctx.reply(
      `✅ Leí <b>${cobranzas} cobranzas</b> de ${escapeHtml(mayor.cuenta)} del <b>${rango}</b> ` +
      `(fuente: ${nombreOrigen(mayor.origen)}).\n\n` +
      `<b>2) Ahora mandame la liquidación de Mercado Pago del ${rango}</b>, como .xlsx.\n` +
      '📥 Es el reporte de <b>Liquidaciones</b> que bajás del panel de MP (el archivo <code>settlement_v2-….xlsx</code>).\n' +
      '⚠️ Tiene que ser del <b>mismo día</b> que el export de Sigma: si no, no concilio.',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  },
  // 2: recibir la liquidación -> conciliar -> responder
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const doc = ctx.message && ctx.message.document;
    if (!doc) { await ctx.reply('Mandame la liquidación de Mercado Pago como documento .xlsx (o "cancelar").'); return; }
    if (!tieneAccesoTesoreria(ctx.state.usuario)) { await ctx.reply('Ya no tenés acceso al área Tesorería.'); return ctx.scene.leave(); }
    if (ctx.wizard.state.conciliando) return;
    ctx.wizard.state.conciliando = true;

    try {
      const buffer = await bajarDoc(ctx, doc);
      let liq;
      try {
        liq = parsearLiquidacion(buffer);
      } catch (e) {
        if (e instanceof LiquidacionError) { await ctx.reply(e.message); return ctx.scene.leave(); }
        throw e;
      }

      const { mayor } = ctx.wizard.state.data;
      const rangos = chequearRangos({ mayor, operaciones: liq.operaciones });
      if (rangos.error) { await ctx.reply(rangos.error); return ctx.scene.leave(); }
      if (rangos.aviso) await ctx.reply(rangos.aviso);

      const resultado = conciliarMP({ movimientos: mayor.movimientos, operaciones: liq.operaciones });
      const fecha = textoRango(mayor.desde, mayor.hasta);
      const texto = formatearMP({ fecha, cuenta: mayor.cuenta, resultado, origen: mayor.origen });

      await ctx.reply(texto, { parse_mode: 'HTML' });

      // Informe PDF: el comprobante del control (salió bien/mal, con la fecha y hora). El
      // mensaje de arriba es la vista rápida; el PDF es para archivar/imprimir. Si el armado
      // del PDF fallara, el control YA se comunicó por el mensaje: se avisa y no se cae.
      try {
        const pdf = await construirInformePDF({ fecha, cuenta: mayor.cuenta, resultado });
        const sufijo = fechaISO(mayor.desde) === fechaISO(mayor.hasta)
          ? fechaISO(mayor.desde)
          : `${fechaISO(mayor.desde)}_${fechaISO(mayor.hasta)}`;
        await ctx.replyWithDocument({ source: pdf, filename: `informe_mp_${sufijo}.pdf` });
      } catch (e) {
        console.error('No pude armar el informe PDF de /mp (el control ya se envió por mensaje):', e.message);
        await ctx.reply('⚠️ El control salió (arriba), pero no pude generar el PDF. Avisá al admin si lo necesitás.');
      }
      return ctx.scene.leave();
    } catch (e) {
      console.error('Error en /mp (liquidación/conciliación):', e.message);
      await ctx.reply('Hubo un problema procesando la liquidación. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    } finally {
      ctx.wizard.state.conciliando = false;
    }
  }
);

module.exports = mpWizard;
