// Guarda por un rato las planillas que fallaron, para poder reintentarlas con un
// botón desde el aviso de Telegram.
//
// POR QUÉ EN MEMORIA Y NO EN LA BASE. Es un archivo de ~100 KB que solo sirve
// durante los minutos siguientes al aviso: guardarlo en Postgres significaría una
// tabla nueva, una migración a mano y basura acumulándose para siempre. Si el bot
// se reinicia entremedio, el botón lo dice y queda el camino de siempre (/carga
// con el adjunto que ya está en el chat), que es exactamente lo mismo.
//
// El tope de piezas existe porque esto es memoria de un contenedor chico: sin él,
// una planilla rota reintentándose cada 4 minutos lo llena en un día.
const MAX_PIEZAS = 5;
const VIDA_MS = 24 * 60 * 60 * 1000;

const piezas = new Map(); // id -> { buffer, nombre, en }
let contador = 0;

function limpiar(ahora = Date.now()) {
  for (const [id, p] of piezas) {
    if (ahora - p.en.getTime() > VIDA_MS) piezas.delete(id);
  }
  // Las más viejas primero: Map itera en orden de inserción.
  while (piezas.size > MAX_PIEZAS) piezas.delete(piezas.keys().next().value);
}

/**
 * Guarda una planilla que falló y devuelve un id corto.
 * Corto porque viaja en el callback_data de un botón de Telegram, que tiene un
 * tope de 64 bytes: un file_id de Telegram no entra.
 */
function guardar(buffer, nombre) {
  if (!buffer || !buffer.length) return null;
  contador += 1;
  const id = `${contador.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  piezas.set(id, { buffer, nombre: nombre || 'planilla.xlsx', en: new Date() });
  limpiar();
  return id;
}

/** La planilla guardada, o null si ya no está (reinicio del bot, o pasó un día). */
function tomar(id) {
  limpiar();
  return piezas.get(String(id)) || null;
}

function _reset() { piezas.clear(); contador = 0; }
function _cantidad() { return piezas.size; }

module.exports = { guardar, tomar, MAX_PIEZAS, VIDA_MS, _reset, _cantidad };
