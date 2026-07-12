// Wizard de CONTROL DE PERÍODO (semanal / mensual). El tesorero manda el libro del período
// (los saldos ya están cargados de los cierres diarios). El bot concilia el período entero
// —saldo del inicio + Σ movimientos = saldo del final— donde el ruido de timing diario se
// lava. Es READ-ONLY sobre el diario: NO pisa movimientos ni conciliaciones diarias; solo
// lee saldos y deja un registro de auditoría. Fábrica: crearControlPeriodo('semanal'|'mensual').
const { Scenes } = require('telegraf');
const { esCancelar } = require('../lib/wizard');
const { parsearLibro, LibroError } = require('../lib/libro-excel');
const { procesarCierre } = require('../lib/control-tesoreria');
const { saldosDeFecha, saldosAnteriores, registrarAuditoria } = require('../db/tesoreria');
const { formatoVencimiento, fechaISO } = require('../lib/fechas');

function tieneAccesoTesoreria(u) {
  return !!(u && (u.es_admin || (u.areas && u.areas.includes('tesoreria'))));
}
const NIVEL_ORD = { ok: 0, timing: 1, revisar: 2, alerta: 3 };
function peorNivel(filas) {
  return filas.reduce((p, f) => (NIVEL_ORD[f.nivel] > NIVEL_ORD[p] ? f.nivel : p), 'ok');
}
async function bajarDoc(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}

function crearControlPeriodo(tipo) {
  const nombre = tipo === 'mensual' ? 'Control mensual' : 'Control semanal';
  return new Scenes.WizardScene(
    `${tipo}-wizard`,
    async (ctx) => {
      await ctx.reply(
        `${nombre}.\n\n` +
        'Mandame el libro diario ("Diario de movimientos" de Sigma) que cubra el período, como .xlsx.\n' +
        'Los saldos ya los tengo de los cierres diarios. Esto NO modifica los cierres diarios.\n(o "cancelar")'
      );
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Control cancelado.'); return ctx.scene.leave(); }
      const doc = ctx.message && ctx.message.document;
      if (!doc) { await ctx.reply('Mandame el libro como documento .xlsx (o "cancelar").'); return; }
      if (!tieneAccesoTesoreria(ctx.state.usuario)) { await ctx.reply('Ya no tenés acceso al área Tesorería.'); return ctx.scene.leave(); }
      if (ctx.wizard.state.procesando) return;
      ctx.wizard.state.procesando = true;

      let libro;
      try {
        const buffer = await bajarDoc(ctx, doc);
        try { libro = parsearLibro(buffer); }
        catch (e) { if (e instanceof LibroError) { await ctx.reply(e.message); return ctx.scene.leave(); } throw e; }
      } catch (e) {
        console.error(`Error en /${tipo} (libro):`, e.message);
        await ctx.reply('Hubo un problema con el libro. Probá de nuevo o avisá al admin.');
        return ctx.scene.leave();
      }

      // Todo lo que sigue toca la DB: si algo falla (hipo de Postgres), salimos limpio con
      // un mensaje útil en vez de dejar el wizard trabado. Y respondemos ANTES de auditar,
      // así un fallo de auditoría no se lleva puesto el reporte ya calculado.
      try {
        const empresa = 'HONRE'; // sistema mono-empresa por ahora
        const desde = libro.desde, hasta = libro.hasta;

        const saldoFin = await saldosDeFecha({ fecha: hasta, empresa });
        if (saldoFin.length === 0) {
          await ctx.reply(`No tengo los saldos del ${formatoVencimiento(hasta)} (fin del período). Cargalos con /cierre y volvé a intentar.`);
          return ctx.scene.leave();
        }
        const inicio = await saldosAnteriores({ fecha: desde, empresa });
        if (inicio.saldos.length === 0) {
          await ctx.reply(`No tengo un saldo anterior al ${formatoVencimiento(desde)} para arrancar el período. Cargá al menos un cierre previo.`);
          return ctx.scene.leave();
        }

        const desdeISO = fechaISO(inicio.fecha), hastaISO = fechaISO(hasta);
        const movs = libro.movimientos.filter((m) => { const iso = fechaISO(m.fecha); return iso > desdeISO && iso <= hastaISO; });
        const periodo = `${formatoVencimiento(inicio.fecha)} → ${formatoVencimiento(hasta)}`;
        const { filas, texto } = procesarCierre({
          empresa, saldosAyer: inicio.saldos, saldosHoy: saldoFin, movimientos: movs,
          historialDiffs: {}, tipo, periodo, fecha: formatoVencimiento(hasta),
        });

        await ctx.reply(texto, { parse_mode: 'HTML' });

        const u = ctx.state.usuario;
        try {
          await registrarAuditoria({
            usuarioId: u ? u.id : null,
            usuarioTxt: (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id)),
            accion: `control_${tipo}`, empresa, fecha: hasta, periodo, nivel: peorNivel(filas),
            detalle: { cuentas: filas.length, alertas: filas.filter((f) => f.nivel === 'alerta').map((f) => f.cuenta) },
          });
        } catch (e) { console.error(`No pude auditar /${tipo}:`, e.message); }
        return ctx.scene.leave();
      } catch (e) {
        console.error(`Error en /${tipo} (conciliación):`, e.message);
        await ctx.reply('Hubo un problema procesando el control. Probá de nuevo o avisá al admin.');
        return ctx.scene.leave();
      }
    }
  );
}

module.exports = { crearControlPeriodo };
