// Redimensiona (máx 900px, sin agrandar) + convierte a WebP (calidad 82) cada foto de
// ARTICULOS/ (carpeta local, NO se commitea — ver .gitignore) y la sube a Supabase Storage
// (bucket "productos", público). Al final escribe assets/productos-manifest.json, la lista de
// nombres de archivo que lee el bot para matchear (ver src/lib/carteleria-catalogo.js) — así el
// bot nunca necesita listar el bucket ni tener ninguna key de Supabase en runtime.
//
// Uso:  SUPABASE_SERVICE_KEY=<la key secreta, Settings > API > service_role> node scripts/subir-catalogo.js
// La key NUNCA va en .env — solo hace falta acá, una vez, para subir. El bot en runtime usa
// SUPABASE_STORAGE_URL (esa sí en .env/Railway) para armar URLs públicas, sin key.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROJECT_URL = process.env.SUPABASE_STORAGE_URL || 'https://lgxqdycrerxkflwedohw.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'productos';
const DIR = path.join(__dirname, '..', 'ARTICULOS');
const MANIFEST_OUT = path.join(__dirname, '..', 'assets', 'productos-manifest.json');
const CONCURRENCIA = 20;

if (!SERVICE_KEY) {
  console.error('Falta SUPABASE_SERVICE_KEY. Uso: SUPABASE_SERVICE_KEY=<key> node scripts/subir-catalogo.js');
  process.exit(1);
}

async function crearBucketSiNoExiste() {
  const res = await fetch(`${PROJECT_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BUCKET, public: true }),
  });
  // 200 = creado; 400 "already exists" = ya estaba, ambos están OK acá.
  if (!res.ok) {
    const texto = await res.text();
    if (!texto.includes('already exists')) throw new Error(`No pude crear el bucket: HTTP ${res.status}: ${texto}`);
  }
}

// Supabase Storage rechaza keys con acentos/ñ/"%" ("InvalidKey") — sacamos los diacríticos
// (á -> a, ñ -> n) y cualquier otro caracter fuera de un set seguro, preservando may/min y
// espacios para que el archivo se siga leyendo bien en el matcheo por palabras.
// Rango construido por código de caracter (no como literal) para evitar líos de encoding.
const RANGO_DIACRITICOS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');
function sanearNombreDestino(nombre) {
  return nombre
    .normalize('NFD').replace(RANGO_DIACRITICOS, '')
    .replace(/[^a-zA-Z0-9 ()._-]/g, '');
}

async function subirArchivo(nombreOrigen) {
  const buffer = await sharp(path.join(DIR, nombreOrigen))
    .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const nombreDestino = sanearNombreDestino(nombreOrigen.replace(/\.\w+$/, '')) + '.webp';
  const res = await fetch(`${PROJECT_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(nombreDestino)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      'Content-Type': 'image/webp',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return nombreDestino;
}

async function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`No encontré la carpeta ${DIR}. Poné ahí las fotos originales del catálogo antes de correr esto.`);
    process.exit(1);
  }
  await crearBucketSiNoExiste();

  const archivos = fs.readdirSync(DIR).filter((a) => /\.(png|jpe?g|webp)$/i.test(a));
  console.log(`Total a subir: ${archivos.length}`);

  const subidos = [];
  const fallidos = [];
  let hechos = 0;

  for (let i = 0; i < archivos.length; i += CONCURRENCIA) {
    const lote = archivos.slice(i, i + CONCURRENCIA);
    const resultados = await Promise.allSettled(lote.map(subirArchivo));
    resultados.forEach((r, idx) => {
      if (r.status === 'fulfilled') subidos.push(r.value);
      else fallidos.push({ archivo: lote[idx], error: r.reason.message });
    });
    hechos += lote.length;
    if (hechos % 200 === 0 || hechos === archivos.length) {
      console.log(`${hechos}/${archivos.length} procesados (${subidos.length} OK, ${fallidos.length} fallidos)`);
    }
  }

  fs.writeFileSync(MANIFEST_OUT, JSON.stringify(subidos.sort(), null, 0));
  console.log(`\nListo. ${subidos.length} subidas OK, ${fallidos.length} fallidas.`);
  console.log(`Manifest escrito en ${MANIFEST_OUT}`);
  if (fallidos.length) {
    console.log('Fallidos (reintentá corriendo el script de nuevo, es idempotente):');
    console.log(JSON.stringify(fallidos, null, 2));
  }
}

main().catch((e) => { console.error('FALLO GENERAL', e); process.exit(1); });
