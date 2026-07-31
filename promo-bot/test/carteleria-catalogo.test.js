// Tests del matcheo de fotos de catálogo (src/lib/carteleria-catalogo.js). Corren contra el
// manifest real del repo (assets/productos-manifest.json) — determinísticos, sin red ni DB.
// Correr: node test/carteleria-catalogo.test.js
const assert = require('assert');
const { archivoMasParecido } = require('../src/lib/carteleria-catalogo');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

console.log('archivoMasParecido(): talle/envase (números, aunque estén pegados a letras)');
t('lata 354cc no matchea la botella de 1.75L del mismo producto', () => {
  const archivo = archivoMasParecido('GASE.COCA COLA LATA 6 UNI X 354 CC');
  assert.match(archivo, /354/);
});
t('talle pegado sin espacio ("X354cc") también desempata por número', () => {
  const archivo = archivoMasParecido('Coca Cola Lata X354cc x unidad');
  assert.match(archivo, /354/);
});
t('otro talle pedido (2.25L) matchea su propio archivo, no el de 354cc', () => {
  const archivo = archivoMasParecido('COCA COLA 2.25 LTS');
  assert.match(archivo, /2\.25/);
});
t('sin talle en el nombre, no rompe (cae a algún candidato válido)', () => {
  const archivo = archivoMasParecido('COCA COLA');
  assert.match(archivo, /coca cola/i);
});

console.log('archivoMasParecido(): variantes de línea (zero) siguen sin cruzarse');
t('"Coca Cola" a secas no matchea la versión Zero', () => {
  const archivo = archivoMasParecido('COCA COLA');
  assert.ok(!/zero/i.test(archivo));
});
t('"Coca Cola Zero" matchea una foto Zero', () => {
  const archivo = archivoMasParecido('COCA COLA ZERO');
  assert.match(archivo, /zero/i);
});
t('"Coca Cola Zero" + talle elige el Zero de ESE talle, no cualquier Zero', () => {
  const archivo = archivoMasParecido('COCA COLA ZERO 354 LATA');
  assert.match(archivo, /zero/i);
  assert.match(archivo, /354/);
});

console.log('archivoMasParecido(): plural no debe perder el sabor/variante específica');
t('"TALITAS" (plural) matchea el archivo "talita" (singular) del mismo sabor', () => {
  const archivo = archivoMasParecido('TALITAS URQUIZA PIZZA X 100 G');
  assert.match(archivo, /pizza/i);
});
t('otro sabor de la misma marca matchea su propio archivo', () => {
  const archivo = archivoMasParecido('TALITAS URQUIZA QUESO');
  assert.match(archivo, /queso/i);
});

console.log(`\n${pass} tests OK`);
