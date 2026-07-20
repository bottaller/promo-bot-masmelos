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
  guardarMovimientos, movimientosDeRango, guardarConciliacion, historialDiferencias, registrarAuditoria,
} = require('../db/tesoreria');
const { telegramIdsAdmins } = require('../db/usuarios');
const { conseguirLibro } = require('../lib/libro-fuente');
const LM = require('../lib/libro-mensajes');
const { formatoVencimiento, fechaISO } = require('../lib/fechas');

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

// Hora 'HH:MM' de un contadoEn canónico 'AAAA-MM-DD HH:MM:SS'.
function horaDe(ts) { return ts ? ts.slice(11, 16) : '23:59'; }

// Mensaje del paso "mandame el libro". Le decimos cuál es el último saldo (con su HORA de
// conteo, contra el que se concilia) y qué rango exportar. Ojo: el corte fino es por HORA
// (entre los dos conteos), pero el export de Sigma es por rango de DÍAS — por eso pedimos
// desde el DÍA del conteo anterior INCLUSIVE (para que venga la cola de esa tarde, que en
// la ventana por hora sí cuenta) hasta hoy. La ventana real la calcula la conciliación
// leyendo la DB por `ingreso`, así que unos días de más en el export no molestan.
async function textoPedirLibro(datos) {
  const hoyTxt = formatoVencimiento(datos.fecha);
  const horaHoy = horaDe(datos.contadoEn);
  const prev = await saldosAnteriores({ fecha: datos.fecha, empresa: datos.empresa });
  if (!prev.fecha) {
    return (
      `📌 Es el primer cierre que cargo de <b>${escapeHtml(datos.empresa)}</b>: no tengo un saldo anterior, ` +
      `así que este día queda como base (no se concilia contra nada).\n\n` +
      `2) Mandame el libro diario ("Diario de movimientos" de Sigma) del <b>${hoyTxt}</b>, como .xlsx.`
    );
  }
  const desdeTxt = formatoVencimiento(prev.fecha); // el DÍA del conteo anterior, inclusive
  const horaPrev = horaDe(prev.contadoEn);
  const base =
    `📌 Último saldo que tengo de <b>${escapeHtml(datos.empresa)}</b>: <b>${desdeTxt} ${horaPrev}</b> — concilio contra ese.\n\n` +
    `2) Ahora mandame el libro diario ("Diario de movimientos" de Sigma), como .xlsx.\n` +
    `📅 En Sigma exportá <b>del ${desdeTxt} al ${hoyTxt}</b> (podés poner unos días más para atrás, no molesta).\n` +
    `⏱️ Yo corto solo por hora: entre las <b>${horaPrev}</b> del conteo anterior y las <b>${horaHoy}</b> de hoy.`;

  // El atajo se ofrece SOLO si están cargados los libros de LOS DOS extremos de la ventana
  // (el día del conteo anterior y hoy). Ofrecerlo cuando falta uno haría que el tesorero
  // escriba "usar" y se coma un rechazo.
  const libHoy = await conseguirLibro({ modo: 'cubre', fecha: datos.fecha });
  const libPrev = await conseguirLibro({ modo: 'cubre', fecha: prev.fecha });
  if (!libHoy.ok || !libPrev.ok) return base;
  const mismo = fechaISO(libPrev.meta.fecha) === fechaISO(libHoy.meta.fecha);
  const queTengo = mismo
    ? `el libro del ${LM.diaLibro(libHoy.meta)}, que trae ${LM.describirRango(libHoy.meta)}`
    : `los libros del ${LM.diaLibro(libPrev.meta)} y del ${LM.diaLibro(libHoy.meta)}`;
  return `${base}\n\n♻️ O escribí <b>"usar"</b> y tomo lo que ya cargó el admin (${queTengo}).`;
}

// Manda "✅ saldos guardados" + el pedido del libro, TOLERANDO fallos: si armar el texto
// (consulta a DB) o el envío HTML fallan, cae a un texto plano. Nunca tira — así el llamador
// puede avanzar el wizard con la certeza de que no queda trabado tras haber guardado los saldos.
async function responderPedidoLibro(ctx, datos, prefijo) {
  // Si el Excel vino sin "Hora del conteo", el corte por hora queda apagado (usa fin del día
  // = modelo por día) → avisar para que no vuelva el bug de la última hora en silencio.
  const avisoHora = datos.horaCargada ? '' :
    '\n⚠️ El Excel no traía la "Hora del conteo" — uso el fin del día (el control fino por hora queda apagado). Agregá la hora en la plantilla para que corte justo.';
  let cuerpo;
  try {
    cuerpo = await textoPedirLibro(datos);
  } catch (e) {
    console.error('No pude armar el pedido del libro (sigo igual):', e.message);
    cuerpo = '2) Ahora mandame el libro diario ("Diario de movimientos" de Sigma) de ese día, como .xlsx.';
  }
  try {
    await ctx.reply(`${prefijo}${avisoHora}\n\n${cuerpo}`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Falló el envío del pedido del libro; reintento en texto plano:', e.message);
    await ctx.reply(`${prefijo}${avisoHora}\n\n2) Mandame el libro diario ("Diario de movimientos") de ese día, como .xlsx.`)
      .catch((e2) => console.error('Tampoco pude enviar el fallback:', e2.message));
  }
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
  const msg = `🔔 <b>Cambio de saldos ya cargados</b> — ${escapeHtml(datos.empresa)}, ${formatoVencimiento(datos.fecha)}\n` +
    `Modificó: ${escapeHtml(quien)}\n\n${detalleCambios(cambios)}`;
  const admins = (await telegramIdsAdmins()).filter((tid) => Number(tid) !== ctx.from.id);
  for (const tid of admins) {
    try { await ctx.telegram.sendMessage(tid, msg, { parse_mode: 'HTML' }); }
    catch (e) { console.error(`No pude avisar al admin ${tid}:`, e.message); }
  }
}

// Paso final: recibido el libro, concilia todo y responde.
//   buffer    el .xlsx que mandó el tesorero, o NULL si eligió usar el libro que ya está cargado.
//   libroMeta metadata de ese libro (solo para dejar la traza de origen en el reporte).
async function conciliarYResponder(ctx, buffer, { libroMeta = null } = {}) {
  const { datos } = ctx.wizard.state.data;
  const u = ctx.state.usuario;
  const empresa = datos.empresa;
  const uid = u ? u.id : null;

  // CON buffer (camino de siempre): se parsea y se guarda. Guardar PRIMERO importa: la ventana
  // se lee de la DB (tesoreria_movimientos), la MISMA fuente y función (movimientosDeRango) que
  // usa el replay del acumulado → el número de hoy y el acumulado de mañana salen del mismo
  // dato, no "de casualidad". El delete-por-día recaptura además correcciones backdateadas.
  //
  // SIN buffer: el tesorero eligió el libro que ya cargó el admin, así que esos movimientos YA
  // están en la tabla. No se vuelve a guardar nada: la conciliación de abajo lee exactamente la
  // misma fuente. Si por lo que sea no hubiera datos en la ventana, el chequeo de más abajo
  // (movsPeriodo vacío) lo corta antes de conciliar contra nada.
  if (buffer) {
    let libro;
    try {
      libro = parsearLibro(buffer);
    } catch (e) {
      if (e instanceof LibroError) { await ctx.reply(e.message); return ctx.scene.leave(); }
      throw e;
    }
    await guardarMovimientos({ empresa, movimientos: libro.movimientos, usuarioId: uid });
  }

  // Ventana POR HORA (conteo anterior, conteo de hoy], por `ingreso`. Sin saldo previo =
  // primer cierre: queda como base (no se concilia).
  const prev = await saldosAnteriores({ fecha: datos.fecha, empresa });
  const movsPeriodo = prev.contadoEn
    ? await movimientosDeRango({ desde: prev.contadoEn, hasta: datos.contadoEn, empresa })
    : [];

  if (prev.contadoEn && movsPeriodo.length === 0) {
    const ventana =
      `entre el conteo anterior (${formatoVencimiento(prev.fecha)} ${horaDe(prev.contadoEn)}) ` +
      `y este (${formatoVencimiento(datos.fecha)} ${horaDe(datos.contadoEn)})`;
    if (buffer) {
      await ctx.reply(
        `El libro no tiene movimientos ${ventana}. ` +
        `¿Exportaste el rango correcto (del ${formatoVencimiento(prev.fecha)} a hoy)?`
      );
      return ctx.scene.leave();
    }
    // Usó el libro cargado y no alcanza: NO se termina el cierre (los saldos ya están guardados
    // y volver a empezar sería tedioso). Se le explica y se queda esperando el Excel.
    await ctx.reply(
      `El libro que tengo cargado no cubre ${ventana}, así que no puedo conciliar todavía.\n\n` +
      `Mandame el "Diario de movimientos" que cubra ese rango y sigo.`
    );
    return;
  }

  const historial = await historialDiferencias({ empresa, hasta: datos.fecha });
  const { filas, texto } = procesarCierre({
    fecha: formatoVencimiento(datos.fecha), empresa,
    saldosAyer: prev.saldos, saldosHoy: datos.saldos, movimientos: movsPeriodo,
    historialDiffs: historial, tipo: 'diario',
  });

  // Persistir la conciliación + auditoría (el libro ya se guardó arriba).
  await guardarConciliacion({ fecha: datos.fecha, empresa, filas, usuarioId: uid });
  const nivel = peorNivel(filas);
  await registrarAuditoria({
    usuarioId: uid, usuarioTxt: (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id)),
    accion: 'cierre_diario', empresa, fecha: datos.fecha, nivel,
    detalle: { cuentas: filas.length, alertas: filas.filter((f) => f.nivel === 'alerta').map((f) => f.cuenta) },
  });

  // Traza de origen: el reporte se reenvía y se mira al día siguiente, y sale idéntico venga
  // del Excel que mandó el tesorero o del libro cargado por el admin. Va acá y NO dentro de
  // formatearCierre porque esa función la comparten /semanal y /mensual.
  await ctx.reply(`${texto}\n\n<i>${escapeHtml(LM.lineaOrigen(libroMeta))}</i>`, { parse_mode: 'HTML' });

  // Si hay 🔴 (acumulado que no se resuelve), avisar a los admins. (El cambio de saldos ya
  // se avisó en el paso 2.) telegram_id viene como string de pg → comparar como Number.
  const enAlerta = filas.filter((f) => f.nivel === 'alerta');
  if (enAlerta.length) {
    const aviso = `🔔 <b>Cierre ${formatoVencimiento(datos.fecha)}</b> — cargó ${escapeHtml(quienEs(ctx))}\n\n` +
      `🔴 Cuentas en alerta (acumulado que no se resuelve):\n` +
      enAlerta.map((f) => `• ${escapeHtml(f.cuenta)}: acum ${fmt(f.acumulado)} ${escapeHtml(f.moneda)}`).join('\n');
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
      '1) Mandame el Excel de "Existencias al cierre" (con la Fecha y la Hora del conteo), como .xlsx.\n' +
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
    await responderPedidoLibro(ctx, datos,
      `✅ Saldos de ${formatoVencimiento(datos.fecha)} guardados (${datos.saldos.length} cuentas).`);
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
    await responderPedidoLibro(ctx, datos,
      `✅ Saldos de ${formatoVencimiento(datos.fecha)} actualizados (les avisé a los administradores).`);
    return ctx.wizard.next(); // -> paso 3 (libro)
  },
  // 3: recibir libro -> conciliar y responder.
  // Acepta el .xlsx (camino de siempre) o que escribas "usar" para tomar el libro que ya cargó
  // el admin con /libro. A propósito NO se detecta el libro solo ni se saltea este paso: es el
  // único momento del flujo donde las fechas del rango te saltan a la vista antes de que el
  // cierre se persista, y ese checkpoint vale más que ahorrarte un mensaje.
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) { await ctx.reply('Cierre cancelado (los saldos ya quedaron guardados).'); return ctx.scene.leave(); }
    const doc = ctx.message && ctx.message.document;

    // --- Sin archivo: puede ser el atajo "usar el libro cargado" ---
    if (!doc) {
      const txt = (ctx.message && typeof ctx.message.text === 'string') ? ctx.message.text.trim() : '';
      if (!/^\/?usar/i.test(txt)) {
        await ctx.reply('Mandame el libro diario como documento .xlsx, escribí "usar" para tomar el que ya está cargado, o "cancelar".');
        return;
      }
      if (ctx.wizard.state.conciliando) return;
      ctx.wizard.state.conciliando = true;
      try {
        const { datos } = ctx.wizard.state.data;
        // El gate se calcula ACÁ y no antes: entre que se cargaron los saldos y este momento
        // pasa tiempo real de usuario, y el libro pudo cargarse (o pisarse) en el medio.
        //
        // Se exigen DOS libros porque la ventana del cierre va del conteo ANTERIOR al de hoy:
        // hace falta la cola de la tarde del día anterior (movimientos posteriores a ese conteo)
        // y el día de hoy hasta el conteo. Con uno solo, la mitad de la ventana queda vacía y el
        // cierre saldría corto culpando a las cuentas. Un mismo export puede cubrir los dos días.
        const prev = await saldosAnteriores({ fecha: datos.fecha, empresa: datos.empresa });
        const libHoy = await conseguirLibro({ modo: 'cubre', fecha: datos.fecha });
        const libPrev = prev.fecha
          ? await conseguirLibro({ modo: 'cubre', fecha: prev.fecha })
          : { ok: true, meta: null }; // primer cierre: no hay día anterior que cubrir

        if (!libHoy.ok || !libPrev.ok) {
          const faltan = [];
          if (!libPrev.ok && prev.fecha) faltan.push(formatoVencimiento(prev.fecha));
          if (!libHoy.ok) faltan.push(formatoVencimiento(datos.fecha));
          const motivo = !libHoy.ok ? libHoy.motivo : libPrev.motivo;
          if (motivo === 'db_caida' || motivo === 'sin_archivo') {
            await ctx.reply(`${LM.textoFallback(motivo)}\n\nO mandame el "Diario de movimientos" y sigo.`);
          } else {
            await ctx.reply(
              `Para conciliar necesito el libro de <b>${faltan.join(' y de ')}</b>, y ` +
              `${faltan.length > 1 ? 'no los tengo' : 'no lo tengo'} cargado${faltan.length > 1 ? 's' : ''}.\n\n` +
              `La ventana del cierre va del conteo del ${prev.fecha ? formatoVencimiento(prev.fecha) : '—'} ` +
              `al de hoy, así que necesito los dos días.\n\n` +
              `Pedile al admin que los cargue (/libro) o mandame el Excel que cubra ese rango y sigo.`,
              { parse_mode: 'HTML' }
            );
          }
          ctx.wizard.state.conciliando = false;
          return; // sigue esperando el archivo
        }

        // Si un solo export cubre los dos días, se nombra una vez sola.
        const mismoLibro = !libPrev.meta || fechaISO(libPrev.meta.fecha) === fechaISO(libHoy.meta.fecha);
        const detalle = mismoLibro
          ? `el libro del <b>${LM.diaLibro(libHoy.meta)}</b> (${LM.describirRango(libHoy.meta)})`
          : `los libros del <b>${LM.diaLibro(libPrev.meta)}</b> y del <b>${LM.diaLibro(libHoy.meta)}</b>`;
        await ctx.reply(`⏳ Usando ${detalle}. Conciliando…`, { parse_mode: 'HTML' });
        return await conciliarYResponder(ctx, null, { libroMeta: libHoy.meta });
      } catch (e) {
        console.error('Error en /cierre (libro cargado):', e.message);
        await ctx.reply('Hubo un problema usando el libro cargado. Mandame el Excel y sigo.');
        ctx.wizard.state.conciliando = false;
        return;
      }
    }

    // --- Con archivo: exactamente como funcionaba antes ---
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
