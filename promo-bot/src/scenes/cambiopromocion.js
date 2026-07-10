// Wizard /cambiopromocion: cambia el % de descuento de una promoción vigente. En vez de buscar el
// producto, arranca mostrando un menú con TODAS las promociones abiertas (botones) para elegir
// directamente sobre cuál operar. Divide la alta en dos por diferencia: lo que no alcanzó a
// venderse al % viejo pasa a una alta nueva con el % nuevo, y la alta vieja queda cerrada marcando
// lo vendido al % viejo. Ver src/db/compras.js (cambiarPorcentajePromocion) para la transacción.
const { Scenes } = require('telegraf');
const { altasEnOferta, altaAbiertaPorId, cambiarPorcentajePromocion } = require('../db/compras');
const { respuesta, esCancelar, parseUnidades, opciones, preguntar } = require('../lib/wizard');
const { parseVencimiento } = require('../lib/fechas');

async function cancelar(ctx) {
  await ctx.reply('Cambio de promoción cancelado.');
  return ctx.scene.leave();
}

function truncar(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function resumenAlta(a) {
  const pct = a.descuento_pct === null || a.descuento_pct === undefined ? 'sin %' : `${a.descuento_pct}%`;
  return `${a.producto} — ${a.cantidad} unidades actuales al ${pct} (vencimiento ${a.vencimiento})`;
}

// Label corto para el botón del menú (Telegram trunca los textos muy largos).
function labelAlta(a) {
  const pct = a.descuento_pct === null || a.descuento_pct === undefined ? 'sin %' : `${a.descuento_pct}%`;
  return `${truncar(a.producto, 24)} — ${a.cantidad}u ${pct} (${a.vencimiento.slice(0, 5)})`;
}

async function pedirNuevoPct(ctx, alta) {
  ctx.wizard.state.data.alta = alta;
  await ctx.reply(`Elegiste:\n${resumenAlta(alta)}\n\n¿Qué nuevo % de descuento le vas a aplicar?`);
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
    // Más próximas a vencer primero (las que más urge cambiar de precio).
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
      'Cambio de % en una promoción vigente.\n\nElegí sobre cuál (o escribí "cancelar"):',
      opciones(ordenadas.map((a) => [labelAlta(a), String(a.id)]))
    );
    return ctx.wizard.next();
  },
  // 1: procesar la elección del menú
  async (ctx) => {
    const r = await respuesta(ctx);
    if (r === null) return; // botón viejo / doble-tap: el paso sigue esperando
    if (esCancelar(r)) return cancelar(ctx);

    const elegida = ctx.wizard.state.data.altasPorId.get(r);
    if (!elegida) {
      await ctx.reply('Elegí una promoción tocando alguno de los botones de la lista.');
      return;
    }
    // Revalidar contra la base: puede haber pasado un rato desde que se armó el menú.
    const alta = await altaAbiertaPorId(elegida.id);
    if (!alta) {
      await ctx.reply('Esa promoción ya no está vigente (se cerró mientras tanto). Volvé a correr /cambiopromocion.');
      return ctx.scene.leave();
    }
    await pedirNuevoPct(ctx, alta);
    return ctx.wizard.next();
  },
  // 2: procesar nuevo % -> preguntar unidades
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (r === null) { await ctx.reply('Escribí el % de descuento nuevo (un número entre 0 y 100, ej: 50).'); return; }
    const nuevoPct = Number(r.replace(',', '.').replace('%', ''));
    if (!Number.isFinite(nuevoPct) || nuevoPct < 0 || nuevoPct > 100) {
      await ctx.reply('Ingresá un % válido, entre 0 y 100 (ej: 50).');
      return;
    }
    ctx.wizard.state.data.nuevoPct = nuevoPct;
    const cantidadActual = Number(ctx.wizard.state.data.alta.cantidad);
    await ctx.reply(`¿A cuántas de esas ${cantidadActual} unidades le aplicás el ${nuevoPct}%?`);
    return ctx.wizard.next();
  },
  // 3: procesar unidades al nuevo % -> confirmar (botones inline)
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
    ctx.wizard.state.data.unidadesNuevoPct = unidades;
    const diferencia = cantidadActual - unidades;
    const d = ctx.wizard.state.data;
    await preguntar(
      ctx,
      'Confirmá el cambio:\n\n' +
      `Producto: ${alta.producto}\n` +
      `${diferencia} unidad(es) quedan marcadas como vendidas al ${alta.descuento_pct ?? '-'}%\n` +
      `${unidades} unidad(es) siguen en promoción, ahora al ${d.nuevoPct}%`,
      opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
    );
    return ctx.wizard.next();
  },
  // 4: confirmar -> guardar
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

    const resultado = await cambiarPorcentajePromocion({
      altaId: d.alta.id,
      unidadesNuevoPct: d.unidadesNuevoPct,
      nuevoPct: d.nuevoPct,
    });
    if (!resultado) {
      await ctx.reply('Esa promoción se cerró justo antes del cambio (alguien hizo /baja mientras tanto). No se pudo aplicar.');
      return ctx.scene.leave();
    }

    const { altaVieja, diferencia } = resultado;
    await ctx.reply(
      `Cambio registrado: ${diferencia} unidad(es) vendidas al ${altaVieja.descuento_pct ?? '-'}%, ` +
      `${d.unidadesNuevoPct} unidad(es) siguen en promoción al ${d.nuevoPct}%.`
    );
    return ctx.scene.leave();
  }
);

module.exports = cambioPromocionWizard;
