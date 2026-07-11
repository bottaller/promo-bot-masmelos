// Wizard /cierre (área Tesorería): el cierre diario. Por ahora carga los SALDOS del día
// ("Existencias al cierre") con control de cambios; el libro diario + la conciliación se
// suman en la próxima fase. Acepta saldos de cualquier fecha (usa la del Excel, no "hoy").
const { Scenes } = require('telegraf');
const { respuesta, esCancelar, preguntar, opciones } = require('../lib/wizard');
const { parsearSaldos, SaldosError } = require('../lib/saldos-excel');
const { guardarSaldos, saldosDeFecha } = require('../db/tesoreria');
const { telegramIdsAdmins } = require('../db/usuarios');
const { formatoVencimiento } = require('../lib/fechas');

function tieneAccesoTesoreria(u) {
  return !!(u && (u.es_admin || (u.areas && u.areas.includes('tesoreria'))));
}

function fmt(m) {
  return Math.round(Number(m)).toLocaleString('es-AR');
}

// Compara los saldos ya guardados contra los nuevos. Devuelve la lista de cuentas que
// cambiaron (o son nuevas): [{cuenta, moneda, anterior, nuevo}]. anterior=null = cuenta nueva.
function calcularCambios(existentes, nuevos) {
  const previos = new Map(existentes.map((s) => [s.cuenta, Number(s.monto)]));
  const cambios = [];
  for (const s of nuevos) {
    const anterior = previos.has(s.cuenta) ? previos.get(s.cuenta) : null;
    if (anterior === null || anterior !== s.monto) {
      cambios.push({ cuenta: s.cuenta, moneda: s.moneda, anterior, nuevo: s.monto });
    }
  }
  return cambios;
}

function detalleCambios(cambios) {
  return cambios
    .map((c) => `• ${c.cuenta}: ${c.anterior === null ? '(nuevo)' : fmt(c.anterior)} → ${fmt(c.nuevo)} ${c.moneda}`)
    .join('\n');
}

const cierreWizard = new Scenes.WizardScene(
  'cierre-wizard',
  // 0: pedir el Excel de saldos
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      'Cierre diario.\n\n' +
      'Mandame el Excel de "Existencias al cierre" (los saldos del día), como .xlsx.\n' +
      'Puede ser de un día anterior — uso la fecha que dice el Excel.\n(o escribí "cancelar")'
    );
    return ctx.wizard.next();
  },
  // 1: recibir, parsear y detectar cambios
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Cierre cancelado.');
      return ctx.scene.leave();
    }
    const doc = ctx.message && ctx.message.document;
    if (!doc) {
      await ctx.reply('Mandame el archivo .xlsx como documento (no como foto ni texto). O escribí "cancelar".');
      return;
    }
    if (!tieneAccesoTesoreria(ctx.state.usuario)) {
      await ctx.reply('Ya no tenés acceso al área Tesorería.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.procesando) return; // evita doble envío del archivo
    ctx.wizard.state.procesando = true;

    let datos;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const resp = await fetch(link.href);
      const buffer = Buffer.from(await resp.arrayBuffer());
      try {
        datos = parsearSaldos(buffer);
      } catch (e) {
        if (e instanceof SaldosError) { await ctx.reply(e.message); return ctx.scene.leave(); }
        throw e;
      }
    } catch (e) {
      console.error('Error en /cierre (descarga/parse):', e.message);
      await ctx.reply('Hubo un problema procesando el Excel. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    }

    const u = ctx.state.usuario;
    const existentes = await saldosDeFecha({ fecha: datos.fecha, empresa: datos.empresa });

    // Primera carga de ese día: guardar directo.
    if (existentes.length === 0) {
      await guardarSaldos({ ...datos, usuarioId: u ? u.id : null });
      await ctx.reply(`✅ Saldos guardados — ${datos.empresa}, ${formatoVencimiento(datos.fecha)} (${datos.saldos.length} cuentas).`);
      return ctx.scene.leave();
    }

    // Ya había saldos: ¿cambió algo?
    const cambios = calcularCambios(existentes, datos.saldos);
    if (cambios.length === 0) {
      await ctx.reply(`Los saldos de ${formatoVencimiento(datos.fecha)} ya estaban cargados y son iguales. No cambié nada.`);
      return ctx.scene.leave();
    }

    // Hay cambios sobre un día ya cargado -> pedir confirmación (es data financiera).
    ctx.wizard.state.data = { datos, cambios };
    await preguntar(
      ctx,
      `⚠️ Ya había saldos cargados para ${formatoVencimiento(datos.fecha)} y ${cambios.length} cambió(n):\n\n` +
      `${detalleCambios(cambios)}\n\n` +
      '¿Confirmás sobrescribir? Se les avisa a los administradores.',
      opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
    );
    return ctx.wizard.next();
  },
  // 2: confirmar la sobrescritura -> guardar + avisar a admins
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return; // botón viejo / doble-tap / no-texto: seguir esperando
    if (esCancelar(raw)) { await ctx.reply('Cierre cancelado. No cambié nada.'); return ctx.scene.leave(); }
    const r = raw.toLowerCase();
    if (r !== 'si' && r !== 'sí') {
      await ctx.reply('Cancelado. No cambié nada.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.guardando) return; // evita doble-tap del confirmar
    ctx.wizard.state.guardando = true;

    const { datos, cambios } = ctx.wizard.state.data;
    const u = ctx.state.usuario;
    await guardarSaldos({ ...datos, usuarioId: u ? u.id : null });
    await ctx.reply(`✅ Saldos de ${formatoVencimiento(datos.fecha)} actualizados. Les avisé a los administradores.`);

    // Aviso a los admins con el detalle del cambio y quién lo hizo (menos el que lo hizo).
    const quien = (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id));
    const msg =
      `🔔 Cambio de saldos ya cargados — ${datos.empresa}, ${formatoVencimiento(datos.fecha)}\n` +
      `Modificó: ${quien}\n\n${detalleCambios(cambios)}`;
    const admins = (await telegramIdsAdmins()).filter((tid) => tid !== ctx.from.id);
    for (const tid of admins) {
      try { await ctx.telegram.sendMessage(tid, msg); }
      catch (e) { console.error(`No pude avisar al admin ${tid}:`, e.message); }
    }
    return ctx.scene.leave();
  }
);

module.exports = cierreWizard;
