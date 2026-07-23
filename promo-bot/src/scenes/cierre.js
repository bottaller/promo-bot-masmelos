// Wizard /cierre (Tesorería): la PRIMERA mitad del cierre diario en dos tiempos.
// El tesorero manda SOLO el Excel de saldos ("Existencias al cierre") a la hora que cuenta.
// El bot los guarda (con control de cambios: si un día ya cargado cambia, avisa a los admins) y
// anota el cierre como PENDIENTE. El análisis se hace después, cuando el admin carga el libro de
// la jornada (/libro): a las 08:00 del día siguiente, el barrido (entrega-cierres.js) concilia y
// le entrega el reporte al tesorero + admins.
//
// Antes el tesorero tenía que mandar también el libro acá mismo; eso lo movíamos a "usar el libro
// cargado", y esa rama fue la que trajo el bug del usuario atrapado. Al pedir solo saldos, ese
// camino deja de existir.
const { Scenes } = require('telegraf');
const { respuesta, esCancelar, preguntar, opciones } = require('../lib/wizard');
const { parsearSaldos, SaldosError } = require('../lib/saldos-excel');
const { guardarSaldos, saldosDeFecha, saldosAnteriores, registrarAuditoria } = require('../db/tesoreria');
const { registrarCierrePendiente } = require('../db/cierres-pendientes');
const { telegramIdsAdmins } = require('../db/usuarios');
const { formatoVencimiento } = require('../lib/fechas');

// Tesorería queda afuera del bypass de "sistemas" (a pedido): acá solo admin real o el rol
// "tesoreria" de verdad, sin pasar por tieneAccesoTotal().
function tieneAccesoTesoreria(u) {
  return !!(u && (u.es_admin || (u.areas && u.areas.includes('tesoreria'))));
}
function fmt(m) { return Math.round(Number(m)).toLocaleString('es-AR'); }
// Escapa texto libre (nombre de empresa/cuenta, usuario) antes de meterlo en un mensaje con
// parse_mode:'HTML'. Sin esto, una razón social o cuenta con &, < o > hace que Telegram
// rechace el mensaje ('can't parse entities') y el reply tire.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Cuentas de saldo que cambiaron respecto de lo ya guardado.
function calcularCambios(existentes, nuevos) {
  const previos = new Map(existentes.map((s) => [s.cuenta, Number(s.monto)]));
  const cambios = [];
  for (const s of nuevos) {
    const anterior = previos.has(s.cuenta) ? previos.get(s.cuenta) : null;
    if (anterior === null || anterior !== s.monto) cambios.push({ cuenta: s.cuenta, moneda: s.moneda, anterior, nuevo: s.monto });
  }
  return cambios;
}
function detalleCambios(cambios) {
  return cambios.map((c) => `• ${escapeHtml(c.cuenta)}: ${c.anterior === null ? '(nuevo)' : fmt(c.anterior)} → ${fmt(c.nuevo)} ${escapeHtml(c.moneda)}`).join('\n');
}

async function bajarDoc(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}

function quienEs(ctx) {
  const u = ctx.state.usuario;
  return (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id));
}

// Registra (append-only) y avisa a los admins un cambio de saldos ya cargados, EN EL ACTO —
// apenas se sobrescriben, no diferido (si algo fallara después, el cambio ya quedó asentado y
// avisado). telegram_id viene como string de pg → comparar como Number.
async function auditarYAvisarCambioSaldos(ctx, datos, cambios) {
  const u = ctx.state.usuario;
  const quien = quienEs(ctx);
  try {
    await registrarAuditoria({
      usuarioId: u ? u.id : null, usuarioTxt: quien, accion: 'cambio_saldos',
      empresa: datos.empresa, fecha: datos.fecha,
      detalle: { cambios: cambios.map((c) => ({ cuenta: c.cuenta, anterior: c.anterior, nuevo: c.nuevo })) },
    });
  } catch (e) { console.error('No pude auditar el cambio de saldos:', e.message); }
  const msg = `🔔 <b>Cambio de saldos ya cargados</b> — ${escapeHtml(datos.empresa)}, ${formatoVencimiento(datos.fecha)}\n` +
    `Modificó: ${escapeHtml(quien)}\n\n${detalleCambios(cambios)}`;
  const admins = (await telegramIdsAdmins()).filter((tid) => Number(tid) !== ctx.from.id);
  for (const tid of admins) {
    try { await ctx.telegram.sendMessage(tid, msg, { parse_mode: 'HTML' }); }
    catch (e) { console.error(`No pude avisar al admin ${tid}:`, e.message); }
  }
}

// Cierra la escena después de guardar los saldos: anota el cierre como pendiente (para que el
// barrido de las 08:00 lo concilie y entregue) y le explica al tesorero qué va a pasar. NO pide
// el libro: esa es tarea del admin (/libro). Nunca deja al usuario esperando algo.
//   prefijo: la confirmación de guardado que ya se armó ("✅ Saldos de … guardados").
async function registrarPendienteYCerrar(ctx, datos, prefijo) {
  // ¿Primer cierre (sin día anterior)? saldosAnteriores busca el último día ANTES de hoy, así que
  // ignora los saldos que se acaban de guardar. Sin día previo no hay ventana que conciliar.
  let prev;
  try {
    prev = await saldosAnteriores({ fecha: datos.fecha, empresa: datos.empresa });
  } catch (e) {
    console.error('No pude ver si hay día anterior (sigo, lo anoto pendiente):', e.message);
    prev = { fecha: 'error' }; // ante la duda, tratarlo como cierre normal (mejor pendiente que perdido)
  }

  // Si el Excel vino SIN "Hora del conteo", el corte fino por hora queda apagado (usa fin del día).
  // Avisar acá es más importante que antes: en el modelo diferido el tesorero no ve el reporte hasta
  // mañana, así que si no se lo decimos ahora, no se entera de que la precisión quedó degradada.
  const avisoHora = datos.horaCargada ? '' :
    '\n\n⚠️ El Excel no traía la "Hora del conteo": uso el fin del día y el corte fino por hora queda ' +
    'apagado. Si querés que corte justo, agregá la hora en la plantilla y recargá.';

  if (!prev.fecha) {
    await ctx.reply(
      `${prefijo}${avisoHora}\n\n` +
      'Es el primer cierre que tengo cargado, así que queda como <b>base</b>: no hay día anterior ' +
      'contra el cual conciliar. Desde el próximo, te entrego el reporte a la mañana siguiente de ' +
      'que se cargue el libro.',
      { parse_mode: 'HTML' }
    );
    return ctx.scene.leave();
  }

  const u = ctx.state.usuario;
  try {
    await registrarCierrePendiente({
      fecha: datos.fecha, empresa: datos.empresa, telegramId: ctx.from.id,
      usuarioId: u ? u.id : null, usuarioTxt: quienEs(ctx),
    });
  } catch (e) {
    console.error('No pude anotar el cierre pendiente:', e.message);
    await ctx.reply(
      `${prefijo}\n\n⚠️ Guardé los saldos, pero no pude anotar el cierre para la entrega automática ` +
      '(problema con la base). Avisale al admin así lo revisa.'
    );
    return ctx.scene.leave();
  }

  await ctx.reply(
    `${prefijo}${avisoHora}\n\n` +
    '📊 El análisis sale cuando se cargue el libro de la jornada. Mañana a la mañana te llega el ' +
    'reporte del cierre, a vos y a los administradores.'
  );
  return ctx.scene.leave();
}

const cierreWizard = new Scenes.WizardScene(
  'cierre-wizard',
  // 0: pedir el Excel de saldos
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      'Cierre diario.\n\n' +
      'Mandame el Excel de "Existencias al cierre" (con la Fecha y la Hora del conteo), como .xlsx.\n' +
      'Con eso me alcanza: el análisis lo hago cuando se cargue el libro de la jornada y te entrego ' +
      'el reporte a la mañana siguiente.\n(o escribí "cancelar")'
    );
    return ctx.wizard.next();
  },
  // 1: recibir saldos, parsear, detectar cambios
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cierre cancelado.'); return ctx.scene.leave(); }
    const doc = ctx.message && ctx.message.document;
    if (!doc) { await ctx.reply('Mandame el Excel de saldos como documento .xlsx (o "cancelar").'); return; }
    if (!tieneAccesoTesoreria(ctx.state.usuario)) { await ctx.reply('Ya no tenés acceso al área Tesorería.'); return ctx.scene.leave(); }
    if (ctx.wizard.state.procesando) return;
    ctx.wizard.state.procesando = true;

    let datos;
    try {
      const buffer = await bajarDoc(ctx, doc);
      try { datos = parsearSaldos(buffer); }
      catch (e) { if (e instanceof SaldosError) { await ctx.reply(e.message); return ctx.scene.leave(); } throw e; }
    } catch (e) {
      console.error('Error en /cierre (saldos):', e.message);
      await ctx.reply('Hubo un problema con el Excel de saldos. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    }
    ctx.wizard.state.procesando = false;

    const u = ctx.state.usuario;
    const existentes = await saldosDeFecha({ fecha: datos.fecha, empresa: datos.empresa });
    const cambios = existentes.length ? calcularCambios(existentes, datos.saldos) : [];
    ctx.wizard.state.data = { datos, cambios };

    if (existentes.length && cambios.length) {
      // Saldos de un día ya cargado que cambiaron: pedir confirmación (data financiera).
      await preguntar(
        ctx,
        `⚠️ Ya había saldos para ${formatoVencimiento(datos.fecha)} y ${cambios.length} cambió(n):\n\n${detalleCambios(cambios)}\n\n¿Confirmás sobrescribir?`,
        opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
      );
      return ctx.wizard.next(); // -> paso 2 (confirmar)
    }
    // Sin cambios (o primera carga): guardar y anotar el cierre pendiente.
    await guardarSaldos({ ...datos, usuarioId: u ? u.id : null });
    return registrarPendienteYCerrar(ctx, datos,
      `✅ Saldos de ${formatoVencimiento(datos.fecha)} guardados (${datos.saldos.length} cuentas).`);
  },
  // 2: confirmar sobrescritura de saldos -> guardar + anotar pendiente
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return;
    if (esCancelar(raw)) { await ctx.reply('Cierre cancelado. No cambié nada.'); return ctx.scene.leave(); }
    const r = raw.toLowerCase();
    if (r !== 'si' && r !== 'sí') { await ctx.reply('Cancelado. No cambié nada.'); return ctx.scene.leave(); }
    if (ctx.wizard.state.guardando) return;
    ctx.wizard.state.guardando = true;

    const { datos, cambios } = ctx.wizard.state.data;
    const u = ctx.state.usuario;
    await guardarSaldos({ ...datos, usuarioId: u ? u.id : null });
    // Auditar + avisar el cambio YA (no diferirlo): el cambio de plata queda asentado aunque
    // después algo falle.
    await auditarYAvisarCambioSaldos(ctx, datos, cambios);
    ctx.wizard.state.guardando = false;
    return registrarPendienteYCerrar(ctx, datos,
      `✅ Saldos de ${formatoVencimiento(datos.fecha)} actualizados (les avisé a los administradores).`);
  }
);

module.exports = cierreWizard;
