// Lectura de la foto de producto+precio que manda Depósito. Solo LEE datos —
// nunca dibuja nada; el precio que termina impreso siempre lo compone
// carteleria-render.js por código a partir de este número, no un modelo generativo.
const Anthropic = require('@anthropic-ai/sdk');

// `precio` es nullable: la foto puede ser solo del producto sin precio visible
// (p.ej. "nuevo ingreso") — el llamador decide si lo necesita o no.
const ESQUEMA_EXTRACCION = {
  type: 'object',
  properties: {
    producto: { type: 'string', description: 'Nombre del producto tal como aparece en la foto, sin el precio' },
    precio: {
      type: ['number', 'null'],
      description: 'Precio final, en pesos, sin símbolo de moneda ni separador de miles (ej: 1999.99). null si la foto no muestra un precio.',
    },
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

// Devuelve { producto, precio } (precio puede ser null si la foto no lo muestra),
// o null si falla la extracción en sí (falta la key, la API no responde, rechaza
// el pedido, no hay producto, etc.) — el llamador debe degradar con gracia, nunca
// dejar el wizard colgado por esto. El llamador decide si el precio es obligatorio
// para el tipo de cartel que está armando.
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
          {
            type: 'text',
            text: 'Es una foto para un cartel de supermercado. Extraé el nombre del producto. Si la foto también muestra un precio final, extraelo; si no hay precio visible (por ejemplo, es solo el producto para un aviso de "nuevo ingreso"), devolvé precio: null.',
          },
        ],
      }],
    });
    if (respuesta.stop_reason === 'refusal') return null;
    const bloqueTexto = respuesta.content.find((b) => b.type === 'text');
    if (!bloqueTexto) return null;
    const datos = JSON.parse(bloqueTexto.text);
    if (!datos.producto) return null;
    const precio = typeof datos.precio === 'number' ? datos.precio : null;
    return { producto: datos.producto, precio };
  } catch (e) {
    console.error('No pude extraer producto/precio con IA:', e.message);
    return null;
  }
}

module.exports = { extraerProductoPrecio, descargarImagenTelegram };
