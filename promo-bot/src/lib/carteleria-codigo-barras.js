// Lee el código de barras (EAN) de la foto que manda Depósito, para identificar el producto
// contra el maestro (bot.articulos, ver db/articulos.js) SIN IA: decodifica local con
// zxing-wasm. El .wasm se carga una sola vez desde node_modules (nunca de un CDN/red), así que
// esto no depende de ningún servicio externo ni tiene costo por uso.
const fs = require('fs');
const path = require('path');
const { prepareZXingModule, readBarcodes } = require('zxing-wasm/reader');

const FORMATOS_SOPORTADOS = ['EAN13', 'EAN8', 'UPCA', 'UPCE'];

let preparado = false;
function asegurarModulo() {
  if (preparado) return;
  const wasmPath = path.join(__dirname, '..', '..', 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm');
  prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(wasmPath).buffer } });
  preparado = true;
}

async function descargarImagenTelegram(telegram, fileId) {
  const url = await telegram.getFileLink(fileId);
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`No pude descargar la foto de Telegram (HTTP ${respuesta.status})`);
  return Buffer.from(await respuesta.arrayBuffer());
}

// Devuelve el texto del código de barras leído de la foto (EAN-13/8, UPC-A/E), o null si no
// encontró ninguno (foto borrosa, mal enfocada, no es un código de barras, etc.) — nunca tira,
// el llamador decide qué hacer (reintentar, cargar a mano).
async function leerCodigoBarras(imagenBuffer) {
  try {
    asegurarModulo();
    const resultados = await readBarcodes(imagenBuffer, {
      formats: FORMATOS_SOPORTADOS,
      tryHarder: true,
      maxNumberOfSymbols: 1,
    });
    return resultados.length ? resultados[0].text : null;
  } catch (e) {
    console.error('No pude leer el código de barras:', e.message);
    return null;
  }
}

module.exports = { leerCodigoBarras, descargarImagenTelegram };
