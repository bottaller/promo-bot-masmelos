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
const { guardarMpConciliacion } = require('./db/mp-conciliacion');
const { telegramIdsPorRol, telegramIdsAdmins } = require('./db/usuarios');
const { formatoVencimiento, fechaISO } = require('./lib/fechas');

// 08:00 en Argentina (UTC-3) = 11:00 UTC. Mismo default que la entrega de cierres.
const HORA_UTC_RAW = Number(process.env.ARQUEO_HORA_UTC);
const HORA_UTC = (Number.isInteger(HORA_UTC_RAW) && HORA_UTC_RAW >= 0 && HORA_UTC_RAW <= 23) ? HORA_UTC_RAW : 11;

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

      // Re-parsear las liquidaciones guardadas (crudas) con el parser de cada plataforma.
      const filas = await liquidacionesDeDia({ fecha: d.fecha, empresa });
      const liquidaciones = [];
      for (const f of filas) {
        const plataforma = porCodigo(f.plataforma);
        if (!plataforma) { console.error(`Arqueo: plataforma desconocida "${f.plataforma}" el ${fechaISO(d.fecha)}.`); continue; }
        try {
          liquidaciones.push({ plataforma, liq: plataforma.parsear(f.archivo) });
        } catch (e) {
          console.error(`Arqueo: no pude parsear la liquidación de ${f.plataforma} del ${fechaISO(d.fecha)}:`, e.message);
        }
      }
      if (!liquidaciones.length) {
        await enviarTexto(telegram, admins, `⚠️ Arqueo del ${formatoVencimiento(d.fecha)}: no pude leer ninguna liquidación. Revisá los archivos.`);
        resumen.error++;
        continue;
      }

      const arq = await arquearDia({ libroBuffer: buf.buffer, libroMeta: lib.meta, liquidaciones, dia: fechaISO(d.fecha) });
      if (!arq.ok) {
        await enviarTexto(telegram, admins, `⚠️ Arqueo del ${formatoVencimiento(d.fecha)}: ${arq.error}`);
        resumen.error++;
        continue;
      }

      // Guardar el resultado SIEMPRE (lo consume el resumen semanal), aunque la entrega falle.
      for (const g of arq.paraGuardar) {
        try {
          await guardarMpConciliacion({ fecha: g.fecha, plataforma: g.plataforma, resultado: g.resultado, fuente: g.fuente, usuarioId: null });
        } catch (e) { console.error(`Arqueo: no pude guardar ${g.plataforma} del ${fechaISO(d.fecha)}:`, e.message); }
      }

      // Entregar: texto + un PDF por plataforma, a los grupos.
      const encabezado = `📊 <b>Arqueo de cobros del ${formatoVencimiento(d.fecha)}</b>`;
      const enviados = await enviarTexto(telegram, dest, `${encabezado}\n\n${arq.texto}`);
      for (const pdf of arq.pdfs) await enviarPdf(telegram, dest, pdf);

      // Solo saco de la espera si el texto llegó a ALGUIEN. Si Telegram estaba caído (enviados=0),
      // se deja pendiente: el resultado ya quedó guardado, pero la ENTREGA se reintenta.
      if (enviados > 0) {
        await borrarLiquidacionesDe({ fecha: d.fecha, empresa });
        resumen.entregados++;
      } else {
        console.error(`Arqueo: concilié el ${formatoVencimiento(d.fecha)} pero no llegó a nadie; queda pendiente.`);
      }
    } catch (e) {
      console.error(`Arqueo: falló el ${formatoVencimiento(d.fecha)} (sigo con los demás):`, e.message);
      resumen.error++;
    }
  }
  return resumen;
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
    }
    setTimeout(correr, msHastaProxima());
  };
  const ms = msHastaProxima();
  console.log(`Entrega de arqueo programada: próxima corrida en ~${Math.round(ms / 3600000)}h.`);
  setTimeout(correr, ms);
}

module.exports = { entregarArqueosPendientes, iniciarEntregaArqueo };
