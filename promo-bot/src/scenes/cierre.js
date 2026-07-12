// Wizard /cierre (Tesorería): el CIERRE DIARIO — control, seguridad y auditoría.
// El tesorero manda 1) el Excel de saldos ("Existencias al cierre") y 2) el libro diario
// ("Diario de movimientos" de Sigma) de ese día. El bot:
//   - guarda los saldos (con control de cambios: si un día ya cargado cambia, avisa a admins),
//   - concilia realidad vs libro por cuenta (saldo_ayer + ingresos − egresos = teórico),
//   - calcula el ACUMULADO por cuenta (lo que separa el timing de un problema real),
//   - guarda movimientos + conciliación + auditoría, y
//   - devuelve el reporte y avisa a los admins si alguna cuenta queda en 🔴 (no se resuelve).
const { Scenes } = require('telegraf');
const { respuesta, esCancelar, preguntar, opciones } = require('../lib/wizard');
const { parsearSaldos, SaldosError } = require('../lib/saldos-excel');
const { parsearLibro, LibroError } = require('../lib/libro-excel');
const { procesarCierre } = require('../lib/control-tesoreria');
const {
  guardarSaldos, saldosDeFecha, saldosAnteriores,
  guardarMovimientos, guardarConciliacion, historialDiferencias, registrarAuditoria,
} = require('../db/tesoreria');
const { telegramIdsAdmins } = require('../db/usuarios');
const { formatoVencimiento, fechaISO } = require('../lib/fechas');

function tieneAccesoTesoreria(u) {
  return !!(u && (u.es_admin || (u.areas && u.areas.includes('tesoreria'))));
}
function fmt(m) { return Math.round(Number(m)).toLocaleString('es-AR'); }

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
  return cambios.map((c) => `• ${c.cuenta}: ${c.anterior === null ? '(nuevo)' : fmt(c.anterior)} → ${fmt(c.nuevo)} ${c.moneda}`).join('\n');
}
const NIVEL_ORD = { ok: 0, timing: 1, revisar: 2, alerta: 3 };
function peorNivel(filas) {
  return filas.reduce((peor, f) => (NIVEL_ORD[f.nivel] > NIVEL_ORD[peor] ? f.nivel : peor), 'ok');
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
// apenas se sobrescriben, no diferido al final (si el libro fallara, el cambio ya quedó
// asentado y avisado). telegram_id viene como string de pg → comparar como Number.
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
  const msg = `🔔 <b>Cambio de saldos ya cargados</b> — ${datos.empresa}, ${formatoVencimiento(datos.fecha)}\n` +
    `Modificó: ${quien}\n\n${detalleCambios(cambios)}`;
  const admins = (await telegramIdsAdmins()).filter((tid) => Number(tid) !== ctx.from.id);
  for (const tid of admins) {
    try { await ctx.telegram.sendMessage(tid, msg, { parse_mode: 'HTML' }); }
    catch (e) { console.error(`No pude avisar al admin ${tid}:`, e.message); }
  }
}

// Paso final: recibido el libro, concilia todo y responde.
async function conciliarYResponder(ctx, buffer) {
  const { datos } = ctx.wizard.state.data;
  const u = ctx.state.usuario;
  const empresa = datos.empresa;

  let libro;
  try {
    libro = parsearLibro(buffer);
  } catch (e) {
    if (e instanceof LibroError) { await ctx.reply(e.message); return ctx.scene.leave(); }
    throw e;
  }

  // Movimientos del período (desde el último saldo cargado hasta hoy). Normalmente es el
  // día; si hubo finde/feriado, el libro trae varios días y tomamos todos los del tramo.
  const prev = await saldosAnteriores({ fecha: datos.fecha, empresa });
  const desdeISO = prev.fecha ? fechaISO(prev.fecha) : null;
  const hastaISO = fechaISO(datos.fecha);
  const movsPeriodo = libro.movimientos.filter((m) => {
    const iso = fechaISO(m.fecha);
    return (desdeISO === null || iso > desdeISO) && iso <= hastaISO;
  });

  if (movsPeriodo.length === 0) {
    await ctx.reply(
      `El libro que mandaste no tiene movimientos del ${formatoVencimiento(datos.fecha)}` +
      (prev.fecha ? ` (ni de los días desde el ${formatoVencimiento(prev.fecha)})` : '') +
      '. ¿Es el "Diario de movimientos" del día correcto?'
    );
    return ctx.scene.leave();
  }

  const historial = await historialDiferencias({ empresa, hasta: datos.fecha });
  const { filas, texto } = procesarCierre({
    fecha: formatoVencimiento(datos.fecha), empresa,
    saldosAyer: prev.saldos, saldosHoy: datos.saldos, movimientos: movsPeriodo,
    historialDiffs: historial, tipo: 'diario',
  });

  // Persistir: libro completo + conciliación + auditoría.
  const uid = u ? u.id : null;
  await guardarMovimientos({ empresa, movimientos: libro.movimientos, usuarioId: uid });
  await guardarConciliacion({ fecha: datos.fecha, empresa, filas, usuarioId: uid });
  const nivel = peorNivel(filas);
  await registrarAuditoria({
    usuarioId: uid, usuarioTxt: (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id)),
    accion: 'cierre_diario', empresa, fecha: datos.fecha, nivel,
    detalle: { cuentas: filas.length, alertas: filas.filter((f) => f.nivel === 'alerta').map((f) => f.cuenta) },
  });

  await ctx.reply(texto, { parse_mode: 'HTML' });

  // Si hay 🔴 (acumulado que no se resuelve), avisar a los admins. (El cambio de saldos ya
  // se avisó en el paso 2.) telegram_id viene como string de pg → comparar como Number.
  const enAlerta = filas.filter((f) => f.nivel === 'alerta');
  if (enAlerta.length) {
    const aviso = `🔔 <b>Cierre ${formatoVencimiento(datos.fecha)}</b> — cargó ${quienEs(ctx)}\n\n` +
      `🔴 Cuentas en alerta (acumulado que no se resuelve):\n` +
      enAlerta.map((f) => `• ${f.cuenta}: acum ${fmt(f.acumulado)} ${f.moneda}`).join('\n');
    const admins = (await telegramIdsAdmins()).filter((tid) => Number(tid) !== ctx.from.id);
    for (const tid of admins) {
      try { await ctx.telegram.sendMessage(tid, aviso, { parse_mode: 'HTML' }); }
      catch (e) { console.error(`No pude avisar al admin ${tid}:`, e.message); }
    }
  }
  return ctx.scene.leave();
}

const cierreWizard = new Scenes.WizardScene(
  'cierre-wizard',
  // 0: pedir el Excel de saldos
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      'Cierre diario.\n\n' +
      '1) Mandame el Excel de "Existencias al cierre" (los saldos del día), como .xlsx.\n' +
      'Después te voy a pedir el libro diario.\n(o escribí "cancelar")'
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
        `⚠️ Ya había saldos para ${formatoVencimiento(datos.fecha)} y ${cambios.length} cambió(n):\n\n${detalleCambios(cambios)}\n\n¿Confirmás sobrescribir? (después seguimos con el libro)`,
        opciones([['✅ Confirmar', 'si'], ['❌ Cancelar', 'no']])
      );
      return ctx.wizard.next(); // -> paso 2 (confirmar)
    }
    // Sin cambios (o primera carga): guardar y pedir el libro directo.
    await guardarSaldos({ ...datos, usuarioId: u ? u.id : null });
    await ctx.reply(
      `✅ Saldos de ${formatoVencimiento(datos.fecha)} guardados (${datos.saldos.length} cuentas).\n\n` +
      '2) Ahora mandame el libro diario ("Diario de movimientos" de Sigma) de ese día, como .xlsx.'
    );
    ctx.wizard.selectStep(3); // saltar la confirmación -> paso 3 (libro)
    return;
  },
  // 2: confirmar sobrescritura de saldos -> guardar + pedir libro
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
    // Auditar + avisar el cambio YA (no esperar al libro; si el paso 3 falla o se cancela,
    // el cambio de plata ya quedó asentado y avisado a los admins).
    await auditarYAvisarCambioSaldos(ctx, datos, cambios);
    ctx.wizard.state.guardando = false;
    await ctx.reply(
      `✅ Saldos de ${formatoVencimiento(datos.fecha)} actualizados (les avisé a los administradores).\n\n` +
      '2) Ahora mandame el libro diario ("Diario de movimientos") de ese día, como .xlsx.'
    );
    return ctx.wizard.next(); // -> paso 3 (libro)
  },
  // 3: recibir libro -> conciliar y responder
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cierre cancelado (los saldos ya quedaron guardados).'); return ctx.scene.leave(); }
    const doc = ctx.message && ctx.message.document;
    if (!doc) { await ctx.reply('Mandame el libro diario como documento .xlsx (o "cancelar").'); return; }
    if (ctx.wizard.state.conciliando) return;
    ctx.wizard.state.conciliando = true;
    try {
      const buffer = await bajarDoc(ctx, doc);
      return await conciliarYResponder(ctx, buffer);
    } catch (e) {
      console.error('Error en /cierre (libro/conciliación):', e.message);
      await ctx.reply('Hubo un problema procesando el libro. Los saldos quedaron guardados; probá el libro de nuevo o avisá al admin.');
      return ctx.scene.leave();
    }
  }
);

module.exports = cierreWizard;
