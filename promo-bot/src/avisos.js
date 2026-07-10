// Avisos de vencimiento.
//  - 1 día antes y el mismo día  -> a los del rol "calidad" (para que lo saquen a tiempo).
//  - ya vencido (una sola vez)   -> al que dio de alta el producto + a los admins.
const { altasParaAviso, marcarAvisoPorVencer, marcarAvisoVencido } = require('./db/compras');
const { telegramIdsPorRol, telegramIdsAdmins } = require('./db/usuarios');
const { parseVencimiento, diasHasta } = require('./lib/fechas');

function itemAlta(a) {
  const lote = a.lote && a.lote !== '-' ? ` — lote ${a.lote}` : '';
  return `• ${a.producto}${lote} — ${a.cantidad} u (vence ${a.vencimiento})`;
}

// Corre el chequeo y manda los avisos. Recibe el objeto `telegram` (bot.telegram o ctx.telegram).
async function revisarVencimientos(telegram) {
  const altas = await altasParaAviso();
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
      let msg = '⚠️ Control de vencimientos\n';
      if (manana.length) msg += `\nVencen MAÑANA:\n${manana.map(itemAlta).join('\n')}\n`;
      if (hoy.length) msg += `\nVencen HOY:\n${hoy.map(itemAlta).join('\n')}\n`;
      for (const tid of calidad) {
        try { await telegram.sendMessage(tid, msg); avisosPorVencer++; }
        catch (e) { console.error(`No pude avisar (por vencer) a ${tid}:`, e.message); }
      }
      await marcarAvisoPorVencer(porVencer.map((a) => a.id));
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
      agregar(a.creador_telegram_id, a); // el que lo dio de alta
      for (const adm of admins) agregar(adm, a); // todos los admins
    }
    for (const [tid, mapa] of porDestinatario) {
      const lista = [...mapa.values()];
      const msg = '🔴 Productos VENCIDOS (siguen en góndola):\n' + lista.map(itemAlta).join('\n');
      try { await telegram.sendMessage(tid, msg); avisosVencido++; }
      catch (e) { console.error(`No pude avisar (vencido) a ${tid}:`, e.message); }
    }
    await marcarAvisoVencido(vencido.map((a) => a.id));
  }

  return { porVencer: porVencer.length, vencido: vencido.length, avisosPorVencer, avisosVencido };
}

// --- Programador: corre una vez por día a la hora indicada ---
const HORA_UTC = Number(process.env.AVISO_HORA_UTC || 12); // 12 UTC = 9:00 hora Argentina

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
  const ms = msHastaProxima();
  console.log(`Avisos de vencimiento programados: próxima corrida en ~${Math.round(ms / 3600000)}h.`);
  setTimeout(correr, ms);
}

module.exports = { revisarVencimientos, iniciarAvisos };
