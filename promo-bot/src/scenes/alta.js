const { Scenes, Markup } = require('telegraf');
const { buscarArticulos } = require('../db/articulos');
const { crearAlta, historialProducto } = require('../db/compras');
const { notificarComprador } = require('../notificar');

// Devuelve el texto del mensaje o null si no vino texto (foto, sticker, etc.).
function texto(ctx) {
  const t = ctx.message && ctx.message.text;
  return typeof t === 'string' ? t.trim() : null;
}

// Permite cancelar en cualquier paso escribiendo "cancelar" o "/cancelar".
async function cancelado(ctx) {
  const t = texto(ctx);
  if (t && /^\/?cancelar$/i.test(t)) {
    await ctx.reply('Alta cancelada.', Markup.removeKeyboard());
    await ctx.scene.leave();
    return true;
  }
  return false;
}

const altaWizard = new Scenes.WizardScene(
  'alta-wizard',
  // 0: pedir búsqueda
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      'Alta en promoción por vencimiento.\n\n' +
      '¿Qué producto? Escribí el EAN, el código o parte del nombre.\n(o "cancelar" para salir)'
    );
    return ctx.wizard.next();
  },
  // 1: procesar búsqueda
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const q = texto(ctx);
    if (!q) { await ctx.reply('Escribí el EAN, código o nombre del producto.'); return; }

    const resultados = await buscarArticulos(q, 10);
    if (resultados.length === 0) {
      ctx.wizard.state.data.manual = true;
      await ctx.reply('No lo encontré en el maestro.\n\nEscribí el nombre del producto para cargarlo a mano (o "cancelar").');
      return ctx.wizard.selectStep(3);
    }
    ctx.wizard.state.opciones = resultados;
    const lista = resultados
      .map((a, i) => `${i + 1}) ${a.nombre}${a.ean_unidad ? ` — EAN ${a.ean_unidad}` : ''} — ${a.proveedor || ''}`)
      .join('\n');
    await ctx.reply(`Encontré:\n\n${lista}\n\nElegí el número. (0 = cargar a mano)`);
    return ctx.wizard.next();
  },
  // 2: elegir opción
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = texto(ctx);
    if (t === '0') {
      ctx.wizard.state.data.manual = true;
      await ctx.reply('Escribí el nombre del producto:');
      return ctx.wizard.selectStep(3);
    }
    const n = Number(t);
    const opciones = ctx.wizard.state.opciones || [];
    if (!Number.isInteger(n) || n < 1 || n > opciones.length) {
      await ctx.reply('Elegí un número válido de la lista (o 0 para cargar a mano).');
      return;
    }
    const art = opciones[n - 1];
    ctx.wizard.state.data.articuloCodigo = art.codigo;
    ctx.wizard.state.data.ean = art.ean_unidad || null;
    ctx.wizard.state.data.producto = art.nombre;
    ctx.wizard.state.data.proveedor = art.proveedor || null;
    await ctx.reply(`Elegiste: ${art.nombre}\nProveedor: ${art.proveedor || '-'}\n\n¿Lote? (si no tiene, escribí "-")`);
    return ctx.wizard.selectStep(5); // saltar la carga manual
  },
  // 3: manual - nombre
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = texto(ctx);
    if (!t) { await ctx.reply('Escribí el nombre del producto.'); return; }
    ctx.wizard.state.data.producto = t;
    await ctx.reply('¿Quién es el proveedor?');
    return ctx.wizard.next();
  },
  // 4: manual - proveedor
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = texto(ctx);
    if (!t) { await ctx.reply('Escribí el proveedor.'); return; }
    ctx.wizard.state.data.proveedor = t;
    await ctx.reply('¿Lote? (si no tiene, escribí "-")');
    return ctx.wizard.next();
  },
  // 5: lote
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = texto(ctx);
    if (!t) { await ctx.reply('Escribí el lote (o "-").'); return; }
    ctx.wizard.state.data.lote = t;
    await ctx.reply('¿Fecha de vencimiento? (DD/MM/AAAA)');
    return ctx.wizard.next();
  },
  // 6: vencimiento
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = texto(ctx);
    if (!t) { await ctx.reply('Escribí la fecha de vencimiento (DD/MM/AAAA).'); return; }
    ctx.wizard.state.data.vencimiento = t;
    await ctx.reply('¿Cantidad que se pasa a promoción?');
    return ctx.wizard.next();
  },
  // 7: cantidad
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const cantidad = Number((texto(ctx) || '').replace(',', '.'));
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      await ctx.reply('Ingresá un número válido de cantidad.');
      return;
    }
    ctx.wizard.state.data.cantidad = cantidad;
    await ctx.reply(
      '¿Motivo?',
      Markup.keyboard([['Vencimiento próximo'], ['Exceso de stock'], ['Otro']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },
  // 8: motivo -> confirmar
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = texto(ctx);
    if (!t) { await ctx.reply('Elegí o escribí el motivo.'); return; }
    ctx.wizard.state.data.motivo = t;
    const d = ctx.wizard.state.data;
    await ctx.reply(
      'Confirmá el alta:\n\n' +
      `Producto: ${d.producto}\n` +
      `Proveedor: ${d.proveedor || '-'}\n` +
      `Lote: ${d.lote}\n` +
      `Vencimiento: ${d.vencimiento}\n` +
      `Cantidad: ${d.cantidad}\n` +
      `Motivo: ${d.motivo}\n\n` +
      'Escribí "si" para confirmar o "no" para cancelar.',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },
  // 9: confirmar -> guardar
  async (ctx) => {
    const t = (texto(ctx) || '').toLowerCase();
    if (t !== 'si' && t !== 'sí') {
      await ctx.reply('Alta cancelada.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const d = ctx.wizard.state.data;
    const u = ctx.state.usuario;

    const altaId = await crearAlta({
      usuarioId: u ? u.id : null,
      usuarioNombre: u ? u.nombre : (ctx.from.username || ctx.from.first_name || null),
      articuloCodigo: d.articuloCodigo || null,
      ean: d.ean || null,
      producto: d.producto,
      proveedor: d.proveedor || null,
      lote: d.lote,
      vencimiento: d.vencimiento,
      cantidad: d.cantidad,
      motivo: d.motivo,
    });

    const hist = await historialProducto({ articuloCodigo: d.articuloCodigo || null, producto: d.producto });
    const mensajeComprador =
      '⚠️ Producto pasado a promoción por vencimiento\n\n' +
      `Producto: ${d.producto}\n` +
      `Proveedor: ${d.proveedor || '-'}\n` +
      `Cantidad: ${d.cantidad}\n` +
      `Motivo: ${d.motivo}\n` +
      `Vencimiento: ${d.vencimiento}\n\n` +
      `Historial: este producto lleva ${hist.veces} alta(s) en promoción, ${hist.unidades} unidades en total. ` +
      'Tenelo en cuenta al recomprar.';
    if (d.proveedor) await notificarComprador(d.proveedor, mensajeComprador);

    await ctx.reply(
      `Alta registrada (id ${altaId}).` +
      (d.proveedor ? ` Se intentó notificar al comprador de "${d.proveedor}".` : '')
    );
    return ctx.scene.leave();
  }
);

module.exports = altaWizard;
