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
const { esCancelar, respuesta, preguntar, opciones } = require('../lib/wizard');
const { conseguirLibro, bufferLibro } = require('../lib/libro-fuente');
const LM = require('../lib/libro-mensajes');
const { parsearMayor, MayorError } = require('../lib/mayor-excel');
const { parsearLiquidacion, LiquidacionError } = require('../lib/liquidacion-excel');
const { conciliarMP, CUENTA_MP } = require('../lib/conciliacion-mp');
const { formatearMP } = require('../lib/reporte-mp');
const { construirInformePDF } = require('../lib/informe-mp-pdf');
const { guardarMpConciliacion } = require('../db/mp-conciliacion');
const { formatoVencimiento, fechaISO, fechaHoraArgDe } = require('../lib/fechas');
const { tieneAccesoTotal } = require('../middleware/authz');

// El área dueña del comando. El acceso ya lo garantiza requiereArea(AREA) al entrar, pero lo
// re-chequeamos en cada paso con documento por si le quitan el rol a mitad de camino (es data
// financiera). OJO: tiene que ser la MISMA área que registra el comando (cajacentral), no otra
// — si no, un usuario con el rol entra pero se traba al mandar el archivo.
const AREA = 'cajacentral';
function tieneAcceso(u) {
  return !!(u && (tieneAccesoTotal(u) || (u.areas && u.areas.includes(AREA))));
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

// Día que cubre la liquidación ('AAAA-MM-DD'), o null si abarca varios. La liquidación es la
// que manda: es la que define, sin ambigüedad, contra qué día hay que conciliar.
function diaDeLiquidacion(liq) {
  const dias = [...new Set((liq.operaciones || []).map((o) => (o.hora || '').slice(0, 10)).filter(Boolean))].sort();
  return dias.length === 1 ? dias[0] : null;
}

function isoADate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Deja el export acotado al día que se concilia. Los movimientos SÍ se filtran (gobiernan el
// apareo 1:1 con las operaciones de MP); `otrasCuentas` NO: el caso que motivó esa feature es
// cross-día (MP cobró un día y el faltante apareció al cerrar la caja a la noche o a la mañana
// siguiente), así que filtrarlas borraría justo la pista que se busca.
// Devuelve { ok:true, mayor, recortado } | { ok:false }
function acotarAlDia(mayor, dia) {
  if (!dia || fechaISO(mayor.desde) === fechaISO(mayor.hasta)) return { ok: true, mayor, recortado: false };
  const delDia = mayor.movimientos.filter((m) => fechaISO(m.fecha) === dia);
  if (delDia.length === 0) return { ok: false };
  const fechas = delDia.map((m) => m.fecha).sort((a, b) => a - b);
  return {
    ok: true,
    recortado: true,
    mayor: { ...mayor, movimientos: delDia, desde: fechas[0], hasta: fechas[fechas.length - 1] },
  };
}

// Concilia y responde. La llaman los DOS caminos —el libro ya cargado y el export mandado a
// mano— para que el resultado y los mensajes sean idénticos vengan de donde vengan.
async function conciliarYResponder(ctx, mayorEntrada, liq, libroMeta) {
  const dia = ctx.wizard.state.data.dia || diaDeLiquidacion(liq);

  const acot = acotarAlDia(mayorEntrada, dia);
  if (!acot.ok) {
    await ctx.reply(
      `El export no tiene movimientos de ${isoALinda(dia)}, que es el día de esa liquidación.\n\n` +
      'Mandame el export de Sigma de ese día y lo concilio.'
    );
    return ctx.scene.leave();
  }
  const mayor = acot.mayor;
  if (acot.recortado) {
    await ctx.reply(
      `📌 El export cubría varios días: me quedo con los <b>${mayor.movimientos.length} movimientos ` +
      `del ${isoALinda(dia)}</b>, que es el día de la liquidación.`,
      { parse_mode: 'HTML' }
    );
  }

  const rangos = chequearRangos({ mayor, operaciones: liq.operaciones });
  if (rangos.error) { await ctx.reply(rangos.error); return ctx.scene.leave(); }
  if (rangos.aviso) await ctx.reply(rangos.aviso);

  // otrasCuentas = el resto del Diario. Habilita rastrear dónde quedó imputado un cobro que MP
  // hizo y no se asentó en la cuenta de MP (ej.: como faltante de una caja física).
  const resultado = conciliarMP({
    movimientos: mayor.movimientos,
    operaciones: liq.operaciones,
    otrasCuentas: mayor.otrasCuentas,
  });
  const fecha = textoRango(mayor.desde, mayor.hasta);
  const texto = formatearMP({ fecha, cuenta: mayor.cuenta, resultado, origen: mayor.origen });

  // Traza de origen: este reporte se reenvía y se mira al día siguiente, y sale idéntico venga
  // del libro o de un Excel subido a mano.
  const partesFinal = [texto, '', `<i>${LM.esc(LM.lineaOrigen(libroMeta))}</i>`];

  // Si el libro se cargó ANTES de que terminaran los cobros del día, puede faltarle la cola de
  // la tarde: aparecerían decenas de operaciones como "cobró MP y no está asentado" y el
  // tesorero perdería horas buscando un agujero que no existe. Es calculable.
  if (libroMeta && libroMeta.cargado_en) {
    const horas = liq.operaciones.map((o) => o.hora).filter(Boolean).sort();
    const ultima = horas.length ? horas[horas.length - 1] : null; // 'AAAA-MM-DD HH:MM:SS' (hora arg de pared)
    // cargado_en es timestamptz; getHours()/fechaISO() sobre él darían la hora del proceso
    // (Railway=UTC), corrida 3 h, así que la comparación contra la hora de pared de la liquidación
    // se dispararía mal (o nunca). Se lleva a hora argentina antes de comparar y de mostrar.
    const cargadoArg = fechaHoraArgDe(libroMeta.cargado_en);
    const cargadoTxt = cargadoArg ? cargadoArg.hhmm : '';
    if (cargadoArg && ultima && `${cargadoArg.iso} ${cargadoTxt}` < ultima.slice(0, 16)) {
      partesFinal.push(
        '',
        `⚠️ Ojo: el libro se cargó a las <b>${cargadoTxt}</b> y hay cobros de MP hasta las ` +
        `<b>${ultima.slice(11, 16)}</b>. Pueden faltar asientos de esa franja: si ves muchas ` +
        'diferencias, reintentá con un export fresco antes de salir a buscarlas.'
      );
    }
  }

  await ctx.reply(partesFinal.join('\n'), { parse_mode: 'HTML' });

  // Informe PDF: el comprobante del control. El mensaje de arriba es la vista rápida; el PDF es
  // para archivar/imprimir. Si el armado fallara, el control YA se comunicó: se avisa y no se cae.
  try {
    const u = ctx.state.usuario;
    const quien = (u && u.nombre) || (ctx.from && ctx.from.username ? '@' + ctx.from.username : String(ctx.from && ctx.from.id || ''));
    const pdf = await construirInformePDF({ fecha, cuenta: mayor.cuenta, resultado, usuario: quien });
    // El nombre lleva la HORA además del día: dos corridas del mismo día (una con el libro viejo
    // en 🔴 y otra con el corregido en 🟢) quedaban con el mismo nombre, indistinguibles sin abrir.
    const ahora = new Date();
    const hhmm = `${String(ahora.getHours()).padStart(2, '0')}${String(ahora.getMinutes()).padStart(2, '0')}`;
    const sufijo = fechaISO(mayor.desde) === fechaISO(mayor.hasta)
      ? fechaISO(mayor.desde)
      : `${fechaISO(mayor.desde)}_${fechaISO(mayor.hasta)}`;
    await ctx.replyWithDocument({ source: pdf, filename: `informe_mp_${sufijo}_${hhmm}.pdf` });
  } catch (e) {
    console.error('No pude armar el informe PDF de /mp (el control ya se envió por mensaje):', e.message);
    await ctx.reply('⚠️ El control salió (arriba), pero no pude generar el PDF. Avisá al admin si lo necesitás.');
  }

  // Guardar cómo salió el control del día → lo consume el RESUMEN SEMANAL (aviso-mp-semanal.js).
  // Robusto: el reporte ya salió; si la base falla, se loguea y no se cae. Re-correr el día pisa.
  try {
    const u = ctx.state.usuario;
    await guardarMpConciliacion({ fecha: mayor.desde, resultado, fuente: mayor.origen, usuarioId: u ? u.id : null });
  } catch (e) {
    console.error('No pude guardar la conciliación de MP del día (el control ya se envió):', e.message);
  }
  return ctx.scene.leave();
}

const mpWizard = new Scenes.WizardScene(
  'mp-wizard',
  // 0: explicar y pedir la LIQUIDACIÓN de Mercado Pago.
  //
  // El orden está invertido a propósito (antes se pedía primero el export de Sigma): la
  // liquidación es la que define SIN AMBIGÜEDAD qué día se concilia, y recién sabiendo el día se
  // puede buscar el libro de ESE día. Si se pidiera primero el export habría que adivinar el día,
  // y un default equivocado se vuelve autoconsistente: el bot pediría la liquidación de ese día,
  // los rangos coincidirían, y saldría un reporte verde del día que no era.
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      '🔎 <b>Conciliación de Mercado Pago</b>, operación por operación.\n' +
      'Aparea cada cobranza del sistema con su cobro en MP y te marca lo que no cierra.\n\n' +
      '<b>Necesito 2 archivos .xlsx, los dos del MISMO día:</b>\n' +
      '  1) la liquidación de Mercado Pago (del panel de MP)\n' +
      '  2) los movimientos del sistema (export de Sigma) — <b>este no hace falta</b> si el admin ' +
      'ya cargó el libro de ese día\n\n' +
      `<b>Qué concilio:</b> las ventas cobradas por <b>QR o transferencia</b>, que es lo que recibe la cuenta ` +
      `${CUENTA_MP} (MERCADO PAGO MORENO). Lo de <b>Point</b> te lo listo aparte pero no se concilia acá: ` +
      'liquida en las cuentas de tarjetas, no en esa cuenta.\n\n' +
      '<b>1) Mandame la liquidación de Mercado Pago</b>, como .xlsx.\n' +
      '📥 Es el reporte de <b>Liquidaciones</b> que bajás del panel de MP (el archivo <code>settlement_v2-….xlsx</code>).\n' +
      '📅 De ahí saco el día y busco el libro de <b>ese</b> día.\n\n' +
      '<i>Si después te pido el export de Sigma, me sirven los dos formatos, pero no dan lo mismo:</i>\n' +
      '• ⭐ el <b>"Diario de movimientos contables"</b> — el mismo que subís al cierre. <b>Es el que conviene:</b> ' +
      'como trae TODAS las cuentas, si algo no cierra puedo decirte <b>en qué otra cuenta quedó imputado</b> ' +
      '(ej.: apareció como faltante de una caja).\n' +
      `• el <b>"Mayor de cuenta"</b> de la ${CUENTA_MP} — solo esa cuenta. Trae el N° de recibo (REC8 …), ` +
      'pero si algo no cierra no puedo rastrear dónde quedó.\n' +
      '📅 Exportá <b>el día que querés conciliar</b>.\n\n' +
      '(o escribí "cancelar")',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  },
  // 1: recibir la liquidación -> saber el día -> buscar el libro de ESE día
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const doc = ctx.message && ctx.message.document;
    if (!doc) { await ctx.reply('Mandame la liquidación de Mercado Pago como documento .xlsx (o "cancelar").'); return; }
    if (!tieneAcceso(ctx.state.usuario)) { await ctx.reply('Ya no tenés acceso al área Caja Central.'); return ctx.scene.leave(); }
    if (ctx.wizard.state.procesando) return; // evita doble envío de archivo
    ctx.wizard.state.procesando = true;

    try {
      const buffer = await bajarDoc(ctx, doc);
      let liq;
      try {
        liq = parsearLiquidacion(buffer);
      } catch (e) {
        if (e instanceof LiquidacionError) { await ctx.reply(e.message); return ctx.scene.leave(); }
        throw e;
      }

      const dia = diaDeLiquidacion(liq);
      ctx.wizard.state.data.liq = liq;
      ctx.wizard.state.data.dia = dia;

      // Si la liquidación abarca varios días no se puede elegir el libro solo: se pide el export.
      if (!dia) {
        await ctx.reply(
          'Esa liquidación abarca varios días, así que no puedo elegir el libro solo.\n\n' +
          '<b>Mandame el export de Sigma</b> que cubra esos días, como .xlsx.',
          { parse_mode: 'HTML' }
        );
        return ctx.wizard.next();
      }

      // El libro tiene que ser el del MISMO día que la liquidación: usar otro produciría
      // diferencias que son puro desfasaje de fechas y no agujeros reales.
      const lib = await conseguirLibro({ modo: 'cubre', fecha: isoADate(dia) });
      if (!lib.ok) {
        const extra = lib.motivo === 'sin_libro'
          ? `Todavía no tengo cargado el libro del <b>${isoALinda(dia)}</b>.`
          : LM.textoFallback(lib.motivo);
        await ctx.reply(
          `${extra}\n\n<b>Mandame el export de Sigma del ${isoALinda(dia)}</b>, como .xlsx.`,
          { parse_mode: 'HTML' }
        );
        return ctx.wizard.next();
      }

      const buf = await bufferLibro(lib.meta);
      if (!buf.ok) {
        await ctx.reply(
          `${LM.textoFallback(buf.motivo)}\n\n<b>Mandame el export de Sigma del ${isoALinda(dia)}</b>, como .xlsx.`,
          { parse_mode: 'HTML' }
        );
        return ctx.wizard.next();
      }

      let mayor;
      try {
        mayor = parsearMayor(buf.buffer, { cuentaId: CUENTA_MP });
      } catch (e) {
        if (!(e instanceof MayorError)) throw e;
        // El libro existe pero no sirve para este control (p. ej. ese día no tuvo cobranzas por
        // QR). NO se termina el wizard: se explica y se le permite mandar el suyo.
        await ctx.reply(
          `${e.message}\n\nSi ese día no hubo cobranzas por QR, es normal. ` +
          `Si creés que sí las hubo, mandame el export de Sigma del ${isoALinda(dia)} y lo miro.`
        );
        return ctx.wizard.next();
      }

      await ctx.reply(
        `✅ Uso el <b>libro del ${LM.diaLibro(lib.meta)}</b> para conciliar el <b>${isoALinda(dia)}</b>. Conciliando…`,
        { parse_mode: 'HTML' }
      );
      ctx.wizard.state.procesando = false;
      return await conciliarYResponder(ctx, mayor, liq, lib.meta);
    } catch (e) {
      console.error('Error en /mp (liquidación):', e.message);
      await ctx.reply('Hubo un problema procesando la liquidación. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    } finally {
      ctx.wizard.state.procesando = false;
    }
  },
  // 2: recibir el export de Sigma (solo si no se pudo usar el libro) -> conciliar
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const doc = ctx.message && ctx.message.document;
    if (!doc) { await ctx.reply('Mandame el export de Sigma como documento .xlsx (o "cancelar").'); return; }
    if (!tieneAcceso(ctx.state.usuario)) { await ctx.reply('Ya no tenés acceso al área Caja Central.'); return ctx.scene.leave(); }
    if (ctx.wizard.state.conciliando) return;
    ctx.wizard.state.conciliando = true;

    try {
      const buffer = await bajarDoc(ctx, doc);
      let mayor;
      try {
        mayor = parsearMayor(buffer, { cuentaId: CUENTA_MP });
      } catch (e) {
        if (e instanceof MayorError) { await ctx.reply(e.message); return ctx.scene.leave(); }
        throw e;
      }
      const { liq } = ctx.wizard.state.data;
      return await conciliarYResponder(ctx, mayor, liq, null);
    } catch (e) {
      console.error('Error en /mp (export del sistema/conciliación):', e.message);
      await ctx.reply('Hubo un problema con el export de Sigma. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    } finally {
      ctx.wizard.state.conciliando = false;
    }
  }
);

module.exports = mpWizard;
