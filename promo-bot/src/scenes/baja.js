const { Scenes, Markup } = require('telegraf');
const { buscarAltasAbiertas, registrarBaja } = require('../db/compras');
const { notificarComprador } = require('../notificar');

function texto(ctx) {
  const t = ctx.message && ctx.message.text;
  return typeof t === 'string' ? t.trim() : null;
}

async function cancelado(ctx) {
  const t = texto(ctx);
  if (t && /^\/?cancelar$/i.test(t)) {
    await ctx.reply('Baja cancelada. No se registró nada.', Markup.removeKeyboard());
    await ctx.scene.leave();
    return true;
  }
  return false;
}

function resumenAlta(a) {
  const fecha = a.fecha ? new Date(a.fecha).toISOString().slice(0, 10) : '';
  return `${a.producto} — proveedor ${a.proveedor || '-'} — ${a.cantidad} unidades (puesta ${fecha})`;
}

function resumenFinal(d, alta) {
  return (
    'Confirmá la baja:\n\n' +
    `Producto: ${alta.producto}\n` +
    `Proveedor: ${alta.proveedor || '-'}\n` +
    `Puesto en promoción: ${alta.cantidad}\n` +
    `Vendido: ${d.vendido}\n` +
    `Remanente: ${d.remanente} (${d.motivoBaja})\n\n` +
    'Escribí "si" para confirmar o "no" para cancelar.'
  );
}

const bajaWizard = new Scenes.WizardScene(
  'baja-wizard',
  // 0: pedir búsqueda
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply('Baja de promoción (se retira de la góndola).\n\n¿Qué producto? EAN, código o nombre. (o "cancelar")');
    return ctx.wizard.next();
  },
  // 1: buscar altas abiertas
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const q = texto(ctx);
    if (!q) { await ctx.reply('Escribí el EAN, código o nombre.'); return; }

    const abiertas = await buscarAltasAbiertas(q);
    if (abiertas.length === 0) {
      await ctx.reply(`No hay ninguna alta abierta en promoción para "${q}".`);
      return ctx.scene.leave();
    }
    if (abiertas.length === 1) {
      ctx.wizard.state.data.alta = abiertas[0];
      await ctx.reply(
        `Encontré:\n${resumenAlta(abiertas[0])}\n\n¿Es esta la que querés dar de baja?`,
        Markup.keyboard([['Sí'], ['No']]).oneTime().resize()
      );
      return ctx.wizard.selectStep(3);
    }
    ctx.wizard.state.opciones = abiertas;
    const lista = abiertas.map((a, i) => `${i + 1}) ${resumenAlta(a)}`).join('\n');
    await ctx.reply(`Hay ${abiertas.length} altas abiertas:\n\n${lista}\n\nRespondé con el número.`);
    return ctx.wizard.next();
  },
  // 2: elegir opción
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const n = Number(texto(ctx));
    const opciones = ctx.wizard.state.opciones || [];
    if (!Number.isInteger(n) || n < 1 || n > opciones.length) {
      await ctx.reply('Elegí un número válido de la lista.');
      return;
    }
    ctx.wizard.state.data.alta = opciones[n - 1];
    await ctx.reply(
      `Elegiste:\n${resumenAlta(opciones[n - 1])}\n\n¿Es esta? (Sí/No)`,
      Markup.keyboard([['Sí'], ['No']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },
  // 3: confirmar producto
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = (texto(ctx) || '').toLowerCase();
    if (t !== 'si' && t !== 'sí') {
      await ctx.reply('Ok, cancelado. Probá de nuevo con /baja.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    await ctx.reply('¿Cuántas unidades quedan sin vender (remanente)? Si se vendió todo, poné 0.', Markup.removeKeyboard());
    return ctx.wizard.next();
  },
  // 4: remanente
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const remanente = Number((texto(ctx) || '').replace(',', '.'));
    if (!Number.isFinite(remanente) || remanente < 0) {
      await ctx.reply('Ingresá un número válido.');
      return;
    }
    const alta = ctx.wizard.state.data.alta;
    const cantidadPuesta = Number(alta.cantidad);
    if (remanente > cantidadPuesta) {
      await ctx.reply(`El remanente no puede ser mayor a lo que se puso en promoción (${cantidadPuesta}).`);
      return;
    }
    ctx.wizard.state.data.remanente = remanente;
    ctx.wizard.state.data.vendido = cantidadPuesta - remanente;

    if (remanente === 0) {
      ctx.wizard.state.data.motivoBaja = 'vendido total';
      await ctx.reply(resumenFinal(ctx.wizard.state.data, alta), Markup.keyboard([['Sí'], ['No']]).oneTime().resize());
      return ctx.wizard.selectStep(6);
    }
    await ctx.reply(
      '¿Qué pasó con el remanente?',
      Markup.keyboard([['Vencido / descartado'], ['Devuelto a góndola normal']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },
  // 5: motivo del remanente
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = texto(ctx);
    if (!t) { await ctx.reply('Elegí qué pasó con el remanente.'); return; }
    ctx.wizard.state.data.motivoBaja = t;
    await ctx.reply(resumenFinal(ctx.wizard.state.data, ctx.wizard.state.data.alta), Markup.keyboard([['Sí'], ['No']]).oneTime().resize());
    return ctx.wizard.next();
  },
  // 6: confirmación final
  async (ctx) => {
    if (await cancelado(ctx)) return;
    const t = (texto(ctx) || '').toLowerCase();
    if (t !== 'si' && t !== 'sí') {
      await ctx.reply('Baja cancelada. No se registró nada.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    return finalizarBaja(ctx);
  }
);

async function finalizarBaja(ctx) {
  const d = ctx.wizard.state.data;
  const alta = d.alta;

  await registrarBaja({ altaId: alta.id, remanente: d.remanente, vendida: d.vendido, motivoBaja: d.motivoBaja });

  const cantidad = Number(alta.cantidad);
  const efectividad = cantidad > 0 ? Math.round((d.vendido / cantidad) * 100) : 0;
  const mensajeComprador =
    '📊 Resultado de promoción\n\n' +
    `Producto: ${alta.producto}\n` +
    `Proveedor: ${alta.proveedor || '-'}\n` +
    `Puesto en promoción: ${alta.cantidad}\n` +
    `Vendido: ${d.vendido}\n` +
    `Remanente: ${d.remanente} (${d.motivoBaja})\n` +
    `Efectividad: ${efectividad}%`;
  if (alta.proveedor) await notificarComprador(alta.proveedor, mensajeComprador);

  await ctx.reply(
    `Baja registrada. Se vendieron ${d.vendido} de ${alta.cantidad} unidades.`,
    Markup.removeKeyboard()
  );
  return ctx.scene.leave();
}

module.exports = bajaWizard;
