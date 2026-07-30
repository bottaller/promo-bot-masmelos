// Composición del cartel final con satori (layout tipo HTML/flexbox, mide el texto de
// verdad — sin heurísticas de ancho de letra) + sharp (rasteriza el SVG final a JPEG).
// El precio y el nombre NUNCA los dibuja un modelo generativo — así el valor impreso
// siempre es exacto.
const fs = require('fs');
const path = require('path');
const satori = require('satori').default;
const sharp = require('sharp');
const opentype = require('@shuding/opentype.js');
const { plantillaPara } = require('./carteleria-plantillas');

// Gráfica cigüeña = mismo diseño que cartel simple, al doble de tamaño de canvas.
const ESCALA_CIGUENA = 2;

// El subset "latin" (U+0000-00FF) trae el alfabeto básico + acentos/ñ en español.
// "latin-ext" es solo para otros idiomas (checo, polaco, etc.) — NO tiene ni A-Z ni 0-9.
const RUTA_FUENTE = path.join(
  __dirname, '..', '..', 'node_modules', '@fontsource', 'anton', 'files', 'anton-latin-400-normal.woff'
);
let fuenteCache = null;
function fuente() {
  if (!fuenteCache) fuenteCache = fs.readFileSync(RUTA_FUENTE);
  return fuenteCache;
}

// Fuente ya parseada, para medir ancho real de texto (satori no expone una API de
// medición propia — usamos la misma librería que usa por dentro, @shuding/opentype.js).
let fuenteParseadaCache = null;
function fuenteParseada() {
  if (!fuenteParseadaCache) {
    const buf = fuente();
    fuenteParseadaCache = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return fuenteParseadaCache;
}

// Reparte `texto` en 2 líneas BALANCEADAS (no amontona todo en la línea 1 dejando
// la línea 2 vacía y el bloque apretado) — probamos cada punto de corte posible y
// nos quedamos con el que minimiza el ancho de la línea más ancha de las dos,
// midiendo con el ancho real de cada palabra (no una heurística). Si ni el mejor
// balance entra en `anchoMax`, se recorta con "…" — nunca se desborda la plantilla.
function partirEnLineas(texto, tamanioFuente, anchoMax) {
  const font = fuenteParseada();
  const anchoDe = (t) => font.getAdvanceWidth(t, tamanioFuente);
  const palabras = String(texto).toUpperCase().trim().split(/\s+/).filter(Boolean);
  if (!palabras.length) return [];
  if (palabras.length === 1) return [palabras[0]];

  let mejorCorte = 1;
  let mejorAncho = Infinity;
  for (let i = 1; i < palabras.length; i++) {
    const anchoMaximo = Math.max(
      anchoDe(palabras.slice(0, i).join(' ')),
      anchoDe(palabras.slice(i).join(' '))
    );
    if (anchoMaximo < mejorAncho) { mejorAncho = anchoMaximo; mejorCorte = i; }
  }

  let linea1 = palabras.slice(0, mejorCorte).join(' ');
  let linea2 = palabras.slice(mejorCorte).join(' ');

  if (anchoDe(linea2) > anchoMax) {
    while (linea2.length > 1 && anchoDe(`${linea2}…`) > anchoMax) linea2 = linea2.slice(0, -1).trimEnd();
    linea2 = `${linea2}…`;
  }
  if (anchoDe(linea1) > anchoMax) {
    while (linea1.length > 1 && anchoDe(`${linea1}…`) > anchoMax) linea1 = linea1.slice(0, -1).trimEnd();
    linea1 = `${linea1}…`;
  }

  return [linea1, linea2];
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

// Guardado en DB como 'YYYY-MM-DD' (recién parseado en el wizard) o Date (columna `date`
// ya leída de la DB, "pg" la devuelve como Date de medianoche LOCAL) -> "D/M/YY", igual
// al formato que ya usan las plantillas a mano ("VTO: 7/8/26"). Usamos los getters UTC
// porque la empresa opera en Argentina (UTC-3): medianoche local siempre cae en el mismo
// día calendario en UTC, así que no hay corrimiento de fecha.
function formatearVencimiento(vencimiento) {
  const fecha = vencimiento instanceof Date ? vencimiento : new Date(`${vencimiento}T00:00:00Z`);
  const dia = fecha.getUTCDate();
  const mes = fecha.getUTCMonth() + 1;
  const anio = String(fecha.getUTCFullYear()).slice(-2);
  return `${dia}/${mes}/${anio}`;
}

function campoRect(campo, ancho, alto) {
  return {
    left: campo.x * ancho,
    top: campo.y * alto,
    width: campo.ancho * ancho,
    height: campo.alto * alto,
  };
}

function justify(align) {
  return align === 'center' ? 'center' : 'flex-start';
}

/**
 * Genera el cartel final.
 * @param {object} datos
 * @param {'a4'|'a4_color'|'cartel_simple'|'ciguena'} datos.tipoGrafica
 * @param {'corto_vencimiento'|'politica'|'precio_piso'|'nuevo_ingreso'} datos.tipoPrecio
 * @param {string} datos.producto
 * @param {number|null} datos.precio - ignorado si la plantilla no tiene campo de precio (nuevo_ingreso)
 * @param {string|Date|null} datos.vencimiento
 * @param {Buffer|null} datos.imagenProductoBuffer - foto del producto ya descargada, o null
 * @returns {Promise<Buffer>} JPEG del cartel final
 */
async function generarCartel({ tipoGrafica, tipoPrecio, producto, precio, vencimiento, imagenProductoBuffer }) {
  const plantilla = plantillaPara(tipoGrafica, tipoPrecio);
  const escala = tipoGrafica === 'ciguena' ? ESCALA_CIGUENA : 1;
  const anchoFinal = Math.round(plantilla.ancho * escala);
  const altoFinal = Math.round(plantilla.alto * escala);

  const fondoBase64 = fs.readFileSync(plantilla.archivo).toString('base64');
  const hijos = [
    {
      type: 'img',
      props: { src: `data:image/jpeg;base64,${fondoBase64}`, width: anchoFinal, height: altoFinal, style: { position: 'absolute', left: 0, top: 0 } },
    },
  ];

  if (plantilla.campos.imagenProducto && imagenProductoBuffer) {
    const rect = campoRect(plantilla.campos.imagenProducto, anchoFinal, altoFinal);
    // Puede venir tal cual de Telegram (JPEG) o ya sin fondo (PNG con transparencia,
    // ver carteleria-fondo.js) — detectamos por los primeros bytes, no asumimos.
    const mime = imagenProductoBuffer[0] === 0x89 ? 'image/png' : 'image/jpeg';
    const productoBase64 = imagenProductoBuffer.toString('base64');
    hijos.push({
      type: 'img',
      props: {
        src: `data:${mime};base64,${productoBase64}`,
        style: { position: 'absolute', ...rect, objectFit: 'contain' },
      },
    });
  }

  // El precio es opcional: "nuevo_ingreso" no tiene ese campo en la plantilla.
  if (plantilla.campos.precio) {
    const { entero, decimales } = formatearPrecio(precio);
    const rectPrecio = campoRect(plantilla.campos.precio, anchoFinal, altoFinal);
    // Mismo color que el "$"/"FINAL" ya impresos en la plantilla (blanco en las A4,
    // negro en las de cartel) — así el precio que agregamos calza con el diseño.
    const colorPrecio = plantilla.campos.colorPrecio || '#1a1a1a';
    // Precio en una sola línea: satori no lo achica solo si es más largo (p.ej. "1.899"
    // vs "999"), así que ajustamos el tamaño según la cantidad de dígitos + el "." de
    // miles, y dejamos overflow:hidden como red de seguridad para que nunca tape el
    // "FINAL" fijo de la plantilla.
    const tamanioPrecio = Math.min(rectPrecio.height * 0.85, rectPrecio.width / (entero.length * 0.62 + 0.47));
    hijos.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: rectPrecio.left, top: rectPrecio.top, width: rectPrecio.width, height: rectPrecio.height,
          display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: justify(plantilla.campos.precio.align),
          overflow: 'hidden',
        },
        children: [
          { type: 'div', props: { style: { fontFamily: 'Anton', fontSize: tamanioPrecio, color: colorPrecio, lineHeight: 1 }, children: entero } },
          { type: 'div', props: { style: { fontFamily: 'Anton', fontSize: tamanioPrecio * 0.38, color: colorPrecio, lineHeight: 1, marginLeft: tamanioPrecio * 0.06 }, children: decimales } },
        ],
      },
    });
  }

  const colorNombre = plantilla.campos.colorNombre || '#ffffff';
  const rectLinea1 = campoRect(plantilla.campos.nombreLinea1, anchoFinal, altoFinal);
  const tamanioNombre = rectLinea1.height * 0.72;
  const [nombreLinea1, nombreLinea2] = partirEnLineas(producto, tamanioNombre, rectLinea1.width);

  // Los nombres de 1 sola línea NO deben quedar pegados arriba del hueco pensado
  // para 2 líneas (se veía desalineado/con un hueco vacío abajo) — unimos las 2
  // franjas de la plantilla en una sola caja y centramos el bloque (1 o 2 líneas)
  // con flexbox, en vez de posicionar cada línea en una coordenada fija.
  // Usamos el área completa (línea 1 + línea 2) para centrar aunque el nombre
  // entre en 1 sola línea — si solo centráramos dentro del rect angosto de la
  // línea 1, un nombre corto seguiría pegado arriba del hueco de 2 líneas.
  let rectNombre = rectLinea1;
  if (plantilla.campos.nombreLinea2) {
    const rectLinea2 = campoRect(plantilla.campos.nombreLinea2, anchoFinal, altoFinal);
    rectNombre = {
      left: rectLinea1.left,
      top: rectLinea1.top,
      width: Math.max(rectLinea1.width, rectLinea2.width),
      height: (rectLinea2.top + rectLinea2.height) - rectLinea1.top,
    };
  }
  hijos.push({
    type: 'div',
    props: {
      style: {
        position: 'absolute', left: rectNombre.left, top: rectNombre.top, width: rectNombre.width, height: rectNombre.height,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: plantilla.campos.nombreLinea1.align === 'center' ? 'center' : 'flex-start',
        overflow: 'hidden',
      },
      children: [nombreLinea1, nombreLinea2].filter(Boolean).map((linea) => ({
        type: 'div',
        props: { style: { fontFamily: 'Anton', fontSize: tamanioNombre, color: colorNombre, lineHeight: 1.25 }, children: linea },
      })),
    },
  });

  if (vencimiento && plantilla.campos.vencimiento) {
    const rectVto = campoRect(plantilla.campos.vencimiento, anchoFinal, altoFinal);
    hijos.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: rectVto.left, top: rectVto.top, width: rectVto.width, height: rectVto.height,
          display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
        },
        children: {
          type: 'div',
          props: { style: { fontFamily: 'Anton', fontSize: rectVto.height * 0.85, color: '#1a1a1a' }, children: `VTO: ${formatearVencimiento(vencimiento)}` },
        },
      },
    });
  }

  const svg = await satori(
    { type: 'div', props: { style: { width: anchoFinal, height: altoFinal, display: 'flex', position: 'relative' }, children: hijos } },
    { width: anchoFinal, height: altoFinal, fonts: [{ name: 'Anton', data: fuente(), weight: 400, style: 'normal' }] }
  );

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

module.exports = { generarCartel, formatearPrecio, formatearVencimiento };
