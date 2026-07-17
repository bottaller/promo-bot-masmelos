const { Scenes } = require('telegraf');
const { crearInforme } = require('../db/deposito');
const { notificarPorRol } = require('../notificar');
const { respuesta, esCancelar, opciones, preguntar, SI_NO } = require('../lib/wizard');

const DESTINOS = { calidad: 'Calidad', compras: 'Compras' };

async function cancelar(ctx) {
  await ctx.reply('Informe cancelado.');
  return ctx.scene.leave();
}

function resumen(d) {
  return (
    'Confirmá el informe:\n\n' +
    `Para: ${DESTINOS[d.destino]}\n` +
    `Proveedor/producto: ${d.referencia}\n\n` +
    `${d.mensaje}`
  );
}

const informeWizard = new Scenes.WizardScene(
  'informe-wizard',
  // 0: elegir destino
  async (ctx) => {
    ctx.wizard.state.data = {};
    await preguntar(ctx, 'Informe de Depósito.\n\n¿A quién es? (o "cancelar")', opciones([['Calidad', 'calidad'], ['Compras', 'compras']]));
    return ctx.wizard.next();
  },
  // 1: destino -> referencia
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (r !== 'calidad' && r !== 'compras') { await ctx.reply('Elegí "Calidad" o "Compras".'); return; }
    ctx.wizard.state.data.destino = r;
    await ctx.reply('¿Sobre qué proveedor o producto es el informe?');
    return ctx.wizard.next();
  },
  // 2: referencia -> mensaje
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el proveedor o producto.'); return; }
    ctx.wizard.state.data.referencia = r;
    await ctx.reply('Escribí el informe:');
    return ctx.wizard.next();
  },
  // 3: mensaje -> confirmar
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) return cancelar(ctx);
    if (!r) { await ctx.reply('Escribí el contenido del informe.'); return; }
    ctx.wizard.state.data.mensaje = r;
    await preguntar(ctx, resumen(ctx.wizard.state.data), SI_NO);
    return ctx.wizard.next();
  },
  // 4: confirmar -> guardar y avisar
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return; // botón viejo / doble-tap / no-texto: el paso sigue esperando
    if (esCancelar(raw)) return cancelar(ctx);
    const r = raw.toLowerCase();
    if (r !== 'si' && r !== 'sí') {
      await ctx.reply('Informe cancelado.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.guardando) return; // evita doble-tap
    ctx.wizard.state.guardando = true;

    const d = ctx.wizard.state.data;
    const u = ctx.state.usuario;
    const nombre = u ? u.nombre : (ctx.from.username || ctx.from.first_name || null);

    await crearInforme({
      destinoArea: d.destino,
      referencia: d.referencia,
      mensaje: d.mensaje,
      usuarioId: u ? u.id : null,
      usuarioNombre: nombre,
    });

    const enviados = await notificarPorRol(
      d.destino,
      `📋 Informe de Depósito — ${DESTINOS[d.destino]}\n` +
      `Proveedor/producto: ${d.referencia}\n\n` +
      `${d.mensaje}\n\n— ${nombre || 'Depósito'}`
    );

    await ctx.reply(
      `Informe registrado y enviado a ${DESTINOS[d.destino]}` +
      (enviados > 0 ? ` (${enviados} persona(s)).` : ', pero todavía no hay nadie con ese rol asignado.')
    );
    return ctx.scene.leave();
  }
);

module.exports = informeWizard;
