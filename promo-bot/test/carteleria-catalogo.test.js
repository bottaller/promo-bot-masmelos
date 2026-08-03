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

console.log('archivoMasParecido(): "galle"/"choco" no deben pesar más que la marca real');
t('marca conocida (sesamo) no se pierde entre el ruido de "galle"', () => {
  const archivo = archivoMasParecido('GALLE.SESAMO GRANIX X 175 G');
  assert.match(archivo, /sesamo/i);
});
t('marca real (mana) le gana a otra marca (cofler) que solo comparte sabor/descriptores', () => {
  // "mana rell 152.webp" no dice "vainilla" — antes perdía contra "GALLE.COFLER...VAINILLA"
  // por compartir sabor+descriptor con la marca buscada, aunque la marca en sí no coincidiera.
  const archivo = archivoMasParecido('GALLE.MANA VAINILLA RELLENAS CHOCO X 152 G');
  assert.match(archivo, /mana/i);
});

console.log('archivoMasParecido(): "vs" (varios sabores) no descarta un sabor puntual pedido');
t('"Mentho Plus" + sabor puntual matchea el archivo "vs" (surtido) de esa marca', () => {
  const archivo = archivoMasParecido('PAST.MENTHO PLUS S/AZU CEREZA X 12 UNI');
  assert.match(archivo, /mentho/i);
});

console.log('archivoMasParecido(): abreviatura de sabor ("mta"=menta) sigue distinguiendo sabores');
t('sabor pedido (frutilla) no matchea un archivo de otro sabor abreviado (mta=menta)', () => {
  const archivo = archivoMasParecido('CHICLE MENTOS BOT FRUTILLA 6 UNI X 56 G');
  assert.ok(!archivo || !/mta|menta/i.test(archivo));
});

console.log('archivoMasParecido(): con 1 sola palabra en común, mejor sin foto que con una mal');
t('nombre sin ningún candidato fuerte -> null, no una foto cualquiera', () => {
  // La marca real ("zqwxy", inventada) no está en ningún archivo; "shampoo"/"anticaspa" son
  // genéricas y no alcanzan solas -> null, no agarra un shampoo cualquiera. (El ejemplo anterior,
  // "CHOCOLATADA BAGGIO", dejó de servir: al renombrar el catálogo contra el maestro, ese producto
  // pasó a tener su foto exacta y ahora SÍ matchea — que es lo correcto.)
  const archivo = archivoMasParecido('SHAMPOO ZQWXY ANTICASPA X 400 ML');
  assert.strictEqual(archivo, null);
});
t('EXCEPCIÓN: 1 sola palabra pero es TODO el nombre de ambos lados -> match exacto, no null', () => {
  // "wd"/"40" no cuentan como palabra (ver numerosDe/PALABRA_MINIMA) — "aerosol" es la única
  // palabra real de los dos lados, y con eso alcanza porque no queda nada más que pueda estar mal.
  const archivo = archivoMasParecido('WD-40 AEROSOL X 155 G.');
  assert.match(archivo, /wd-40/i);
});
t('EXCEPCIÓN: nombre de marca inventado de una sola palabra ("chocopamela") matchea exacto', () => {
  const archivo = archivoMasParecido('GALLE.CHOCOPAMELA 29 X 170 G');
  assert.match(archivo, /chocopamela/i);
});

console.log(`\n${pass} tests OK`);
