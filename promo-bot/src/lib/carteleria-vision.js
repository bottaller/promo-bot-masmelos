// Lectura de la foto de producto+precio que manda Depósito. Solo LEE datos —
// nunca dibuja nada; el precio que termina impreso siempre lo compone
// carteleria-render.js por código a partir de este número, no un modelo generativo.
const Anthropic = require('@anthropic-ai/sdk');

const ESQUEMA_EXTRACCION = {
  type: 'object',
  properties: {
    producto: { type: 'string', description: 'Nombre del producto tal como aparece en la foto, sin el precio' },
    precio: { type: 'number', description: 'Precio final, en pesos, sin símbolo de moneda ni separador de miles (ej: 1999.99)' },
  },
  required: ['producto', 'precio'],
  additionalProperties: false,
};

async function descargarImagenTelegram(telegram, fileId) {
  const url = await telegram.getFileLink(fileId);
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`No pude descargar la foto de Telegram (HTTP ${respuesta.status})`);
  return Buffer.from(await respuesta.arrayBuffer());
}

// Devuelve { producto, precio } o null si falla (falta la key, la API no
// responde, rechaza el pedido, etc.) — el llamador debe degradar con gracia,
// nunca dejar el wizard colgado por esto.
async function extraerProductoPrecio(imagenBuffer) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const respuesta = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 512,
      // Extracción simple sin herramientas: no hace falta thinking, effort bajo
      // alcanza y sale más rápido/barato.
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA_EXTRACCION } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagenBuffer.toString('base64') } },
          { type: 'text', text: 'Es una foto de un producto con su precio para un cartel de supermercado. Extraé el nombre del producto y el precio final.' },
        ],
      }],
    });
    if (respuesta.stop_reason === 'refusal') return null;
    const bloqueTexto = respuesta.content.find((b) => b.type === 'text');
    if (!bloqueTexto) return null;
    const datos = JSON.parse(bloqueTexto.text);
    if (!datos.producto || typeof datos.precio !== 'number') return null;
    return { producto: datos.producto, precio: datos.precio };
  } catch (e) {
    console.error('No pude extraer producto/precio con IA:', e.message);
    return null;
  }
}

module.exports = { extraerProductoPrecio, descargarImagenTelegram };
