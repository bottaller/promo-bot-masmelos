// Wizard /carteleria (área Depósito): pide una foto del producto (+ precio, salvo para
// "nuevo ingreso"), el tipo de gráfica y el tipo de precio, y arma el diseño final
// automáticamente:
//   1. Lee producto (y precio, si corresponde) de la foto con IA (visión, solo lectura —
//      nunca dibuja nada).
//   2. Compone el cartel por código (satori + sharp) sobre la plantilla que corresponda.
//      "nuevo_ingreso" (solo A4/A4 Color) no lleva precio: la propia foto que sube
//      Depósito se compone en el hueco de imagen del cartel.
//   3. Le manda a MARKETING la foto original + el diseño generado, para que lo verifique
//      contra la foto antes de imprimir o pedirlo a la gráfica (ver acciones-deposito.js).
// Si la IA falla o no está configurada, cae al flujo viejo: foto cruda directo a Marketing,
// sin diseño ni verificación (degradación explícita, nunca deja el wizard colgado).
const { Scenes } = require('telegraf');
const { crearCarteleria, carteleriaPorId, guardarDiseno } = require('../db/carteleria');
const { esCancelar, opciones, preguntar, respuesta, texto } = require('../lib/wizard');
const { TIPOS, avisarAMarketingFinal, avisarVerificacionMarketing } = require('../lib/carteleria-mensajes');
const { tiposPrecioValidos, LABELS_TIPO_PRECIO } = require('../lib/carteleria-plantillas');
const { extraerProductoPrecio, descargarImagenTelegram } = require('../lib/carteleria-vision');
const { quitarFondo } = require('../lib/carteleria-fondo');
const { generarCartel } = require('../lib/carteleria-render');

// "7/8/26", "07-08-2026", etc. -> 'YYYY-MM-DD' (o null si no es una fecha válida).
function parseFecha(valor) {
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec((valor || '').trim());
  if (!m) return null;
  let d = Number(m[1]);
  let mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const fecha = new Date(Date.UTC(y, mo - 1, d));
  if (fecha.getUTCFullYear() !== y || fecha.getUTCMonth() !== mo - 1 || fecha.getUTCDate() !== d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}`;
}

const carteleriaWizard = new Scenes.WizardScene(
  'carteleria-wizard',
  // 0: pedir la foto
  async (ctx) => {
    await ctx.reply('Mandame la foto del producto con el precio (o "cancelar").');
    return ctx.wizard.next();
  },
  // 1: recibir la foto -> preguntar el tipo de gráfica
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const fotos = ctx.message && ctx.message.photo;
    if (!fotos || !fotos.length) {
      await ctx.reply('Mandame la foto (o "cancelar").');
      return;
    }
    ctx.wizard.state.fotoFileId = fotos[fotos.length - 1].file_id;
    await preguntar(
      ctx,
      '¿Qué tipo de gráfica necesitás?',
      opciones([
        ['A4', 'a4'],
        ['A4 Color', 'a4_color'],
        ['Cartel simple', 'cartel_simple'],
        ['Gráfica cigüeña', 'ciguena'],
      ])
    );
    return ctx.wizard.next();
  },
  // 2: recibir el tipo de gráfica -> preguntar el tipo de precio (según corresponda)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!r || !TIPOS[r]) { await ctx.reply('Elegí una de las opciones.'); return; }

    ctx.wizard.state.tipo = r;
    const opcionesPrecio = tiposPrecioValidos(r).map((t) => [LABELS_TIPO_PRECIO[t], t]);
    await preguntar(ctx, '¿Qué tipo de precio es?', opciones(opcionesPrecio));
    return ctx.wizard.next();
  },
  // 3: recibir el tipo de precio -> vencimiento (si aplica), cantidad de copias (si es interno), o terminar
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const tipo = ctx.wizard.state.tipo;
    if (!r || !tiposPrecioValidos(tipo).includes(r)) { await ctx.reply('Elegí una de las opciones.'); return; }

    ctx.wizard.state.tipoPrecio = r;
    if (r === 'corto_vencimiento') {
      await ctx.reply('¿Cuál es la fecha de vencimiento? (formato D/M/AAAA, ej: 7/8/2026)');
      return ctx.wizard.next();
    }
    if (TIPOS[tipo].interno) {
      await ctx.reply('¿Cuántas copias necesitás?');
      ctx.wizard.selectStep(5);
      return;
    }
    return procesarYFinalizar(ctx);
  },
  // 4: (solo corto vencimiento) recibir la fecha -> siempre es A4/A4 Color, así que pide copias
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const fecha = parseFecha(t);
    if (!fecha) { await ctx.reply('Mandame la fecha en formato D/M/AAAA (ej: 7/8/2026), o "cancelar".'); return; }
    ctx.wizard.state.vencimiento = fecha;
    await ctx.reply('¿Cuántas copias necesitás?');
    return ctx.wizard.next();
  },
  // 5: recibir la cantidad de copias -> generar el diseño y avisar a Marketing
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const cantidad = Number(t);
    if (!t || !Number.isInteger(cantidad) || cantidad < 1) {
      await ctx.reply('Mandame un número entero mayor a 0 (o "cancelar").');
      return;
    }
    ctx.wizard.state.cantidadCopias = cantidad;
    return procesarYFinalizar(ctx);
  }
);

async function procesarYFinalizar(ctx) {
  const u = ctx.state.usuario;
  const { fotoFileId, tipo, tipoPrecio, cantidadCopias, vencimiento } = ctx.wizard.state;

  const id = await crearCarteleria({
    fotoFileId, tipo, tipoPrecio, cantidadCopias, vencimiento,
    usuarioId: u ? u.id : null,
    usuarioNombre: u ? u.nombre : (ctx.from.username || ctx.from.first_name || null),
    usuarioTelegramId: ctx.from.id,
  });

  await ctx.reply('Dame un momento, estoy generando el diseño...');

  const disenoOk = await intentarGenerarDiseno(ctx, { id, fotoFileId, tipo, tipoPrecio, cantidadCopias, vencimiento });
  if (!disenoOk) {
    const avisados = await avisarAMarketingFinal(ctx.telegram, { id, fileIdParaEnviar: fotoFileId, tipo, cantidadCopias });
    await ctx.reply(`No pude generar el diseño automático, le mandé la foto directamente a Marketing (${avisados} persona(s)).`);
    return ctx.scene.leave();
  }

  await ctx.reply('Listo, le mandé el diseño a Marketing para que lo verifique.');
  return ctx.scene.leave();
}

// Devuelve true si pudo generar el diseño y avisarle a Marketing con la verificación;
// false si hay que caer al flujo viejo (cualquier falla se atrapa acá, nunca se propaga).
async function intentarGenerarDiseno(ctx, { id, fotoFileId, tipo, tipoPrecio, cantidadCopias, vencimiento }) {
  try {
    const imagenBuffer = await descargarImagenTelegram(ctx.telegram, fotoFileId);
    const datos = await extraerProductoPrecio(imagenBuffer);
    if (!datos) return false;
    // "nuevo_ingreso" no lleva precio: si es cualquier otro tipo, sí lo necesitamos
    // de verdad (si la IA no lo pudo leer, mejor caer al flujo viejo que mostrar $0).
    if (tipoPrecio !== 'nuevo_ingreso' && typeof datos.precio !== 'number') return false;

    // "nuevo_ingreso": la foto que subió Depósito ES la imagen del cartel — le
    // sacamos el fondo para que se vea solo el producto sobre la plantilla.
    // Para el resto todavía no hay catálogo de imágenes de producto (mejora futura).
    const imagenProductoBuffer = tipoPrecio === 'nuevo_ingreso' ? await quitarFondo(imagenBuffer) : null;

    const disenoBuffer = await generarCartel({
      tipoGrafica: tipo, tipoPrecio, producto: datos.producto, precio: datos.precio, vencimiento,
      imagenProductoBuffer,
    });

    await guardarDiseno(id, { producto: datos.producto, precio: datos.precio, disenoFileId: null });
    const carteleria = await carteleriaPorId(id);
    const { avisados, disenoFileId } = await avisarVerificacionMarketing(ctx.telegram, { carteleria, disenoBuffer });
    if (disenoFileId) await guardarDiseno(id, { producto: datos.producto, precio: datos.precio, disenoFileId });
    return avisados > 0;
  } catch (e) {
    console.error('No pude generar el diseño de cartelería:', e.message);
    return false;
  }
}

module.exports = carteleriaWizard;
