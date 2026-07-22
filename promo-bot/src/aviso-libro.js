// Recordatorio del LIBRO DIARIO: a las 21:00 (hora Argentina), si nadie cargó el libro de
// la jornada, se les avisa a los admins. La carga es la que alimenta a todos los comandos
// (cierre, semanal, mensual, flujos, mp, arqueo), así que si falta, al día siguiente no
// hay con qué trabajar.
const { cubreFecha, ultimoLibro } = require('./db/libro');
const { telegramIdsAdmins } = require('./db/usuarios');
const { fechaHoyArgISO, formatoVencimiento, parseVencimiento } = require('./lib/fechas');

// Hora del chequeo, en UTC. Default 00:00 UTC = 21:00 Argentina (UTC-3). Para las
// 20:30 Arg poné LIBRO_HORA_UTC=23 y LIBRO_MIN_UTC=30 (23:30 UTC). A esa hora
// `fechaHoyArgISO()` todavía devuelve el día que está terminando, que es justo la
// jornada que hay que chequear.
const HORA_UTC_RAW = Number(process.env.LIBRO_HORA_UTC);
const HORA_UTC = (Number.isInteger(HORA_UTC_RAW) && HORA_UTC_RAW >= 0 && HORA_UTC_RAW <= 23) ? HORA_UTC_RAW : 0;
const MIN_UTC_RAW = Number(process.env.LIBRO_MIN_UTC);
const MIN_UTC = (Number.isInteger(MIN_UTC_RAW) && MIN_UTC_RAW >= 0 && MIN_UTC_RAW <= 59) ? MIN_UTC_RAW : 0;

// Guard en memoria: no repetir el aviso de la misma jornada dentro del mismo proceso.
let ultimaJornadaAvisada = null;

function isoALinda(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

// Chequea la jornada de hoy y avisa si falta. Devuelve { jornada, cargado, avisados }.
async function revisarLibroDelDia(telegram, { empresa = 'HONRE' } = {}) {
  const hoyISO = fechaHoyArgISO();
  const fecha = parseVencimiento(isoALinda(hoyISO));
  // cubreFecha y no hayLibro: si el export cargado abarca varios días e incluye hoy, el día
  // está cubierto aunque su jornada registrada sea otra. Avisar ahí sería un falso positivo.
  const cargado = await cubreFecha({ fecha, empresa });
  if (cargado) return { jornada: hoyISO, cargado: true, avisados: 0 };
  if (ultimaJornadaAvisada === hoyISO) return { jornada: hoyISO, cargado: false, avisados: 0 };

  // Qué fue lo último que sí se cargó — así el admin sabe cuánto hace que viene faltando.
  let cola = '';
  try {
    const ult = await ultimoLibro({ empresa });
    cola = ult
      ? `\n\nEl último que tengo es del ${formatoVencimiento(ult.fecha)} (${ult.filas} movimientos).`
      : '\n\nTodavía no tengo ningún libro cargado.';
  } catch (e) {
    console.error('Aviso del libro: no pude leer el último cargado:', e.message);
  }

  const msg =
    `📚 <b>Falta el libro diario de hoy</b> (${isoALinda(hoyISO)})\n\n` +
    `Sin él, mañana no van a poder correr el cierre, el arqueo ni los controles.\n` +
    `Cargalo con /libro.${cola}`;

  const admins = await telegramIdsAdmins();
  let avisados = 0;
  for (const tid of admins) {
    try { await telegram.sendMessage(tid, msg, { parse_mode: 'HTML' }); avisados++; }
    catch (e) { console.error(`Aviso del libro: no pude avisar a ${tid}:`, e.message); }
  }
  // Solo se marca si llegó a alguien; si fallaron todos, se reintenta en la próxima corrida.
  if (avisados > 0) ultimaJornadaAvisada = hoyISO;
  return { jornada: hoyISO, cargado: false, avisados };
}

function msHastaProxima() {
  const ahora = Date.now();
  const d = new Date();
  let prox = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HORA_UTC, MIN_UTC, 0);
  if (prox <= ahora) prox += 24 * 3600 * 1000;
  return prox - ahora;
}

// A diferencia de los avisos de vencimiento, acá NO hay corrida de recuperación al arrancar:
// el dedup vive en memoria, así que un reinicio (los deploys de Railway son frecuentes)
// volvería a disparar el aviso. Perder el recordatorio de un día es más barato que spamear.
function iniciarAvisoLibro(bot) {
  const correr = async () => {
    try {
      const r = await revisarLibroDelDia(bot.telegram);
      console.log(`Libro diario ${r.jornada}: ${r.cargado ? 'cargado' : `FALTA (avisé a ${r.avisados} admin/s)`}.`);
    } catch (e) {
      console.error('Error en el aviso del libro diario:', e);
    }
    setTimeout(correr, msHastaProxima());
  };
  const ms = msHastaProxima();
  console.log(`Aviso del libro diario programado: próxima corrida en ~${Math.round(ms / 3600000)}h.`);
  setTimeout(correr, ms);
}

module.exports = { revisarLibroDelDia, iniciarAvisoLibro };
