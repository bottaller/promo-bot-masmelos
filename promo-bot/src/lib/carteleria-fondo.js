// Recorte de fondo de la foto de producto (@imgly/background-removal-node — corre
// local vía ONNX, sin API externa ni Python). Devuelve un PNG con transparencia
// para que en el cartel se vea solo el producto sobre el fondo de la plantilla.
//
// Es best-effort: si falla o tarda demasiado, se usa la foto tal cual la mandó
// Depósito (con fondo) en vez de romper el flujo — nunca debe colgar el wizard.
const { removeBackground } = require('@imgly/background-removal-node');

const TIMEOUT_MS = 30_000;

// Devuelve un Buffer PNG sin fondo, o el mismo `imagenBuffer` sin tocar si falla
// o se pasa del tiempo límite.
async function quitarFondo(imagenBuffer, mimeType = 'image/jpeg') {
  try {
    const blob = new Blob([imagenBuffer], { type: mimeType });
    const resultado = await Promise.race([
      removeBackground(blob),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
    return Buffer.from(await resultado.arrayBuffer());
  } catch (e) {
    console.error('No pude recortar el fondo de la foto, uso la original:', e.message);
    return imagenBuffer;
  }
}

module.exports = { quitarFondo };
