// Wizard /carga: la puerta de entrada de TODOS los .xlsx que recibe el bot. El usuario manda los
// archivos en cualquier orden y el bot reconoce cada uno solo (no hay que decirle cuál es cuál).
//
// Qué entra hoy (ver lib/documentos-carga.js, que es donde se declara cada tipo):
//   - el LIBRO DIARIO (Diario de Sigma)  → se archiva permanente (lo usan cierre/mp/flujos),
//   - la liquidación de MERCADO PAGO      → queda en espera para el arqueo de las 08:00,
//   - la PLANILLA DE RETIROS              → alimenta la pantalla /tv_recepcion del sitio.
// TALO NO se pide acá: se baja sola por API a las 21:00 (bajaPorApi), así que ni se reclama ni se
// lista. Igual se puede subir a mano como fallback si la bajada falló (cae en la misma espera).
//
// DOS RITMOS DISTINTOS conviven en el mismo comando. El libro y las liquidaciones son la carga
// NOCTURNA: no se concilia en el momento, a las 08:00 el barrido (entrega-arqueo.js) cruza todo y
// manda los reportes. La planilla de retiros es lo contrario: se sube durante el día, varias veces.
// Por eso el resumen final solo reclama lo nocturno si efectivamente se cargó algo nocturno — si
// no, alguien que sube retiros a las 11 de la mañana se llevaría un "me falta el libro" que no
// tiene nada que ver con lo que hizo.
//
// EL PERMISO ES POR DOCUMENTO, no por comando: entra cualquiera que pueda subir al menos un tipo,
// y al reconocer el archivo se valida si esa persona puede. Así el área Retiros sube su planilla
// sin que se le abran el libro ni las liquidaciones, que son data financiera.
const { Scenes } = require('telegraf');
const { esCancelar } = require('../lib/wizard');
const { PLATAFORMAS, plataformasManuales } = require('../lib/plataformas');
const { LibroError } = require('../lib/registrar-libro');
const { plataformasPendientesDe } = require('../db/liquidaciones-pendientes');
const { avisarLibroResuelto } = require('../aviso-libro');
const { cubreFecha } = require('../db/libro');
const {
  DocumentoInvalido, puedeSubir, documentosDe, puedeUsarCarga, detectarDocumento, isoALinda,
} = require('../lib/documentos-carga');

async function bajarDoc(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}

// Rutea UN documento: detecta qué es, valida el permiso y lo guarda donde va. NO tira por archivo
// inválido ni por falta de permiso: devuelve un objeto con el resultado para que el wizard arme el
// mensaje.
async function rutearDoc({ buffer, nombreArchivo, usuario }) {
  const doc = detectarDocumento(buffer);
  if (!doc) return { tipo: 'no_reconocido', msg: '' };

  // El permiso se chequea DESPUÉS de saber qué es y ANTES de escribir nada: detectar solo lee
  // encabezados, así que hasta acá no se tocó la base.
  if (!puedeSubir(usuario, doc)) {
    return {
      tipo: 'sin_permiso',
      msg: `🔒 Reconocí el archivo (${doc.nombre.toLowerCase()}), pero ese documento no lo subís vos. ` +
           'Pedile a quien corresponda que lo cargue.',
    };
  }

  try {
    const res = await doc.procesar({ buffer, nombreArchivo, usuarioId: usuario ? usuario.id : null });
    return { tipo: 'ok', doc, ...res };
  } catch (e) {
    // El libro es el catch-all: que no parsee significa que el archivo no era ninguno de los tipos.
    if (e instanceof LibroError) return { tipo: 'no_reconocido', msg: e.message };
    if (e instanceof DocumentoInvalido) return { tipo: 'invalido', msg: e.message };
    throw e;
  }
}

// Estado del día para el resumen NOCTURNO: qué hay y qué falta (libro + cada plataforma).
async function estadoDelDia(dia) {
  const [y, m, d] = String(dia).split('-').map(Number);
  const fecha = new Date(y, m - 1, d);
  const [tieneLibro, plataformas] = await Promise.all([
    cubreFecha({ fecha }).catch(() => false),
    plataformasPendientesDe({ fecha }).catch(() => []),
  ]);
  const faltan = [];
  if (!tieneLibro) faltan.push('el libro');
  // Solo se reclaman las plataformas de carga MANUAL: Talo se baja sola por API (bajaPorApi) y no se
  // reclama acá (igual que el aviso de las 21:30). Si igual se subió a mano, cae en `plataformas`.
  for (const p of plataformasManuales()) {
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
    const usuario = ctx.state.usuario;
    const r = await rutearDoc({ buffer, nombreArchivo: doc.file_name || 'archivo.xlsx', usuario });

    if (r.tipo === 'no_reconocido') {
      // Se enumera solo lo que ESTA persona puede subir: listarle documentos que no le
      // corresponden es ruido y la manda a buscar un archivo que no tiene.
      const mios = documentosDe(usuario).map((d) => d.nombre.toLowerCase());
      await ctx.reply(
        '🤔 No reconozco ese archivo.' +
        (mios.length ? ` Esperaba: ${mios.join(', ')}.` : '') +
        (r.msg ? `\n\n${r.msg}` : '')
      );
      return;
    }
    if (r.tipo === 'invalido' || r.tipo === 'sin_permiso') {
      await ctx.reply(r.msg, { parse_mode: 'HTML' });
      return;
    }

    st.huboAlgo = true;
    for (const dia of r.dias || []) (r.doc.nocturno ? st.diasNocturnos : st.diasRetiros).add(dia);
    await ctx.reply(`${r.mensaje}\n\nMandame otro documento o escribí <b>listo</b>.`, { parse_mode: 'HTML' });

    // Como /libro: si había un aviso "falta el libro" pendiente, avisar al resto que ya está.
    if (r.huboLibro) {
      st.huboLibro = true;
      try {
        await avisarLibroResuelto(ctx.telegram, {
          subidoPorTxt: (usuario && usuario.nombre) || (ctx.from && ctx.from.username ? '@' + ctx.from.username : ''),
          subidoPorTelegramId: ctx.from && ctx.from.id,
        });
      } catch (e) { console.error('carga: avisarLibroResuelto falló (sigo):', e.message); }
    }
  } catch (e) {
    console.error('Error en /carga (documento):', e.message);
    await ctx.reply('Hubo un problema con ese archivo. Probá de nuevo o avisá al admin.');
  }
}

// Cierra la carga. Corre DESPUÉS de los documentos en vuelo (va por la misma cola), así el estado
// que reporta ya incluye lo recién guardado.
//
// El reclamo de "me falta el libro / Mercado Pago" es de la carga NOCTURNA y solo sale si se cargó
// algo nocturno. Quien sube la planilla de retiros a media mañana no tiene por qué llevarse un
// pedido de documentos de Tesorería que ni siquiera puede subir.
async function finalizar(ctx, st) {
  if (!st.huboAlgo) { await ctx.reply('Todavía no me mandaste ningún documento.'); return ctx.scene.leave(); }

  const lineas = [];
  if (st.diasNocturnos.size) {
    lineas.push('✅ <b>Listo por hoy.</b>');
    for (const dia of [...st.diasNocturnos].sort()) {
      const e = await estadoDelDia(dia);
      lineas.push('', `📅 <b>${isoALinda(dia)}</b>:`);
      if (!e.faltan.length) lineas.push('   Tengo todo (libro + liquidaciones). El arqueo sale a las 08:00. ✅');
      else lineas.push(`   Me falta: <b>${e.faltan.join(', ')}</b>. Subilo y a las 08:00 arqueo lo que tenga.`);
    }
  }
  if (st.diasRetiros.size) {
    if (lineas.length) lineas.push('');
    const dias = [...st.diasRetiros].sort().map(isoALinda).join(', ');
    lineas.push(`📺 <b>Pantalla de recepción</b> actualizada con: ${dias}.`);
    lineas.push('<i>Volvé a mandarme la planilla cada vez que la actualices y la pantalla se pone al día.</i>');
  }
  await ctx.reply(lineas.join('\n'), { parse_mode: 'HTML' });
  return ctx.scene.leave();
}

const cargaWizard = new Scenes.WizardScene(
  'carga-wizard',
  // 0: explicar y pedir los documentos, listando solo lo que ESTA persona puede subir
  async (ctx) => {
    ctx.wizard.state.data = {
      diasNocturnos: new Set(), diasRetiros: new Set(), huboLibro: false, huboAlgo: false,
    };
    const usuario = ctx.state.usuario;
    const mios = documentosDe(usuario);
    if (!mios.length) { await ctx.reply('No tenés ningún documento para cargar.'); return ctx.scene.leave(); }

    // Cada tipo de documento se presenta solo (ver lib/documentos-carga.js). Las liquidaciones
    // salen una por plataforma con su `archivoEsperado`, que es lo que sumó el arqueo bancario.
    const lista = mios.flatMap((d) => d.etiquetas()).map((e) => `• ${e}`).join('\n');

    // Plataformas que se bajan solas por API (hoy Talo): se avisa que NO hay que subirlas. Solo si
    // esta persona sube liquidaciones — a quien carga retiros no le dice nada. Todo pluralizado por
    // si mañana hay más de una plataforma automática ("A y B se descargan…").
    let notaAuto = '';
    if (mios.some((d) => d.codigo === 'liquidacion')) {
      const auto = PLATAFORMAS.filter((p) => p.bajaPorApi).map((p) => p.nombre);
      if (auto.length) {
        const varios = auto.length > 1;
        const nombres = varios ? `${auto.slice(0, -1).join(', ')} y ${auto[auto.length - 1]}` : auto[0];
        const la = varios ? 'las' : 'la';
        notaAuto =
          `🤖 <b>${nombres}</b> se descarga${varios ? 'n' : ''} sola${varios ? 's' : ''} por API a las 21:00 — ` +
          `no hace falta subirla${varios ? 's' : ''} a mano ` +
          `(si algún día te ${la} pido porque ${varios ? 'fallaron' : 'falló'}, ${la} podés mandar acá igual).\n\n`;
      }
    }

    // La nota del cierre nocturno tampoco aplica a quien solo sube retiros.
    const notaNocturna = mios.some((d) => d.nocturno)
      ? '🕗 El libro queda archivado; las liquidaciones se arquean solas a las 08:00 y el reporte ' +
        'les llega a Tesorería y Caja Central.\n\n'
      : '';
    const notaRetiros = mios.some((d) => d.codigo === 'retiros')
      ? '📺 La planilla de retiros actualiza la pantalla de recepción al toque. Mandámela cada vez ' +
        'que la cambies.\n\n'
      : '';

    await ctx.reply(
      '📥 <b>Carga de documentos</b>.\n\n' +
      `Mandame los archivos (uno o varios, en cualquier orden):\n${lista}\n\n` +
      notaAuto + notaRetiros + notaNocturna +
      '🔎 Reconozco cada archivo solo: no hace falta que me digas cuál es cuál.\n\n' +
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
    // El permiso fino es por documento (ver rutearDoc); acá solo se corta a quien no puede subir nada.
    if (!puedeUsarCarga(ctx.state.usuario)) { await ctx.reply('No tenés ningún documento para cargar.'); return ctx.scene.leave(); }
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
