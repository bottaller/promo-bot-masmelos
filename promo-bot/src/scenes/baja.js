const { Scenes, Markup } = require('telegraf');
const { TABS, appendRow, readAll, updateCellById } = require('../sheets');
const { notificarComprador } = require('../notificar');

function nuevoId() {
  return `B${Date.now()}`;
}

function resumenAlta(alta) {
  return `${alta.producto} — proveedor ${alta.proveedor} — ${alta.cantidad} unidades puestas el ${alta.fecha.slice(0, 10)}`;
}

const bajaWizard = new Scenes.WizardScene(
  'baja-wizard',
  // 0: pedir SKU
  async (ctx) => {
    await ctx.reply('Baja de promoción (se retira de la góndola).\n\n¿SKU del producto?');
    ctx.wizard.state.data = {};
    return ctx.wizard.next();
  },
  // 1: procesar SKU -> decidir si hay 0, 1 o varias altas abiertas
  async (ctx) => {
    const sku = ctx.message.text.trim();
    const { records } = await readAll(TABS.ALTAS);
    const abiertas = records.filter(
      (r) => r.sku.toLowerCase() === sku.toLowerCase() && r.estado === 'abierta'
    );

    if (abiertas.length === 0) {
      await ctx.reply(`No hay ningún alta abierta en promoción para el SKU "${sku}".`);
      return ctx.scene.leave();
    }

    ctx.wizard.state.data.sku = sku;

    if (abiertas.length === 1) {
      ctx.wizard.state.data.alta = abiertas[0];
      await ctx.reply(
        `Encontramos:\n${resumenAlta(abiertas[0])}\n\n¿Es este el producto que querés dar de baja?`,
        Markup.keyboard([['Sí'], ['No']]).oneTime().resize()
      );
      return ctx.wizard.selectStep(3);
    }

    ctx.wizard.state.data.opciones = abiertas;
    const lista = abiertas
      .map((r, i) => `${i + 1}) ${resumenAlta(r)}`)
      .join('\n');
    await ctx.reply(`Hay ${abiertas.length} altas abiertas para "${sku}":\n\n${lista}\n\nRespondé con el número.`);
    return ctx.wizard.next();
  },
  // 2: elegir entre varias opciones
  async (ctx) => {
    const opcion = Number(ctx.message.text.trim());
    const opciones = ctx.wizard.state.data.opciones;
    if (!opcion || !opciones[opcion - 1]) {
      await ctx.reply('Elegí un número válido de la lista.');
      return;
    }
    const alta = opciones[opcion - 1];
    ctx.wizard.state.data.alta = alta;
    await ctx.reply(
      `Elegiste:\n${resumenAlta(alta)}\n\n¿Es este el producto que querés dar de baja?`,
      Markup.keyboard([['Sí'], ['No']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },
  // 3: confirmar que el producto es el correcto
  async (ctx) => {
    const respuesta = ctx.message.text.trim().toLowerCase();
    if (respuesta !== 'si' && respuesta !== 'sí') {
      await ctx.reply('Ok, cancelado. Revisá el SKU y volvé a intentar con /baja.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    await ctx.reply(
      '¿Cuántas unidades quedan sin vender (remanente)? Si se vendió todo, poné 0.',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },
  // 4: cantidad remanente
  async (ctx) => {
    const remanente = Number(ctx.message.text.trim().replace(',', '.'));
    if (Number.isNaN(remanente) || remanente < 0) {
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
    ctx.wizard.state.data.motivoBaja = ctx.message.text.trim();
    const alta = ctx.wizard.state.data.alta;
    await ctx.reply(resumenFinal(ctx.wizard.state.data, alta), Markup.keyboard([['Sí'], ['No']]).oneTime().resize());
    return ctx.wizard.next();
  },
  // 6: confirmación final
  async (ctx) => {
    const respuesta = ctx.message.text.trim().toLowerCase();
    if (respuesta !== 'si' && respuesta !== 'sí') {
      await ctx.reply('Baja cancelada. No se registró nada.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    return finalizarBaja(ctx);
  }
);

function resumenFinal(d, alta) {
  return (
    `Confirmá la baja:\n\n` +
    `Producto: ${alta.producto}\n` +
    `Proveedor: ${alta.proveedor}\n` +
    `Puesto en promoción: ${alta.cantidad}\n` +
    `Vendido: ${d.vendido}\n` +
    `Remanente: ${d.remanente} (${d.motivoBaja})\n\n` +
    `Escribí "si" para confirmar o "no" para cancelar.`
  );
}

async function finalizarBaja(ctx) {
  const d = ctx.wizard.state.data;
  const alta = d.alta;
  const id = nuevoId();
  const fecha = new Date().toISOString();

  await appendRow(TABS.BAJAS, [id, fecha, alta.id, d.sku, d.remanente, d.vendido, d.motivoBaja]);
  await updateCellById(TABS.ALTAS, 'id', alta.id, 'estado', 'cerrada');

  const mensajeComprador =
    `📊 Resultado de promoción\n\n` +
    `Producto: ${alta.producto}\n` +
    `Proveedor: ${alta.proveedor}\n` +
    `SKU: ${d.sku}\n` +
    `Puesto en promoción: ${alta.cantidad}\n` +
    `Vendido: ${d.vendido}\n` +
    `Remanente: ${d.remanente} (${d.motivoBaja})\n` +
    `Efectividad: ${Math.round((d.vendido / alta.cantidad) * 100)}%`;

  await notificarComprador(alta.proveedor, mensajeComprador);
  await ctx.reply(
    `Baja registrada. Se vendieron ${d.vendido} de ${alta.cantidad} unidades. Se notificó al comprador.`,
    Markup.removeKeyboard()
  );
  return ctx.scene.leave();
}

module.exports = bajaWizard;
