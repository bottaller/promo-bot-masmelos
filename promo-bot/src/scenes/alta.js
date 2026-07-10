const { Scenes } = require('telegraf');
const { buscarArticulos } = require('../db/articulos');
const { crearAlta, historialProducto } = require('../db/compras');
const { notificarComprador } = require('../notificar');
const { respuesta, esCancelar, opciones, preguntar } = require('../lib/wizard');
const { parseVencimiento, formatoVencimiento, diasHasta } = require('../lib/fechas');

async function cancelar(ctx) {
  await ctx.reply('Alta cancelada.');
  return ctx.scene.leave();
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
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el EAN, código o nombre del producto.'); return; }

    const resultados = await buscarArticulos(r, 10);
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
  // 2: elegir opción (se tipea el número)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (r === '0') {
      ctx.wizard.state.data.manual = true;
      await ctx.reply('Escribí el nombre del producto:');
      return ctx.wizard.selectStep(3);
    }
    const n = Number(r);
    const ops = ctx.wizard.state.opciones || [];
    if (!Number.isInteger(n) || n < 1 || n > ops.length) {
      await ctx.reply('Elegí un número válido de la lista (o 0 para cargar a mano).');
      return;
    }
    const art = ops[n - 1];
    ctx.wizard.state.data.articuloCodigo = art.codigo;
    ctx.wizard.state.data.ean = art.ean_unidad || null;
    ctx.wizard.state.data.producto = art.nombre;
    ctx.wizard.state.data.proveedor = art.proveedor || null;
    await ctx.reply(`Elegiste: ${art.nombre}\nProveedor: ${art.proveedor || '-'}\n\n¿Lote? (si no tiene, escribí "-")`);
    return ctx.wizard.selectStep(5);
  },
  // 3: manual - nombre
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el nombre del producto.'); return; }
    ctx.wizard.state.data.producto = r;
    await ctx.reply('¿Quién es el proveedor?');
    return ctx.wizard.next();
  },
  // 4: manual - proveedor
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el proveedor.'); return; }
    ctx.wizard.state.data.proveedor = r;
    await ctx.reply('¿Lote? (si no tiene, escribí "-")');
    return ctx.wizard.next();
  },
  // 5: lote
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el lote (o "-").'); return; }
    ctx.wizard.state.data.lote = r;
    await ctx.reply('¿Fecha de vencimiento? (DD/MM/AAAA)');
    return ctx.wizard.next();
  },
  // 6: vencimiento (se valida: una fecha imparseable deja el producto sin avisos para siempre)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí la fecha de vencimiento (DD/MM/AAAA).'); return; }
    const fecha = parseVencimiento(r);
    if (!fecha) {
      await ctx.reply('No entendí la fecha. Escribila como DD/MM/AAAA, por ejemplo 25/12/2026.');
      return;
    }
    const dias = diasHasta(fecha);
    if (dias < 0) {
      await ctx.reply(`Ojo: esa fecha ya pasó hace ${-dias} día(s). Si te equivocaste, escribila de nuevo (DD/MM/AAAA).`);
      return;
    }
    ctx.wizard.state.data.vencimiento = formatoVencimiento(fecha); // normalizada a DD/MM/AAAA
    await ctx.reply(`Vence en ${dias} día(s).\n\n¿Cantidad que se pasa a promoción?`);
    return ctx.wizard.next();
  },
  // 7: cantidad -> motivo (botones inline)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const cantidad = Number((r || '').replace(',', '.'));
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      await ctx.reply('Ingresá un número válido de cantidad.');
      return;
    }
    ctx.wizard.state.data.cantidad = cantidad;
    await preguntar(ctx, '¿Motivo? (elegí uno o escribí otro)', opciones(['Vencimiento próximo', 'Exceso de stock']));
    return ctx.wizard.next();
  },
  // 8: motivo -> confirmar (botones inline)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Elegí o escribí el motivo.'); return; }
    ctx.wizard.state.data.motivo = r;
    const d = ctx.wizard.state.data;
    await preguntar(
      ctx,
      'Confirmá el alta:\n\n' +
      `Producto: ${d.producto}\n` +
      `Proveedor: ${d.proveedor || '-'}\n` +
      `Lote: ${d.lote}\n` +
      `Vencimiento: ${d.vencimiento}\n` +
      `Cantidad: ${d.cantidad}\n` +
      `Motivo: ${d.motivo}`,
      opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
    );
    return ctx.wizard.next();
  },
  // 9: confirmar -> guardar
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return; // botón viejo / doble-tap / no-texto: el paso sigue esperando
    const r = raw.toLowerCase();
    if (r !== 'si' && r !== 'sí') {
      await ctx.reply('Alta cancelada.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.guardando) return; // evita doble-tap: ya se está guardando
    ctx.wizard.state.guardando = true;
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
