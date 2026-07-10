// Wizard /reposicion: suma cantidad a una promoción YA ABIERTA del mismo producto con la misma
// fecha de vencimiento, en vez de crear otra alta. Ej: hoy se cargaron 5 alfajores por vencimiento;
// mañana se ponen 5 más del mismo lote (misma fecha de vencimiento) -> queda una sola alta con 10.
const { Scenes } = require('telegraf');
const { buscarArticulos } = require('../db/articulos');
const { buscarAltasParaReponer, sumarCantidadAlta } = require('../db/compras');
const { notificarComprador } = require('../notificar');
const { respuesta, esCancelar, parseUnidades, opciones, preguntar } = require('../lib/wizard');
const { parseVencimiento, formatoVencimiento, diasHasta } = require('../lib/fechas');

async function cancelar(ctx) {
  await ctx.reply('Reposición cancelada.');
  return ctx.scene.leave();
}

function resumenAlta(a) {
  return `${a.producto} — ${a.cantidad} unidades actuales (vencimiento ${a.vencimiento})`;
}

// Pregunta cuántas unidades se agregan y deja la alta elegida guardada en el estado.
async function pedirCantidadAdicional(ctx, alta) {
  ctx.wizard.state.data.alta = alta;
  await ctx.reply(`Encontré:\n${resumenAlta(alta)}\n\n¿Cuántas unidades más se agregan?`);
}

const reposicionWizard = new Scenes.WizardScene(
  'reposicion-wizard',
  // 0: pedir búsqueda de producto
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      'Reposición de una promoción ya abierta.\n\n' +
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
      await ctx.reply('No lo encontré en el maestro.\n\nEscribí el nombre exacto tal como está cargado en la promoción (o "cancelar").');
      return ctx.wizard.selectStep(3);
    }
    ctx.wizard.state.opciones = resultados;
    const lista = resultados
      .map((a, i) => `${i + 1}) ${a.nombre}${a.ean_unidad ? ` — EAN ${a.ean_unidad}` : ''} — ${a.proveedor || ''}`)
      .join('\n');
    await ctx.reply(`Encontré:\n\n${lista}\n\nElegí el número. (0 = escribir el nombre a mano)`);
    return ctx.wizard.next();
  },
  // 2: elegir opción (se tipea el número)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (r === '0') {
      ctx.wizard.state.data.manual = true;
      await ctx.reply('Escribí el nombre exacto del producto:');
      return ctx.wizard.selectStep(3);
    }
    const n = Number(r);
    const ops = ctx.wizard.state.opciones || [];
    if (!Number.isInteger(n) || n < 1 || n > ops.length) {
      await ctx.reply('Elegí un número válido de la lista (o 0 para escribir el nombre a mano).');
      return;
    }
    const art = ops[n - 1];
    ctx.wizard.state.data.articuloCodigo = art.codigo;
    ctx.wizard.state.data.producto = art.nombre;
    await ctx.reply('¿Fecha de vencimiento de la promoción a la que se suma? (DD/MM/AAAA)');
    return ctx.wizard.selectStep(4);
  },
  // 3: manual - nombre exacto
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el nombre del producto.'); return; }
    ctx.wizard.state.data.producto = r;
    await ctx.reply('¿Fecha de vencimiento de la promoción a la que se suma? (DD/MM/AAAA)');
    return ctx.wizard.next();
  },
  // 4: vencimiento -> buscar alta(s) abierta(s) que matcheen producto + vencimiento
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
    const d = ctx.wizard.state.data;
    const vencimiento = formatoVencimiento(fecha);

    const abiertas = await buscarAltasParaReponer({
      articuloCodigo: d.articuloCodigo || null,
      producto: d.producto,
      vencimiento,
    });

    if (abiertas.length === 0) {
      await ctx.reply(
        `No hay ninguna promoción abierta de "${d.producto}" con vencimiento ${vencimiento}.\n\n` +
        'Si es la primera vez que se pone en oferta, usá /alta.'
      );
      return ctx.scene.leave();
    }

    if (abiertas.length === 1) {
      await pedirCantidadAdicional(ctx, abiertas[0]);
      return ctx.wizard.selectStep(6);
    }

    ctx.wizard.state.opciones = abiertas;
    const lista = abiertas.map((a, i) => `${i + 1}) ${resumenAlta(a)}`).join('\n');
    await ctx.reply(`Hay ${abiertas.length} promociones abiertas que matchean:\n\n${lista}\n\nRespondé con el número.`);
    return ctx.wizard.next();
  },
  // 5: elegir cuál (solo si había más de una)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const n = Number(r);
    const ops = ctx.wizard.state.opciones || [];
    if (!Number.isInteger(n) || n < 1 || n > ops.length) {
      await ctx.reply('Elegí un número válido de la lista.');
      return;
    }
    await pedirCantidadAdicional(ctx, ops[n - 1]);
    return ctx.wizard.next();
  },
  // 6: procesar cantidad adicional -> confirmar (botones inline)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const cantidad = parseUnidades(r);
    if (cantidad === null || cantidad <= 0) {
      await ctx.reply('Ingresá una cantidad válida en unidades enteras (ej: 500).');
      return;
    }
    ctx.wizard.state.data.cantidadAdicional = cantidad;
    const alta = ctx.wizard.state.data.alta;
    const total = Number(alta.cantidad) + cantidad;
    await preguntar(
      ctx,
      'Confirmá la reposición:\n\n' +
      `Producto: ${alta.producto}\n` +
      `Actualmente en promoción: ${alta.cantidad}\n` +
      `Se agregan: ${cantidad}\n` +
      `Total quedaría: ${total}`,
      opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
    );
    return ctx.wizard.next();
  },
  // 7: confirmar -> guardar
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return; // botón viejo / doble-tap / no-texto: el paso sigue esperando
    const r = raw.toLowerCase();
    if (r !== 'si' && r !== 'sí') {
      await ctx.reply('Reposición cancelada.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.guardando) return; // evita doble-tap: ya se está guardando
    ctx.wizard.state.guardando = true;
    const d = ctx.wizard.state.data;
    const alta = d.alta;

    const nuevoTotal = await sumarCantidadAlta({ altaId: alta.id, cantidadAdicional: d.cantidadAdicional });
    if (nuevoTotal === null) {
      await ctx.reply('Esa promoción se cerró justo antes de sumar (alguien hizo /baja mientras tanto). No se pudo reponer.');
      return ctx.scene.leave();
    }

    const mensajeComprador =
      '🔄 Reposición de promoción por vencimiento\n\n' +
      `Producto: ${alta.producto}\n` +
      `Proveedor: ${alta.proveedor || '-'}\n` +
      `Se agregaron: ${d.cantidadAdicional} unidades más\n` +
      `Total ahora en promoción: ${nuevoTotal} unidades\n` +
      `Vencimiento: ${alta.vencimiento}`;
    if (alta.proveedor) await notificarComprador(alta.proveedor, mensajeComprador);

    await ctx.reply(
      `Reposición registrada. Ahora hay ${nuevoTotal} unidades en promoción de este producto.` +
      (alta.proveedor ? ` Se intentó notificar al comprador de "${alta.proveedor}".` : '')
    );
    return ctx.scene.leave();
  }
);

module.exports = reposicionWizard;
