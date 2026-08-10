// Entrega del ARQUEO DE COBROS: a las 08:00 (hora Argentina) un barrido toma cada día que tenga
// liquidaciones en espera (bot.liquidaciones_pendientes, cargadas de noche con /carga), las cruza
// contra el libro de ese día, arma UN PDF por plataforma (MP, Talo) + texto y se los manda a los
// grupos Tesorería + Caja Central. Guarda el resultado (bot.mp_conciliacion → resumen semanal) y
// borra las liquidaciones ya procesadas. Si falta el libro, no procesa y avisa a los admins.
//
// Es la contraparte de arqueo de la entrega de cierres: mismo horario, misma lógica de barrido
// idempotente (lo entregado se borra de la espera; el resultado guardado se pisa al re-correr).
const { diasPendientes, liquidacionesDeDia, borrarLiquidacionesDe } = require('./db/liquidaciones-pendientes');
const { conseguirLibro, bufferLibro } = require('./lib/libro-fuente');
const { porCodigo } = require('./lib/plataformas');
const { arquearDia } = require('./lib/arqueo');
const { guardarMpConciliacion, hayConciliacion } = require('./db/mp-conciliacion');
const { telegramIdsPorRol, telegramIdsAdmins } = require('./db/usuarios');
const { formatoVencimiento, fechaISO, fechaHoyArgISO, sumarDias } = require('./lib/fechas');
const { bajarExtracto } = require('./lib/talo-api');

// 08:00 en Argentina (UTC-3) = 11:00 UTC. Mismo default que la entrega de cierres.
const HORA_UTC_RAW = Number(process.env.ARQUEO_HORA_UTC);
const HORA_UTC = (Number.isInteger(HORA_UTC_RAW) && HORA_UTC_RAW >= 0 && HORA_UTC_RAW <= 23) ? HORA_UTC_RAW : 11;

// 21:00 en Argentina (UTC-3) = 00:00 UTC. El barrido de Talo por API va a la NOCHE (no a la mañana
// como el de arriba): a las 21:00 el día ya cerró y la API tiene el movimiento COMPLETO — a media
// tarde faltaría la cola (lo comprobamos: el Excel del panel bajado 16:00 perdía el resto del día).
// Configurable con TALO_ARQUEO_HORA_UTC.
const TALO_HORA_UTC_RAW = Number(process.env.TALO_ARQUEO_HORA_UTC);
const TALO_HORA_UTC = (Number.isInteger(TALO_HORA_UTC_RAW) && TALO_HORA_UTC_RAW >= 0 && TALO_HORA_UTC_RAW <= 23) ? TALO_HORA_UTC_RAW : 0;

const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isoADate = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d); };
const isoALinda = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Grupos que reciben el arqueo: Tesorería + Caja Central (sin repetir). Decisión del dueño: el
// cierre va a admins, pero el arqueo va a los dos grupos operativos.
async function destinatarios() {
  const [tes, caja] = await Promise.all([telegramIdsPorRol('tesoreria'), telegramIdsPorRol('cajacentral')]);
  return [...new Set([...tes, ...caja].map(String))];
}

async function enviarTexto(telegram, destinatarios, msg) {
  let enviados = 0;
  for (const tid of new Set(destinatarios.map((t) => String(t)))) {
    try { await telegram.sendMessage(tid, msg, { parse_mode: 'HTML' }); enviados++; }
    catch (e) { console.error(`Arqueo: no pude enviar texto a ${tid}:`, e.message); }
  }
  return enviados;
}

async function enviarPdf(telegram, destinatarios, pdf) {
  for (const tid of new Set(destinatarios.map((t) => String(t)))) {
    try { await telegram.sendDocument(tid, { source: pdf.buffer, filename: pdf.filename }); }
    catch (e) { console.error(`Arqueo: no pude enviar el PDF ${pdf.filename} a ${tid}:`, e.message); }
  }
}

// Una pendiente manual de una plataforma que se baja por API (Talo) es REDUNDANTE si ese día ya se
// arqueó (barrido de las 21:00 o la recuperación de las 08:00): no hay que re-arquearla ni
// re-entregarla a los grupos, solo limpiarla. Si la API falló y NO hay conciliación guardada,
// devuelve false y la pendiente se procesa normal (el fallback manual haciendo su trabajo).
// hayConciliacionFn es inyectable para los tests (sin base). Ver el bug de "doble entrega".
async function pendienteYaArqueadaPorApi(plataforma, { fecha, empresa = 'HONRE' }, hayConciliacionFn = hayConciliacion) {
  if (!plataforma || !plataforma.bajaPorApi) return false;
  return !!(await hayConciliacionFn({ fecha, plataforma: plataforma.codigo, empresa }));
}

// Procesa la espera una vez. Devuelve un resumen para el log.
async function entregarArqueosPendientes(telegram, { empresa = 'HONRE' } = {}) {
  const dias = await diasPendientes({ empresa });
  const resumen = { total: dias.length, entregados: 0, sinLibro: 0, error: 0 };
  if (!dias.length) return resumen;

  const admins = await telegramIdsAdmins();
  let dest = await destinatarios();
  // Si nadie tiene rol Tesorería/Caja Central (config incompleta), no perdemos el arqueo:
  // cae a los admins para que al menos alguien lo vea.
  if (!dest.length) { dest = admins.map(String); }

  for (const d of dias) {
    try {
      const lib = await conseguirLibro({ modo: 'cubre', fecha: d.fecha, empresa });
      if (!lib.ok) {
        await enviarTexto(telegram, admins,
          `📚 <b>No pude arquear el ${formatoVencimiento(d.fecha)}</b>: todavía falta el libro. ` +
          'Cargalo con /carga y lo arqueo en la próxima corrida (o mañana a la mañana).');
        resumen.sinLibro++;
        continue; // NO borro las liquidaciones: quedan para la próxima corrida
      }
      const buf = await bufferLibro(lib.meta, { empresa });
      if (!buf.ok) {
        await enviarTexto(telegram, admins,
          `📚 <b>Arqueo del ${formatoVencimiento(d.fecha)}</b>: tengo el libro registrado pero no pude leer el archivo. Avisá al admin.`);
        resumen.sinLibro++;
        continue;
      }

      // Re-parsear las liquidaciones guardadas (crudas) con el parser de cada plataforma. Las que
      // fallen (formato cambiado, código desconocido) NO se pierden: quedan pendientes y se avisa.
      const filas = await liquidacionesDeDia({ fecha: d.fecha, empresa });
      const liquidaciones = [];
      const fallidas = [];
      const yaArqueadas = []; // pendientes manuales de plataformas por API cuyo día ya se arqueó: se limpian sin re-entregar
      for (const f of filas) {
        const plataforma = porCodigo(f.plataforma);
        if (!plataforma) { console.error(`Arqueo: plataforma desconocida "${f.plataforma}" el ${fechaISO(d.fecha)}.`); fallidas.push(f.plataforma); continue; }
        // Talo (bajaPorApi) subida a mano como fallback pero cuyo día YA se arqueó por API: no se
        // re-arquea ni se re-entrega (si no, Tesorería/Caja Central reciben el arqueo dos veces).
        if (await pendienteYaArqueadaPorApi(plataforma, { fecha: d.fecha, empresa })) {
          yaArqueadas.push(plataforma.codigo);
          continue;
        }
        try {
          liquidaciones.push({ plataforma, liq: plataforma.parsear(f.archivo) });
        } catch (e) {
          console.error(`Arqueo: no pude parsear la liquidación de ${f.plataforma} del ${fechaISO(d.fecha)}:`, e.message);
          fallidas.push(f.plataforma);
        }
      }
      // Limpiar las pendientes redundantes (ya arqueadas por API), haya o no algo más que arquear.
      if (yaArqueadas.length) {
        await borrarLiquidacionesDe({ fecha: d.fecha, empresa, plataformas: yaArqueadas });
        console.log(`Arqueo: ${fechaISO(d.fecha)} ${yaArqueadas.join(',')} ya arqueada(s) por API; limpio la pendiente manual sin re-entregar.`);
      }
      // Lo que no se pudo leer queda PENDIENTE (no se borra) y se avisa a los admins para que lo resuban.
      if (fallidas.length) {
        await enviarTexto(telegram, admins,
          `⚠️ <b>Arqueo del ${formatoVencimiento(d.fecha)}</b>: no pude leer la liquidación de <b>${fallidas.join(', ')}</b>. ` +
          'Queda pendiente — revisá el archivo y volvé a subirla con /carga.');
      }
      // Si no quedó nada nuevo que arquear: si solo había redundantes ya limpiadas, no es error.
      if (!liquidaciones.length) { if (!yaArqueadas.length) resumen.error++; continue; }

      const arq = await arquearDia({ libroBuffer: buf.buffer, libroMeta: lib.meta, liquidaciones, dia: fechaISO(d.fecha) });
      if (!arq.ok) {
        await enviarTexto(telegram, admins, `⚠️ Arqueo del ${formatoVencimiento(d.fecha)}: ${arq.error}`);
        resumen.error++;
        continue;
      }

      // Guardar el resultado (lo consume el resumen semanal). Trackeamos cuáles se guardaron OK:
      // SOLO esas se borran después. Un fallo de guardado no frena la entrega, pero deja la
      // liquidación pendiente para reintentar (si no, el día desaparecería del resumen semanal).
      const guardadas = [];
      for (const g of arq.paraGuardar) {
        try {
          await guardarMpConciliacion({ fecha: g.fecha, plataforma: g.plataforma, resultado: g.resultado, fuente: g.fuente, usuarioId: null });
          guardadas.push(g.plataforma);
        } catch (e) { console.error(`Arqueo: no pude guardar ${g.plataforma} del ${fechaISO(d.fecha)}:`, e.message); }
      }

      // Entregar: texto + un PDF por plataforma, a los grupos.
      const encabezado = `📊 <b>Arqueo de cobros del ${formatoVencimiento(d.fecha)}</b>`;
      const enviados = await enviarTexto(telegram, dest, `${encabezado}\n\n${arq.texto}`);
      for (const pdf of arq.pdfs) await enviarPdf(telegram, dest, pdf);

      // Borro SOLO las plataformas ENTREGADAS y GUARDADAS OK. Las que fallaron el parseo (fallidas)
      // o el guardado quedan pendientes para la próxima corrida. Si Telegram estaba caído
      // (enviados=0), no borro nada y se reintenta entero.
      if (enviados > 0 && guardadas.length) {
        await borrarLiquidacionesDe({ fecha: d.fecha, empresa, plataformas: guardadas });
        resumen.entregados++;
      } else if (enviados === 0) {
        console.error(`Arqueo: concilié el ${formatoVencimiento(d.fecha)} pero no llegó a nadie; queda pendiente.`);
      }
    } catch (e) {
      console.error(`Arqueo: falló el ${formatoVencimiento(d.fecha)} (sigo con los demás):`, e.message);
      resumen.error++;
    }
  }
  return resumen;
}

// ---------------------------------------------------------------------------------------------
// Barrido de Talo por API (21:00): baja el extracto del DÍA solo, sin subirlo a mano, y lo arquea.
// Si algo falla, avisa a los ADMINS (decisión del dueño: que se pueda revisar a mano). Va aparte
// del barrido de arriba (que sigue procesando lo que se sube con /carga) para no tocar el flujo de
// MP; por ahora Talo es la única plataforma que se baja sola.
// ---------------------------------------------------------------------------------------------
async function entregarTaloDelDia(telegram, { empresa = 'HONRE', fecha = null } = {}) {
  const admins = (await telegramIdsAdmins()).map(String);
  const avisarAdmins = (msg) => enviarTexto(telegram, admins, msg);
  try {
    if (!process.env.TALO_USER_ID || !process.env.TALO_CLIENT_ID || !process.env.TALO_CLIENT_SECRET) {
      console.log('Arqueo Talo API: sin credenciales TALO_* configuradas; no corro.');
      return { corrio: false, motivo: 'sin_credenciales' };
    }
    const talo = porCodigo('talo');
    if (!talo) { await avisarAdmins('⚠️ Arqueo Talo: no encuentro la plataforma "talo" en el registro. Avisá al admin.'); return { corrio: false, motivo: 'sin_plataforma' }; }

    const dia = fecha || fechaHoyArgISO(); // 'AAAA-MM-DD', hoy en Argentina
    const linda = isoALinda(dia);

    // 1) Bajar el extracto de Talo del día por API.
    let liq;
    try {
      liq = await bajarExtracto({ desde: dia });
    } catch (e) {
      await avisarAdmins(`⚠️ <b>Arqueo Talo del ${linda}</b>: no pude bajar el extracto por API — ${escapeHtml(e.message)}\n\nBajalo a mano del panel y subilo con /carga.`);
      return { corrio: false, motivo: 'api' };
    }
    if (!liq.operaciones.length) {
      await avisarAdmins(`ℹ️ <b>Arqueo Talo del ${linda}</b>: la API no devolvió ningún movimiento. ¿Fue un día sin cobros por Talo?`);
      return { corrio: false, motivo: 'sin_movimientos' };
    }

    // 2) Libro del día (el mismo que usa el resto del arqueo).
    const lib = await conseguirLibro({ modo: 'cubre', fecha: isoADate(dia), empresa });
    if (!lib.ok) {
      await avisarAdmins(`📚 <b>Arqueo Talo del ${linda}</b>: bajé ${liq.operaciones.length} movimiento(s) de Talo pero falta el libro del día. Cargalo con /libro y lo arqueo.`);
      return { corrio: false, motivo: 'sin_libro' };
    }
    const buf = await bufferLibro(lib.meta, { empresa });
    if (!buf.ok) {
      await avisarAdmins(`📚 <b>Arqueo Talo del ${linda}</b>: tengo el libro registrado pero no pude leer el archivo. Avisá al admin.`);
      return { corrio: false, motivo: 'libro_ilegible' };
    }

    // 3) Arquear (solo Talo, contra su cuenta).
    const arq = await arquearDia({ libroBuffer: buf.buffer, libroMeta: lib.meta, liquidaciones: [{ plataforma: talo, liq }], dia });
    if (!arq.ok) {
      await avisarAdmins(`⚠️ <b>Arqueo Talo del ${linda}</b>: ${escapeHtml(arq.error)}`);
      return { corrio: false, motivo: 'arqueo' };
    }

    // 4) Guardar el resultado (lo consume el resumen semanal). Un fallo de guardado no frena la entrega.
    for (const g of arq.paraGuardar) {
      try { await guardarMpConciliacion({ fecha: g.fecha, plataforma: g.plataforma, resultado: g.resultado, fuente: 'talo-api', usuarioId: null }); }
      catch (e) { console.error(`Arqueo Talo API: no pude guardar ${g.plataforma} del ${dia}:`, e.message); }
    }

    // 5) Entregar a los grupos (Tesorería + Caja Central; si no hay ninguno, a los admins).
    let dest = await destinatarios();
    if (!dest.length) dest = admins;
    const enviados = await enviarTexto(telegram, dest, `📊 <b>Arqueo de cobros Talo del ${linda}</b> <i>(bajado por API)</i>\n\n${arq.texto}`);
    for (const pdf of arq.pdfs) await enviarPdf(telegram, dest, pdf);

    if (enviados === 0) {
      await avisarAdmins(`⚠️ Arqueo Talo del ${linda}: lo concilié pero no le llegó a nadie de Tesorería/Caja Central. Revisá los grupos.`);
      return { corrio: false, motivo: 'sin_destinatarios' };
    }
    console.log(`Arqueo Talo API del ${dia}: entregado a ${enviados} destinatario(s).`);
    return { corrio: true, enviados, dia };
  } catch (e) {
    // Cualquier error inesperado -> aviso a los admins (lo pidió el dueño), y queda logueado.
    console.error('Arqueo Talo API: error inesperado:', e);
    try { await avisarAdmins(`❌ <b>El arqueo automático de Talo (21:00) falló</b>: ${escapeHtml(e.message)}\n\nRevisalo cuando puedas.`); } catch (_) { /* ya está logueado */ }
    return { corrio: false, motivo: 'error' };
  }
}

// ---------------------------------------------------------------------------------------------
// Red de respaldo del arqueo de Talo. El barrido de las 21:00 hace UN SOLO intento: si a esa hora
// el libro del día todavía no estaba cargado (p. ej. se cargó a las 22:00) o el bot estaba
// reiniciándose, Talo de ese día queda sin arquear y NO se reintenta —el barrido de las 08:00 solo
// procesa lo que se sube a mano con /carga, y Talo ya no se sube a mano—. Esta corrida, enganchada
// al barrido de las 08:00 (cuando el libro seguro ya está), detecta el hueco y lo arquea. Si aún no
// se puede (sigue sin libro, API caída), entregarTaloDelDia ya le avisa a los admins para que lo
// suban a mano. Idempotente: si el día ya tiene conciliación guardada NO hace nada, así no
// re-entrega lo que el barrido de las 21:00 ya mandó.
async function recuperarTaloRezagado(telegram, {
  empresa = 'HONRE',
  dia = null, // día a recuperar (ISO 'AAAA-MM-DD'); si no se pasa, es AYER (hoyIso - 1)
  hoyIso = fechaHoyArgISO(), // 'AAAA-MM-DD' de hoy en Argentina (fechaHoyArg() devuelve string DD/MM, no Date)
  hayConciliacionFn = hayConciliacion, // inyectables para los tests (sin base ni Telegram)
  entregarFn = entregarTaloDelDia,
} = {}) {
  if (!dia) {
    const [y, m, d] = hoyIso.split('-').map(Number);
    dia = fechaISO(sumarDias(new Date(y, m - 1, d), -1)); // el día que acaba de cerrar
  }
  try {
    if (await hayConciliacionFn({ fecha: dia, plataforma: 'talo', empresa })) {
      return { recuperado: false, motivo: 'ya_estaba', dia };
    }
    console.log(`Arqueo Talo: el ${dia} no quedó arqueado; reintento ahora (red de respaldo 08:00).`);
    const r = await entregarFn(telegram, { empresa, fecha: dia });
    return { recuperado: !!r.corrio, motivo: r.corrio ? 'recuperado' : (r.motivo || 'no_pudo'), dia };
  } catch (e) {
    console.error(`Arqueo Talo: falló la recuperación del ${dia}:`, e.message);
    return { recuperado: false, motivo: 'error', dia };
  }
}

// Red de respaldo AMPLIADA: revisa los últimos `dias` días (no solo ayer). Cubre el caso de un libro
// cargado con 2+ días de atraso —p.ej. el del fin de semana cargado el domingo/lunes—: cada día que
// quedó sin arquear se recupera recién cuando su libro ya está. Idempotente por día (los que ya
// tienen conciliación se saltean). Configurable con TALO_RECUPERAR_DIAS (default 3). Un resultado
// por día. hayConciliacionFn/entregarFn se propagan para los tests.
async function recuperarTaloRezagados(telegram, {
  empresa = 'HONRE',
  hoyIso = fechaHoyArgISO(),
  dias = Number(process.env.TALO_RECUPERAR_DIAS) || 3,
  hayConciliacionFn = hayConciliacion,
  entregarFn = entregarTaloDelDia,
} = {}) {
  const [y, m, d] = hoyIso.split('-').map(Number);
  const resultados = [];
  for (let i = 1; i <= dias; i++) {
    const dia = fechaISO(sumarDias(new Date(y, m - 1, d), -i));
    resultados.push(await recuperarTaloRezagado(telegram, { empresa, dia, hayConciliacionFn, entregarFn }));
  }
  return resultados;
}

// ms hasta la próxima vez que sean las `horaUtc`:00 UTC (para agendar un barrido diario a esa hora).
function msHastaLasUtc(horaUtc) {
  const ahora = Date.now();
  const d = new Date();
  let prox = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), horaUtc, 0, 0);
  if (prox <= ahora) prox += 24 * 3600 * 1000;
  return prox - ahora;
}

function msHastaProxima() {
  const ahora = Date.now();
  const d = new Date();
  let prox = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HORA_UTC, 0, 0);
  if (prox <= ahora) prox += 24 * 3600 * 1000;
  return prox - ahora;
}

// Igual que la entrega de cierres: sin corrida de recuperación al arrancar (los deploys de
// Railway son frecuentes; disparar a media mañana mandaría reportes a destiempo). El barrido es
// idempotente, así que esperar a la próxima corrida de las 08:00 no pierde nada.
function iniciarEntregaArqueo(bot) {
  const correr = async () => {
    try {
      const r = await entregarArqueosPendientes(bot.telegram);
      console.log(`Arqueo de cobros: ${r.entregados} entregado/s, ${r.sinLibro} sin libro, ${r.error} con error (de ${r.total}).`);
    } catch (e) {
      console.error('Error en la entrega de arqueos:', e);
      require('./notificar').avisarProblema({ proceso: 'arqueo de MP/Talo (08:00)', que: 'El barrido de arqueo falló.', detalle: e && e.message, nivel: '❌' }).catch(() => {});
    }
    // Red de respaldo de Talo: si el barrido de las 21:00 no dejó arqueado alguno de los últimos
    // días (libro cargado tarde —hasta el finde cargado el lunes—, o el bot reiniciado), reintentar
    // ahora que el libro seguro está. Revisa varios días atrás, no solo ayer.
    try {
      const rs = await recuperarTaloRezagados(bot.telegram);
      for (const t of rs) {
        if (t.motivo !== 'ya_estaba') {
          console.log(`Arqueo Talo (respaldo 08:00): ${t.dia} -> ${t.recuperado ? 'recuperado' : `no se pudo (${t.motivo})`}.`);
        }
      }
    } catch (e) {
      console.error('Arqueo Talo (respaldo 08:00): error inesperado:', e.message);
    }
    setTimeout(correr, msHastaProxima());
  };
  const ms = msHastaProxima();
  console.log(`Entrega de arqueo programada: próxima corrida en ~${Math.round(ms / 3600000)}h.`);
  setTimeout(correr, ms);
}

// Igual que el barrido de arriba pero a las 21:00 y SOLO para Talo por API. Sin corrida al arrancar
// (los deploys de Railway son frecuentes; disparar a media mañana mandaría un reporte a destiempo);
// la falla, si la hay, ya la avisa entregarTaloDelDia a los admins.
function iniciarEntregaTaloApi(bot) {
  const correr = async () => {
    try {
      const r = await entregarTaloDelDia(bot.telegram);
      console.log(`Arqueo Talo API (21:00): ${r.corrio ? `entregado (${r.enviados} dest.)` : `no corrió (${r.motivo})`}.`);
    } catch (e) {
      console.error('Error en la entrega del arqueo Talo API:', e);
    }
    setTimeout(correr, msHastaLasUtc(TALO_HORA_UTC));
  };
  const ms = msHastaLasUtc(TALO_HORA_UTC);
  console.log(`Entrega de arqueo Talo (API) programada: próxima corrida en ~${Math.round(ms / 3600000)}h.`);
  setTimeout(correr, ms);
}

module.exports = { entregarArqueosPendientes, pendienteYaArqueadaPorApi, iniciarEntregaArqueo, entregarTaloDelDia, recuperarTaloRezagado, recuperarTaloRezagados, iniciarEntregaTaloApi };
