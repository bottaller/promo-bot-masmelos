// Wizard /carga (admin): la carga NOCTURNA de los documentos del día. Reemplaza a /libro y le
// suma las liquidaciones de las plataformas de cobro. El admin manda, en cualquier orden:
//   - el LIBRO DIARIO (Diario de Sigma)     → se archiva permanente (lo usan cierre/mp/flujos),
//   - la liquidación de MERCADO PAGO         → queda en espera para el arqueo de las 08:00,
//   - la liquidación de TALO                 → ídem.
// El bot RECONOCE cada archivo solo (no hay que decirle cuál es cuál). NO concilia en el momento:
// a las 08:00 el barrido (entrega-arqueo.js) cruza las liquidaciones contra el libro y manda los
// reportes a Tesorería + Caja Central. Acá solo se recibe, se guarda y se confirma qué falta.
//
// Admin-only a propósito (igual que /libro): es data financiera y el libro no lo debe pisar
// cualquiera con dos exports distintos del mismo día.
const { Scenes } = require('telegraf');
const { esCancelar } = require('../lib/wizard');
const { detectarPlataforma, PLATAFORMAS } = require('../lib/plataformas');
const { registrarLibro, LibroError } = require('../lib/registrar-libro');
const { guardarLiquidacion, plataformasPendientesDe } = require('../db/liquidaciones-pendientes');
const { avisarLibroResuelto } = require('../aviso-libro');
const { cubreFecha } = require('../db/libro');
const { formatoVencimiento } = require('../lib/fechas');

function esAdmin(u) {
  return !!(u && u.es_admin);
}
async function bajarDoc(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}
function kb(bytes) {
  return `${Math.round((bytes || 0) / 1024)} KB`;
}
function isoADate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function isoALinda(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
// Día que cubre la liquidación ('AAAA-MM-DD'), o null si abarca varios (no se puede archivar sola).
function diaDeLiquidacion(liq) {
  const dias = [...new Set((liq.operaciones || []).map((o) => (o.hora || '').slice(0, 10)).filter(Boolean))].sort();
  return dias.length === 1 ? dias[0] : null;
}

// Rutea UN documento: detecta qué es y lo guarda donde va. NO tira por archivo inválido: devuelve
// un objeto con el resultado para que el wizard arme el mensaje. `dias` acumula los días tocados.
async function rutearDoc({ buffer, nombreArchivo, usuarioId }) {
  // 1) ¿Es la liquidación de una plataforma? (se reconoce por los encabezados)
  const plataforma = detectarPlataforma(buffer);
  if (plataforma) {
    let liq;
    try {
      liq = plataforma.parsear(buffer);
    } catch (e) {
      if (e instanceof plataforma.Error) return { tipo: 'invalido', msg: `${plataforma.nombre}: ${e.message}` };
      throw e;
    }
    const dia = diaDeLiquidacion(liq);
    if (!dia) {
      return { tipo: 'invalido', msg: `Esa liquidación de ${plataforma.nombre} abarca varios días. Mandame una por día para poder arquearla contra su libro.` };
    }
    await guardarLiquidacion({
      fecha: isoADate(dia), plataforma: plataforma.codigo, archivo: buffer,
      nombreArchivo, nOperaciones: liq.operaciones.length, usuarioId,
    });
    return { tipo: 'liquidacion', plataforma, dia, n: liq.operaciones.length };
  }

  // 2) Si no es liquidación, tiene que ser el LIBRO (Diario de Sigma). registrarLibro valida el
  //    formato: si no es un Diario válido, tira LibroError y lo tratamos como "no reconocido".
  try {
    const res = await registrarLibro({ buffer, nombreArchivo, usuarioId });
    return { tipo: 'libro', res };
  } catch (e) {
    if (e instanceof LibroError) return { tipo: 'no_reconocido', msg: e.message };
    throw e;
  }
}

// Estado del día para el resumen: qué hay y qué falta (libro + cada plataforma).
async function estadoDelDia(dia) {
  const fecha = isoADate(dia);
  const [tieneLibro, plataformas] = await Promise.all([
    cubreFecha({ fecha }).catch(() => false),
    plataformasPendientesDe({ fecha }).catch(() => []),
  ]);
  const faltan = [];
  if (!tieneLibro) faltan.push('el libro');
  for (const p of PLATAFORMAS) {
    if (!plataformas.includes(p.codigo)) faltan.push(p.nombre);
  }
  return { tieneLibro, plataformas, faltan };
}

// Serializa las tareas de un MISMO chat. Cuando el admin manda los .xlsx como álbum, Telegram los
// entrega en el mismo batch de getUpdates y telegraf los corre con Promise.all (concurrentes),
// compartiendo la sesión: sin serializar, el segundo documento se pisaba con el primero. Se
// encadenan sincrónicamente (sin await antes del set del Map, así el encadenado es atómico entre
// los handlers concurrentes). El "listo" también se encola → resume DESPUÉS de guardar todo.
const colaPorChat = new Map();
function encolar(ctx, tarea) {
  const chatId = ctx.chat && ctx.chat.id;
  const prev = colaPorChat.get(chatId) || Promise.resolve();
  const mio = prev.then(() => tarea()).catch((e) => { console.error('Error en /carga (cola):', e.message); });
  colaPorChat.set(chatId, mio.finally(() => { if (colaPorChat.get(chatId) === mio) colaPorChat.delete(chatId); }));
  return mio;
}

// Procesa UN documento: lo rutea y confirma. No usa un flag de "procesando" — la cola de arriba
// garantiza que corra de a uno. `st` es el estado del wizard (acumula los días tocados).
async function procesarDoc(ctx, doc, st) {
  try {
    const buffer = await bajarDoc(ctx, doc);
    const u = ctx.state.usuario;
    const r = await rutearDoc({ buffer, nombreArchivo: doc.file_name || 'archivo.xlsx', usuarioId: u ? u.id : null });

    if (r.tipo === 'no_reconocido' || r.tipo === 'invalido') {
      await ctx.reply(
        (r.tipo === 'no_reconocido'
          ? '🤔 No reconozco ese archivo. Esperaba el libro diario de Sigma o una liquidación de ' +
            `${PLATAFORMAS.map((p) => p.nombre).join(' / ')}.\n\n`
          : '') + r.msg
      );
      return;
    }
    if (r.tipo === 'liquidacion') {
      st.dias.add(r.dia);
      await ctx.reply(
        `✅ <b>${r.plataforma.nombre}</b>: ${r.n} operación(es) del <b>${isoALinda(r.dia)}</b>, en espera para el arqueo de las 08:00.\n\n` +
        'Mandame otro documento o escribí <b>listo</b>.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Libro cargado (registrarLibro devolvió el resumen). Se archiva y avisa como /libro.
    const res = r.res;
    st.huboLibro = true;
    if (res.jornada) st.dias.add(res.jornada instanceof Date
      ? `${res.jornada.getFullYear()}-${String(res.jornada.getMonth() + 1).padStart(2, '0')}-${String(res.jornada.getDate()).padStart(2, '0')}`
      : String(res.jornada).slice(0, 10));
    const rango = formatoVencimiento(res.desde) === formatoVencimiento(res.hasta)
      ? formatoVencimiento(res.desde)
      : `${formatoVencimiento(res.desde)} al ${formatoVencimiento(res.hasta)}`;
    const partes = [
      `✅ <b>Libro</b> cargado — jornada <b>${formatoVencimiento(res.jornada)}</b> (${res.filas} mov. · ${kb(buffer.length)}).`,
      `📅 Trae del: ${rango}`,
    ];
    if (res.yaHabia) partes.push(`⚠️ Reemplacé el libro que ya estaba de esa jornada (tenía ${res.previo.filas} mov.).`);
    if (res.huecos && res.huecos.length) {
      partes.push(`📭 Días sin libro en la semana: <b>${res.huecos.map((iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`).join(', ')}</b> <i>(ignorá los feriados)</i>`);
    }
    partes.push('', 'Mandame otro documento o escribí <b>listo</b>.');
    await ctx.reply(partes.join('\n'), { parse_mode: 'HTML' });

    // Como /libro: si había un aviso "falta el libro" pendiente, avisar al resto que ya está.
    const u2 = ctx.state.usuario;
    try {
      await avisarLibroResuelto(ctx.telegram, {
        subidoPorTxt: (u2 && u2.nombre) || (ctx.from && ctx.from.username ? '@' + ctx.from.username : ''),
        subidoPorTelegramId: ctx.from && ctx.from.id,
      });
    } catch (e) { console.error('carga: avisarLibroResuelto falló (sigo):', e.message); }
  } catch (e) {
    console.error('Error en /carga (documento):', e.message);
    await ctx.reply('Hubo un problema con ese archivo. Probá de nuevo o avisá al admin.');
  }
}

// Cierra la carga con el resumen del día (qué falta). Corre DESPUÉS de los documentos en vuelo
// (va por la misma cola), así el estado que reporta ya incluye lo recién guardado.
async function finalizar(ctx, st) {
  if (!st.dias.size && !st.huboLibro) { await ctx.reply('Todavía no me mandaste ningún documento.'); return ctx.scene.leave(); }
  const lineas = ['✅ <b>Listo por hoy.</b>'];
  for (const dia of [...st.dias].sort()) {
    const e = await estadoDelDia(dia);
    lineas.push('', `📅 <b>${isoALinda(dia)}</b>:`);
    if (!e.faltan.length) lineas.push('   Tengo todo (libro + liquidaciones). El arqueo sale a las 08:00. ✅');
    else lineas.push(`   Me falta: <b>${e.faltan.join(', ')}</b>. Subilo y a las 08:00 arqueo lo que tenga.`);
  }
  await ctx.reply(lineas.join('\n'), { parse_mode: 'HTML' });
  return ctx.scene.leave();
}

const cargaWizard = new Scenes.WizardScene(
  'carga-wizard',
  // 0: explicar y pedir los documentos del día
  async (ctx) => {
    ctx.wizard.state.data = { dias: new Set(), huboLibro: false };
    const lista = ['• <b>Libro diario</b> (Diario de movimientos de Sigma)']
      .concat(PLATAFORMAS.map((p) => `• <b>${p.nombre}</b> (liquidación del panel)`))
      .join('\n');
    await ctx.reply(
      '📥 <b>Carga del día</b>.\n\n' +
      `Mandame los documentos del día (uno o varios, en cualquier orden):\n${lista}\n\n` +
      '🔎 Reconozco cada archivo solo: no hace falta que me digas cuál es cuál.\n' +
      '🕗 El libro queda archivado; las liquidaciones se arquean solas a las 08:00 y el reporte ' +
      'les llega a Tesorería y Caja Central.\n\n' +
      'Cuando termines, escribí <b>listo</b>.\n(o escribí "cancelar")',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  },
  // 1: recibir cada documento (o "listo"). El procesamiento se ENCOLA por chat (ver `encolar`):
  // así un álbum de .xlsx —que llega concurrente en el mismo batch— se procesa de a uno sin
  // pisarse, y el "listo" resume DESPUÉS de que todo se guardó.
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Carga cancelada.'); return ctx.scene.leave(); }
    if (!esAdmin(ctx.state.usuario)) { await ctx.reply('Solo un administrador puede cargar los documentos.'); return ctx.scene.leave(); }
    const st = ctx.wizard.state.data;
    const doc = ctx.message && ctx.message.document;

    if (doc) return encolar(ctx, () => procesarDoc(ctx, doc, st));

    // Sin documento: "listo" cierra (encolado, tras los docs en vuelo); otra cosa recuerda qué hacer.
    const txt = ((ctx.message && ctx.message.text) || '').trim().toLowerCase();
    if (!/^(listo|dale|ya|ok|terminé|termine)$/.test(txt)) {
      await ctx.reply('Mandame un documento .xlsx, o escribí "listo" cuando termines.');
      return;
    }
    return encolar(ctx, () => finalizar(ctx, st));
  }
);

module.exports = cargaWizard;
