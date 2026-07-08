const { Scenes, Markup } = require('telegraf');
const { TABS, appendRow, readAll, updateCellById } = require('../sheets');
const { notificarComprador } = require('../notificar');

function nuevoId() {
  return `B${Date.now()}`;
}

const bajaWizard = new Scenes.WizardScene(
  'baja-wizard',
  async (ctx) => {
    await ctx.reply('Baja de promoción (se retira de la góndola).\n\n¿SKU del producto?');
    ctx.wizard.state.data = {};
    return ctx.wizard.next();
  },
  async (ctx) => {
    const sku = ctx.message.text.trim();
    const { records } = await readAll(TABS.ALTAS);
    const abiertas = records.filter(
      (r) => r.sku.toLowerCase() === sku.toLowerCase() && r.estado === 'abierta'
    );

    if (abiertas.length === 0) {
      await ctx.reply(`No hay ningún alta abierta en promoción para "${sku}".`);
      return ctx.scene.leave();
    }

    if (abiertas.length === 1) {
      ctx.wizard.state.data.sku = sku;
      ctx.wizard.state.data.alta = abiertas[0];
      await ctx.reply(
        `Alta encontrada: ${abiertas[0].cantidad} unidades puestas el ${abiertas[0].fecha.slice(0, 10)}.\n\n` +
        `¿Cuántas unidades quedan sin vender (remanente)? Si se vendió todo, poné 0.`
      );
      return ctx.wizard.selectStep(3);
    }

    ctx.wizard.state.data.sku = sku;
    ctx.wizard.state.data.opciones = abiertas;
    const lista = abiertas
      .map((r, i) => `${i + 1}) id ${r.id} — ${r.cantidad} unidades — ${r.fecha.slice(0, 10)}`)
      .join('\n');
    await ctx.reply(`Hay ${abiertas.length} altas abiertas para "${sku}":\n\n${lista}\n\nRespondé con el número.`);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const opcion = Number(ctx.message.text.trim());
    const opciones = ctx.wizard.state.data.opciones;
    if (!opcion || !opciones[opcion - 1]) {
      await ctx.reply('Elegí un número válido de la lista.');
      return;
    }
    ctx.wizard.state.data.alta = opciones[opcion - 1];
    await ctx.reply('¿Cuántas unidades quedan sin vender (remanente)? Si se vendió todo, poné 0.');
    return ctx.wizard.next();
  },
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
      ctx.wizard.state.data.motivoBaja = 'vendido';
      return finalizarBaja(ctx);
    }

    await ctx.reply(
      '¿Qué pasó con el remanente?',
      Markup.keyboard([['Vencido / descartado'], ['Devuelto a góndola normal']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.data.motivoBaja = ctx.message.text.trim();
    return finalizarBaja(ctx);
  }
);

async function finalizarBaja(ctx) {
  const d = ctx.wizard.state.data;
  const alta = d.alta;
  const id = nuevoId();
  const fecha = new Date().toISOString();

  await appendRow(TABS.BAJAS, [id, fecha, alta.id, d.sku, d.remanente, d.vendido, d.motivoBaja]);
  await updateCellById(TABS.ALTAS, 'id', alta.id, 'estado', 'cerrada');

  const mensajeComprador =
    `📊 Resultado de promoción\n\n` +
    `SKU: ${d.sku}\n` +
    `Puesto en promoción: ${alta.cantidad}\n` +
    `Vendido: ${d.vendido}\n` +
    `Remanente: ${d.remanente} (${d.motivoBaja})\n` +
    `Efectividad: ${Math.round((d.vendido / alta.cantidad) * 100)}%`;

  await notificarComprador(alta.categoria, mensajeComprador);
  await ctx.reply(`Baja registrada. Se vendieron ${d.vendido} de ${alta.cantidad} unidades. Se notificó al comprador.`, Markup.removeKeyboard());
  return ctx.scene.leave();
}

module.exports = bajaWizard;
