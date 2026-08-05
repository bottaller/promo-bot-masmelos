const { Scenes } = require('telegraf');
const { buscarArticulos } = require('../db/articulos');
const { crearAlta, historialProducto, buscarAltasParaReponer, sumarCantidadAlta } = require('../db/compras');
const { respuesta, esCancelar, parseUnidades, parsePrecio, opciones, preguntar } = require('../lib/wizard');
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
    await ctx.reply(`Elegiste: ${art.nombre}\nProveedor: ${art.proveedor || '-'}\n\n¿Fecha de vencimiento? (DD/MM/AAAA)`);
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
    await ctx.reply('¿Fecha de vencimiento? (DD/MM/AAAA)');
    return ctx.wizard.next();
  },
  // 5: vencimiento (se valida: una fecha imparseable deja el producto sin avisos para siempre)
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
    const vencimiento = formatoVencimiento(fecha); // normalizada a DD/MM/AAAA
    d.vencimiento = vencimiento;

    // Mismo producto + misma fecha de vencimiento ya en promoción ABIERTA: puede ser el mismo
    // lote que ya se cargó antes (correspondería /reposicion, no otra alta) o un tipeo repetido
    // por error — avisamos ANTES de seguir, en vez de dejar que se cree una alta calcada sin
    // querer (ver el mismo chequeo que ya usa /reposicion, db/compras.js#buscarAltasParaReponer).
    const duplicados = await buscarAltasParaReponer({
      articuloCodigo: d.articuloCodigo || null,
      producto: d.producto,
      vencimiento,
    });
    if (duplicados.length > 0) {
      // Limpio: si el producto se eligió de una lista (paso 2), wizard.state.opciones sigue
      // seteado con ESA lista vieja — el paso 11 usa la misma propiedad para "elegir cuál de los
      // duplicados", así que si no se limpia acá confunde una cosa con la otra.
      delete ctx.wizard.state.opciones;
      d.duplicados = duplicados;
      const lista = duplicados
        .map((a) => `• ${a.cantidad} unidades (cargó ${a.usuario_nombre || '-'})`)
        .join('\n');
      await preguntar(
        ctx,
        `⚠️ Ya hay ${duplicados.length > 1 ? 'promociones ABIERTAS' : 'una promoción ABIERTA'} de "${d.producto}" con vencimiento ${vencimiento}:\n\n${lista}\n\n` +
        '¿Es el mismo lote que ya está cargado (sumo esta cantidad a esa) o te equivocaste?',
        opciones([['➕ Es el mismo, sumar cantidad', 'reponer'], ['❌ Me equivoqué, cancelar carga', 'cancelar_carga']])
      );
      return ctx.wizard.selectStep(11);
    }

    await ctx.reply(`Vence en ${dias} día(s).\n\n¿Cantidad que se pasa a promoción?`);
    return ctx.wizard.next();
  },
  // 6: cantidad -> tipo de promoción (botones inline)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const cantidad = parseUnidades(r);
    if (cantidad === null || cantidad <= 0) {
      await ctx.reply('Ingresá una cantidad válida en unidades enteras (ej: 1000).');
      return;
    }
    ctx.wizard.state.data.cantidad = cantidad;
    await preguntar(
      ctx,
      '¿La promoción es por % de descuento o por un precio promocional?',
      opciones([['% Descuento', 'pct'], ['Precio promocional', 'precio']])
    );
    return ctx.wizard.next();
  },
  // 7: tipo de promoción -> pedir el valor (% o precio)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (r !== 'pct' && r !== 'precio') { await ctx.reply('Elegí "% Descuento" o "Precio promocional".'); return; }
    ctx.wizard.state.data.tipoPromo = r;
    await ctx.reply(r === 'pct'
      ? '¿Qué % de descuento tiene la promoción? (ej: 30)'
      : '¿Cuál es el precio promocional? (ej: 1500)');
    return ctx.wizard.next();
  },
  // 8: valor de la promoción -> motivo (botones inline)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const d = ctx.wizard.state.data;
    if (r === null) {
      await ctx.reply(d.tipoPromo === 'pct'
        ? 'Escribí el % de descuento (un número entre 0 y 100, ej: 30).'
        : 'Escribí el precio promocional (ej: 1500).');
      return;
    }
    if (d.tipoPromo === 'pct') {
      const descuento = Number(r.replace(',', '.').replace('%', ''));
      if (!Number.isFinite(descuento) || descuento < 0 || descuento > 100) {
        await ctx.reply('Ingresá un % válido, entre 0 y 100 (ej: 30).');
        return;
      }
      d.descuentoPct = descuento;
      d.precioPromocional = null;
    } else {
      const precio = parsePrecio(r);
      if (precio === null) {
        await ctx.reply('Ingresá un precio válido, mayor a 0 (ej: 1500).');
        return;
      }
      d.precioPromocional = precio;
      d.descuentoPct = null;
    }
    await preguntar(ctx, '¿Motivo? (elegí uno o escribí otro)', opciones(['Vencimiento próximo', 'Exceso de stock']));
    return ctx.wizard.next();
  },
  // 9: motivo -> confirmar (botones inline)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Elegí o escribí el motivo.'); return; }
    ctx.wizard.state.data.motivo = r;
    const d = ctx.wizard.state.data;
    const promoTxt = d.tipoPromo === 'pct' ? `Descuento: ${d.descuentoPct}%` : `Precio promocional: $${d.precioPromocional}`;
    await preguntar(
      ctx,
      'Confirmá el alta:\n\n' +
      `Producto: ${d.producto}\n` +
      `Proveedor: ${d.proveedor || '-'}\n` +
      `Vencimiento: ${d.vencimiento}\n` +
      `Cantidad: ${d.cantidad}\n` +
      `${promoTxt}\n` +
      `Motivo: ${d.motivo}`,
      opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
    );
    return ctx.wizard.next();
  },
  // 10: confirmar -> guardar
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
      vencimiento: d.vencimiento,
      cantidad: d.cantidad,
      motivo: d.motivo,
      descuentoPct: d.descuentoPct,
      precioPromocional: d.precioPromocional,
    });

    const hist = await historialProducto({ articuloCodigo: d.articuloCodigo || null, producto: d.producto });
    await ctx.reply(
      `Alta registrada (id ${altaId}).\n\n` +
      `Historial: este producto lleva ${hist.veces} alta(s) en promoción, ${hist.unidades} unidades en total. ` +
      'Tenelo en cuenta al recomprar.'
    );
    return ctx.scene.leave();
  },
  // --- A partir de acá, solo se llega saltando desde el paso 5 (vencimiento) cuando ya hay una
  // promoción abierta del mismo producto+vencimiento — ver buscarAltasParaReponer más arriba.
  // Van al final (no insertados en el medio) para no tener que renumerar los selectStep() de
  // arriba. Mismo patrón que /reposicion (scenes/reposicion.js): si hay una sola coincidencia se
  // salta directo a pedir la cantidad; si hay varias, se elige cuál antes.
  //
  // 11: reponer/cancelar (o elegir cuál, si había más de una coincidencia)
  async (ctx) => {
    const d = ctx.wizard.state.data;
    if (ctx.wizard.state.opciones) {
      const r = await respuesta(ctx);
      if (esCancelar(r)) return cancelar(ctx);
      if (!r) { await ctx.reply('Escribí el número de la lista (o "cancelar").'); return; }
      const n = Number(r);
      const ops = ctx.wizard.state.opciones;
      if (!Number.isInteger(n) || n < 1 || n > ops.length) {
        await ctx.reply('Elegí un número válido de la lista.');
        return;
      }
      delete ctx.wizard.state.opciones;
      d.altaParaReponer = ops[n - 1];
      await ctx.reply(`¿Cuántas unidades más se agregan? (actualmente ${d.altaParaReponer.cantidad})`);
      return ctx.wizard.next();
    }

    const r = await respuesta(ctx);
    if (r === null) return; // botón viejo / doble-tap
    if (esCancelar(r) || r === 'cancelar_carga') return cancelar(ctx);
    if (r !== 'reponer') { await ctx.reply('Elegí una opción.'); return; }

    const duplicados = d.duplicados;
    if (duplicados.length === 1) {
      d.altaParaReponer = duplicados[0];
      await ctx.reply(`¿Cuántas unidades más se agregan? (actualmente ${duplicados[0].cantidad})`);
      return ctx.wizard.next();
    }
    ctx.wizard.state.opciones = duplicados;
    const lista = duplicados.map((a, i) => `${i + 1}) ${a.cantidad} unidades (cargó ${a.usuario_nombre || '-'})`).join('\n');
    await ctx.reply(`Hay ${duplicados.length} promociones abiertas que matchean:\n\n${lista}\n\nRespondé con el número.`);
  },
  // 12: cantidad adicional -> confirmar (botones inline)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const cantidad = parseUnidades(r);
    if (cantidad === null || cantidad <= 0) {
      await ctx.reply('Ingresá una cantidad válida en unidades enteras (ej: 500).');
      return;
    }
    const d = ctx.wizard.state.data;
    d.cantidadAdicional = cantidad;
    const alta = d.altaParaReponer;
    const total = Number(alta.cantidad) + cantidad;
    await preguntar(
      ctx,
      'Confirmá la reposición (en vez de una alta nueva):\n\n' +
      `Producto: ${alta.producto}\n` +
      `Actualmente en promoción: ${alta.cantidad}\n` +
      `Se agregan: ${cantidad}\n` +
      `Total quedaría: ${total}`,
      opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
    );
    return ctx.wizard.next();
  },
  // 13: confirmar -> sumar cantidad a la alta existente (no crea una alta nueva)
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return; // botón viejo / doble-tap / no-texto: el paso sigue esperando
    const r = raw.toLowerCase();
    if (r !== 'si' && r !== 'sí') {
      await ctx.reply('Carga cancelada.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.guardando) return; // evita doble-tap: ya se está guardando
    ctx.wizard.state.guardando = true;
    const d = ctx.wizard.state.data;
    const alta = d.altaParaReponer;

    const nuevoTotal = await sumarCantidadAlta({ altaId: alta.id, cantidadAdicional: d.cantidadAdicional });
    if (nuevoTotal === null) {
      await ctx.reply('Esa promoción se cerró justo antes de sumar (alguien hizo /baja mientras tanto). No se pudo reponer.');
      return ctx.scene.leave();
    }
    await ctx.reply(`Reposición registrada. Ahora hay ${nuevoTotal} unidades en promoción de este producto.`);
    return ctx.scene.leave();
  }
);

module.exports = altaWizard;
