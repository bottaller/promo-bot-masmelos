# Catálogo de fotos de producto

Fotos de producto **ya limpias** (sin fondo, o con fondo transparente) para componer en
los carteles que tienen hueco de imagen (`nuevo_ingreso`, `corto_vencimiento`). El bot
**no** usa la foto que sube Depósito por `/carteleria` para esto — esa foto es del
código de barras, solo sirve para identificar el producto; la imagen del cartel
siempre sale de este catálogo.

## Dónde viven las fotos

**No están en esta carpeta ni en el repo.** Son ~4500 fotos (~1.4GB en crudo) —
demasiado para comitear a git. Viven en **Supabase Storage**, bucket `productos`
(público — el bot las trae por `fetch()` a la URL pública, sin ninguna key).

- `scripts/subir-catalogo.js` — redimensiona (máx 900px) + convierte a WebP cada foto
  de una carpeta local `ARTICULOS/` (gitignoreada) y las sube al bucket. Se corre a
  mano cuando hay fotos nuevas: `SUPABASE_SERVICE_KEY=<service_role, Settings > API> node scripts/subir-catalogo.js`
  (la key es solo para subir, nunca queda guardada en ningún `.env`).
- `assets/productos-manifest.json` — la lista de nombres de archivo que quedaron en el
  bucket, generada por ese mismo script. El bot la carga una sola vez por proceso (sin
  red) para no tener que listar el bucket en cada cartel — si subís fotos nuevas,
  hace falta volver a correr el script para que el manifest se actualice.
- `SUPABASE_STORAGE_URL` (`.env` / Railway) — URL del proyecto, para armar la URL
  pública de cada foto.

## Cómo se buscan

`src/lib/carteleria-catalogo.js` matchea en dos pasos:

1. **Por código de artículo** (primero) — la mayoría de los archivos se llaman por el
   código del maestro `bot.articulos` (ej. `10013 (1).webp` → código `10013`, con un
   sufijo `(N)` cuando hay más de una foto del mismo producto). Si Depósito identificó
   el producto por código de barras o código a mano, se busca un archivo con ese
   código exacto.
2. **Por nombre** (si no hay código, o no matcheó ninguno) — superposición de palabras
   entre el nombre del producto y el nombre de archivo (sin extensión), para los pocos
   archivos con nombre descriptivo en vez de código. No hace falta que coincida exacto.

Si no hay match de ningún tipo, el cartel queda **sin foto** — nunca se usa una imagen
"parecida a lo loco".

Ejemplos de nombres de archivo que matchean por nombre:

```
beldent menta.webp          -> matchea "Beldent Chicles Menta Sin Azúcar"
toddy stick 400g.webp       -> matchea "Toddy Stick x 400g"
yerba playadito 1kg.webp    -> matchea "Yerba Mate Playadito x 1kg"
```

## Formato

- Al subir con `scripts/subir-catalogo.js`, todo se normaliza a WebP calidad 82,
  máximo 900px de lado — de sobra para el hueco de imagen más grande que usan las
  plantillas (~950px). Acepta `.jpg`, `.jpeg`, `.png` o `.webp` como entrada.
- Si el archivo original tiene transparencia, se respeta (se ve el fondo de la
  plantilla). Con fondo sólido, ese fondo tapa la plantilla en el hueco de imagen —
  para mejor resultado, las fotos de origen deberían tener fondo transparente o
  blanco liso.
