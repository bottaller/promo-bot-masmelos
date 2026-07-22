// Wizard /cambiopromocion: cambia la promoción vigente (% de descuento o precio promocional; se
// puede pasar de una a la otra) de una camada. En vez de buscar el producto, arranca mostrando un
// menú con TODAS las promociones abiertas (botones) para elegir directamente sobre cuál operar.
// Divide la alta en dos por diferencia: lo que no alcanzó a venderse con la promo vieja pasa a una
// alta nueva con la promo nueva, y la alta vieja queda cerrada marcando lo vendido con la vieja.
// Ver src/db/compras.js (cambiarPromocion) para la transacción.
const { Scenes } = require('telegraf');
const { altasEnOferta, altaAbiertaPorId, cambiarPromocion } = require('../db/compras');
const { respuesta, esCancelar, parseUnidades, parsePrecio, opciones, preguntar } = require('../lib/wizard');
const { parseVencimiento } = require('../lib/fechas');

async function cancelar(ctx) {
  await ctx.reply('Cambio de promoción cancelado.');
  return ctx.scene.leave();
}

function truncar(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// "30%", "$500" o "sin promo" (camada vieja sin ninguno de los dos datos cargado).
function etiquetaPromo(a) {
  if (a.descuento_pct !== null && a.descuento_pct !== undefined) return `${a.descuento_pct}%`;
  if (a.precio_promocional !== null && a.precio_promocional !== undefined) return `$${a.precio_promocional}`;
  return 'sin promo';
}

function resumenAlta(a) {
  return `${a.producto} — ${a.cantidad} unidades actuales a ${etiquetaPromo(a)} (vencimiento ${a.vencimiento})`;
}

// Label corto para el botón del menú (Telegram trunca los textos muy largos).
function labelAlta(a) {
  return `${truncar(a.producto, 24)} — ${a.cantidad}u ${etiquetaPromo(a)} (${a.vencimiento.slice(0, 5)})`;
}

async function pedirTipoNuevo(ctx, alta) {
  ctx.wizard.state.data.alta = alta;
  await preguntar(
    ctx,
    `Elegiste:\n${resumenAlta(alta)}\n\n¿Le aplicás un nuevo % de descuento o un nuevo precio promocional?`,
    opciones([['% Descuento', 'pct'], ['Precio promocional', 'precio']])
  );
}

const cambioPromocionWizard = new Scenes.WizardScene(
  'cambiopromocion-wizard',
  // 0: mostrar el menú con todas las promociones vigentes
  async (ctx) => {
    ctx.wizard.state.data = {};
    const abiertas = await altasEnOferta();
    if (abiertas.length === 0) {
      await ctx.reply('No hay ninguna promoción vigente en este momento.');
      return ctx.scene.leave();
    }
    // Más próximas a vencer primero (las que más urge cambiar de promoción).
    const ordenadas = [...abiertas].sort((a, b) => {
      const fa = parseVencimiento(a.vencimiento);
      const fb = parseVencimiento(b.vencimiento);
      if (fa && fb) return fa.getTime() - fb.getTime();
      if (fa) return -1;
      if (fb) return 1;
      return 0;
    });
    ctx.wizard.state.data.altasPorId = new Map(ordenadas.map((a) => [String(a.id), a]));
    await preguntar(
      ctx,
      'Cambio de promoción vigente.\n\nElegí sobre cuál (o escribí "cancelar"):',
      opciones(ordenadas.map((a) => [labelAlta(a), String(a.id)]))
    );
    return ctx.wizard.next();
  },
  // 1: procesar la elección del menú -> preguntar el tipo de promo nueva
  async (ctx) => {
    const r = await respuesta(ctx);
    if (r === null) return; // botón viejo / doble-tap: el paso sigue esperando
    if (esCancelar(r)) return cancelar(ctx);

    const elegida = ctx.wizard.state.data.altasPorId.get(r);
    if (!elegida) {
      // Escribió texto en vez de tocar un botón: respuesta() ya le sacó el teclado, así que
      // volvemos a mostrar el menú (si no, quedaría sin botones que tocar, en un callejón sin salida).
      const altas = [...ctx.wizard.state.data.altasPorId.values()];
      await preguntar(
        ctx,
        'Tocá uno de los botones para elegir la promoción (o escribí "cancelar"):',
        opciones(altas.map((a) => [labelAlta(a), String(a.id)]))
      );
      return;
    }
    // Revalidar contra la base: puede haber pasado un rato desde que se armó el menú.
    const alta = await altaAbiertaPorId(elegida.id);
    if (!alta) {
      await ctx.reply('Esa promoción ya no está vigente (se cerró mientras tanto). Volvé a correr /cambiopromocion.');
      return ctx.scene.leave();
    }
    await pedirTipoNuevo(ctx, alta);
    return ctx.wizard.next();
  },
  // 2: procesar el tipo elegido -> pedir el valor nuevo
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (r !== 'pct' && r !== 'precio') { await ctx.reply('Elegí "% Descuento" o "Precio promocional".'); return; }
    ctx.wizard.state.data.tipoNuevo = r;
    await ctx.reply(r === 'pct' ? '¿Qué nuevo % de descuento le vas a aplicar?' : '¿Cuál es el nuevo precio promocional?');
    return ctx.wizard.next();
  },
  // 3: procesar el valor nuevo (% o precio) -> preguntar unidades
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (r === null) { await ctx.reply('Escribí el valor nuevo.'); return; }
    const d = ctx.wizard.state.data;
    if (d.tipoNuevo === 'pct') {
      const nuevoPct = Number(r.replace(',', '.').replace('%', ''));
      if (!Number.isFinite(nuevoPct) || nuevoPct < 0 || nuevoPct > 100) {
        await ctx.reply('Ingresá un % válido, entre 0 y 100 (ej: 50).');
        return;
      }
      d.nuevoPct = nuevoPct;
      d.nuevoPrecio = null;
    } else {
      const nuevoPrecio = parsePrecio(r);
      if (nuevoPrecio === null) {
        await ctx.reply('Ingresá un precio válido, mayor a 0 (ej: 1500).');
        return;
      }
      d.nuevoPrecio = nuevoPrecio;
      d.nuevoPct = null;
    }
    const etiquetaNueva = d.tipoNuevo === 'pct' ? `${d.nuevoPct}%` : `$${d.nuevoPrecio}`;
    const cantidadActual = Number(d.alta.cantidad);
    await ctx.reply(`¿A cuántas de esas ${cantidadActual} unidades le aplicás ${etiquetaNueva}?`);
    return ctx.wizard.next();
  },
  // 4: procesar unidades al valor nuevo -> confirmar (botones inline)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const unidades = parseUnidades(r);
    const alta = ctx.wizard.state.data.alta;
    const cantidadActual = Number(alta.cantidad);
    if (unidades === null || unidades <= 0) {
      await ctx.reply('Ingresá una cantidad válida en unidades enteras (ej: 100).');
      return;
    }
    if (unidades > cantidadActual) {
      await ctx.reply(`No puede ser más que las ${cantidadActual} unidades actuales. Ingresá un número válido.`);
      return;
    }
    ctx.wizard.state.data.unidadesNuevo = unidades;
    const diferencia = cantidadActual - unidades;
    const d = ctx.wizard.state.data;
    const etiquetaNueva = d.tipoNuevo === 'pct' ? `${d.nuevoPct}%` : `$${d.nuevoPrecio}`;
    await preguntar(
      ctx,
      'Confirmá el cambio:\n\n' +
      `Producto: ${alta.producto}\n` +
      `${diferencia} unidad(es) quedan marcadas como vendidas a ${etiquetaPromo(alta)}\n` +
      `${unidades} unidad(es) siguen en promoción, ahora a ${etiquetaNueva}`,
      opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
    );
    return ctx.wizard.next();
  },
  // 5: confirmar -> guardar
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return; // botón viejo / doble-tap / no-texto: el paso sigue esperando
    const r = raw.toLowerCase();
    if (r !== 'si' && r !== 'sí') {
      await ctx.reply('Cambio de promoción cancelado.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.guardando) return; // evita doble-tap: ya se está guardando
    ctx.wizard.state.guardando = true;
    const d = ctx.wizard.state.data;

    const resultado = await cambiarPromocion({
      altaId: d.alta.id,
      unidadesNuevo: d.unidadesNuevo,
      nuevoPct: d.nuevoPct,
      nuevoPrecio: d.nuevoPrecio,
      cantidadEsperada: Number(d.alta.cantidad),
    });
    if (resultado.cerrada) {
      await ctx.reply('Esa promoción se cerró justo antes del cambio (alguien hizo /baja mientras tanto). No se pudo aplicar.');
      return ctx.scene.leave();
    }
    if (resultado.cambiada) {
      await ctx.reply(
        `La promoción cambió de cantidad mientras confirmabas (ahora tiene ${resultado.cantidadActual} unidades, ` +
        'seguramente por una reposición). Volvé a hacer /cambiopromocion.'
      );
      return ctx.scene.leave();
    }

    const { altaVieja, diferencia } = resultado;
    const etiquetaNueva = d.tipoNuevo === 'pct' ? `${d.nuevoPct}%` : `$${d.nuevoPrecio}`;
    await ctx.reply(
      `Cambio registrado: ${diferencia} unidad(es) vendidas a ${etiquetaPromo(altaVieja)}, ` +
      `${d.unidadesNuevo} unidad(es) siguen en promoción a ${etiquetaNueva}.`
    );
    return ctx.scene.leave();
  }
);

module.exports = cambioPromocionWizard;
