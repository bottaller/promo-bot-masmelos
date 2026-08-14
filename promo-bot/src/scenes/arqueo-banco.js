// Wizard /arqueobanco (rol "administración" — bot.areas, DISTINTO de admin del bot): arqueo de
// cobros de Santander/Supervielle, TODAVÍA A DEMANDA — a diferencia de MP/Talo (que se cargan
// con /carga y arquean solos a las 08:00), esto no está enganchado al circuito automático: la
// persona manda el extracto de UN día + el libro/Mayor de Sigma que lo cubra, y el arqueo (texto
// + PDF) le llega en el momento. No guarda nada en bot.liquidaciones_pendientes ni en
// bot.mp_conciliacion — es un chequeo puntual, no se reparte solo a Tesorería/Caja Central ni
// suma al resumen semanal (eso, si se pide, es un paso futuro — ver plataformas.js).
//
// Reusa el MISMO motor que /carga: detectarPlataformaBanco/parsear (plataformas.js) y
// arquearDia/diaDeLiquidacion (arqueo.js) — nada de esto se reimplementa acá.
const { Scenes } = require('telegraf');
const { esCancelar } = require('../lib/wizard');
const { detectarPlataformaBanco, PLATAFORMAS_BANCOS } = require('../lib/plataformas');
const { arquearDia, diaDeLiquidacion } = require('../lib/arqueo');
const { construirInformePDF } = require('../lib/informe-mp-pdf');
const { formatoVencimiento } = require('../lib/fechas');

async function bajarDoc(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}
function isoADate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Misma cola por chat que /carga (carga.js): si los dos archivos llegan como álbum, Telegram los
// entrega concurrentes en el mismo batch — sin serializar, el segundo pisaría el estado del primero.
const colaPorChat = new Map();
function encolar(ctx, tarea) {
  const chatId = ctx.chat && ctx.chat.id;
  const prev = colaPorChat.get(chatId) || Promise.resolve();
  const mio = prev.then(() => tarea()).catch((e) => { console.error('Error en /arqueobanco (cola):', e.message); });
  colaPorChat.set(chatId, mio.finally(() => { if (colaPorChat.get(chatId) === mio) colaPorChat.delete(chatId); }));
  return mio;
}

// Procesa UN documento: si es un extracto bancario reconocido, lo guarda como `banco`; si no, se
// asume que es el libro/Mayor de Sigma (arquearDia ya sabe qué hacer si en realidad no lo es: la
// cuenta queda "sin movimientos", igual que en /carga). Cuando están los dos, dispara el arqueo
// y limpia el estado para poder encadenar otro día/banco sin volver a entrar al comando.
async function procesarDoc(ctx, doc, st) {
  try {
    const buffer = await bajarDoc(ctx, doc);
    const plataforma = detectarPlataformaBanco(buffer);

    if (plataforma) {
      let liq;
      try {
        liq = plataforma.parsear(buffer);
      } catch (e) {
        if (e instanceof plataforma.Error) { await ctx.reply(`${plataforma.nombre}: ${e.message}`); return; }
        throw e;
      }
      const dia = diaDeLiquidacion(liq);
      if (!dia) {
        await ctx.reply(`Ese extracto de ${plataforma.nombre} abarca varios días. Mandame el de UN solo día para poder arquearlo.`);
        return;
      }
      st.banco = { plataforma, liq, dia };
      await ctx.reply(
        `✅ <b>${plataforma.nombre}</b>: ${liq.operaciones.length} operación(es) del <b>${formatoVencimiento(isoADate(dia))}</b>.` +
        (st.libro ? ' Arqueo ahora...' : ' Ahora mandame el libro/Mayor de Sigma de ese día.'),
        { parse_mode: 'HTML' }
      );
    } else {
      st.libro = { buffer, nombreArchivo: doc.file_name || 'archivo.xlsx' };
      await ctx.reply(
        `📚 Libro recibido (${doc.file_name || 'archivo.xlsx'}).` +
        (st.banco ? ' Arqueo ahora...' : ' Ahora mandame el extracto de Santander o Supervielle de ese día.')
      );
    }

    if (!(st.banco && st.libro)) return;

    const { banco, libro } = st;
    st.banco = null; st.libro = null; // libre para el próximo par, sin reentrar al comando
    const arq = await arquearDia({
      libroBuffer: libro.buffer,
      liquidaciones: [{ plataforma: banco.plataforma, liq: banco.liq }],
      dia: banco.dia,
    });
    if (!arq.ok) { await ctx.reply(`⚠️ ${arq.error}`); return; }

    await ctx.reply(arq.texto, { parse_mode: 'HTML' });
    try {
      const x = arq.resultados[0];
      const u = ctx.state.usuario;
      const nombre = (u && u.nombre) || (ctx.from && ctx.from.username ? `@${ctx.from.username}` : 'Administración');
      const pdf = await construirInformePDF({ fecha: formatoVencimiento(isoADate(banco.dia)), resultados: [x], usuario: nombre });
      await ctx.replyWithDocument({ source: pdf, filename: `arqueo_${x.plataforma.corto}_${banco.dia}.pdf` });
    } catch (e) {
      console.error('arqueobanco: no pude armar el PDF:', e.message);
    }
    await ctx.reply('Mandame otro extracto + libro para otro arqueo, o escribí <b>listo</b>.', { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Error en /arqueobanco (documento):', e.message);
    await ctx.reply('Hubo un problema con ese archivo. Probá de nuevo o avisá al admin.');
  }
}

const arqueoBancoWizard = new Scenes.WizardScene(
  'arqueo-banco-wizard',
  // 0: explicar y pedir los dos documentos
  async (ctx) => {
    ctx.wizard.state.data = { banco: null, libro: null };
    const bancos = PLATAFORMAS_BANCOS.map((p) => p.nombre).join(' o ');
    await ctx.reply(
      '🏦 <b>Arqueo bancario</b> (Santander / Supervielle) — herramienta manual, todavía no automática.\n\n' +
      `Mandame, en cualquier orden:\n• El extracto de <b>${bancos}</b> de UN día (lo reconozco solo).\n` +
      '• El libro/Mayor de Sigma que cubra ese día.\n\n' +
      'En cuanto tenga los dos, te mando el arqueo (texto + PDF) al toque. Podés encadenar varios ' +
      'pares (otro día, o el otro banco) sin volver a escribir el comando.\n\n' +
      'Cuando termines, escribí <b>listo</b>.\n(o escribí "cancelar")',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  },
  // 1: recibir cada documento (o "listo"). Encolado por chat, igual que /carga.
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Listo, salgo.'); return ctx.scene.leave(); }
    const st = ctx.wizard.state.data;
    const doc = ctx.message && ctx.message.document;

    if (doc) return encolar(ctx, () => procesarDoc(ctx, doc, st));

    const txt = ((ctx.message && ctx.message.text) || '').trim().toLowerCase();
    if (/^(listo|dale|ya|ok|terminé|termine)$/.test(txt)) { await ctx.reply('Listo.'); return ctx.scene.leave(); }
    await ctx.reply('Mandame un documento .xlsx, o escribí "listo" cuando termines.');
  }
);

module.exports = arqueoBancoWizard;
