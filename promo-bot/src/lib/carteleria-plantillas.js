// Mapeo {tipo_grafica, tipo_precio} -> plantilla + posiciones de los campos variables.
//
// Las coordenadas de "campos" son fracciones (0-1) del ancho/alto real de cada
// plantilla (ver `ancho`/`alto`, medidos con sharp .metadata()) — no píxeles fijos,
// así no dependen de que el archivo cambie de resolución.
//
// A4 y A4 Color comparten las mismas 3 plantillas (a4_*). Cartel simple y Gráfica
// cigüeña comparten las mismas 2 plantillas (cartel_*) — cigüeña se renderiza al
// doble del tamaño del canvas (ver ESCALA_CIGUENA en carteleria-render.js).
//
// El texto de "FINAL" y los tags (¡PRECIOS AL PISO!, DTO. X VOL, etc.) ya vienen
// impresos en la plantilla — NO son campos variables. Los disclaimers de abajo de
// cada plantilla también están fijos en el arte.
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'assets', 'carteleria');

// tipos de precio válidos por tipo de gráfica (mismo criterio que el wizard).
// "nuevo_ingreso" no es realmente un "precio" — es un aviso de producto nuevo sin
// precio, pero vive en esta misma lista porque comparte el mecanismo de selección.
const TIPOS_PRECIO_POR_GRAFICA = {
  a4: ['corto_vencimiento', 'politica', 'precio_piso', 'nuevo_ingreso'],
  a4_color: ['corto_vencimiento', 'politica', 'precio_piso', 'nuevo_ingreso'],
  cartel_simple: ['politica', 'precio_piso'],
  ciguena: ['politica', 'precio_piso'],
};

const LABELS_TIPO_PRECIO = {
  corto_vencimiento: 'Corto vencimiento',
  politica: 'Política',
  precio_piso: 'Precio al piso',
  nuevo_ingreso: 'Nuevo ingreso',
};

// tipos de precio que NO llevan precio en el cartel final (solo producto + foto).
const TIPOS_PRECIO_SIN_PRECIO = ['nuevo_ingreso'];

// A4 / A4 Color: plantilla vertical (~800x1125), pastilla roja "$ ___ FINAL" arriba, hueco de
// foto de producto en el medio, caja oscura de nombre de producto abajo, disclaimer fijo al pie.
const CAMPOS_A4_PRECIO = {
  // y=0.246 (no 0.235): medido por píxeles contra el rojo real de la píldora en el arte
  // (a4_precio_piso.jpg y a4_politica.jpg, ambas ~y:0.243-0.249, alto:0.1004) — el precio
  // arrancaba ~1.4% del alto del cartel por encima de donde arranca la píldora de verdad.
  precio: { x: 0.29, y: 0.246, ancho: 0.27, alto: 0.10, align: 'left' },
  imagenProducto: { x: 0.15, y: 0.37, ancho: 0.70, alto: 0.36 },
  nombreLinea1: { x: 0.145, y: 0.775, ancho: 0.665, alto: 0.045, align: 'center' },
  nombreLinea2: { x: 0.145, y: 0.825, ancho: 0.665, alto: 0.045, align: 'center' },
  colorNombre: '#ffffff', // caja oscura de fondo
  colorFondoNombre: '#332a21', // color real de la caja (sampleado del arte), para repintar la línea divisoria fija
  colorDivisorNombre: 'rgba(255,255,255,0.35)',
  // Ancho real de la parte RECTA de la caja (sampleado por píxeles en la fila del divisor,
  // con un margen chico) — repintar más ancho que esto asoma con esquinas cuadradas por fuera
  // de la esquina redondeada del arte.
  cajaNombreSegura: { x: 0.205, ancho: 0.615 },
  colorPrecio: '#ffffff', // "$" y "FINAL" de la pastilla roja son blancos
  // Tag con punta (banderín) fijo arriba a la derecha de la pastilla — en "precio_piso" dice
  // "¡PRECIOS AL PISO!" (fijo), en "politica" dice "DTO. X VOL" (fijo) y ahí es donde se
  // repinta con la política que escribe Depósito (solo se usa cuando tipo_precio=politica, ver
  // carteleria-render.js). Hasta 2 líneas — la parte de abajo se angosta por la punta del
  // banderín, por eso el rect no ocupa toda la altura visible del tag.
  tagPolitica: { x: 0.638, y: 0.248, ancho: 0.135, alto: 0.095, colorFondo: '#34332f', colorTexto: '#ffe000' },
};

// A4 corto vencimiento: plantilla vertical más grande (~1131x1600), banner
// "OFERTA LIMITADA" arriba, pastilla de precio + tag "¡PRECIO AL PISO!" fijo,
// línea puntero hacia la fecha de vencimiento, foto de producto en el medio,
// caja oscura de nombre, disclaimer con borde fijo al pie.
const CAMPOS_A4_CORTO_VENCIMIENTO = {
  // Medido por píxeles contra el rojo real de la píldora en el arte (a4_corto_vencimiento.jpg):
  // x:0.284-0.630, y:0.245-0.328 (alto real ≈0.083) — el precio usaba solo un 66% del alto
  // disponible (alto:0.055) y arrancaba centrado más abajo de la píldora real, quedando chico.
  precio: { x: 0.32, y: 0.248, ancho: 0.20, alto: 0.075, align: 'left' },
  vencimiento: { x: 0.02, y: 0.395, ancho: 0.18, alto: 0.03, align: 'left' },
  imagenProducto: { x: 0.18, y: 0.36, ancho: 0.62, alto: 0.34 },
  nombreLinea1: { x: 0.20, y: 0.73, ancho: 0.62, alto: 0.035, align: 'center' },
  nombreLinea2: { x: 0.20, y: 0.77, ancho: 0.62, alto: 0.032, align: 'center' },
  colorNombre: '#ffffff', // caja oscura de fondo
  colorFondoNombre: '#434341',
  colorDivisorNombre: 'rgba(255,255,255,0.35)',
  cajaNombreSegura: { x: 0.234, ancho: 0.572 },
  colorPrecio: '#ffffff', // "$" y "FINAL" de la pastilla roja son blancos
};

// A4 nuevo ingreso: plantilla vertical (~1135x1600), banner "¡NUEVO INGRESO!" +
// subtítulo "Consultá por este artículo a tu vendedor!" fijos, SIN precio — la
// foto que sube Depósito va directo al hueco central (es la misma foto, no un
// catálogo aparte), caja oscura de nombre, logo + redes fijos al pie.
const CAMPOS_A4_NUEVO_INGRESO = {
  imagenProducto: { x: 0.08, y: 0.27, ancho: 0.84, alto: 0.42 },
  nombreLinea1: { x: 0.16, y: 0.758, ancho: 0.68, alto: 0.035, align: 'center' },
  nombreLinea2: { x: 0.16, y: 0.805, ancho: 0.68, alto: 0.032, align: 'center' },
  colorNombre: '#ffffff', // caja oscura de fondo
  colorFondoNombre: '#3c3c3a',
  colorDivisorNombre: 'rgba(255,255,255,0.35)',
  cajaNombreSegura: { x: 0.167, ancho: 0.705 },
};

// Cartel simple / Cigüeña: plantilla horizontal (~1600x1066), "$" grande fijo a la
// izquierda, "FINAL" fijo arriba a la derecha, precio grande en el campo amarillo, hueco de
// foto de producto a la derecha, barra blanca de nombre abajo, footer negro con disclaimer fijo.
const CAMPOS_CARTEL_PRECIO = {
  precio: { x: 0.10, y: 0.20, ancho: 0.55, alto: 0.30, align: 'left' },
  imagenProducto: { x: 0.35, y: 0.40, ancho: 0.60, alto: 0.33 },
  nombreLinea1: { x: 0.03, y: 0.755, ancho: 0.94, alto: 0.06, align: 'center' },
  nombreLinea2: { x: 0.03, y: 0.825, ancho: 0.94, alto: 0.06, align: 'center' },
  colorNombre: '#1a1a1a', // barra blanca de fondo (no hay caja oscura)
  colorFondoNombre: '#ffffff',
  colorDivisorNombre: 'rgba(0,0,0,0.18)',
  // Acá "la caja" es toda la franja blanca de abajo, borde a borde — sin esquinas
  // redondeadas que esquivar, así que coincide con nombreLinea1.
  cajaNombreSegura: { x: 0.03, ancho: 0.94 },
  colorPrecio: '#1a1a1a', // "$" y "FINAL" son negros sobre el fondo amarillo
  // El rect de precio es alto a propósito, para centrar bien el bloque con precios de
  // distinto largo (ver carteleria-render.js) — el tamaño de fuente sale del 85% de esa
  // altura, topeado por ancho para precios largos.
  // Banner rojo fijo arriba a la izquierda — en "precio_piso" dice "¡PRECIOS AL PISO!" (fijo),
  // en "politica" dice "DESCUENTO POR VOLUMEN" (fijo) y ahí es donde se repinta con la política
  // que escribe Depósito (solo cuando tipo_precio=politica). El banner es angosto y se angosta
  // más todavía hacia la derecha (corte diagonal) — 1 sola línea, se trunca con "…" si no entra.
  tagPolitica: { x: 0.025, y: 0, ancho: 0.35, alto: 0.09, colorFondo: '#e40e16', colorTexto: '#ffe814', lineas: 1 },
};

const PLANTILLAS = {
  'a4:precio_piso': { archivo: path.join(DIR, 'a4_precio_piso.jpg'), ancho: 800, alto: 1126, campos: CAMPOS_A4_PRECIO },
  'a4:politica': { archivo: path.join(DIR, 'a4_politica.jpg'), ancho: 799, alto: 1125, campos: CAMPOS_A4_PRECIO },
  'a4:corto_vencimiento': { archivo: path.join(DIR, 'a4_corto_vencimiento.jpg'), ancho: 1131, alto: 1600, campos: CAMPOS_A4_CORTO_VENCIMIENTO },
  'a4:nuevo_ingreso': { archivo: path.join(DIR, 'a4_nuevo_ingreso.jpg'), ancho: 1135, alto: 1600, campos: CAMPOS_A4_NUEVO_INGRESO },
  'cartel_simple:precio_piso': { archivo: path.join(DIR, 'cartel_precio_piso.jpg'), ancho: 1600, alto: 1066, campos: CAMPOS_CARTEL_PRECIO },
  'cartel_simple:politica': { archivo: path.join(DIR, 'cartel_politica.jpg'), ancho: 1600, alto: 1066, campos: CAMPOS_CARTEL_PRECIO },
};

// a4_color usa las mismas plantillas que a4; ciguena usa las mismas que cartel_simple.
function claveTipoGrafica(tipoGrafica) {
  if (tipoGrafica === 'a4_color') return 'a4';
  if (tipoGrafica === 'ciguena') return 'cartel_simple';
  return tipoGrafica;
}

function plantillaPara(tipoGrafica, tipoPrecio) {
  const clave = `${claveTipoGrafica(tipoGrafica)}:${tipoPrecio}`;
  const plantilla = PLANTILLAS[clave];
  if (!plantilla) throw new Error(`No hay plantilla para ${tipoGrafica} + ${tipoPrecio}`);
  return plantilla;
}

function tiposPrecioValidos(tipoGrafica) {
  return TIPOS_PRECIO_POR_GRAFICA[claveTipoGrafica(tipoGrafica)] || [];
}

module.exports = {
  PLANTILLAS,
  TIPOS_PRECIO_POR_GRAFICA,
  LABELS_TIPO_PRECIO,
  TIPOS_PRECIO_SIN_PRECIO,
  plantillaPara,
  tiposPrecioValidos,
  claveTipoGrafica,
};
