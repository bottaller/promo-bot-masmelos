// Avisos de vencimiento.
//  - 1 día antes y el mismo día  -> a los del rol "calidad" (para que lo saquen a tiempo).
//  - ya vencido (una sola vez)   -> al que dio de alta el producto + a los admins.
const { altasParaAviso, marcarAvisoPorVencer, marcarAvisoVencido } = require('./db/compras');
const { telegramIdsPorRol, telegramIdsAdmins } = require('./db/usuarios');
const { parseVencimiento, diasHasta, fechaHoyArgISO } = require('./lib/fechas');

const LIMITE_MSG = 3500; // margen bajo el tope de 4096 caracteres de Telegram

function itemAlta(a) {
  const lote = a.lote && a.lote !== '-' ? ` — lote ${a.lote}` : '';
  return `• ${a.producto}${lote} — ${a.cantidad} u (vence ${a.vencimiento})`;
}

// Manda un encabezado + una lista de líneas, partiéndola en varios mensajes si supera el tope
// de Telegram. Devuelve true solo si TODOS los envíos salieron bien (si algo falló, el llamador
// no marca el aviso como entregado y se reintenta en la próxima corrida).
async function enviarLista(telegram, tid, encabezado, lineas) {
  const bloques = [];
  let actual = encabezado;
  for (const linea of lineas) {
    if ((actual + '\n' + linea).length > LIMITE_MSG) {
      bloques.push(actual);
      actual = linea;
    } else {
      actual += '\n' + linea;
    }
  }
  bloques.push(actual);

  let ok = true;
  for (const b of bloques) {
    try { await telegram.sendMessage(tid, b); }
    catch (e) { ok = false; console.error(`No pude avisar a ${tid}:`, e.message); }
  }
  return ok;
}

// Corre el chequeo y manda los avisos. Recibe el objeto `telegram` (bot.telegram o ctx.telegram).
async function revisarVencimientos(telegram) {
  const hoyISO = fechaHoyArgISO();
  const altas = await altasParaAviso(hoyISO);
  const manana = [];
  const hoy = [];
  const vencido = [];

  for (const a of altas) {
    const dias = diasHasta(parseVencimiento(a.vencimiento));
    if (dias === null) continue; // fecha inválida, no se puede calcular
    if (dias === 1 && a.puede_avisar_vencer) manana.push(a);
    else if (dias === 0 && a.puede_avisar_vencer) hoy.push(a);
    else if (dias < 0 && !a.aviso_vencido) vencido.push(a);
  }

  let avisosPorVencer = 0;
  let avisosVencido = 0;

  // --- Por vencer (mañana / hoy) -> rol calidad ---
  const porVencer = [...manana, ...hoy];
  if (porVencer.length > 0) {
    const calidad = await telegramIdsPorRol('calidad');
    if (calidad.length > 0) {
      const lineas = [];
      if (manana.length) { lineas.push('Vencen MAÑANA:'); manana.forEach((a) => lineas.push(itemAlta(a))); }
      if (hoy.length) { lineas.push('Vencen HOY:'); hoy.forEach((a) => lineas.push(itemAlta(a))); }
      let algunoEntregado = false;
      for (const tid of calidad) {
        if (await enviarLista(telegram, tid, '⚠️ Control de vencimientos', lineas)) { avisosPorVencer++; algunoEntregado = true; }
      }
      // Marcamos solo si al menos un destinatario lo recibió; si todos fallaron, se reintenta.
      if (algunoEntregado) await marcarAvisoPorVencer(porVencer.map((a) => a.id), hoyISO);
    }
  }

  // --- Vencidos -> creador de la alta + admins (una sola vez) ---
  if (vencido.length > 0) {
    const admins = await telegramIdsAdmins();
    // Para cada destinatario, junta los productos vencidos que le corresponden (sin repetir).
    const porDestinatario = new Map(); // telegram_id -> Map(altaId -> alta)
    const agregar = (tid, alta) => {
      if (!tid) return;
      if (!porDestinatario.has(tid)) porDestinatario.set(tid, new Map());
      porDestinatario.get(tid).set(alta.id, alta);
    };
    for (const a of vencido) {
      agregar(a.creador_telegram_id, a); // el que lo dio de alta (si sigue activo)
      for (const adm of admins) agregar(adm, a); // todos los admins
    }
    // Solo marcamos como avisada una alta si llegó a AL MENOS un destinatario; el resto se reintenta.
    const entregadas = new Set();
    for (const [tid, mapa] of porDestinatario) {
      const lista = [...mapa.values()];
      const ok = await enviarLista(telegram, tid, '🔴 Productos VENCIDOS (siguen en góndola):', lista.map(itemAlta));
      if (ok) { avisosVencido++; lista.forEach((a) => entregadas.add(a.id)); }
    }
    if (entregadas.size > 0) await marcarAvisoVencido([...entregadas]);
  }

  return { porVencer: porVencer.length, vencido: vencido.length, avisosPorVencer, avisosVencido };
}

// --- Programador: corre una vez por día a la hora indicada ---
const HORA_UTC_RAW = Number(process.env.AVISO_HORA_UTC);
const HORA_UTC = (Number.isInteger(HORA_UTC_RAW) && HORA_UTC_RAW >= 0 && HORA_UTC_RAW <= 23) ? HORA_UTC_RAW : 12; // 12 UTC = 9:00 hora Argentina

function msHastaProxima() {
  const ahora = Date.now();
  const d = new Date();
  let prox = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HORA_UTC, 0, 0);
  if (prox <= ahora) prox += 24 * 3600 * 1000;
  return prox - ahora;
}

function iniciarAvisos(bot) {
  const correr = async () => {
    try {
      const r = await revisarVencimientos(bot.telegram);
      console.log(`Avisos de vencimiento: por vencer ${r.porVencer}, vencidos ${r.vencido}.`);
    } catch (e) {
      console.error('Error en avisos de vencimiento:', e);
    }
    setTimeout(correr, msHastaProxima());
  };

  // Recuperación al iniciar: si el proceso estaba caído cuando debía correr hoy (deploy, crash,
  // mantenimiento), corremos ahora. Es idempotente —los flags de dedup evitan reenvíos— así que
  // no duplica avisos, pero rescata el aviso "vence HOY" que si no se perdería hasta mañana.
  const d = new Date();
  const horaHoy = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HORA_UTC, 0, 0);
  if (Date.now() >= horaHoy) {
    console.log('Avisos de vencimiento: corrida de recuperación al iniciar (ya pasó la hora de hoy).');
    correr();
  } else {
    const ms = msHastaProxima();
    console.log(`Avisos de vencimiento programados: próxima corrida en ~${Math.round(ms / 3600000)}h.`);
    setTimeout(correr, ms);
  }
}

module.exports = { revisarVencimientos, iniciarAvisos };
