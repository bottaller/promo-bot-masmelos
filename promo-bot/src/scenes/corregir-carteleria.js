// Wizard de corrección de /carteleria (Marketing): le pregunta producto y precio
// correctos, regenera el diseño y se lo vuelve a mandar con los mismos botones
// de verificación — puede corregirse las veces que haga falta.
const { Scenes } = require('telegraf');
const { carteleriaPorId, guardarDiseno } = require('../db/carteleria');
const { esCancelar, parsePrecio, texto } = require('../lib/wizard');
const { avisarVerificacionMarketing } = require('../lib/carteleria-mensajes');
const { generarCartel } = require('../lib/carteleria-render');

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
      `Producto actual: ${carteleria.producto}\n¿Cuál es el correcto? (o "igual" para dejarlo así, o "cancelar")`
    );
    return ctx.wizard.next();
  },
  // 1: recibir el producto -> preguntar el precio
  async (ctx) => {
    const t = texto(ctx);
    if (esCancelar(t)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!t) { await ctx.reply('Mandame el nombre del producto, "igual" o "cancelar".'); return; }
    ctx.wizard.state.producto = esIgual(t) ? ctx.wizard.state.carteleria.producto : t;

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

    const { carteleria, producto } = ctx.wizard.state;
    try {
      const disenoBuffer = await generarCartel({
        tipoGrafica: carteleria.tipo,
        tipoPrecio: carteleria.tipo_precio,
        producto,
        precio,
        vencimiento: carteleria.vencimiento,
        imagenProductoBuffer: null,
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
);

module.exports = corregirCarteleriaWizard;
