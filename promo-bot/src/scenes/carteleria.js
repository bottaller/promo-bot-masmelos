// Wizard /carteleria (área Depósito): identifica el producto (código de barras o a mano,
// contra el maestro bot.articulos — SIN IA, ver carteleria-codigo-barras.js), pide el tipo de
// gráfica, el tipo de precio, el precio (salvo "nuevo ingreso") y el vencimiento si corresponde,
// y arma el diseño final automáticamente:
//   1. Compone el cartel por código (satori + sharp) sobre la plantilla que corresponda.
//      Si la plantilla tiene hueco de foto (nuevo_ingreso, corto_vencimiento), se busca la
//      imagen YA LIMPIA que corresponda en el catálogo (assets/productos/,
//      carteleria-catalogo.js) por el nombre del producto — si no hay ninguna que matchee,
//      el cartel queda sin foto.
//   2. Le manda a MARKETING el diseño generado, para que lo verifique antes de imprimir o
//      pedirlo a la gráfica (ver acciones-deposito.js).
const { Scenes } = require('telegraf');
const { crearCarteleria, carteleriaPorId, guardarDiseno } = require('../db/carteleria');
const { buscarArticulos } = require('../db/articulos');
const { esCancelar, opciones, parsePrecio, preguntar, respuesta, texto } = require('../lib/wizard');
const { TIPOS, avisarVerificacionMarketing } = require('../lib/carteleria-mensajes');
const { tiposPrecioValidos, LABELS_TIPO_PRECIO, TIPOS_PRECIO_SIN_PRECIO } = require('../lib/carteleria-plantillas');
const { leerCodigoBarras, descargarImagenTelegram } = require('../lib/carteleria-codigo-barras');
const { buscarImagenProducto } = require('../lib/carteleria-catalogo');
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

async function pedirTipoGrafica(ctx) {
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
}

// Fábrica en vez de una sola escena: /carteleria_prueba (solo el dueño del bot, ver
// middleware/authz.js requiereDueno) usa exactamente el mismo wizard, pero con esPrueba=true
// -> el pedido se guarda marcado (bot.carteleria.es_prueba) y TODO vuelve a quien lo probó en
// vez de salir para Marketing real (ver carteleria-mensajes.js).
function crearCarteleriaWizard({ id, esPrueba }) {
  return new Scenes.WizardScene(
  id,
  // 0: pedir la foto del código de barras (o el código/nombre a mano)
  async (ctx) => {
    await ctx.reply(
      (esPrueba ? '🧪 Modo prueba (esto no le llega a Marketing, te llega a vos): ' : '') +
      'Mandame una foto del código de barras del producto, o escribí el código o el nombre a mano (o "cancelar").'
    );
    return ctx.wizard.next();
  },
  // 1: recibir foto (decodifica el código) o texto (código/nombre) -> buscar en el maestro
  async (ctx) => {
    const t = texto(ctx);
    if (t && esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }

    let termino;
    const fotos = ctx.message && ctx.message.photo;
    if (fotos && fotos.length) {
      const fileId = fotos[fotos.length - 1].file_id;
      let buffer;
      try {
        buffer = await descargarImagenTelegram(ctx.telegram, fileId);
      } catch (e) {
        console.error('No pude descargar la foto del código de barras:', e.message);
        await ctx.reply('No pude descargar esa foto. Probá de nuevo, o escribí el código o nombre a mano.');
        return;
      }
      const codigo = await leerCodigoBarras(buffer);
      if (!codigo) {
        await ctx.reply('No pude leer un código de barras en esa foto. Probá con más luz/enfoque, o escribí el código o el nombre a mano (o "cancelar").');
        return;
      }
      ctx.wizard.state.fotoCodigoFileId = fileId;
      termino = codigo;
    } else if (t) {
      termino = t;
    } else {
      await ctx.reply('Mandame la foto del código de barras, o escribí el código o el nombre a mano (o "cancelar").');
      return;
    }

    const resultados = await buscarArticulos(termino, 10);
    if (resultados.length === 0) {
      await ctx.reply(`No encontré "${termino}" en el maestro.\n\nEscribí el nombre del producto para cargarlo a mano (o "cancelar").`);
      return ctx.wizard.selectStep(3);
    }
    ctx.wizard.state.opcionesArticulo = resultados;
    const lista = resultados.map((a, i) => `${i + 1}) ${a.nombre}${a.ean_unidad ? ` — EAN ${a.ean_unidad}` : ''}`).join('\n');
    await ctx.reply(`Encontré:\n\n${lista}\n\nElegí el número (0 = ninguno, cargar a mano).`);
    return ctx.wizard.next();
  },
  // 2: elegir opción de la lista (se tipea el número)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!r) { await ctx.reply('Escribí el número de la lista (o 0 para cargar a mano).'); return; }
    if (r === '0') {
      await ctx.reply('Escribí el nombre del producto (o "cancelar").');
      return ctx.wizard.selectStep(3);
    }
    const n = Number(r);
    const ops = ctx.wizard.state.opcionesArticulo || [];
    if (!Number.isInteger(n) || n < 1 || n > ops.length) {
      await ctx.reply('Elegí un número válido de la lista (o 0 para cargar a mano).');
      return;
    }
    ctx.wizard.state.producto = ops[n - 1].nombre;
    ctx.wizard.state.articuloCodigo = ops[n - 1].codigo;
    await pedirTipoGrafica(ctx);
    return ctx.wizard.selectStep(4);
  },
  // 3: producto cargado a mano (sin match en el maestro)
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!t) { await ctx.reply('Escribí el nombre del producto (o "cancelar").'); return; }
    ctx.wizard.state.producto = t;
    await pedirTipoGrafica(ctx);
    return ctx.wizard.next();
  },
  // 4: recibir el tipo de gráfica -> preguntar el tipo de precio (según corresponda)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!r || !TIPOS[r]) { await ctx.reply('Elegí una de las opciones.'); return; }

    ctx.wizard.state.tipo = r;
    const opcionesPrecio = tiposPrecioValidos(r).map((t) => [LABELS_TIPO_PRECIO[t], t]);
    await preguntar(ctx, '¿Qué tipo de precio es?', opciones(opcionesPrecio));
    return ctx.wizard.next();
  },
  // 5: recibir el tipo de precio -> precio (salvo "nuevo ingreso", que no tiene)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const tipo = ctx.wizard.state.tipo;
    if (!r || !tiposPrecioValidos(tipo).includes(r)) { await ctx.reply('Elegí una de las opciones.'); return; }

    ctx.wizard.state.tipoPrecio = r;
    if (TIPOS_PRECIO_SIN_PRECIO.includes(r)) {
      if (TIPOS[tipo].interno) {
        await ctx.reply('¿Cuántas copias necesitás?');
        ctx.wizard.selectStep(8);
        return;
      }
      return procesarYFinalizar(ctx, esPrueba);
    }
    await ctx.reply('¿Cuál es el precio? (ej: 1500 o 1500,50)');
    return ctx.wizard.next();
  },
  // 6: recibir el precio -> vencimiento (si aplica), cantidad de copias (si es interno), o terminar
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const precio = parsePrecio(t);
    if (precio === null) { await ctx.reply('Mandame un precio válido (ej: 1500 o 1500,50), o "cancelar".'); return; }
    ctx.wizard.state.precio = precio;

    const tipo = ctx.wizard.state.tipo;
    if (ctx.wizard.state.tipoPrecio === 'corto_vencimiento') {
      await ctx.reply('¿Cuál es la fecha de vencimiento? (formato D/M/AAAA, ej: 7/8/2026)');
      return ctx.wizard.next();
    }
    if (TIPOS[tipo].interno) {
      await ctx.reply('¿Cuántas copias necesitás?');
      ctx.wizard.selectStep(8);
      return;
    }
    return procesarYFinalizar(ctx, esPrueba);
  },
  // 7: (solo corto vencimiento) recibir la fecha -> siempre es A4/A4 Color, así que pide copias
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const fecha = parseFecha(t);
    if (!fecha) { await ctx.reply('Mandame la fecha en formato D/M/AAAA (ej: 7/8/2026), o "cancelar".'); return; }
    ctx.wizard.state.vencimiento = fecha;
    await ctx.reply('¿Cuántas copias necesitás?');
    return ctx.wizard.next();
  },
  // 8: recibir la cantidad de copias -> generar el diseño y avisar a Marketing
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    const cantidad = Number(t);
    if (!t || !Number.isInteger(cantidad) || cantidad < 1) {
      await ctx.reply('Mandame un número entero mayor a 0 (o "cancelar").');
      return;
    }
    ctx.wizard.state.cantidadCopias = cantidad;
    return procesarYFinalizar(ctx, esPrueba);
  }
  );
}

async function procesarYFinalizar(ctx, esPrueba) {
  const u = ctx.state.usuario;
  const { fotoCodigoFileId, tipo, tipoPrecio, cantidadCopias, vencimiento, producto, precio, articuloCodigo } = ctx.wizard.state;

  const id = await crearCarteleria({
    fotoFileId: fotoCodigoFileId || null, tipo, tipoPrecio, cantidadCopias, vencimiento,
    usuarioId: u ? u.id : null,
    usuarioNombre: u ? u.nombre : (ctx.from.username || ctx.from.first_name || null),
    usuarioTelegramId: ctx.from.id,
    esPrueba, producto, precio: precio ?? null,
  });

  await ctx.reply('Dame un momento, estoy generando el diseño...');

  try {
    const imagenProductoBuffer = await buscarImagenProducto(producto, articuloCodigo);
    const disenoBuffer = await generarCartel({
      tipoGrafica: tipo, tipoPrecio, producto, precio: precio ?? null, vencimiento, imagenProductoBuffer,
    });

    const carteleria = await carteleriaPorId(id);
    const { avisados, disenoFileId } = await avisarVerificacionMarketing(ctx.telegram, { carteleria, disenoBuffer });
    if (disenoFileId) await guardarDiseno(id, { producto, precio: precio ?? null, disenoFileId });

    if (avisados > 0) {
      await ctx.reply(esPrueba ? 'Listo, te mandé el diseño (no salió para Marketing).' : 'Listo, le mandé el diseño a Marketing para que lo verifique.');
    } else {
      await ctx.reply('Generé el diseño pero no le pude avisar a nadie (¿hay alguien con el rol "marketing" cargado?). Avisale al admin.');
    }
  } catch (e) {
    console.error('No pude generar el diseño de cartelería:', e.message);
    await ctx.reply('No pude generar el diseño del cartel. Probá de nuevo, o avisale al admin si sigue fallando.');
  }
  return ctx.scene.leave();
}

const carteleriaWizard = crearCarteleriaWizard({ id: 'carteleria-wizard', esPrueba: false });
const carteleriaPruebaWizard = crearCarteleriaWizard({ id: 'carteleria-prueba-wizard', esPrueba: true });

module.exports = { carteleriaWizard, carteleriaPruebaWizard };
