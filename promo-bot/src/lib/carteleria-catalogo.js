// Catálogo de fotos de producto SIN fondo (assets/productos/), para componer en
// el hueco de imagen de los carteles que lo tienen (nuevo_ingreso, corto_vencimiento).
//
// La foto que sube Depósito por /carteleria NUNCA se compone directo en el cartel:
// solo sirve para que la IA identifique de qué producto se trata (carteleria-vision.js).
// Con ese nombre se busca acá la foto ya limpia correspondiente. Si no hay una que
// matchee, el cartel queda sin foto — no se usa la foto cruda (con fondo) como
// respaldo.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'assets', 'productos');
const EXTENSIONES_VALIDAS = /\.(jpe?g|png|webp)$/i;
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

function palabras(texto) {
  return normalizar(texto).split(' ').filter((p) => p.length >= PALABRA_MINIMA);
}

function listarCatalogo() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => EXTENSIONES_VALIDAS.test(f));
}

// Matcheo por superposición de palabras entre el nombre del producto y el nombre
// del archivo (sin extensión). Devuelve el archivo con más palabras en común: si
// ninguno comparte ni una palabra, no hay match (null) — mejor sin foto que con
// una equivocada.
function archivoMasParecido(nombreProducto) {
  const archivos = listarCatalogo();
  if (!archivos.length) return null;
  const palabrasProducto = new Set(palabras(nombreProducto));
  if (!palabrasProducto.size) return null;

  let mejorArchivo = null;
  let mejorPuntaje = 0;
  for (const archivo of archivos) {
    const palabrasArchivo = new Set(palabras(path.parse(archivo).name));
    let coincidencias = 0;
    for (const palabra of palabrasProducto) {
      if (palabrasArchivo.has(palabra)) coincidencias++;
    }
    if (coincidencias > mejorPuntaje) {
      mejorPuntaje = coincidencias;
      mejorArchivo = archivo;
    }
  }
  return mejorArchivo;
}

// Devuelve el Buffer de la foto del catálogo que mejor matchea `nombreProducto`,
// o null si no hay ninguna coincidencia (catálogo vacío, o ningún archivo
// comparte palabras con el nombre).
async function buscarImagenProducto(nombreProducto) {
  const archivo = archivoMasParecido(nombreProducto);
  if (!archivo) return null;
  try {
    return fs.readFileSync(path.join(DIR, archivo));
  } catch (e) {
    console.error('No pude leer la imagen del catálogo:', e.message);
    return null;
  }
}

module.exports = { buscarImagenProducto, listarCatalogo };
