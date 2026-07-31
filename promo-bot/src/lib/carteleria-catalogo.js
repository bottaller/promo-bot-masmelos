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
const PALABRAS_VACIAS = new Set([
  'los', 'las', 'del', 'con', 'sin', 'por', 'para', 'que', 'una', 'uno', 'esta', 'esto',
  'eso', 'ese', 'esa', 'son', 'hay', 'muy', 'mas', 'bien', 'mal', 'todo', 'toda', 'otro', 'otra',
  'como', 'pero', 'porque',
  'gase', 'lata', 'latas', 'uni', 'unid', 'unidad', 'unidades', 'pack', 'display', 'botella',
  'caja', 'sachet', 'pote', 'sobre', 'bolsa',
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
function raiz(palabra) {
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
const PALABRAS_DISTINTIVAS = [
  // variantes de línea (cambian el producto, no solo lo describen)
  'zero', 'light', 'diet', 'mini', 'maxi', 'free',
  // sabores comunes en golosinas/bebidas/snacks (kiosco) — un producto puede compartir marca y
  // casi todas las demás palabras con otro sabor y aun así ser un producto distinto
  'menta', 'frutilla', 'banana', 'lima', 'limon', 'naranja', 'durazno', 'manzana', 'anana',
  'ananas', 'mango', 'frambuesa', 'arandano', 'cereza', 'uva', 'mora', 'coco', 'cafe',
  'vainilla', 'chocolate', 'miel', 'sandia', 'tutti', 'frutos',
];

function sonProductosDistintos(palabrasProducto, palabrasArchivo) {
  for (const distintiva of PALABRAS_DISTINTIVAS) {
    if (palabrasProducto.has(distintiva) !== palabrasArchivo.has(distintiva)) return true;
  }
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

// Devuelve el nombre de archivo (en el bucket) que mejor matchea, o null si no hay ninguno.
function archivoMasParecido(nombreProducto, articuloCodigo) {
  const archivos = listarCatalogo();
  if (!archivos.length) return null;

  if (articuloCodigo) {
    const codigoBuscado = normalizarCodigo(articuloCodigo);
    const porCodigo = archivos.filter((a) => codigoDe(a) && normalizarCodigo(codigoDe(a)) === codigoBuscado).sort();
    if (porCodigo.length) return porCodigo[0];
  }

  const palabrasProducto = new Set(palabras(nombreProducto));
  if (!palabrasProducto.size) return null;

  let mejorPuntaje = 0;
  let empatados = [];
  for (const archivo of archivos) {
    if (codigoDe(archivo)) continue; // ya se probaron por código arriba
    const palabrasArchivo = new Set(palabras(path.parse(archivo).name));
    if (sonProductosDistintos(palabrasProducto, palabrasArchivo)) continue;
    const raicesArchivo = new Set([...palabrasArchivo].map(raiz));
    let coincidencias = 0;
    for (const palabra of palabrasProducto) {
      if (raicesArchivo.has(raiz(palabra))) coincidencias++;
    }
    if (coincidencias === 0) continue;
    if (coincidencias > mejorPuntaje) {
      mejorPuntaje = coincidencias;
      empatados = [archivo];
    } else if (coincidencias === mejorPuntaje) {
      empatados.push(archivo);
    }
  }
  if (!empatados.length) return null;
  if (empatados.length === 1) return empatados[0];

  // Empate por palabras reales (pasa seguido: "coca cola" matchea todas las variantes de
  // tamaño) — desempatar por talle/cantidad, que es justo lo que distingue a esas variantes.
  const numerosProducto = numerosDe(nombreProducto);
  let mejorArchivo = empatados[0];
  let mejorSolapeNumeros = -1;
  for (const archivo of empatados) {
    const numerosArchivo = numerosDe(path.parse(archivo).name);
    let solape = 0;
    for (const n of numerosProducto) if (numerosArchivo.has(n)) solape++;
    if (solape > mejorSolapeNumeros) {
      mejorSolapeNumeros = solape;
      mejorArchivo = archivo;
    }
  }
  return mejorArchivo;
}

// Devuelve el Buffer de la foto del catálogo que mejor matchea, o null si no hay ninguna
// coincidencia (catálogo vacío, o ningún archivo comparte código/palabras).
async function buscarImagenProducto(nombreProducto, articuloCodigo) {
  const archivo = archivoMasParecido(nombreProducto, articuloCodigo);
  if (!archivo) return null;
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

module.exports = { buscarImagenProducto, listarCatalogo, archivoMasParecido };
