// Agrega UNA sola foto al catálogo de productos (Supabase Storage, bucket "productos"), sin
// tocar las demás ~4500 fotos ni pasar por el resync completo de subir-catalogo.js (que
// regenera assets/productos-manifest.json desde CERO listando la carpeta local ARTICULOS/ --
// si esa carpeta no está completa localmente, correrlo rompería el manifest de todo lo demás).
// Este script busca el nombre real del producto en bot.articulos por código (para que el
// archivo quede nombrado EXACTAMENTE con la misma convención que el resto del catálogo,
// "CODIGO NOMBRE.webp" -- ver carteleria-catalogo.js), procesa la imagen igual que
// subir-catalogo.js (resize 900px + WebP calidad 82), la sube, y AGREGA (no reemplaza) esa
// entrada al manifest existente.
//
// Uso: SUPABASE_SERVICE_KEY=<key secreta, Settings > API > service_role> \
//      node scripts/agregar-foto-catalogo.js <codigoArticulo> <rutaImagenLocal>
// La key NUNCA va en .env por defecto -- ver el comentario de subir-catalogo.js.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { pool } = require('../src/db/pool');

const PROJECT_URL = process.env.SUPABASE_STORAGE_URL || 'https://lgxqdycrerxkflwedohw.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'productos';
const MANIFEST_PATH = path.join(__dirname, '..', 'assets', 'productos-manifest.json');

const RANGO_DIACRITICOS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');
function sanearNombreDestino(nombre) {
  return nombre.normalize('NFD').replace(RANGO_DIACRITICOS, '').replace(/[^a-zA-Z0-9 ()._-]/g, '');
}

async function main() {
  const [codigo, rutaImagen] = process.argv.slice(2);
  if (!SERVICE_KEY) { console.error('Falta SUPABASE_SERVICE_KEY.'); process.exit(1); }
  if (!codigo || !rutaImagen) { console.error('Uso: node scripts/agregar-foto-catalogo.js <codigoArticulo> <rutaImagenLocal>'); process.exit(1); }
  if (!fs.existsSync(rutaImagen)) { console.error(`No encontré el archivo: ${rutaImagen}`); process.exit(1); }

  const { rows } = await pool.query('select codigo, nombre from bot.articulos where codigo = $1', [codigo]);
  if (!rows.length) { console.error(`No encontré el código ${codigo} en bot.articulos.`); process.exit(1); }
  const { nombre } = rows[0];
  console.log(`Producto: ${codigo} ${nombre}`);

  const buffer = await sharp(rutaImagen)
    .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }) // por si trae alpha -- el catálogo espera fondo sólido, no transparencia
    .webp({ quality: 82 })
    .toBuffer();

  const nombreDestino = sanearNombreDestino(`${codigo} ${nombre}`) + '.webp';
  console.log(`Subiendo como: ${nombreDestino}`);

  const res = await fetch(`${PROJECT_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(nombreDestino)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': 'image/webp', 'x-upsert': 'true' },
    body: buffer,
  });
  if (!res.ok) { console.error(`FALLO al subir: HTTP ${res.status}: ${await res.text()}`); process.exit(1); }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (!manifest.includes(nombreDestino)) {
    manifest.push(nombreDestino);
    manifest.sort();
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 0));
    console.log(`Agregada al manifest (${manifest.length} archivos en total ahora).`);
  } else {
    console.log('Ya estaba en el manifest (se sobrescribió la foto en el bucket, x-upsert).');
  }

  console.log('Listo.');
  await pool.end();
}

main().catch((e) => { console.error('FALLO GENERAL', e); process.exit(1); });
