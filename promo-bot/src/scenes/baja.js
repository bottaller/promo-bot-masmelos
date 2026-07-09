const { Scenes } = require('telegraf');
const { buscarAltasAbiertas, registrarBaja } = require('../db/compras');
const { notificarComprador } = require('../notificar');
const { respuesta, esCancelar, opciones, SI_NO } = require('../lib/wizard');

async function cancelar(ctx) {
  await ctx.reply('Baja cancelada. No se registró nada.');
  return ctx.scene.leave();
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
    `Remanente: ${d.remanente} (${d.motivoBaja})`
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
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el EAN, código o nombre.'); return; }

    const abiertas = await buscarAltasAbiertas(r);
    if (abiertas.length === 0) {
      await ctx.reply(`No hay ninguna alta abierta en promoción para "${r}".`);
      return ctx.scene.leave();
    }
    if (abiertas.length === 1) {
      ctx.wizard.state.data.alta = abiertas[0];
      await ctx.reply(`Encontré:\n${resumenAlta(abiertas[0])}\n\n¿Es esta la que querés dar de baja?`, SI_NO);
      return ctx.wizard.selectStep(3);
    }
    ctx.wizard.state.opciones = abiertas;
    const lista = abiertas.map((a, i) => `${i + 1}) ${resumenAlta(a)}`).join('\n');
    await ctx.reply(`Hay ${abiertas.length} altas abiertas:\n\n${lista}\n\nRespondé con el número.`);
    return ctx.wizard.next();
  },
  // 2: elegir opción (se tipea el número)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const n = Number(r);
    const ops = ctx.wizard.state.opciones || [];
    if (!Number.isInteger(n) || n < 1 || n > ops.length) {
      await ctx.reply('Elegí un número válido de la lista.');
      return;
    }
    ctx.wizard.state.data.alta = ops[n - 1];
    await ctx.reply(`Elegiste:\n${resumenAlta(ops[n - 1])}\n\n¿Es esta?`, SI_NO);
    return ctx.wizard.next();
  },
  // 3: confirmar producto
  async (ctx) => {
    const r = (await respuesta(ctx) || '').toLowerCase();
    if (esCancelar(r)) return cancelar(ctx);
    if (r !== 'si' && r !== 'sí') {
      await ctx.reply('Ok, cancelado. Probá de nuevo con /baja.');
      return ctx.scene.leave();
    }
    await ctx.reply('¿Cuántas unidades quedan sin vender (remanente)? Si se vendió todo, poné 0.');
    return ctx.wizard.next();
  },
  // 4: remanente (se tipea el número)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    const remanente = Number((r || '').replace(',', '.'));
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
      await ctx.reply(resumenFinal(ctx.wizard.state.data, alta), SI_NO);
      return ctx.wizard.selectStep(6);
    }
    await ctx.reply(
      '¿Qué pasó con el remanente?',
      opciones(['Vencido / descartado', 'Devuelto a góndola normal'])
    );
    return ctx.wizard.next();
  },
  // 5: motivo del remanente
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Elegí qué pasó con el remanente.'); return; }
    ctx.wizard.state.data.motivoBaja = r;
    await ctx.reply(resumenFinal(ctx.wizard.state.data, ctx.wizard.state.data.alta), SI_NO);
    return ctx.wizard.next();
  },
  // 6: confirmación final
  async (ctx) => {
    const r = (await respuesta(ctx) || '').toLowerCase();
    if (esCancelar(r)) return cancelar(ctx);
    if (r !== 'si' && r !== 'sí') {
      await ctx.reply('Baja cancelada. No se registró nada.');
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

  await ctx.reply(`Baja registrada. Se vendieron ${d.vendido} de ${alta.cantidad} unidades.`);
  return ctx.scene.leave();
}

module.exports = bajaWizard;
