// Wizard de corrección de /carteleria (Marketing): le pregunta producto (y precio,
// salvo para "nuevo_ingreso", que no lleva), regenera el diseño — buscando de nuevo
// en el catálogo (carteleria-catalogo.js) la foto que corresponda al nombre
// corregido — y se lo vuelve a mandar con los mismos botones de verificación; puede
// corregirse las veces que haga falta.
// Alternativa: si el diseño automático está mal de una forma que no se arregla
// corrigiendo producto/precio (ej. la foto no tiene nada que ver, o el diseño necesita
// un ajuste manual), Marketing puede mandar directamente la FOTO de su propio diseño ya
// armado en vez de tipear el producto — se usa tal cual, sin pasar por generarCartel.
const { Scenes } = require('telegraf');
const { carteleriaPorId, guardarDiseno } = require('../db/carteleria');
const { esCancelar, parsePrecio, texto } = require('../lib/wizard');
const { avisarVerificacionMarketing } = require('../lib/carteleria-mensajes');
const { generarCartel } = require('../lib/carteleria-render');
const { buscarImagenProducto } = require('../lib/carteleria-catalogo');

function esIgual(valor) {
  return typeof valor === 'string' && /^igual$/i.test(valor.trim());
}

const corregirCarteleriaWizard = new Scenes.WizardScene(
  'corregir-carteleria-wizard',
  // 0: cargar el registro y preguntar el producto
  async (ctx) => {
    const carteleria = await carteleriaPorId(ctx.session.carteleriaIdParaCorregir);
    if (!carteleria) { await ctx.reply('No encontré ese pedido de cartelería.'); return ctx.scene.leave(); }
    ctx.wizard.state.carteleria = carteleria;
    await ctx.reply(
      `Producto actual: ${carteleria.producto}\n¿Cuál es el correcto? (o "igual" para dejarlo así, "cancelar", ` +
      `o mandame directamente la FOTO de tu propio diseño ya armado si preferís subirlo vos)`
    );
    return ctx.wizard.next();
  },
  // 1: recibir el producto (texto) -> preguntar el precio (salvo "nuevo_ingreso"), O recibir
  // directamente la foto del diseño propio de Marketing -> usarla tal cual, sin regenerar
  async (ctx) => {
    const fotos = ctx.message && ctx.message.photo;
    if (fotos && fotos.length) {
      return usarDisenoPropio(ctx, fotos[fotos.length - 1].file_id);
    }

    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!t) { await ctx.reply('Mandame el nombre del producto, "igual", "cancelar", o la foto de tu propio diseño.'); return; }
    ctx.wizard.state.producto = esIgual(t) ? ctx.wizard.state.carteleria.producto : t;

    if (ctx.wizard.state.carteleria.tipo_precio === 'nuevo_ingreso') {
      return regenerarYReenviar(ctx, null);
    }

    const precioActual = Number(ctx.wizard.state.carteleria.precio);
    await ctx.reply(`Precio actual: $${precioActual.toFixed(2)}\n¿Cuál es el correcto? (o "igual", o "cancelar")`);
    return ctx.wizard.next();
  },
  // 2: recibir el precio -> regenerar el diseño y reenviar a Marketing
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    let precio;
    if (esIgual(t)) {
      precio = Number(ctx.wizard.state.carteleria.precio);
    } else {
      precio = parsePrecio(t);
      if (precio === null) { await ctx.reply('Mandame un precio válido (ej: 1500 o 1500,50), "igual" o "cancelar".'); return; }
    }
    return regenerarYReenviar(ctx, precio);
  }
);

async function regenerarYReenviar(ctx, precio) {
  const { carteleria, producto } = ctx.wizard.state;
  try {
    // La imagen del cartel sale del catálogo, matcheada por el nombre corregido
    // (si Marketing cambió el producto, buscamos de nuevo con el nombre nuevo).
    const imagenProductoBuffer = await buscarImagenProducto(producto);

    const disenoBuffer = await generarCartel({
      tipoGrafica: carteleria.tipo,
      tipoPrecio: carteleria.tipo_precio,
      producto,
      precio,
      vencimiento: carteleria.vencimiento,
      politica: carteleria.politica_texto, // no se corrige acá, se preserva la original
      imagenProductoBuffer,
    });

    await guardarDiseno(carteleria.id, { producto, precio, disenoFileId: null });
    const actualizado = await carteleriaPorId(carteleria.id);
    const { avisados, disenoFileId } = await avisarVerificacionMarketing(ctx.telegram, { carteleria: actualizado, disenoBuffer });
    if (disenoFileId) await guardarDiseno(carteleria.id, { producto, precio, disenoFileId });

    await ctx.reply(`Listo, mandé el diseño corregido para que lo vuelvan a verificar (${avisados} persona(s)).`);
  } catch (e) {
    console.error('No pude regenerar el diseño de cartelería:', e.message);
    await ctx.reply('No pude regenerar el diseño. Probá de nuevo con /carteleria o avisale al admin.');
  }
  return ctx.scene.leave();
}

// Marketing subió su propio diseño ya armado (en vez de corregir producto/precio para que se
// regenere automático) — se usa el file_id tal cual, sin pasar por generarCartel ni por el
// catálogo de fotos. Producto/precio quedan sin cambios (no es lo que se está corrigiendo acá).
async function usarDisenoPropio(ctx, disenoFileId) {
  const { carteleria } = ctx.wizard.state;
  try {
    await guardarDiseno(carteleria.id, { producto: carteleria.producto, precio: carteleria.precio, disenoFileId });
    const actualizado = await carteleriaPorId(carteleria.id);
    const { avisados } = await avisarVerificacionMarketing(ctx.telegram, { carteleria: actualizado, disenoFileId });
    await ctx.reply(`Listo, mandé tu diseño para que lo vuelvan a verificar (${avisados} persona(s)).`);
  } catch (e) {
    console.error('No pude mandar el diseño propio de cartelería:', e.message);
    await ctx.reply('No pude mandar el diseño. Probá de nuevo con /carteleria o avisale al admin.');
  }
  return ctx.scene.leave();
}

module.exports = corregirCarteleriaWizard;
