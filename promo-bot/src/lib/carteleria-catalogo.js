// Catálogo de fotos de producto SIN fondo, para componer en el hueco de imagen de los
// carteles que lo tienen (nuevo_ingreso, corto_vencimiento). Vive en Supabase Storage (bucket
// "productos", PÚBLICO) — son ~4500 fotos; se subieron con un script aparte (resize a 900px +
// WebP, así entraban cómodas en el free tier) porque 1.4GB en crudo no tenía sentido comitear
// al repo. El bot arma la URL pública directo y la trae por HTTP — NO necesita ninguna key de
// Supabase en runtime (esa key la usa solo, una vez, el script de subida).
//
// Para no tener que listar el bucket en cada cartel (lento, y de a 100/1000 por página), la
// lista de nombres de archivo se cachea en assets/productos-manifest.json (generada por el
// mismo script de subida) y se carga una sola vez por proceso.
//
// Matcheo: primero por CÓDIGO de artículo exacto (la mayoría de los archivos se llaman así, ej.
// "10013 (1).webp" -> código 10013 — viene del maestro bot.articulos cuando Depósito escaneó el
// código de barras o lo tipeó). Si no hay código, o no matchea ninguno, cae a superposición de
// palabras entre el nombre del producto y el nombre del archivo (para los pocos archivos con
// nombre descriptivo en vez de código). Si no hay match de ningún tipo, el cartel queda sin foto
// — mejor sin foto que con una equivocada.
const path = require('path');

const PROJECT_URL = process.env.SUPABASE_STORAGE_URL || 'https://lgxqdycrerxkflwedohw.supabase.co';
const BUCKET = 'productos';
const MANIFEST_PATH = path.join(__dirname, '..', '..', 'assets', 'productos-manifest.json');
const PALABRA_MINIMA = 3; // ignora palabras muy cortas ("x", "de", "c/") al matchear
const PUNTAJE_MINIMO = 2; // con 1 sola palabra en común el match es demasiado poco confiable

// Rango Unicode de marcas diacríticas combinantes (acentos/ñ sueltos después de
// normalize('NFD')). Construido por código de caracter (no como literal en el
// código fuente) para evitar líos de encoding con los propios acentos.
const RANGO_DIACRITICOS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

function normalizar(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD').replace(RANGO_DIACRITICOS, '') // sacar acentos/ñ -> n
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Palabras sin valor distintivo — ni números sueltos ("100", "500": son el gramaje/cantidad,
// aparecen en cientos de productos no relacionados) ni palabras de relleno del español ("bien",
// "para", "con"). Sin esto, cualquiera de estas puede desempatar un match por pura casualidad
// (pasó de verdad: "El producto está BIEN..." matcheó una foto de un brownie "...sabe BIEN...").
// "100g"/"1kg" (alfanuméricos) sí quedan — esos sí distinguen el producto.
// También packaging/formato genérico ("lata", "uni", "gase" -> aparecen en cientos de productos
// de cualquier marca, ej. "uni" está en 660 nombres distintos del maestro) — pasó de verdad:
// "GASE.COCA COLA LATA...UNI" empataba con "CERVEZA BRAHMA LATA...UNI" (2 y 2, "lata"+"uni")
// contra las marcas reales ("coca cola"), y el desempate por orden alfabético elegía cualquier
// cosa que empiece antes con mayúscula.
// "galle"/"alf"/"past" son el mismo problema que "gase": prefijos de categoría abreviados con
// punto ("GALLE.", "ALF.", "PAST.") que aparecen en cientos de productos de cualquier marca
// (conteo real sobre el manifest: "galle" 232 veces, "choco" 274, "alf" 51, "past" 38) — sin
// sacarlos, pesan más que la marca real y hacen ganar a un producto de otra marca que por
// casualidad comparte más de estos genéricos (pasó de verdad: "GALLE.MANA VAINILLA...CHOCO"
// matcheaba "GALLE.COFLER CHOCO...VAINILLA" por "galle"+"choco"+"vainilla", perdiendo contra la
// marca real "mana"). "removebg"/"preview" son artefactos del nombre de archivo que deja la
// herramienta de recorte de fondo (".../foto-removebg-preview.png"), no describen el producto.
const PALABRAS_VACIAS = new Set([
  'los', 'las', 'del', 'con', 'sin', 'por', 'para', 'que', 'una', 'uno', 'esta', 'esto',
  'eso', 'ese', 'esa', 'son', 'hay', 'muy', 'mas', 'bien', 'mal', 'todo', 'toda', 'otro', 'otra',
  'como', 'pero', 'porque',
  'gase', 'lata', 'latas', 'uni', 'unid', 'unidad', 'unidades', 'pack', 'display', 'botella',
  'caja', 'sachet', 'pote', 'sobre', 'bolsa',
  'galle', 'choco', 'alf', 'past', 'removebg', 'preview',
  // "yerba"/"mate" (categoría, no marca): "YERBA MATE PLAYADITO X 1KG" empataba con CUALQUIER
  // otra marca de yerba (canarias, barao, la merced...) por "yerba"+"mate" solos.
  'yerba', 'mate',
  // "(EESS)" es alguna etiqueta interna/administrativa (solo aparece en 2 archivos, ambos de
  // filtros de cigarrillo) — no describe el producto, y por ser rara casi matcheaba productos
  // sin ninguna relación (una bebida "(EESS)LEVITE...") solo por compartir esa etiqueta.
  'eess',
]);
function palabras(texto) {
  return normalizar(texto).split(' ').filter((p) => p.length >= PALABRA_MINIMA && !/^\d+$/.test(p) && !PALABRAS_VACIAS.has(p));
}

// Plural simple ("talitas" vs "talita", "galletas" vs "galleta") — sin esto son palabras
// DISTINTAS para el puntaje, así que un plural de más/de menos entre lo que tipeó Depósito y
// el nombre del archivo le resta coincidencias reales al match correcto y lo empareja con
// candidatos sueltos que no tienen nada que ver (pasó de verdad con "TALITAS URQUIZA PIZZA":
// "talita urquiza pizza.webp" perdía el punto de "talita"/"talitas" y quedaba empatado con
// "talitas urquiza 100g.webp", genérico sin sabor). Heurística liviana, no un stemmer
// completo — alcanza para el caso común de plural regular en español (agregar "s").
// "rell" (abreviatura de "relleno/rellena/rellenas", 52 veces en el manifest) es el mismo
// problema: "GALLE.MANA VAINILLA RELLENAS...152 G" no matcheaba "mana rell 152.webp" (el
// archivo correcto) por ese desacople, y terminaba ganando otra marca por casualidad.
function raiz(palabra) {
  if (palabra === 'rell' || palabra.startsWith('rellen')) return 'rell';
  return palabra.length > 4 && palabra.endsWith('s') ? palabra.slice(0, -1) : palabra;
}

// Números sueltos (talle/cantidad: "354", "500", "1", "75" de "1.75") — quedan afuera del
// puntaje principal en `palabras()` porque aparecen en cientos de productos no relacionados,
// pero SÍ sirven para desempatar entre variantes del MISMO producto en distinto tamaño/envase
// (ver más abajo) — sin esto, "COCA COLA LATA X 354CC" empataba en puntaje con TODOS los
// tamaños de Coca Cola del catálogo (354cc lata, 500cc, 1.75L, 2.25L botella...) y ganaba
// cualquiera de ellos por orden de aparición en el manifest, no el que realmente se pidió.
// Se extraen las corridas de dígitos de CUALQUIER parte del texto (no solo tokens 100%
// numéricos) porque Depósito suele escribirlo pegado ("X354cc", "6X473ml") — con split()
// simple ese "354" quedaría escondido dentro de un token alfanumérico y nunca se vería.
function numerosDe(texto) {
  return new Set(normalizar(texto).match(/\d+/g) || []);
}

// Palabras que cambian el PRODUCTO, no solo lo describen — si el nombre buscado y el archivo no
// coinciden en tener (o no tener) alguna de estas, NUNCA matchean por más palabras en común que
// compartan (pasó de verdad: "COCA COLA" sin más terminaba matcheando "COCA COLA ZERO..." porque
// "gase", "coca", "cola", "lata", "uni" son iguales en los dos nombres — con el conteo simple,
// esas 5 coincidencias pesaban más que la única palabra distinta, "zero").
// Separadas en dos grupos porque no se relajan igual: una variante de LÍNEA (zero/light/...) es
// siempre un producto distinto, así el archivo diga "vs" (varios sabores) o no. Un SABOR en
// cambio puede estar incluido en un archivo "surtido" sin que su nombre lo liste explícitamente
// — ver `esSurtido` más abajo.
const LINEAS_DISTINTAS = ['zero', 'light', 'diet', 'mini', 'maxi', 'free'];

// Sabores comunes en golosinas/bebidas/snacks (kiosco) — un producto puede compartir marca y
// casi todas las demás palabras con otro sabor y aun así ser un producto distinto.
const SABORES = [
  'menta', 'frutilla', 'banana', 'lima', 'limon', 'naranja', 'durazno', 'manzana', 'anana',
  'ananas', 'mango', 'frambuesa', 'arandano', 'cereza', 'uva', 'mora', 'coco', 'cafe',
  'vainilla', 'chocolate', 'miel', 'sandia', 'tutti', 'frutos',
];

// "vs" = "varios sabores/variedades", abreviatura frecuente en el catálogo (87 archivos) para
// fotos de exhibidores/cajas surtidas — ej. "PASTillas MENTHO PLUS vs X 12 UNI". Buscar un
// sabor puntual ("...CEREZA...") no debería descartar ese archivo solo porque no lista "cereza"
// en el nombre: es justamente el que más probablemente lo tenga adentro. Chequea el texto
// normalizado directo (no `palabras()`) porque "vs" tiene 2 letras — PALABRA_MINIMA lo filtraría.
function esSurtido(nombreArchivo) {
  return normalizar(nombreArchivo).split(' ').includes('vs');
}

// Abreviaturas reales de sabor que aparecen en el catálogo ("MTA" en 11 archivos, "MZA" en 5) —
// sin esto, un archivo de un sabor abreviado se veía como "sin sabor" (no dice la palabra
// entera) y pasaba el chequeo de abajo aunque el sabor buscado fuera otro (pasó de verdad:
// "CHICLE MENTOS...FRUTILLA" terminaba matcheando un Beldent de menta abreviada "mta"). Mapa
// chico a propósito — cada entrada tiene que estar confirmada contra el manifest real, no
// adivinada (ej. "van" NO es "vainilla" acá: son cigarrillos "Van Haasen"/"Van Kiff").
const ABREVIATURAS_SABOR = { mta: 'menta', mza: 'manzana' };

function saboresDe(palabrasArchivo) {
  const encontrados = new Set();
  for (const sabor of SABORES) if (palabrasArchivo.has(sabor)) encontrados.add(sabor);
  for (const [abrev, sabor] of Object.entries(ABREVIATURAS_SABOR)) {
    if (palabrasArchivo.has(abrev)) encontrados.add(sabor);
  }
  return encontrados;
}

// Asimétrico a propósito: si el ARCHIVO no nombra ningún sabor (ni completo ni abreviado), no
// lo descartamos por sabor — puede ser una foto genérica del producto sin ese dato en el nombre
// (pasó de verdad: "mana rell 152.webp" no dice "vainilla" y perdía contra otra marca que sí la
// nombraba). Si el archivo SÍ nombra un sabor puntual, tiene que coincidir con lo buscado.
// `m` es la metadata cacheada del archivo (ver metadataCatalogo) — nunca se recalcula
// esSurtido/palabras por archivo en cada búsqueda, esa es la parte cara.
function sonProductosDistintosCache(palabrasProducto, m) {
  for (const linea of LINEAS_DISTINTAS) {
    if (palabrasProducto.has(linea) !== m.palabrasArchivo.has(linea)) return true;
  }
  if (m.surtido) return false;
  const saboresArchivo = saboresDe(m.palabrasArchivo);
  if (!saboresArchivo.size) return false;
  for (const sabor of saboresArchivo) if (!palabrasProducto.has(sabor)) return true;
  return false;
}

let manifestCache = null;
function listarCatalogo() {
  if (manifestCache) return manifestCache;
  try {
    manifestCache = require(MANIFEST_PATH);
  } catch (e) {
    manifestCache = [];
  }
  return manifestCache;
}

// "10013 (1).webp" -> "10013" (el archivo se llama por código de artículo, con un sufijo
// opcional "(N)" cuando hay más de una foto del mismo producto). Si el nombre no es puramente
// numérico (ej. "3 bombones bariloche.webp"), devuelve null — es un archivo con nombre
// descriptivo, se matchea por palabras más abajo.
function codigoDe(archivo) {
  const base = path.parse(archivo).name.replace(/\s*\(\d+\)\s*$/, '').trim();
  return /^\d+$/.test(base) ? base : null;
}

// bot.articulos.codigo viene con ceros a la izquierda (ej. "010013"), los nombres de archivo
// no (ej. "10013.webp") — se compara como número, no como string, para que matcheen igual.
function normalizarCodigo(codigo) {
  const n = Number(codigo);
  return Number.isFinite(n) ? String(n) : String(codigo).trim();
}

// Metadata de cada archivo del catálogo (código, o palabras/raíces/si-es-surtido), calculada
// UNA sola vez por archivo y cacheada — el manifest es estático (se carga una vez por proceso,
// ver listarCatalogo), así que tokenizar cada nombre de archivo en cada búsqueda es trabajo
// repetido de más: con 4551 archivos, cada búsqueda sin código recorre el catálogo entero.
let metadataCache = null;
function metadataCatalogo() {
  if (metadataCache) return metadataCache;
  metadataCache = listarCatalogo().map((archivo) => {
    const codigo = codigoDe(archivo);
    if (codigo) return { archivo, codigo };
    const nombreArchivo = path.parse(archivo).name;
    const palabrasArchivo = new Set(palabras(nombreArchivo));
    return {
      archivo,
      codigo: null,
      nombreArchivo,
      palabrasArchivo,
      raicesArchivo: new Set([...palabrasArchivo].map(raiz)),
      surtido: esSurtido(nombreArchivo),
    };
  });
  return metadataCache;
}

// Match por código exacto — el mismo para archivoMasParecido y archivosCandidatos, y NUNCA
// ambiguo (si hay código, listado a mano por Depósito o leído del código de barras, es la
// fuente más confiable que hay, no tiene sentido preguntarle a Marketing).
function archivoPorCodigo(articuloCodigo) {
  if (!articuloCodigo) return null;
  const codigoBuscado = normalizarCodigo(articuloCodigo);
  const porCodigo = metadataCatalogo()
    .filter((m) => m.codigo && normalizarCodigo(m.codigo) === codigoBuscado)
    .map((m) => m.archivo)
    .sort();
  return porCodigo.length ? porCodigo[0] : null;
}

// Cuántos archivos del catálogo (sin contar los que van por código) contienen cada raíz —
// calculado UNA vez y cacheado, igual que metadataCatalogo. Una palabra rara (aparece en pocos
// archivos, ej. "sprite" en 6) alcanza sola para confiar en un match; una común (ej. "miel" en
// 24, y ya de por sí las de sabor se manejan aparte) no — ver empatePocoConfiable.
let frecuenciaCache = null;
function frecuenciaPalabras() {
  if (frecuenciaCache) return frecuenciaCache;
  frecuenciaCache = new Map();
  for (const m of metadataCatalogo()) {
    if (m.codigo) continue;
    for (const r of m.raicesArchivo) frecuenciaCache.set(r, (frecuenciaCache.get(r) || 0) + 1);
  }
  return frecuenciaCache;
}

// Núcleo del matcheo por superposición de palabras (código exacto ya se resolvió aparte, ver
// archivoPorCodigo) — compartido entre archivoMasParecido y archivosCandidatos para no repetir
// el recorrido completo del catálogo. Devuelve los archivos empatados en el puntaje más alto
// (mejorPuntaje), listos para que cada función de arriba decida qué hacer con el empate.
function candidatosPorPalabras(nombreProducto) {
  const palabrasProducto = new Set(palabras(nombreProducto));
  if (!palabrasProducto.size) return { empatados: [], mejorPuntaje: 0, palabrasProducto };
  const raicesProducto = new Set([...palabrasProducto].map(raiz));

  let mejorPuntaje = 0;
  let empatados = []; // [{ archivo, m }]
  for (const m of metadataCatalogo()) {
    if (m.codigo) continue; // ya se probaron por código arriba
    if (sonProductosDistintosCache(palabrasProducto, m)) continue;
    let coincidencias = 0;
    for (const raizProducto of raicesProducto) {
      if (m.raicesArchivo.has(raizProducto)) coincidencias++;
    }
    if (coincidencias === 0) continue;
    if (coincidencias > mejorPuntaje) {
      mejorPuntaje = coincidencias;
      empatados = [{ archivo: m.archivo, m }];
    } else if (coincidencias === mejorPuntaje) {
      empatados.push({ archivo: m.archivo, m });
    }
  }
  return { empatados, mejorPuntaje, palabrasProducto };
}

// Con 1 sola palabra en común hay demasiadas chances de que sea casualidad, no el producto
// real (pasó de verdad varias veces: "cereza" o "baggio" sueltos matcheaban cualquier cosa) —
// EXCEPTO cuando esa palabra sola ya alcanza para confiar:
//   (a) es TODO el contenido distintivo de ambos lados (nombre buscado Y archivo se reducen los
//       dos a esa misma palabra — ej. "WD-40 AEROSOL..." contra "WD-40 AEROSOL....webp"), o
//   (b) es una palabra RARA en todo el catálogo (aparece en pocos archivos — ej. "sprite" en
//       6, "vimar" en 12) y no es de sabor/línea (esas ya se manejan aparte, ver
//       sonProductosDistintosCache — un sabor raro igual no identifica el PRODUCTO, solo un
//       atributo que puede compartir cualquier otra marca).
// Auditoría real contra el maestro (bot.articulos, 3241 productos) mostró que sin (b) el 20% del
// catálogo quedaba "sin foto" — pero 609 de esos 663 sí tenían un candidato de 1 sola palabra,
// muchos tan confiables como "sprite" (marca única, sin ambigüedad posible).
const PALABRA_RARA_MAXIMA = 8;

// Adjetivos/descriptores genéricos de tamaño o presentación — son raros en el catálogo por
// PURA CASUALIDAD (no porque identifiquen una marca/producto puntual), así que la regla de
// "palabra rara" de arriba los tomaba como si fueran un "sprite" y armaba matches sin sentido
// (pasó de verdad: "CAFE...MOLIDO MEDIO" matcheaba tampones por "medio"; "DURACELL...GRANDE"
// matcheaba nachos por "grande"; "(EESS)LEVITE..." matcheaba filtros de cigarrillo). Cualquier
// producto real puede ser "grande"/"original"/"clásico", así que solos no dicen nada de CUÁL es.
const DESCRIPTORES_GENERICOS = new Set([
  'grande', 'grandes', 'chico', 'chica', 'chicos', 'chicas', 'mediano', 'mediana', 'medio', 'media',
  'blister', 'extra', 'original', 'originales', 'clasico', 'clasica', 'especial', 'especiales',
  'tradicional', 'individual', 'super', 'nuevo', 'nueva', 'nuevos', 'nuevas', 'molido', 'molida',
  'premium', 'simple', 'doble', 'triple', 'surtido', 'surtidos', 'varios', 'normal', 'regular',
  'estandar', 'economico',
]);

// Un token alfanumérico que empieza con dígito ("600cc", "1kg") es un TALLE, no una marca — sirve
// para desempatar entre variantes de un mismo producto (ver numerosDe/desempatarPorNumeros), pero
// solo, no dice nada de CUÁL producto es (pasó de verdad: "GASE.SPRITE...600CC" casi matcheaba
// "manaos cola 600cc.webp" — otra gaseosa distinta, incidentalmente del mismo tamaño).
function esTalle(palabra) {
  return /^\d/.test(palabra);
}

function esPalabraDeAtributo(palabra) {
  return SABORES.includes(palabra) || LINEAS_DISTINTAS.includes(palabra)
    || Object.prototype.hasOwnProperty.call(ABREVIATURAS_SABOR, palabra)
    || DESCRIPTORES_GENERICOS.has(palabra) || esTalle(palabra);
}

function empatePocoConfiable(empatados, mejorPuntaje, palabrasProducto) {
  if (mejorPuntaje >= PUNTAJE_MINIMO) return null;
  if (mejorPuntaje !== 1) return [];
  const frecuencias = frecuenciaPalabras();
  const confiables = empatados.filter(({ m }) => {
    if (m.palabrasArchivo.size === 1 && palabrasProducto.size === 1) return true;
    const palabraCompartida = [...palabrasProducto].find((p) => m.raicesArchivo.has(raiz(p)));
    if (!palabraCompartida || esPalabraDeAtributo(palabraCompartida)) return false;
    return (frecuencias.get(raiz(palabraCompartida)) || 0) <= PALABRA_RARA_MAXIMA;
  });
  return confiables.map((e) => e.archivo);
}

// Desempate por talle/cantidad (pasa seguido: "coca cola" matchea todas las variantes de
// tamaño) — devuelve TODOS los que quedan mejor parados, que puede seguir siendo más de uno
// (ver archivosCandidatos) si ninguno tiene un número que lo distinga de los demás.
function desempatarPorNumeros(empatados, nombreProducto) {
  const numerosProducto = numerosDe(nombreProducto);
  const conSolape = empatados.map(({ archivo }) => {
    const numerosArchivo = numerosDe(path.parse(archivo).name);
    let solape = 0;
    for (const n of numerosProducto) if (numerosArchivo.has(n)) solape++;
    return { archivo, solape };
  });
  const mejorSolape = Math.max(...conSolape.map((e) => e.solape));
  return conSolape.filter((e) => e.solape === mejorSolape).map((e) => e.archivo);
}

// Varios archivos del mismo producto (fotos distintas del mismo artículo, típicamente con
// sufijo "(1)"/"(2)", o nombrado con alguna diferencia menor de mayúscula/plural) tienen las
// mismas palabras reales — eso NO es ambigüedad de producto, es la misma foto repetida, y
// mostrárselo a Marketing como "elegí entre estas 3" sería confuso (pasó de verdad: "COCA COLA
// LATA 354CC" quedaba con 3 "candidatos" que eran la misma lata; "GALLE.TRIO PEPAS" con 2 que
// diferían solo en "pepas"/"pepa"). Misma raíz que usa el puntaje (`raiz`, plural-insensible) —
// nos quedamos con 1 archivo por cada combinación distinta de palabras reales.
function sinFotosRepetidas(archivos) {
  const vistos = new Set();
  const unicos = [];
  for (const archivo of archivos) {
    const firma = [...palabras(path.parse(archivo).name)].map(raiz).sort().join('|');
    if (vistos.has(firma)) continue;
    vistos.add(firma);
    unicos.push(archivo);
  }
  return unicos;
}

// Devuelve el nombre de archivo (en el bucket) que mejor matchea, o null si no hay ninguno.
// Ante un empate, elige uno solo (con el mejor desempate posible) — para el uso normal, donde
// hace falta una sola foto. Ver `archivosCandidatos` para el caso en que el empate es real y
// conviene preguntarle a Marketing en vez de adivinar.
function archivoMasParecido(nombreProducto, articuloCodigo) {
  if (!listarCatalogo().length) return null;
  const porCodigo = archivoPorCodigo(articuloCodigo);
  if (porCodigo) return porCodigo;

  const { empatados, mejorPuntaje, palabrasProducto } = candidatosPorPalabras(nombreProducto);
  if (!palabrasProducto.size) return null;
  const pocoConfiable = empatePocoConfiable(empatados, mejorPuntaje, palabrasProducto);
  if (pocoConfiable) return pocoConfiable[0] || null;
  if (empatados.length === 1) return empatados[0].archivo;

  return desempatarPorNumeros(empatados, nombreProducto)[0];
}

// Como archivoMasParecido, pero cuando el matcheo automático queda ambiguo entre 2 o más fotos
// igual de buenas (incluso después de desempatar por talle/cantidad), devuelve esas opciones en
// vez de adivinar una sola — así Marketing puede elegir a mano cuál es la correcta en vez de
// tener que corregir todo el cartel después (ver scenes/carteleria.js). Con código de artículo
// exacto, o con un solo candidato claro, nunca es ambiguo: devuelve un array de 1 elemento. Sin
// ningún match, array vacío — el llamador decide si eso significa "sin foto" o "no preguntar".
function archivosCandidatos(nombreProducto, articuloCodigo, max = 4) {
  if (!listarCatalogo().length) return [];
  const porCodigo = archivoPorCodigo(articuloCodigo);
  if (porCodigo) return [porCodigo];

  const { empatados, mejorPuntaje, palabrasProducto } = candidatosPorPalabras(nombreProducto);
  if (!palabrasProducto.size) return [];
  const pocoConfiable = empatePocoConfiable(empatados, mejorPuntaje, palabrasProducto);
  if (pocoConfiable) return pocoConfiable;
  if (empatados.length === 1) return [empatados[0].archivo];

  const desempatados = sinFotosRepetidas(desempatarPorNumeros(empatados, nombreProducto));
  return desempatados.slice(0, max);
}

// Baja el Buffer de UNA foto del catálogo, o null si falla la descarga.
async function descargarFoto(archivo) {
  try {
    const url = `${PROJECT_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(archivo)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error('No pude bajar la imagen del catálogo:', e.message);
    return null;
  }
}

// Devuelve el Buffer de la foto del catálogo que mejor matchea, o null si no hay ninguna
// coincidencia (catálogo vacío, o ningún archivo comparte código/palabras).
async function buscarImagenProducto(nombreProducto, articuloCodigo) {
  const archivo = archivoMasParecido(nombreProducto, articuloCodigo);
  return archivo ? descargarFoto(archivo) : null;
}

// Como buscarImagenProducto, pero devuelve TODOS los Buffers candidatos cuando el matcheo
// queda ambiguo (ver archivosCandidatos) — 1 solo Buffer si el match es confiable, ninguno si
// no hay match. Descartar (sin frenar todo) las que fallen la descarga individualmente.
async function buscarImagenesCandidatas(nombreProducto, articuloCodigo, max = 4) {
  const archivos = archivosCandidatos(nombreProducto, articuloCodigo, max);
  const buffers = await Promise.all(archivos.map(descargarFoto));
  return buffers.filter(Boolean);
}

module.exports = {
  buscarImagenProducto, buscarImagenesCandidatas, listarCatalogo, archivoMasParecido, archivosCandidatos,
};
