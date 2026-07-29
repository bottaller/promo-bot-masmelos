// Composición del cartel final: plantilla + texto (producto, precio, vencimiento)
// + foto del producto, todo por código con sharp. El precio y el nombre NUNCA los
// dibuja un modelo generativo — así el valor impreso siempre es exacto.
const sharp = require('sharp');
const { plantillaPara } = require('./carteleria-plantillas');

// Gráfica cigüeña = mismo diseño que cartel simple, al doble de tamaño de canvas.
const ESCALA_CIGUENA = 2;

function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// $1.999 -> { entero: "1.999", decimales: "99" }. `precio` siempre viene con 2
// decimales aunque sean $0 (p.ej. $500 -> entero "500", decimales "00").
function formatearPrecio(precio) {
  const numero = Number(precio);
  const entero = Math.trunc(numero);
  const decimales = Math.round((numero - entero) * 100);
  return {
    entero: entero.toLocaleString('es-AR'),
    decimales: String(Math.abs(decimales)).padStart(2, '0'),
  };
}

// 'YYYY-MM-DD' (recién parseado en el wizard) o Date (columna `date` ya leída de la
// DB, "pg" la devuelve como Date de medianoche LOCAL) -> "D/M/YY", igual al formato
// que ya usan las plantillas a mano ("VTO: 7/8/26"). Usamos los getters UTC porque
// la empresa opera en Argentina (UTC-3): medianoche local siempre cae en el mismo
// día calendario en UTC, así que no hay corrimiento de fecha.
function formatearVencimiento(vencimiento) {
  const fecha = vencimiento instanceof Date ? vencimiento : new Date(`${vencimiento}T00:00:00Z`);
  const dia = fecha.getUTCDate();
  const mes = fecha.getUTCMonth() + 1;
  const anio = String(fecha.getUTCFullYear()).slice(-2);
  return `${dia}/${mes}/${anio}`;
}

// Corta el nombre del producto en hasta 2 líneas. Heurística simple por cantidad
// de caracteres (no hay medición real de ancho de fuente); si no entra, se corta.
function envolverNombre(producto, maxCaracteresPorLinea) {
  const palabras = String(producto).toUpperCase().trim().split(/\s+/);
  let linea1 = '';
  let linea2 = '';
  for (const palabra of palabras) {
    const candidata = linea1 ? `${linea1} ${palabra}` : palabra;
    if (candidata.length <= maxCaracteresPorLinea || !linea1) {
      linea1 = candidata;
    } else {
      linea2 = linea2 ? `${linea2} ${palabra}` : palabra;
    }
  }
  if (linea2.length > maxCaracteresPorLinea) {
    linea2 = linea2.slice(0, maxCaracteresPorLinea - 1).trimEnd() + '…';
  }
  return [linea1, linea2];
}

// Sharp/librsvg no mide texto real, así que estimamos el ancho por caracter
// (fuente bold condensada ~0.6x el tamaño de fuente) para que nunca se desborde
// del campo, sin importar qué tan largo sea el nombre del producto o el precio.
const ANCHO_PROMEDIO_GLIFO = 0.95;

function tamanioAjustado(texto, ancho, alto, factorAlto) {
  const porAlto = alto * (factorAlto || 0.85);
  const porAncho = ancho / (Math.max(String(texto).length, 1) * ANCHO_PROMEDIO_GLIFO);
  return Math.min(porAlto, porAncho);
}

function campoRect(campo, ancho, alto) {
  return {
    x: campo.x * ancho,
    y: campo.y * alto,
    ancho: campo.ancho * ancho,
    alto: campo.alto * alto,
  };
}

function textoSvg({ x, y, ancho, alto, texto, align, tamanioFuente, color, pesoFuente }) {
  const anchorX = align === 'center' ? x + ancho / 2 : x;
  const textAnchor = align === 'center' ? 'middle' : 'start';
  const yCentrado = y + alto / 2 + tamanioFuente * 0.3; // aproximación de centrado vertical
  return `<text x="${anchorX}" y="${yCentrado}" font-family="Arial, Helvetica, sans-serif" ` +
    `font-weight="${pesoFuente || 900}" font-size="${tamanioFuente}" fill="${color}" ` +
    `text-anchor="${textAnchor}">${escaparXml(texto)}</text>`;
}

/**
 * Genera el cartel final.
 * @param {object} datos
 * @param {'a4'|'a4_color'|'cartel_simple'|'ciguena'} datos.tipoGrafica
 * @param {'corto_vencimiento'|'politica'|'precio_piso'} datos.tipoPrecio
 * @param {string} datos.producto
 * @param {number} datos.precio
 * @param {string|null} datos.vencimiento - 'YYYY-MM-DD' o null
 * @param {Buffer|null} datos.imagenProductoBuffer - foto del producto ya descargada, o null
 * @returns {Promise<Buffer>} JPEG del cartel final
 */
async function generarCartel({ tipoGrafica, tipoPrecio, producto, precio, vencimiento, imagenProductoBuffer }) {
  const plantilla = plantillaPara(tipoGrafica, tipoPrecio);
  const escala = tipoGrafica === 'ciguena' ? ESCALA_CIGUENA : 1;
  const anchoFinal = Math.round(plantilla.ancho * escala);
  const altoFinal = Math.round(plantilla.alto * escala);

  const capas = [];

  // Foto del producto (si hay campo definido en la plantilla y se pasó imagen)
  if (plantilla.campos.imagenProducto && imagenProductoBuffer) {
    const rect = campoRect(plantilla.campos.imagenProducto, anchoFinal, altoFinal);
    const imagenRedimensionada = await sharp(imagenProductoBuffer)
      .resize(Math.round(rect.ancho), Math.round(rect.alto), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();
    capas.push({ input: imagenRedimensionada, left: Math.round(rect.x), top: Math.round(rect.y) });
  }

  // Texto (precio, nombre, vencimiento) en un solo overlay SVG
  const { entero, decimales } = formatearPrecio(precio);
  const campoPrecio = campoRect(plantilla.campos.precio, anchoFinal, altoFinal);
  const tamanioPrecio = tamanioAjustado(entero, campoPrecio.ancho * 0.78, campoPrecio.alto, 0.85);
  const tamanioDecimales = tamanioPrecio * 0.4;

  const elementosSvg = [];
  elementosSvg.push(textoSvg({
    ...campoPrecio, texto: entero, align: plantilla.campos.precio.align,
    tamanioFuente: tamanioPrecio, color: '#1a1a1a',
  }));
  // Decimales, más chicos, pegados a la derecha del entero
  const xDecimales = campoPrecio.x + (plantilla.campos.precio.align === 'center' ? campoPrecio.ancho / 2 : 0) + tamanioPrecio * entero.length * 0.62;
  elementosSvg.push(`<text x="${xDecimales}" y="${campoPrecio.y + campoPrecio.alto * 0.42}" ` +
    `font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${tamanioDecimales}" ` +
    `fill="#1a1a1a">${decimales}</text>`);

  const maxCaracteresNombre = tipoGrafica === 'a4' || tipoGrafica === 'a4_color'
    ? (tipoPrecio === 'corto_vencimiento' ? 26 : 30)
    : 40;
  const [nombreLinea1, nombreLinea2] = envolverNombre(producto, maxCaracteresNombre);
  const colorNombre = plantilla.campos.colorNombre || '#ffffff';
  const campoLinea1 = campoRect(plantilla.campos.nombreLinea1, anchoFinal, altoFinal);
  elementosSvg.push(textoSvg({
    ...campoLinea1, texto: nombreLinea1, align: plantilla.campos.nombreLinea1.align,
    tamanioFuente: tamanioAjustado(nombreLinea1, campoLinea1.ancho, campoLinea1.alto, 0.85), color: colorNombre,
  }));
  if (nombreLinea2 && plantilla.campos.nombreLinea2) {
    const campoLinea2 = campoRect(plantilla.campos.nombreLinea2, anchoFinal, altoFinal);
    elementosSvg.push(textoSvg({
      ...campoLinea2, texto: nombreLinea2, align: plantilla.campos.nombreLinea2.align,
      tamanioFuente: tamanioAjustado(nombreLinea2, campoLinea2.ancho, campoLinea2.alto, 0.85), color: colorNombre,
    }));
  }

  if (vencimiento && plantilla.campos.vencimiento) {
    const campoVto = campoRect(plantilla.campos.vencimiento, anchoFinal, altoFinal);
    elementosSvg.push(textoSvg({
      ...campoVto, texto: `VTO: ${formatearVencimiento(vencimiento)}`, align: 'left',
      tamanioFuente: campoVto.alto * 0.9, color: '#1a1a1a', pesoFuente: 700,
    }));
  }

  const svg = `<svg width="${anchoFinal}" height="${altoFinal}" xmlns="http://www.w3.org/2000/svg">${elementosSvg.join('')}</svg>`;
  capas.push({ input: Buffer.from(svg), left: 0, top: 0 });

  return sharp(plantilla.archivo)
    .resize(anchoFinal, altoFinal)
    .composite(capas)
    .jpeg({ quality: 92 })
    .toBuffer();
}

module.exports = { generarCartel, formatearPrecio, formatearVencimiento, envolverNombre };
