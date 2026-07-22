// Entrega de CIERRES PENDIENTES: a las 08:00 (hora Argentina) un barrido toma cada cierre
// cuyos saldos ya se cargaron (lista de espera bot.cierres_pendientes), lo concilia contra el
// libro que se haya cargado de noche y le entrega el reporte al tesorero que lo cargó + a los
// admins. Si de un cierre todavía falta el libro, no lo entrega y avisa a los admins.
//
// Es la segunda mitad del "cierre en dos tiempos": el tesorero carga saldos de tarde (/cierre),
// el admin carga el libro de noche (/libro), y esto cierra el círculo a la mañana siguiente.
const { cierresPendientes, borrarCierrePendiente } = require('./db/cierres-pendientes');
const { completarCierre } = require('./lib/completar-cierre');
const { telegramIdsAdmins } = require('./db/usuarios');
const LM = require('./lib/libro-mensajes');
const { formatoVencimiento } = require('./lib/fechas');

// 08:00 en Argentina (UTC-3) = 11:00 UTC. Configurable por si cambia el horario de entrega.
const HORA_UTC_RAW = Number(process.env.CIERRE_HORA_UTC);
const HORA_UTC = (Number.isInteger(HORA_UTC_RAW) && HORA_UTC_RAW >= 0 && HORA_UTC_RAW <= 23) ? HORA_UTC_RAW : 11;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Manda un mensaje HTML a una lista de destinatarios (dedup), tolerando que alguno falle.
async function enviarA(telegram, destinatarios, msg) {
  let enviados = 0;
  for (const tid of new Set(destinatarios.map((t) => String(t)))) {
    try { await telegram.sendMessage(tid, msg, { parse_mode: 'HTML' }); enviados++; }
    catch (e) { console.error(`Entrega de cierres: no pude enviar a ${tid}:`, e.message); }
  }
  return enviados;
}

// Procesa la lista de espera una vez. Devuelve un resumen para el log.
async function entregarCierresPendientes(telegram, { empresa = 'HONRE' } = {}) {
  const pendientes = await cierresPendientes({ empresa });
  const resumen = { total: pendientes.length, entregados: 0, sinLibro: 0, base: 0 };
  if (!pendientes.length) return resumen;

  const admins = await telegramIdsAdmins();

  for (const p of pendientes) {
    // TODO el procesamiento de un cierre va dentro del try: si uno rompe (completar, envío o
    // borrado), se loguea y se sigue con los demás — nunca frena el barrido entero.
    try {
      const res = await completarCierre({ empresa, fecha: p.fecha, usuarioId: p.usuario_id, usuarioTxt: p.usuario_txt });

      if (res.estado === 'ok') {
        const encabezado = `📋 <b>Cierre del ${formatoVencimiento(p.fecha)}</b>`;
        const origen = `<i>${escapeHtml(LM.lineaOrigen(res.libroMeta))}</i>`;
        // El reporte (res.texto) ya viene en HTML y marca las cuentas en 🔴. Va completo al
        // tesorero y a los admins: "todo junto a la mañana".
        const enviados = await enviarA(telegram, [p.telegram_id, ...admins], `${encabezado}\n\n${res.texto}\n\n${origen}`);
        // Solo se saca de la espera si llegó a ALGUIEN. Si Telegram estaba caído (enviados=0), se
        // deja pendiente y se reintenta: la conciliación ya quedó persistida, así que no se pierde
        // el dato, pero la ENTREGA sí hay que repetirla.
        if (enviados > 0) {
          await borrarCierrePendiente({ fecha: p.fecha, empresa });
          resumen.entregados++;
        } else {
          console.error(`Entrega de cierres: concilié el ${formatoVencimiento(p.fecha)} pero no llegó a nadie; queda pendiente.`);
        }
      } else if (res.estado === 'base') {
        // Primer cierre sin día anterior: no hay nada que conciliar. Se saca de la espera.
        await borrarCierrePendiente({ fecha: p.fecha, empresa });
        resumen.base++;
      } else if (res.estado === 'sin_libro') {
        // Todavía falta el libro: NO se entrega y se avisa a los admins para que lo carguen.
        const faltan = res.faltan.map((f) => formatoVencimiento(f)).join(' y del ');
        const aviso =
          `📚 <b>El cierre del ${formatoVencimiento(p.fecha)} sigue sin libro</b>\n\n` +
          `Me falta el libro del ${faltan} para conciliarlo. Cargalo con /libro y lo entrego ` +
          `en la próxima corrida (o mañana a la mañana).`;
        await enviarA(telegram, admins, aviso);
        resumen.sinLibro++;
      }
    } catch (e) {
      console.error(`Entrega de cierres: falló el ${formatoVencimiento(p.fecha)} (sigo con los demás):`, e.message);
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

// Igual que el aviso del libro: sin corrida de recuperación al arrancar. El barrido es idempotente
// (los entregados se borran de la espera), pero disparar la entrega en cada deploy de Railway
// mandaría reportes a media mañana; mejor esperar a la próxima corrida de las 08:00.
function iniciarEntregaCierres(bot) {
  const correr = async () => {
    try {
      const r = await entregarCierresPendientes(bot.telegram);
      console.log(`Entrega de cierres: ${r.entregados} entregado/s, ${r.sinLibro} sin libro, ${r.base} base (de ${r.total}).`);
    } catch (e) {
      console.error('Error en la entrega de cierres:', e);
    }
    setTimeout(correr, msHastaProxima());
  };
  const ms = msHastaProxima();
  console.log(`Entrega de cierres programada: próxima corrida en ~${Math.round(ms / 3600000)}h.`);
  setTimeout(correr, ms);
}

module.exports = { entregarCierresPendientes, iniciarEntregaCierres };
