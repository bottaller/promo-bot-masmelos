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
const { conciliarMP } = require('../lib/conciliacion-mp');
const { PLATAFORMAS, detectarPlataforma } = require('../lib/plataformas');
const { formatearArqueo } = require('../lib/reporte-mp');
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
// Concilia TODAS las plataformas cuyas liquidaciones se subieron (Mercado Pago, Talo, …) y
// responde con UN mensaje y UN PDF. El libro es uno solo: de él se saca la cuenta de cada
// plataforma. `liquidaciones` = [{ plataforma, liq }].
async function conciliarYResponder(ctx, libroBuffer, liquidaciones, libroMeta) {
  const dia = ctx.wizard.state.data.dia;
  const resultados = [];

  for (const { plataforma, liq } of liquidaciones) {
    let mayor;
    try {
      mayor = parsearMayor(libroBuffer, { cuentaId: plataforma.cuenta });
    } catch (e) {
      if (!(e instanceof MayorError)) throw e;
      // Esa cuenta no tiene movimientos en el libro. NO es un error: significa que todo lo que
      // cobró la plataforma quedó sin asentar, y eso es justo lo que hay que mostrar.
      mayor = {
        origen: 'diario', cuenta: plataforma.cuentaNombre, movimientos: [], otrasCuentas: [],
        desde: isoADate(dia), hasta: isoADate(dia),
      };
    }
    const acot = acotarAlDia(mayor, dia);
    const mayorDia = acot.ok ? acot.mayor : { ...mayor, movimientos: [] };
    if (acot.recortado) {
      await ctx.reply(
        `📌 ${plataforma.nombre}: el export cubría varios días, me quedo con los ` +
        `<b>${mayorDia.movimientos.length} movimientos del ${isoALinda(dia)}</b>.`,
        { parse_mode: 'HTML' }
      );
    }
    const rangos = chequearRangos({ mayor: mayorDia, operaciones: liq.operaciones });
    if (rangos.error) { await ctx.reply(`${plataforma.nombre}: ${rangos.error}`); return ctx.scene.leave(); }
    if (rangos.aviso) await ctx.reply(rangos.aviso);

    // otrasCuentas = el resto del Diario. Habilita rastrear dónde quedó imputado un cobro que
    // la plataforma hizo y no se asentó en su cuenta (ej.: como faltante de una caja física).
    resultados.push({
      plataforma,
      cuenta: mayorDia.cuenta || plataforma.cuentaNombre,
      mayor: mayorDia,
      resultado: conciliarMP({
        movimientos: mayorDia.movimientos,
        operaciones: liq.operaciones,
        otrasCuentas: mayor.otrasCuentas,
        plataforma,
      }),
    });
  }

  // Para los mensajes de abajo (aviso de libro temprano, PDF, guardado) alcanza con el primero
  // como referencia de origen: el libro es el mismo para todas.
  const mayor = resultados[0].mayor;
  const liq = { operaciones: liquidaciones.flatMap((x) => x.liq.operaciones) };
  const resultado = resultados[0].resultado;
  const fecha = textoRango(mayor.desde, mayor.hasta);
  const texto = formatearArqueo({ fecha, origen: mayor.origen, resultados });

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
        `⚠️ Ojo: el libro se cargó a las <b>${cargadoTxt}</b> y hay cobros hasta las ` +
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
    const pdf = await construirInformePDF({ fecha, resultados, usuario: quien });
    // El nombre lleva la HORA además del día: dos corridas del mismo día (una con el libro viejo
    // en 🔴 y otra con el corregido en 🟢) quedaban con el mismo nombre, indistinguibles sin abrir.
    const ahora = new Date();
    const hhmm = `${String(ahora.getHours()).padStart(2, '0')}${String(ahora.getMinutes()).padStart(2, '0')}`;
    const sufijo = fechaISO(mayor.desde) === fechaISO(mayor.hasta)
      ? fechaISO(mayor.desde)
      : `${fechaISO(mayor.desde)}_${fechaISO(mayor.hasta)}`;
    await ctx.replyWithDocument({ source: pdf, filename: `arqueo_cobros_${sufijo}_${hhmm}.pdf` });
  } catch (e) {
    console.error('No pude armar el informe PDF de /mp (el control ya se envió por mensaje):', e.message);
    await ctx.reply('⚠️ El control salió (arriba), pero no pude generar el PDF. Avisá al admin si lo necesitás.');
  }

  // Guardar cómo salió el control del día, UNA fila por plataforma → lo consume el RESUMEN
  // SEMANAL (aviso-mp-semanal.js). Robusto: el reporte ya salió; si la base falla se loguea y
  // no se cae. Re-correr el día pisa la fila de esa plataforma (no la de las otras).
  for (const x of resultados) {
    try {
      const u = ctx.state.usuario;
      await guardarMpConciliacion({
        fecha: x.mayor.desde, plataforma: x.plataforma.codigo, resultado: x.resultado,
        fuente: x.mayor.origen, usuarioId: u ? u.id : null,
      });
    } catch (e) {
      console.error(`No pude guardar el arqueo de ${x.plataforma.codigo} (el control ya se envió):`, e.message);
    }
  }
  return ctx.scene.leave();
}

// Con las liquidaciones ya recibidas: define el día, busca el libro de ESE día y concilia.
// Si no hay libro utilizable, no corta el wizard: explica y pasa al paso que pide el export.
async function buscarLibroYConciliar(ctx) {
  const liquidaciones = ctx.wizard.state.data.liquidaciones;

  // Todas las liquidaciones tienen que ser del mismo día: si no, el arqueo mezcla días y las
  // diferencias que salen son puro desfasaje de fechas.
  const dias = [...new Set(liquidaciones.map((x) => x.dia).filter(Boolean))];
  if (dias.length > 1) {
    await ctx.reply(
      `Las liquidaciones que me mandaste no son del mismo día (${dias.map(isoALinda).join(', ')}). ` +
      'Mandame las del mismo día y las concilio juntas.'
    );
    return ctx.scene.leave();
  }
  const dia = dias[0] || null;
  ctx.wizard.state.data.dia = dia;
  const nombres = liquidaciones.map((x) => x.plataforma.nombre).join(' + ');

  // Sin un día único (una liquidación abarca varios) no se puede elegir el libro solo.
  if (!dia) {
    await ctx.reply(
      'Esa liquidación abarca varios días, así que no puedo elegir el libro solo.\n\n' +
      '<b>Mandame el export de Sigma</b> que cubra esos días, como .xlsx.',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  }

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

  await ctx.reply(
    `✅ Uso el <b>libro del ${LM.diaLibro(lib.meta)}</b> para arquear <b>${escapeHtml(nombres)}</b> ` +
    `del <b>${isoALinda(dia)}</b>. Conciliando…`,
    { parse_mode: 'HTML' }
  );
  return await conciliarYResponder(ctx, buf.buffer, liquidaciones, lib.meta);
}

const mpWizard = new Scenes.WizardScene(
  'mp-wizard',
  // 0: explicar y pedir las LIQUIDACIONES (una o varias, cualquier plataforma).
  //
  // El orden está invertido a propósito (antes se pedía primero el export de Sigma): la
  // liquidación es la que define SIN AMBIGÜEDAD qué día se concilia, y recién sabiendo el día se
  // puede buscar el libro de ESE día. Si se pidiera primero el export habría que adivinar el día,
  // y un default equivocado se vuelve autoconsistente.
  async (ctx) => {
    ctx.wizard.state.data = { liquidaciones: [] };
    // OJO con escapeHtml: 'Movimientos_<desde>_<hasta>.xlsx' trae <…>, y Telegram lo tomaría
    // como una etiqueta y RECHAZARÍA el mensaje entero (parse_mode HTML).
    const lista = PLATAFORMAS.map((p) => `• <b>${p.nombre}</b> — ${escapeHtml(p.archivoEsperado)}`).join('\n');
    await ctx.reply(
      '📊 <b>Arqueo de cobros</b>, operación por operación.\n' +
      'Aparea cada cobranza del sistema con su cobro en la plataforma y te marca lo que no cierra.\n\n' +
      `<b>Mandame las liquidaciones del día</b> (una o varias, en cualquier orden):\n${lista}\n\n` +
      '🔎 <b>No hace falta que me digas cuál es cuál</b>: reconozco cada archivo solo.\n' +
      '📅 Todas tienen que ser del <b>mismo día</b>. De ahí saco el día y busco el libro de ese día ' +
      '(si el admin ya lo cargó, no me tenés que mandar nada más).\n\n' +
      'Cuando me hayas mandado todas, escribí <b>listo</b>.\n' +
      '(o escribí "cancelar")',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  },
  // 1: ir recibiendo liquidaciones (se detecta la plataforma de cada una). Con "listo" arranca.
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!tieneAcceso(ctx.state.usuario)) { await ctx.reply('Ya no tenés acceso al área Caja Central.'); return ctx.scene.leave(); }
    const acumuladas = ctx.wizard.state.data.liquidaciones;
    const doc = ctx.message && ctx.message.document;

    // Sin documento: si dijo "listo" arrancamos; si no, se le recuerda qué falta.
    if (!doc) {
      const txt = ((ctx.message && ctx.message.text) || '').trim().toLowerCase();
      if (!/^(listo|dale|ya|ok|arranca)$/.test(txt)) {
        await ctx.reply('Mandame la liquidación como documento .xlsx, o escribí "listo" si ya me mandaste todas.');
        return;
      }
      if (!acumuladas.length) { await ctx.reply('Todavía no me mandaste ninguna liquidación.'); return; }
      if (ctx.wizard.state.procesando) return;
      ctx.wizard.state.procesando = true;
      try {
        return await buscarLibroYConciliar(ctx);
      } finally {
        ctx.wizard.state.procesando = false;
      }
    }

    if (ctx.wizard.state.procesando) return; // evita doble envío de archivo
    ctx.wizard.state.procesando = true;
    try {
      const buffer = await bajarDoc(ctx, doc);
      const plataforma = detectarPlataforma(buffer);
      if (!plataforma) {
        await ctx.reply(
          'No reconozco ese archivo como liquidación de ninguna plataforma que conozca ' +
          `(${PLATAFORMAS.map((p) => p.nombre).join(', ')}). ¿Es el reporte correcto?`
        );
        return;
      }
      if (acumuladas.some((x) => x.plataforma.codigo === plataforma.codigo)) {
        await ctx.reply(`Ya me habías mandado la de <b>${plataforma.nombre}</b>: uso la última.`, { parse_mode: 'HTML' });
      }
      let liq;
      try {
        liq = plataforma.parsear(buffer);
      } catch (e) {
        if (e instanceof plataforma.Error) { await ctx.reply(e.message); return; }
        throw e;
      }
      const dia = diaDeLiquidacion(liq);
      const otras = acumuladas.filter((x) => x.plataforma.codigo !== plataforma.codigo);
      otras.push({ plataforma, liq, dia });
      ctx.wizard.state.data.liquidaciones = otras;

      await ctx.reply(
        `✅ <b>${plataforma.nombre}</b>: ${liq.operaciones.length} movimiento(s)` +
        `${dia ? ` del <b>${isoALinda(dia)}</b>` : ''}.\n\n` +
        'Mandame otra liquidación o escribí <b>listo</b> para conciliar.',
        { parse_mode: 'HTML' }
      );
      return;
    } catch (e) {
      console.error('Error en /mp (liquidación):', e.message);
      await ctx.reply('Hubo un problema con esa liquidación. Probá de nuevo o avisá al admin.');
      return;
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
      return await conciliarYResponder(ctx, buffer, ctx.wizard.state.data.liquidaciones, null);
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
