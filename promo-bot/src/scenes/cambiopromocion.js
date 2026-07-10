// Wizard /cambiopromocion: cambia el % de descuento de una promoción vigente. Divide la alta en
// dos por diferencia: lo que no alcanzó a venderse al % viejo pasa a una alta nueva con el % nuevo,
// y la alta vieja queda cerrada marcando lo vendido al % viejo. Ver src/db/compras.js
// (cambiarPorcentajePromocion) para el detalle de la transacción.
const { Scenes } = require('telegraf');
const { buscarAltasAbiertas, cambiarPorcentajePromocion } = require('../db/compras');
const { notificarComprador } = require('../notificar');
const { respuesta, esCancelar, parseUnidades, opciones, preguntar } = require('../lib/wizard');

async function cancelar(ctx) {
  await ctx.reply('Cambio de promoción cancelado.');
  return ctx.scene.leave();
}

function resumenAlta(a) {
  const pct = a.descuento_pct === null || a.descuento_pct === undefined ? 'sin %' : `${a.descuento_pct}%`;
  return `${a.producto} — ${a.cantidad} unidades actuales al ${pct} (vencimiento ${a.vencimiento})`;
}

async function pedirNuevoPct(ctx, alta) {
  ctx.wizard.state.data.alta = alta;
  await ctx.reply(`Encontré:\n${resumenAlta(alta)}\n\n¿Qué nuevo % de descuento le vas a aplicar?`);
}

const cambioPromocionWizard = new Scenes.WizardScene(
  'cambiopromocion-wizard',
  // 0: pedir búsqueda de producto (entre las promociones vigentes)
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      'Cambio de % en una promoción vigente.\n\n' +
      '¿Qué producto? Escribí el EAN, el código o parte del nombre.\n(o "cancelar" para salir)'
    );
    return ctx.wizard.next();
  },
  // 1: buscar promociones vigentes que matcheen
  async (ctx) => {
    const q = await respuesta(ctx);
    if (esCancelar(q)) return cancelar(ctx);
    if (!q) { await ctx.reply('Escribí el EAN, código o nombre.'); return; }

    const abiertas = await buscarAltasAbiertas(q);
    if (abiertas.length === 0) {
      await ctx.reply(`No hay ninguna promoción vigente para "${q}".`);
      return ctx.scene.leave();
    }
    if (abiertas.length === 1) {
      await pedirNuevoPct(ctx, abiertas[0]);
      return ctx.wizard.selectStep(3);
    }
    ctx.wizard.state.opciones = abiertas;
    const lista = abiertas.map((a, i) => `${i + 1}) ${resumenAlta(a)}`).join('\n');
    await ctx.reply(`Hay ${abiertas.length} promociones vigentes que matchean:\n\n${lista}\n\nRespondé con el número.`);
    return ctx.wizard.next();
  },
  // 2: elegir cuál (solo si había más de una)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const n = Number(r);
    const ops = ctx.wizard.state.opciones || [];
    if (!Number.isInteger(n) || n < 1 || n > ops.length) {
      await ctx.reply('Elegí un número válido de la lista.');
      return;
    }
    await pedirNuevoPct(ctx, ops[n - 1]);
    return ctx.wizard.next();
  },
  // 3: procesar nuevo % -> preguntar unidades
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
  // 4: procesar unidades al nuevo % -> confirmar (botones inline)
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
    const mensajeComprador =
      '🔀 Cambio de % en promoción por vencimiento\n\n' +
      `Producto: ${altaVieja.producto}\n` +
      `Proveedor: ${altaVieja.proveedor || '-'}\n` +
      `Vendido al ${altaVieja.descuento_pct ?? '-'}%: ${diferencia} unidad(es)\n` +
      `Sigue en promoción al ${d.nuevoPct}%: ${d.unidadesNuevoPct} unidad(es)\n` +
      `Vencimiento: ${altaVieja.vencimiento}`;
    if (altaVieja.proveedor) await notificarComprador(altaVieja.proveedor, mensajeComprador);

    await ctx.reply(
      `Cambio registrado: ${diferencia} unidad(es) vendidas al ${altaVieja.descuento_pct ?? '-'}%, ` +
      `${d.unidadesNuevoPct} unidad(es) siguen en promoción al ${d.nuevoPct}%.`
    );
    return ctx.scene.leave();
  }
);

module.exports = cambioPromocionWizard;
