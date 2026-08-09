// Tests del reparto manual/automático de plataformas (plataformasManuales, src/lib/plataformas.js).
// Es la fuente ÚNICA que usan /carga y el aviso de las 21:30 para saber qué reclamar: Talo se baja
// sola por API, así que NO se reclama ni se pide; Mercado Pago sí. Si esto se rompe, /carga volvería
// a pedir Talo (el bug que originó este arreglo) o dejaría de pedir MP. Correr: node test/plataformas.test.js
const assert = require('assert');
const { PLATAFORMAS, plataformasManuales } = require('../src/lib/plataformas');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

t('Talo (bajaPorApi) NO está entre las manuales', () => {
  const cods = plataformasManuales().map((p) => p.codigo);
  assert.ok(!cods.includes('talo'), 'Talo se baja por API: no debe reclamarse ni pedirse a mano');
});

t('Mercado Pago (manual) SÍ está entre las manuales', () => {
  const cods = plataformasManuales().map((p) => p.codigo);
  assert.ok(cods.includes('mp'), 'MP se sube a mano: tiene que reclamarse');
});

t('manuales = exactamente las que NO tienen bajaPorApi (coherente con PLATAFORMAS)', () => {
  const esperadas = PLATAFORMAS.filter((p) => !p.bajaPorApi).map((p) => p.codigo).sort();
  const obtenidas = plataformasManuales().map((p) => p.codigo).sort();
  assert.deepStrictEqual(obtenidas, esperadas);
});

t('hay al menos una plataforma por API (si no, el arreglo no tendría sentido)', () => {
  assert.ok(PLATAFORMAS.some((p) => p.bajaPorApi), 'esperaba al menos una plataforma con bajaPorApi (Talo)');
});

console.log(`\n${pass} tests OK`);
