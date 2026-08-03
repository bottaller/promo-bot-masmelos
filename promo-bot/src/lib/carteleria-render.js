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

// Une `texto` en UNA sola línea que entre en `anchoMax`, recortando con "…" si hace falta —
// para el tag de política de Cartel/Cigüeña, que se angosta hacia la punta y no da lugar a 2
// líneas (a diferencia del de A4, que sí usa partirEnLineas normal).
function unaLinea(texto, tamanioFuente, anchoMax) {
  const font = fuenteParseada();
  const anchoDe = (t) => font.getAdvanceWidth(t, tamanioFuente);
  let linea = String(texto).toUpperCase().trim().replace(/\s+/g, ' ');
  if (!linea) return '';
  if (anchoDe(linea) <= anchoMax) return linea;
  while (linea.length > 1 && anchoDe(`${linea}…`) > anchoMax) linea = linea.slice(0, -1).trimEnd();
  return `${linea}…`;
}

// Encuentra el tamaño de fuente más grande (arrancando en `tamanioMax`) con el que `texto`
// entra en `anchoMax` SIN truncar con "…" — para el tag de política, donde el largo real varía
// mucho ("3X2" vs "Llevando 6 unidades 15% off") y truncar pierde información importante (un
// "%" cortado a la mitad es peor que la letra más chica). Nunca baja de `tamanioMin`: ahí sí se
// acepta el truncado de partirEnLineas/unaLinea como último recurso.
function ajustarTamanioTag(texto, tamanioMax, tamanioMin, anchoMax, unaSolaLinea) {
  let tamanio = tamanioMax;
  let lineas = unaSolaLinea ? [unaLinea(texto, tamanio, anchoMax)] : partirEnLineas(texto, tamanio, anchoMax);
  while (lineas.some((l) => l.includes('…')) && tamanio > tamanioMin) {
    tamanio = Math.max(tamanio * 0.92, tamanioMin);
    lineas = unaSolaLinea ? [unaLinea(texto, tamanio, anchoMax)] : partirEnLineas(texto, tamanio, anchoMax);
  }
  return { tamanio, lineas };
}

// $1999 -> { entero: "1999", decimales: "99" }. `precio` siempre viene con 2
// decimales aunque sean $0 (p.ej. $500 -> entero "500", decimales "00"). Sin punto de miles
// a propósito (a diferencia del resto del bot, que sí lo usa en texto) — en el cartel cada
// caracter de menos es lugar de más para agrandar la fuente, y así es como se ve en los
// carteles reales (ej. "$7347" no "$7.347").
function formatearPrecio(precio) {
  const numero = Number(precio);
  const entero = Math.trunc(numero);
  const decimales = Math.round((numero - entero) * 100);
  return {
    entero: String(entero),
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
 * @param {string|null} datos.politica - solo para tipoPrecio='politica'; reemplaza el tag fijo
 *   "DTO. X VOL" / "DESCUENTO POR VOLUMEN" por este texto. Se ignora en el resto de los tipos.
 * @param {Buffer|null} datos.imagenProductoBuffer - foto del producto ya descargada, o null
 * @returns {Promise<Buffer>} JPEG del cartel final
 */
async function generarCartel({ tipoGrafica, tipoPrecio, producto, precio, vencimiento, politica, imagenProductoBuffer }) {
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

  // El precio es opcional: "nuevo_ingreso" no tiene ese campo en la plantilla.
  if (plantilla.campos.precio) {
    const { entero, decimales } = formatearPrecio(precio);
    const rectPrecio = campoRect(plantilla.campos.precio, anchoFinal, altoFinal);
    // Mismo color que el "$"/"FINAL" ya impresos en la plantilla (blanco en las A4,
    // negro en las de cartel) — así el precio que agregamos calza con el diseño.
    const colorPrecio = plantilla.campos.colorPrecio || '#1a1a1a';
    // Precio en una sola línea: satori no lo achica solo si es más largo (p.ej. "1.899"
    // vs "999"), así que calculamos el tamaño más grande que entra — con el ancho REAL de
    // "entero" + "decimales" (medido con la fuente de verdad, igual que partirEnLineas/el tag
    // de política — antes esto era la única fuente que usaba una heurística de "0.62 de ancho
    // por carácter", quedando bastante más chico de lo que el casillero permitía). Como el ancho
    // de un texto escala lineal con el tamaño de fuente, alcanza con medir a tamaño 1 y despejar.
    // Tope de altura: 85% del rect. En Cartel/Cigüeña el rect es alto a propósito (para
    // centrar bien el bloque con precios de distinto largo, ver más abajo) — un tope de altura
    // más chico dejaba SIEMPRE el mismo tamaño de fuente sin importar el largo del precio,
    // chico y lejos del "$"/"FINAL" fijos. El tope por ancho de abajo ya evita que un precio
    // largo choque con el "FINAL" fijo, así que no hace falta un segundo tope de altura.
    const capAltura = rectPrecio.height * 0.85;
    const font = fuenteParseada();
    const anchoEnteroPorUnidad = font.getAdvanceWidth(entero, 1);
    const anchoDecimalesPorUnidad = font.getAdvanceWidth(decimales, 1);
    // width(S) = S*anchoEnteroPorUnidad + margenPorUnidad*S + (0.38*S)*anchoDecimalesPorUnidad
    const anchoPorUnidadDeTamanio = anchoEnteroPorUnidad + 0.06 + 0.38 * anchoDecimalesPorUnidad;
    const capAncho = rectPrecio.width / anchoPorUnidadDeTamanio;
    const tamanioPrecio = Math.min(capAltura, capAncho);
    // Un precio largo (ej. "1.500" vs "999") achica tamanioPrecio para no desbordar — si el
    // bloque quedara anclado arriba (flex-start), un precio más chico dejaría un hueco vacío
    // debajo y se vería "flotando" desalineado del "$"/"FINAL" fijos de la plantilla. Igual que
    // con el nombre: centramos el bloque completo verticalmente (contenedor externo), y adentro
    // mantenemos el precio y los centavos en su propia fila para conservar el efecto de
    // superíndice (centavos arriba a la derecha, más chicos).
    hijos.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: rectPrecio.left, top: rectPrecio.top, width: rectPrecio.width, height: rectPrecio.height,
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          alignItems: justify(plantilla.campos.precio.align) === 'center' ? 'center' : 'flex-start',
          overflow: 'hidden',
        },
        children: {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'row', alignItems: 'flex-start' },
            children: [
              { type: 'div', props: { style: { fontFamily: 'Anton', fontSize: tamanioPrecio, color: colorPrecio, lineHeight: 1 }, children: entero } },
              { type: 'div', props: { style: { fontFamily: 'Anton', fontSize: tamanioPrecio * 0.38, color: colorPrecio, lineHeight: 1, marginLeft: tamanioPrecio * 0.06 }, children: decimales } },
            ],
          },
        },
      },
    });
  }

  const colorNombre = plantilla.campos.colorNombre || '#ffffff';
  const rectLinea1 = campoRect(plantilla.campos.nombreLinea1, anchoFinal, altoFinal);

  // Los nombres de 1 sola línea NO deben quedar pegados arriba del hueco pensado
  // para 2 líneas (se veía desalineado/con un hueco vacío abajo) — unimos las 2
  // franjas de la plantilla en una sola caja y centramos el bloque (1 o 2 líneas)
  // con flexbox, en vez de posicionar cada línea en una coordenada fija.
  // Usamos el área completa (línea 1 + línea 2) para centrar aunque el nombre
  // entre en 1 sola línea — si solo centráramos dentro del rect angosto de la
  // línea 1, un nombre corto seguiría pegado arriba del hueco de 2 líneas.
  let rectNombre = rectLinea1;
  let maxLineasNombre = 1;
  if (plantilla.campos.nombreLinea2) {
    const rectLinea2 = campoRect(plantilla.campos.nombreLinea2, anchoFinal, altoFinal);
    rectNombre = {
      left: rectLinea1.left,
      top: rectLinea1.top,
      width: Math.max(rectLinea1.width, rectLinea2.width),
      height: (rectLinea2.top + rectLinea2.height) - rectLinea1.top,
    };
    maxLineasNombre = 2;
  }

  // El tamaño de fuente del nombre se ajusta para llenar el espacio real disponible (medido por
  // píxeles contra carteles de referencia: el nombre ocupaba mucho más lugar del que este fijo
  // de antes —altura*0.72— dejaba) — arrancamos de un tamaño grande (el que llenaría el alto
  // del contenedor con el máximo de líneas permitidas) y achicamos de a poco hasta que entre
  // sin truncar ("…") en el ancho Y sin desbordar en el alto. Mismo patrón que ajustarTamanioTag.
  let tamanioNombre = (rectNombre.height / (maxLineasNombre * 1.25)) * 1.08;
  const tamanioMinNombre = rectLinea1.height * 0.4;
  let [nombreLinea1, nombreLinea2] = partirEnLineas(producto, tamanioNombre, rectLinea1.width);
  const excedeAlto = () => {
    const lineas = nombreLinea2 ? 2 : 1;
    return lineas * tamanioNombre * 1.25 > rectNombre.height;
  };
  while (
    (nombreLinea1.includes('…') || (nombreLinea2 && nombreLinea2.includes('…')) || excedeAlto())
    && tamanioNombre > tamanioMinNombre
  ) {
    tamanioNombre *= 0.94;
    [nombreLinea1, nombreLinea2] = partirEnLineas(producto, tamanioNombre, rectLinea1.width);
  }

  // La plantilla trae una línea divisoria fija pensada para separar línea 1 de línea 2, dibujada
  // justo en el centro vertical de rectNombre — con 1 sola línea centrada ahí, el texto le
  // pasaba por encima ("pisando la línea"). Repintamos el interior de la caja con su color real
  // (sampleado del arte) para taparla, y si hacen falta 2 líneas dibujamos NOSOTROS una nueva
  // divisoria, siempre exactamente en el medio entre ambas (2 líneas de igual alto centradas en
  // rectNombre siempre parten justo en su centro, así que no hace falta calcular la posición real
  // de cada línea).
  // rectNombre viene del área de TEXTO (nombreLinea1/2) — no necesariamente coincide con la
  // parte RECTA de la caja de la plantilla (esquinas redondeadas): pintar directo con esas
  // coordenadas puede asomar con esquinas cuadradas por fuera de la curva. cajaNombreSegura
  // (medida a mano por plantilla, sampleando dónde termina realmente la parte recta) define el
  // ancho seguro para pintar; alto y posición vertical los toma de rectNombre (ahí nunca hubo
  // problema, el ancho es lo único que varía por el redondeado de las esquinas).
  const cajaSegura = plantilla.campos.cajaNombreSegura;
  const rectFondoNombre = cajaSegura
    ? { left: cajaSegura.x * anchoFinal, top: rectNombre.top, width: cajaSegura.ancho * anchoFinal, height: rectNombre.height }
    : rectNombre;
  if (plantilla.campos.colorFondoNombre) {
    hijos.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: rectFondoNombre.left, top: rectFondoNombre.top, width: rectFondoNombre.width, height: rectFondoNombre.height,
          backgroundColor: plantilla.campos.colorFondoNombre,
        },
      },
    });
  }
  if (nombreLinea2 && plantilla.campos.colorDivisorNombre) {
    const grosorDivisor = Math.max(1.5, altoFinal * 0.0015);
    hijos.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: rectFondoNombre.left, top: rectNombre.top + rectNombre.height / 2 - grosorDivisor / 2,
          width: rectFondoNombre.width, height: grosorDivisor, backgroundColor: plantilla.campos.colorDivisorNombre,
        },
      },
    });
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

  // La foto de producto se dibuja DESPUÉS de la caja del nombre (no antes) — en Cartel/Cigüeña
  // el diseño real pisa la franja blanca del nombre con la parte de abajo de la foto (a propósito,
  // para que se vea grande), y si la pintábamos antes, la caja del nombre (que repinta un
  // rectángulo opaco para tapar su línea divisoria fija) la tapaba a la altura de esa franja.
  // Dibujándola al final queda arriba de todo eso, sin que nada la recorte.
  if (plantilla.campos.imagenProducto && imagenProductoBuffer) {
    const rect = campoRect(plantilla.campos.imagenProducto, anchoFinal, altoFinal);
    // satori NO decodifica WebP (el catálogo sube todo en ese formato, ver
    // carteleria-catalogo.js) — a pesar de que "image/webp" aparece en su bundle, no hay
    // decoder real: el <img> se ignora en silencio, sin tirar error. Normalizamos siempre a
    // PNG con sharp antes de pasarlo, sea cual sea el formato de entrada.
    const productoPngBuffer = await sharp(imagenProductoBuffer).png().toBuffer();
    const productoBase64 = productoPngBuffer.toString('base64');
    hijos.push({
      type: 'img',
      props: {
        src: `data:image/png;base64,${productoBase64}`,
        style: { position: 'absolute', ...rect, objectFit: 'contain' },
      },
    });
  }

  // Tag de política ("DTO. X VOL" / "DESCUENTO POR VOLUMEN" fijos en el arte) — se repinta con
  // la política que escribió Depósito, solo para tipo_precio=politica. A4 admite 2 líneas
  // (partirEnLineas, igual que el nombre); Cartel/Cigüeña es angosto y se cierra hacia la punta
  // del banderín, así que va en 1 sola línea truncada.
  if (tipoPrecio === 'politica' && politica && plantilla.campos.tagPolitica) {
    const tag = plantilla.campos.tagPolitica;
    const rectTag = campoRect(tag, anchoFinal, altoFinal);
    const unaSolaLinea = tag.lineas === 1;
    const tamanioMax = rectTag.height * (unaSolaLinea ? 0.6 : 0.4);
    const { tamanio: tamanioTag, lineas: lineasTag } = ajustarTamanioTag(politica, tamanioMax, tamanioMax * 0.4, rectTag.width, unaSolaLinea);
    // El banderín de Cartel/Cigüeña es un paralelogramo (corte diagonal, medido por píxeles
    // contra el arte: ~-4°) y el texto fijo "¡PRECIOS AL PISO!"/"DESCUENTO POR VOLUMEN" que
    // reemplaza sigue esa inclinación — sin rotar, el texto repintado quedaba derecho, en
    // diagonal contra el borde de abajo del recuadro.
    const transformTag = tag.anguloGrados ? { transform: `rotate(${tag.anguloGrados}deg)` } : {};
    // El texto se puede correr hacia abajo DENTRO del rect (textoOffsetY, fracción de
    // rectTag.height) sin tocar el fondo — el fondo tiene que seguir tapando el rect completo
    // (ver comentario de tagPolitica en carteleria-plantillas.js), si no asoma el texto fijo
    // original en la franja que el fondo dejó de cubrir.
    const offsetTexto = (tag.textoOffsetY || 0) * rectTag.height;
    const rectTexto = { left: rectTag.left, top: rectTag.top + offsetTexto, width: rectTag.width, height: rectTag.height - offsetTexto };
    hijos.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: rectTag.left, top: rectTag.top, width: rectTag.width, height: rectTag.height,
          backgroundColor: tag.colorFondo,
        },
      },
    });
    hijos.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: rectTexto.left, top: rectTexto.top, width: rectTexto.width, height: rectTexto.height,
          display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
          overflow: 'hidden', ...transformTag,
        },
        children: lineasTag.filter(Boolean).map((linea) => ({
          type: 'div',
          props: { style: { fontFamily: 'Anton', fontSize: tamanioTag, color: tag.colorTexto, lineHeight: 1.2 }, children: linea },
        })),
      },
    });
  }

  if (vencimiento && plantilla.campos.vencimiento) {
    const rectVto = campoRect(plantilla.campos.vencimiento, anchoFinal, altoFinal);
    const textoVto = `VTO: ${formatearVencimiento(vencimiento)}`;
    // El campo es angosto a propósito (calza con el tramo horizontal de la línea puntero fija
    // del arte) — a tamaño fijo (altura*0.85), una fecha de 2 dígitos de año entraba pero
    // "VTO: 31/12/26" no, y sin achicar el texto se partía solo en 2 líneas (satori no trunca
    // ni ajusta un <div> de texto por su cuenta) tapándose con la línea de abajo. Achicamos
    // SOLO si hace falta (nunca agrandamos más allá del tope por altura) — la fecha nunca se
    // trunca con "…", siempre se ve completa.
    const tamanioMaxPorAltura = rectVto.height * 0.85;
    const anchoATamanioMax = fuenteParseada().getAdvanceWidth(textoVto, tamanioMaxPorAltura);
    const tamanioVto = anchoATamanioMax > rectVto.width
      ? tamanioMaxPorAltura * (rectVto.width / anchoATamanioMax)
      : tamanioMaxPorAltura;
    hijos.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: rectVto.left, top: rectVto.top, width: rectVto.width, height: rectVto.height,
          display: 'flex', alignItems: 'center', justifyContent: 'flex-start', overflow: 'hidden',
        },
        children: {
          type: 'div',
          props: { style: { fontFamily: 'Anton', fontSize: tamanioVto, color: '#1a1a1a', whiteSpace: 'nowrap' }, children: textoVto },
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
