// Wizard /arqueobanco (rol "administración" — bot.areas, DISTINTO de admin del bot): arqueo
// ACUMULADO de cobros de Santander/Supervielle. Cada extracto bancario y cada Mayor/Diario que se
// sube queda GUARDADO renglón por renglón (bot.arqueo_banco_movimientos / arqueo_banco_mayor,
// migración 041): así un cobro que el banco acredita hoy pero Sigma asienta recién unos días
// después se matchea solo en cuanto llega un Mayor más nuevo, sin tener que volver a subir nada de
// lo viejo. El apareo se acota al MES CALENDARIO actual (no compara contra meses anteriores — eso
// es un control aparte, manual).
//
// A DÍA VENCIDO (reporte-arqueo-banco.js::filtrarPorVencimiento): lo pendiente de los últimos
// DIAS_GRACIA_DEFAULT días NO se reporta como alarma — es timing normal, se resuelve solo. Recién
// se marca "vencido, hay que revisarlo" pasado ese margen. Un match se marca matcheado sin importar
// la antigüedad; el filtro solo decide qué se REPORTA como problema.
//
// Sigue sin estar enganchado al circuito automático de MP/Talo — ver la nota en plataformas.js.
// Reusa el mismo motor: parsear()/detectarPlataformaBanco (plataformas.js), parsearMayor
// (mayor-excel.js) y conciliarMP (conciliacion-mp.js). Lo único nuevo es la PERSISTENCIA.
const { Scenes } = require('telegraf');
const { esCancelar } = require('../lib/wizard');
const { detectarPlataformaBanco, PLATAFORMAS_BANCOS } = require('../lib/plataformas');
const { parsearMayor, MayorError } = require('../lib/mayor-excel');
const { conciliarMP, separarTransferenciasInternas } = require('../lib/conciliacion-mp');
const { guardarMovimientosBanco, guardarMayor, pendientesDelMes, marcarMatch } = require('../db/arqueo-banco');
const { formatearArqueoBancoAcumulado, filtrarPorVencimiento } = require('../lib/reporte-arqueo-banco');
const { construirInformePDF } = require('../lib/informe-mp-pdf');
const { fechaHoyArgISO } = require('../lib/fechas');

async function bajarDoc(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}

// 'AAAA-MM' de hoy (Argentina) y su nombre lindo ('agosto 2026'), y el rango de fecha del mes
// para el PDF (que espera 'DD/MM/AAAA al DD/MM/AAAA').
function mesActual() {
  const hoy = fechaHoyArgISO(); // 'AAAA-MM-DD'
  const [y, m] = hoy.split('-').map(Number);
  const mes = `${y}-${String(m).padStart(2, '0')}`;
  const nombre = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(y, m - 1, 1));
  const ultimoDia = new Date(y, m, 0).getDate();
  const rangoPdf = `01/${String(m).padStart(2, '0')}/${y} al ${String(ultimoDia).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  return { mes, nombre, rangoPdf };
}

// Corre el apareo del mes para una plataforma/cuenta y persiste los matches nuevos. Un match es
// un match sin importar la antigüedad: el "día vencido" (filtrarPorVencimiento) solo afecta qué
// se REPORTA como alarma, no qué se marca matcheado. -> resultado CRUDO (conciliarMP)
async function rematchearMes(plataforma) {
  const { mes } = mesActual();
  const { operaciones, movimientos } = await pendientesDelMes({ plataforma: plataforma.codigo, cuentaId: plataforma.cuenta, mes });
  const resultado = conciliarMP({ movimientos, operaciones, plataforma });
  if (resultado.pares.length) {
    await marcarMatch(resultado.pares.map((p) => ({ movimientoId: p.op._id, mayorId: p.mov._id })));
  }
  return resultado;
}

async function responderConAcumulado(ctx, plataforma) {
  const { mes, nombre } = mesActual();
  const crudo = await rematchearMes(plataforma);
  const texto = formatearArqueoBancoAcumulado({ mesTxt: nombre, plataforma, resultado: filtrarPorVencimiento(crudo) });
  await ctx.reply(texto, { parse_mode: 'HTML' });
  return { mes, resultado: crudo };
}

// Misma cola por chat que /carga: si llegan varios archivos como álbum, se procesan de a uno.
const colaPorChat = new Map();
function encolar(ctx, tarea) {
  const chatId = ctx.chat && ctx.chat.id;
  const prev = colaPorChat.get(chatId) || Promise.resolve();
  const mio = prev.then(() => tarea()).catch((e) => { console.error('Error en /arqueobanco (cola):', e.message); });
  colaPorChat.set(chatId, mio.finally(() => { if (colaPorChat.get(chatId) === mio) colaPorChat.delete(chatId); }));
  return mio;
}

// Procesa UN documento: si es un extracto bancario reconocido, lo guarda y matchea esa
// plataforma. Si no, se prueba como Mayor/Diario de Sigma contra CADA cuenta bancaria conocida
// (puede traer una sola o las dos, como "Mayor de cuenta bancos.xlsx") y matchea las que tengan
// movimientos. `st.tocadas` acumula qué plataformas se tocaron en la sesión, para el PDF final.
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
      const u = ctx.state.usuario;
      const { insertados, ignorados } = await guardarMovimientosBanco({
        plataforma: plataforma.codigo, operaciones: liq.operaciones,
        nombreArchivo: doc.file_name || 'archivo.xlsx', usuarioId: u ? u.id : null,
      });
      st.tocadas.add(plataforma.codigo);
      const nota = ignorados ? ` (${ignorados} ya estaban cargados, no se duplicaron)` : '';
      await ctx.reply(`✅ <b>${plataforma.nombre}</b>: ${insertados} movimiento(s) nuevo(s)${nota}. Recalculando el acumulado del mes...`, { parse_mode: 'HTML' });
      await responderConAcumulado(ctx, plataforma);
      return;
    }

    // No es un extracto bancario: se prueba como Mayor/Diario contra cada cuenta conocida.
    let algunaCuenta = false;
    for (const p of PLATAFORMAS_BANCOS) {
      let mayor;
      try {
        mayor = parsearMayor(buffer, { cuentaId: p.cuenta });
      } catch (e) {
        if (e instanceof MayorError) continue; // esa cuenta no está en este archivo
        throw e;
      }
      algunaCuenta = true;
      // Si el archivo trae el Diario ENTERO (no solo el Mayor de esta cuenta), se pueden
      // reconocer las transferencias internas (ej. "Trf Santander -> Supervielle") y sacarlas de
      // los candidatos ANTES de guardar — si no, quedarían pendientes para siempre como si fueran
      // un cobro sin asentar. Con el Mayor de una sola cuenta no hay cómo distinguirlas (mismo
      // límite que ya tenía /mp): quedan todas como candidatas.
      const { candidatos, transferencias } = separarTransferenciasInternas(mayor.movimientos, mayor.otrasCuentas);
      const u = ctx.state.usuario;
      const { insertados, ignorados } = await guardarMayor({
        cuentaId: p.cuenta, movimientos: candidatos,
        nombreArchivo: doc.file_name || 'archivo.xlsx', usuarioId: u ? u.id : null,
      });
      st.tocadas.add(p.codigo);
      const notaDup = ignorados ? ` (${ignorados} ya estaban cargados, no se duplicaron)` : '';
      const notaTransf = transferencias.length ? ` · ${transferencias.length} transferencia(s) interna(s) descartada(s) (no son cobros)` : '';
      await ctx.reply(`📚 <b>Libro (${p.nombre})</b>: ${insertados} movimiento(s) nuevo(s)${notaDup}${notaTransf}. Recalculando el acumulado del mes...`, { parse_mode: 'HTML' });
      await responderConAcumulado(ctx, p);
    }
    if (!algunaCuenta) {
      await ctx.reply(
        '🤔 No reconozco ese archivo. Esperaba un extracto de Santander/Supervielle, o el Mayor/Diario ' +
        'de Sigma que incluya alguna de esas dos cuentas.'
      );
    }
  } catch (e) {
    console.error('Error en /arqueobanco (documento):', e.message);
    await ctx.reply('Hubo un problema con ese archivo. Probá de nuevo o avisá al admin.');
  }
}

// Cierra la sesión: un PDF de cierre por cada plataforma que se tocó, con el acumulado del mes.
async function finalizar(ctx, st) {
  if (!st.tocadas.size) { await ctx.reply('Listo, no mandaste ningún documento.'); return ctx.scene.leave(); }
  const { rangoPdf } = mesActual();
  for (const codigo of st.tocadas) {
    const plataforma = PLATAFORMAS_BANCOS.find((p) => p.codigo === codigo);
    if (!plataforma) continue;
    try {
      const crudo = await rematchearMes(plataforma);
      const u = ctx.state.usuario;
      const nombre = (u && u.nombre) || (ctx.from && ctx.from.username ? `@${ctx.from.username}` : 'Administración');
      const pdf = await construirInformePDF({
        fecha: rangoPdf, resultados: [{ plataforma, cuenta: plataforma.cuentaNombre, resultado: filtrarPorVencimiento(crudo) }], usuario: nombre,
      });
      await ctx.replyWithDocument({ source: pdf, filename: `arqueo_${plataforma.corto}_${mesActual().mes}.pdf` });
    } catch (e) {
      console.error('arqueobanco: no pude armar el PDF de cierre:', e.message);
    }
  }
  await ctx.reply('Listo.');
  return ctx.scene.leave();
}

const arqueoBancoWizard = new Scenes.WizardScene(
  'arqueo-banco-wizard',
  // 0: explicar
  async (ctx) => {
    ctx.wizard.state.data = { tocadas: new Set() };
    const bancos = PLATAFORMAS_BANCOS.map((p) => p.nombre).join(' o ');
    await ctx.reply(
      '🏦 <b>Arqueo bancario acumulado</b> (Santander / Supervielle) — herramienta manual, todavía no automática.\n\n' +
      `Mandame, cuando tengas, en cualquier orden y cantidad:\n• Extractos de <b>${bancos}</b> (los reconozco solos).\n` +
      '• El libro/Mayor o Diario de Sigma (con una cuenta o las dos juntas, como venga).\n\n' +
      'Cada archivo se GUARDA (no se pisa lo de antes) y recalculo el acumulado del <b>mes actual</b> ' +
      'contra TODO lo cargado hasta ahora — así, si Sigma asienta algo unos días después del extracto, ' +
      'lo matchea solo cuando llegue un Mayor más nuevo, sin que resubas nada.\n\n' +
      '⏳ El reporte es <b>a día vencido</b>: lo pendiente de los últimos días no se marca como problema ' +
      '(es normal que tarde en asentarse); recién avisa cuando algo sigue sin aparear pasado ese margen.\n\n' +
      'Cuando termines te mando un PDF de cierre por cada banco que tocaste. Escribí <b>listo</b>.\n(o "cancelar")',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  },
  // 1: recibir documentos (o "listo")
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Listo, salgo.'); return ctx.scene.leave(); }
    const st = ctx.wizard.state.data;
    const doc = ctx.message && ctx.message.document;

    if (doc) return encolar(ctx, () => procesarDoc(ctx, doc, st));

    const txt = ((ctx.message && ctx.message.text) || '').trim().toLowerCase();
    if (/^(listo|dale|ya|ok|terminé|termine)$/.test(txt)) return encolar(ctx, () => finalizar(ctx, st));
    await ctx.reply('Mandame un documento .xlsx, o escribí "listo" cuando termines.');
  }
);

module.exports = arqueoBancoWizard;
