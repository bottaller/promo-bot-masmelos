// Wizard /auditoria_altura (área Calidad): auditoría de mercadería en altura, pallet por pallet.
// Pide N° Pallet y Pasillo una sola vez; después el repositor va mandando una foto del código de
// barras (o escribiéndolo/el nombre a mano) por cada producto — el bot lo busca en el maestro
// (bot.articulos, SIN IA, ver lib/carteleria-codigo-barras.js) y pregunta si es el producto
// correcto antes de seguir. Confirmado, solo pide cantidad de Unidades sueltas, Displays y
// Bultos, y agrega la fila a la planilla (lib/inventario-sheets.js). Descripción, Cant. x
// Display, Cant. x Bulto y el TOTAL se completan solos en la planilla (fórmulas ya armadas ahí
// contra el código escaneado) — el bot no los toca. Sigue escaneando bajo el mismo pallet/pasillo
// hasta que el repositor escribe "listo".
const { Scenes } = require('telegraf');
const { buscarArticulos } = require('../db/articulos');
const { agregarConteo } = require('../lib/inventario-sheets');
const { leerCodigoBarras, descargarImagenTelegram } = require('../lib/carteleria-codigo-barras');
const { texto, respuesta, esCancelar, parseUnidades, opciones, preguntar } = require('../lib/wizard');

const ES_LISTO = (v) => typeof v === 'string' && /^listo$/i.test(v.trim());

async function cancelar(ctx) {
  await ctx.reply('Auditoría cancelada.');
  return ctx.scene.leave();
}

async function pedirFotoOCodigo(ctx) {
  await ctx.reply(
    'Mandame una foto del código de barras del producto, o escribí el código o el nombre a mano.\n' +
    '(o "listo" para terminar este pallet, "cancelar" para salir)'
  );
}

async function mostrarConfirmacion(ctx, articulo, terminoEscaneado) {
  const d = ctx.wizard.state.data;
  d.candidato = articulo;
  d.terminoEscaneado = terminoEscaneado;
  await preguntar(
    ctx,
    `Encontré: ${articulo.nombre}${articulo.ean_unidad ? ` — EAN ${articulo.ean_unidad}` : ''}\n\n¿Es este el producto?`,
    opciones([['✅ Sí', 'si'], ['🔁 No, reintentar', 'no']])
  );
}

const auditoriaAlturaWizard = new Scenes.WizardScene(
  'auditoria-altura-wizard',
  // 0: pedir N° Pallet
  async (ctx) => {
    ctx.wizard.state.data = { cargados: 0 };
    await ctx.reply('Auditoría de altura.\n\n¿N° de Pallet? (o "cancelar" para salir)');
    return ctx.wizard.next();
  },
  // 1: recibir N° Pallet -> pedir Pasillo
  async (ctx) => {
    const r = texto(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el número de pallet.'); return; }
    ctx.wizard.state.data.pallet = r;
    await ctx.reply('¿Pasillo?');
    return ctx.wizard.next();
  },
  // 2: recibir Pasillo -> arrancar el loop de escaneo
  async (ctx) => {
    const r = texto(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el pasillo.'); return; }
    ctx.wizard.state.data.pasillo = r;
    await pedirFotoOCodigo(ctx);
    return ctx.wizard.next();
  },
  // 3: recibir foto (decodifica el código) o texto (código/nombre) -> buscar en el maestro
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) return cancelar(ctx);
    if (t && ES_LISTO(t)) {
      const { cargados, pallet } = ctx.wizard.state.data;
      await ctx.reply(`Listo. Cargaste ${cargados} producto(s) en el pallet ${pallet}.`);
      return ctx.scene.leave();
    }

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
        await ctx.reply('No pude leer un código de barras en esa foto. Probá con más luz/enfoque, o escribí el código o el nombre a mano.');
        return;
      }
      termino = codigo;
    } else if (t) {
      termino = t;
    } else {
      await pedirFotoOCodigo(ctx);
      return;
    }

    const resultados = await buscarArticulos(termino, 10);
    if (resultados.length === 0) {
      await ctx.reply(`No encontré "${termino}" en el maestro.\n\nProbá con otra foto, o escribí el código o el nombre a mano (o "listo"/"cancelar").`);
      return;
    }
    if (resultados.length === 1) {
      await mostrarConfirmacion(ctx, resultados[0], termino);
      return ctx.wizard.next();
    }
    ctx.wizard.state.data.opciones = resultados;
    ctx.wizard.state.data.terminoEscaneado = termino;
    const lista = resultados.map((a, i) => `${i + 1}) ${a.nombre}${a.ean_unidad ? ` — EAN ${a.ean_unidad}` : ''}`).join('\n');
    await ctx.reply(`Encontré varios:\n\n${lista}\n\nElegí el número (0 = ninguno, probar de nuevo).`);
    return ctx.wizard.next();
  },
  // 4: elegir de la lista (si hubo >1 match) o confirmar sí/no el producto encontrado
  async (ctx) => {
    const d = ctx.wizard.state.data;
    if (d.opciones) {
      const r = await respuesta(ctx);
      if (esCancelar(r)) return cancelar(ctx);
      if (!r) { await ctx.reply('Escribí el número de la lista (o 0 para probar de nuevo).'); return; }
      if (r === '0') {
        delete d.opciones;
        await pedirFotoOCodigo(ctx);
        return ctx.wizard.selectStep(3);
      }
      const n = Number(r);
      const ops = d.opciones;
      if (!Number.isInteger(n) || n < 1 || n > ops.length) {
        await ctx.reply('Elegí un número válido de la lista (o 0 para probar de nuevo).');
        return;
      }
      const articulo = ops[n - 1];
      delete d.opciones;
      await mostrarConfirmacion(ctx, articulo, d.terminoEscaneado);
      return;
    }

    const r = await respuesta(ctx);
    if (r === null) return; // botón viejo / doble-tap
    if (esCancelar(r)) return cancelar(ctx);
    if (r === 'no') {
      await pedirFotoOCodigo(ctx);
      return ctx.wizard.selectStep(3);
    }
    if (r !== 'si') { await ctx.reply('Elegí Sí o No.'); return; }
    await ctx.reply('¿Cuántas unidades SUELTAS hay? (0 si no hay)');
    return ctx.wizard.next();
  },
  // 5: recibir Unidades -> pedir Displays
  async (ctx) => {
    const r = texto(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const n = parseUnidades(r);
    if (n === null) { await ctx.reply('Ingresá un número entero (0 si no hay).'); return; }
    ctx.wizard.state.data.unidades = n;
    await ctx.reply('¿Cuántos Displays hay? (0 si no hay)');
    return ctx.wizard.next();
  },
  // 6: recibir Displays -> pedir Bultos
  async (ctx) => {
    const r = texto(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const n = parseUnidades(r);
    if (n === null) { await ctx.reply('Ingresá un número entero (0 si no hay).'); return; }
    ctx.wizard.state.data.displays = n;
    await ctx.reply('¿Cuántos Bultos hay? (0 si no hay)');
    return ctx.wizard.next();
  },
  // 7: recibir Bultos -> confirmar antes de guardar
  async (ctx) => {
    const r = texto(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const n = parseUnidades(r);
    if (n === null) { await ctx.reply('Ingresá un número entero (0 si no hay).'); return; }
    const d = ctx.wizard.state.data;
    d.bultos = n;
    await preguntar(
      ctx,
      'Confirmá para agregar a la planilla:\n\n' +
      `Pallet: ${d.pallet} — Pasillo: ${d.pasillo}\n` +
      `Producto: ${d.candidato.nombre}\n` +
      `Unidades: ${d.unidades} — Displays: ${d.displays} — Bultos: ${d.bultos}`,
      opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
    );
    return ctx.wizard.next();
  },
  // 8: confirmar -> guardar en la planilla y volver a pedir el próximo producto
  async (ctx) => {
    const r = await respuesta(ctx);
    if (r === null) return; // botón viejo / doble-tap
    if (r !== 'si') {
      await ctx.reply('No se cargó ese producto.');
      await pedirFotoOCodigo(ctx);
      return ctx.wizard.selectStep(3);
    }
    if (ctx.wizard.state.guardando) return; // evita doble-tap
    ctx.wizard.state.guardando = true;
    const d = ctx.wizard.state.data;
    try {
      await agregarConteo({
        pallet: d.pallet,
        pasillo: d.pasillo,
        codigo: d.terminoEscaneado,
        unidades: d.unidades,
        displays: d.displays,
        bultos: d.bultos,
      });
    } catch (e) {
      console.error('No pude agregar el conteo a la planilla:', e.message);
      ctx.wizard.state.guardando = false;
      await ctx.reply('No pude guardar en la planilla, intentá de nuevo confirmando.');
      return;
    }
    d.cargados += 1;
    ctx.wizard.state.guardando = false;
    delete d.candidato;
    delete d.terminoEscaneado;
    delete d.unidades;
    delete d.displays;
    delete d.bultos;
    await ctx.reply('Cargado ✅');
    await pedirFotoOCodigo(ctx);
    return ctx.wizard.selectStep(3);
  }
);

module.exports = auditoriaAlturaWizard;
