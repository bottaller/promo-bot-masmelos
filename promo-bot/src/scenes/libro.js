// Wizard /libro (admin): carga el LIBRO DIARIO UNA sola vez, para que lo consuman los comandos
// que hoy piden el mismo Excel. Ya cableados: /cierre, /mp y /flujos. (/semanal, /mensual y
// /arqueo todavía piden su propio Excel; cuando se cableen, sumarlos acá y al mensaje de abajo.)
// Guarda los movimientos parseados + el .xlsx crudo (ver lib/registrar-libro.js).
//
// La JORNADA se deduce del Excel, no del día en que se sube: si el martes te acordás de que no
// cargaste el lunes, subís el export del lunes y queda archivado como lunes. El bot te lo dice
// explícitamente para que no haya dudas de qué día quedó cargado.
//
// Es admin-only a propósito: si cada área pudiera pisar el libro, dos personas podrían estar
// mirando reportes armados sobre exports distintos del mismo día.
const { Scenes } = require('telegraf');
const { esCancelar } = require('../lib/wizard');
const { registrarLibro, LibroError } = require('../lib/registrar-libro');
const { avisarLibroResuelto } = require('../aviso-libro');
const { formatoVencimiento } = require('../lib/fechas');
const { tieneAccesoTotal } = require('../middleware/authz');

function esAdmin(u) {
  return tieneAccesoTotal(u);
}

async function bajarDoc(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}

function kb(bytes) {
  return `${Math.round((bytes || 0) / 1024)} KB`;
}

// 'AAAA-MM-DD' -> 'DD/MM' (para listar los huecos sin que quede un chorizo de fechas largas).
function diaCorto(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

const libroWizard = new Scenes.WizardScene(
  'libro-wizard',
  // 0: pedir el Excel
  async (ctx) => {
    await ctx.reply(
      '📚 Libro diario.\n\n' +
      'Mandame el "Diario de movimientos contables" de Sigma, como .xlsx.\n' +
      'Queda cargado para /cierre, /mp y /flujos: no hace falta volver a subirlo en cada uno.\n\n' +
      '📌 El día lo saco del Excel, así que si te olvidaste de cargar uno, podés subirlo ahora ' +
      'y queda guardado con SU fecha.\n(o escribí "cancelar")'
    );
    return ctx.wizard.next();
  },
  // 1: recibir el archivo, registrarlo y responder
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Carga cancelada.');
      return ctx.scene.leave();
    }
    const doc = ctx.message && ctx.message.document;
    if (!doc) {
      await ctx.reply('Mandame el libro como documento .xlsx (o "cancelar").');
      return;
    }
    // Re-chequeo del rol: es data financiera y el wizard puede quedar abierto un rato.
    if (!esAdmin(ctx.state.usuario)) {
      await ctx.reply('Solo un administrador puede cargar el libro diario.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.procesando) return; // evita el doble envío del mismo archivo
    ctx.wizard.state.procesando = true;

    const u = ctx.state.usuario;
    try {
      await ctx.reply('Recibido. Guardando el libro…');
      const buffer = await bajarDoc(ctx, doc);

      let res;
      try {
        res = await registrarLibro({
          buffer,
          nombreArchivo: doc.file_name || 'diario.xlsx',
          usuarioId: u ? u.id : null,
        });
      } catch (e) {
        // LibroError = Excel inválido o fecha futura: el mensaje ya está escrito para el usuario.
        if (e instanceof LibroError) { await ctx.reply(e.message); return ctx.scene.leave(); }
        throw e;
      }

      const rango = formatoVencimiento(res.desde) === formatoVencimiento(res.hasta)
        ? formatoVencimiento(res.desde)
        : `${formatoVencimiento(res.desde)} al ${formatoVencimiento(res.hasta)}`;

      const partes = [
        `✅ Libro cargado — jornada <b>${formatoVencimiento(res.jornada)}</b>`,
        '',
        `📅 Trae movimientos del: ${rango}`,
        `📝 ${res.filas} movimientos en ${res.dias} día(s)`,
        `💾 ${kb(buffer.length)}`,
      ];

      // Si en Sigma pediste un rango más ancho del que realmente trajo datos, se aclara: si no,
      // podrías creer que quedaron cubiertos días que en realidad no tienen ni un movimiento.
      const pedido = res.desdePedido && res.hastaPedido
        ? `${formatoVencimiento(res.desdePedido)} al ${formatoVencimiento(res.hastaPedido)}`
        : null;
      if (pedido && pedido !== `${formatoVencimiento(res.desde)} al ${formatoVencimiento(res.hasta)}`
          && pedido !== `${rango} al ${rango}`) {
        partes.push('', `ℹ️ En Sigma pediste ${pedido}, pero solo hay movimientos en el rango de arriba. Archivé ese, que es el real.`);
      }

      // Caso "me olvidé de cargarlo": se dice con todas las letras de qué día quedó, para que
      // no se confunda con el de hoy.
      if (res.atrasado) {
        partes.push('', `📌 Es de un día ANTERIOR — quedó archivado como el libro del ${formatoVencimiento(res.jornada)}.`);
      }
      // Si pisó uno que ya estaba, se dice: un export incompleto no debe reemplazar al bueno
      // sin que nadie lo note.
      if (res.yaHabia) {
        partes.push('', `⚠️ Reemplacé el libro que ya estaba de esa jornada (tenía ${res.previo.filas} movimientos).`);
      }
      // Huecos de la última semana. Puede incluir domingos/feriados: por eso se aclara.
      if (res.huecos && res.huecos.length) {
        partes.push('', `📭 Días sin libro en la última semana: <b>${res.huecos.map(diaCorto).join(', ')}</b>`,
          '<i>(si alguno fue feriado o no hubo operación, ignoralo)</i>');
      }
      partes.push('', 'Ya lo pueden usar /cierre, /mp y /flujos.');

      await ctx.reply(partes.join('\n'), { parse_mode: 'HTML' });

      // Si este libro resuelve un aviso "falta el libro" que ya había salido, avisarle al resto de
      // los admins que ya está (para que no lo carguen de nuevo). Fire-and-forget: no debe demorar
      // ni romper la carga, que ya quedó confirmada arriba. avisarLibroResuelto nunca tira.
      const subidoPorTxt = (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id));
      avisarLibroResuelto(ctx.telegram, { subidoPorTxt, subidoPorTelegramId: ctx.from.id })
        .catch((e) => console.error('No pude anunciar el libro resuelto:', e.message));

      return ctx.scene.leave();
    } catch (e) {
      console.error('Error en /libro:', e.message);
      await ctx.reply('Hubo un problema guardando el libro. Probá de nuevo o revisá el archivo.');
      return ctx.scene.leave();
    }
  }
);

module.exports = libroWizard;
