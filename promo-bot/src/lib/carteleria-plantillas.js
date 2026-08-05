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
  // x:0.284-0.630, y:0.2450-0.3281 (alto real 0.0831). y/alto ajustados a esos valores exactos
  // (antes 0.248/0.075, quedaba un poco más chico y arrancando más abajo que la píldora real) --
  // a pedido, el número tiene que quedar centrado en altura dentro del rojo, no pegado arriba
  // (ver `justifyContent` en generarCartel, centrado acá a diferencia de Cartel/Cigüeña).
  precio: { x: 0.32, y: 0.2450, ancho: 0.20, alto: 0.0831, align: 'left' },
  // A pedido, el precio se centra entre donde termina el "$" y donde arranca "FINAL" (ambos
  // fijos en la pastilla del arte) -- medido por píxeles contra a4_corto_vencimiento.jpg en
  // blanco: "$" termina en x:0.3218, "FINAL" arranca en x:0.5402.
  // `siempre: true` -- a diferencia de Cartel/Cigüeña, en A4 el precio se centra SIEMPRE, no
  // solo cuando el precio es corto (el casillero acá ya es angosto, pensado para 4 cifras).
  precioCentradoEntre: { izq: 0.3218, der: 0.5402, siempre: true },
  // Centavos apilados arriba de "FINAL", igual que en Cartel/Cigüeña (a pedido) -- pero acá la
  // pastilla es mucho más baja (arranca en y:0.2450, contra el techo de "FINAL" en y:0.2956:
  // solo 0.0506 de aire, contra el resto del alto del cartel que da Cartel/Cigüeña), así que
  // `techoMinY` le pone un piso al hueco disponible (ver generarCartel) -- sin esto, el cálculo
  // asume que hay aire hasta el borde de arriba del CANVAS entero (y:0), que acá se comería el
  // logo "MASMELOS" de arriba. Centrado sobre "FINAL" (arranca en x:0.5402, termina en x:0.6172
  // -- centro 0.5787).
  // factor: 0.55 (antes 0.280, compartido sin querer con Cartel/Cigüeña -- quedaban chicos acá,
  // subido bastante porque el tope real (headroom entre "FINAL" y techoMinY) da mucho más
  // margen que ese factor, a diferencia de Cartel/Cigüeña donde el factor SÍ es el que manda).
  decimales: { x: 0.5337, ancho: 0.09, techoY: 0.2956, techoMinY: 0.2450, align: 'center', factor: 0.55 },
  // Medido por píxeles contra el tramo HORIZONTAL de la línea puntero fija (arranca en
  // x:0.084 y dobla en x:0.2325, a y≈0.418): el campo viejo (x:0.02) arrancaba 6-7% del ancho
  // a la IZQUIERDA de donde empieza la línea, así que el texto "VTO: ..." quedaba flotando
  // separado de la línea en vez de sentarse justo arriba de ella.
  vencimiento: { x: 0.084, y: 0.383, ancho: 0.148, alto: 0.033, align: 'left' },
  imagenProducto: { x: 0.18, y: 0.36, ancho: 0.62, alto: 0.34 },
  // Medido por píxeles contra la caja oscura real (a4_corto_vencimiento.jpg): y:0.7131-0.8050
  // (alto real ≈0.0919) — el campo viejo (y:0.73, hasta y:0.802) arrancaba 1.7% del alto MÁS
  // ABAJO que el techo real de la caja, dejando un margen vacío arriba y el bloque de texto
  // corrido hacia el borde inferior en vez de centrado.
  nombreLinea1: { x: 0.20, y: 0.721, ancho: 0.62, alto: 0.0355, align: 'center' },
  nombreLinea2: { x: 0.20, y: 0.762, ancho: 0.62, alto: 0.0355, align: 'center' },
  colorNombre: '#ffffff', // caja oscura de fondo
  colorFondoNombre: '#434341',
  colorDivisorNombre: 'rgba(255,255,255,0.35)',
  // Medido por píxeles: la parte recta de la caja real llega hasta x:0.206-0.8347 — se deja
  // ~1% de margen a cada lado (no hasta el borde exacto) para no asomar por la esquina redondeada.
  cajaNombreSegura: { x: 0.216, ancho: 0.608 },
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
  // Medido por píxeles contra carteles reales de referencia (no contra el arte en blanco):
  // el precio ("7347"/"1014") arranca en x≈0.056 (pegado al "$", que termina en x:0.069) y
  // llega hasta x≈0.62-0.63 — los CENTAVOS no van pegados al final de esos dígitos: van en su
  // propio casillero fijo, apilados arriba de "FINAL" (ver `decimales` más abajo), no en la
  // misma fila. Puede superponerse con la foto de producto (que arranca en x:0.65) para precios
  // largos; el diseño real tampoco lo evita (la foto ahí queda más a la derecha).
  // Ancla ARRIBA (no centrado — ver generarCartel) en vez de estar centrado en un casillero
  // alto: a pedido, la parte VISIBLE del dígito (no el rect — la fuente deja un margen interno
  // arriba del glifo, medido: ~0.023 a este tamaño) tiene que arrancar exacto donde arranca
  // "FINAL" (y:0.243) — de ahí y:0.22 (0.243 - 0.023). El número entero crece SOLO para abajo
  // con precios de menos dígitos (rango de diseño: 3 a 5 cifras) — hasta el punto medio entre
  // el número y "*CON LA MEJOR POLÍTICA COMERCIAL" (y≈0.65).
  precio: { x: 0.06, y: 0.212, ancho: 0.63, alto: 0.513, align: 'left' },
  // Con 4+ cifras el precio ya ocupa casi toda esta franja (se deja anclado a la izquierda, ver
  // generarCartel). Con menos cifras sobra ancho -- a pedido, se centra entre donde termina el
  // "$" y donde arranca "FINAL" (medido por píxeles contra el arte en blanco: "$" termina en
  // x:0.0688, "FINAL" arranca en x:0.6894).
  precioCentradoEntre: { izq: 0.0688, der: 0.6894 },
  // Casillero de los centavos ("11", "88") — NO van pegados a la derecha de los dígitos
  // enteros: medido por píxeles contra los carteles de referencia, van en su propia columna,
  // centrados EXACTO sobre "FINAL" (que arranca en x:0.6894 y termina en x:0.7919 — centro
  // x:0.74065, de ahí x = centro - ancho/2 = 0.6557) y apilados arriba, con el borde de abajo
  // un poco más cerca de "FINAL" que antes (techoY 0.213→0.225, a pedido, "FINAL" arranca en
  // y:0.243, sigue quedando aire entre los dos).
  // factor: 0.280, confirmado -- ver el historial de ajuste en el comentario de generarCartel.
  decimales: { x: 0.6557, ancho: 0.17, techoY: 0.225, align: 'center', factor: 0.280 },
  // Corrido más a la derecha (antes x:0.35) y agrandada — con la foto de producto renderizada
  // DESPUÉS de la caja del nombre (ver generarCartel en carteleria-render.js), no importa que
  // pise la franja blanca ni la línea divisoria: queda arriba de todo eso, igual que en el diseño
  // real (el pan de la referencia tapa buena parte del cartel de nombre con la parte de abajo de
  // la bolsa).
  // Punto medio entre el 3er y 4to ajuste (y:0.46/0.50 -> 0.48, alto:0.41/0.40 -> 0.405) + más
  // ancho para que la foto (con su relación de aspecto real, sin deformar por objectFit:contain)
  // se vea más grande: ancho 0.33→0.35.
  // Último ajuste: un poco más arriba (y:0.48→0.45→0.42) — a la derecha ya no hay más lugar,
  // x:0.65 con este ancho ya llega justo al borde derecho de la plantilla (x+ancho=1.0).
  imagenProducto: { x: 0.65, y: 0.42, ancho: 0.35, alto: 0.405 },
  // Agrandado al máximo seguro (antes alto:0.075/0.075, y:0.745/0.845) — medido por píxeles
  // contra el arte (cartel_precio_piso.jpg): la franja blanca real va de y:0.743 a y:0.9456
  // (ahí arranca el pie de página negro, medido exacto), este es el límite físico del arte
  // actual — para llegar al tamaño de los carteles de referencia (que tienen el pie de página
  // más abajo) haría falta un archivo de arte nuevo con la franja blanca más alta.
  // Centrado entre el borde izquierdo (x:0) y donde arranca la foto de producto (x:0.65, ver
  // `imagenProducto` arriba) — centro efectivo x:0.325 — a pedido explícito, no en la mitad
  // fija del cartel. Las 2 líneas se siguen centrando cada una por separado adentro de este
  // casillero (ver más abajo), compartiendo este mismo centro.
  nombreLinea1: { x: 0, y: 0.745, ancho: 0.65, alto: 0.09, align: 'center' },
  nombreLinea2: { x: 0, y: 0.85, ancho: 0.65, alto: 0.09, align: 'center' },
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
  // anguloGrados: medido por píxeles contra el borde diagonal de abajo del banner en el arte
  // (cartel_precio_piso.jpg: sube de y:0.161 a y:0.119 entre x:0.03 y x:0.44, ≈-4°) — el texto
  // fijo "¡PRECIOS AL PISO!" sigue esa inclinación; sin rotar, el texto repintado por Depósito
  // quedaba derecho contra un borde en diagonal.
  // OJO: el rectángulo de fondo (colorFondo) tiene que arrancar en y:0 SIEMPRE — es lo que tapa
  // el texto fijo original ("¡PRECIOS AL PISO!"), que llega hasta el mismísimo borde superior de
  // la plantilla (medido por píxeles: y:0.052-0.123). Correr y no tapa una franja arriba y deja
  // asomar el texto viejo. Para bajar el texto NUEVO sin perder esa cobertura, se corre solo el
  // texto con textoOffsetY (fracción de `alto` — ver carteleria-render.js), no el fondo.
  tagPolitica: {
    x: 0.025, y: 0, ancho: 0.35, alto: 0.09, colorFondo: '#e40e16', colorTexto: '#ffe814', lineas: 1,
    anguloGrados: -4, textoOffsetY: 0.22,
  },
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
