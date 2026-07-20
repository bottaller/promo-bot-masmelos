// Tests del gate del cierre diferido: con qué libros presentes se puede conciliar y con cuáles
// el cierre queda esperando. Es la decisión que separa "todavía falta el libro" (no entregar,
// avisar) de "listo, concilio y entrego" — si se equivoca, o entrega un cierre incompleto o deja
// uno bueno colgado para siempre.
//   node test/completar-cierre.test.js
const assert = require('assert');

// completar-cierre importa la capa DB (pool.js), que exige DATABASE_URL. Se pone una ficticia:
// decidirEstado es puro y no consulta nada, pero el require del módulo la necesita.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';

const { decidirEstado } = require('../src/lib/completar-cierre');

let pass = 0;
function t(nombre, fn) {
  try { fn(); pass++; console.log(`  ok: ${nombre}`); }
  catch (e) { console.error(`  FALLA: ${nombre}\n    ${e.message}`); process.exitCode = 1; }
}

const ayer = new Date(2026, 6, 17); // 17/07/2026 (mes 0-based)

console.log('decidirEstado(): primer cierre');
t('sin día anterior es base, aunque no haya libros', () => {
  assert.strictEqual(decidirEstado({ prevFecha: null, libHoyOk: false, libPrevOk: false }), 'base');
});
t('sin día anterior es base aunque estén los libros', () => {
  assert.strictEqual(decidirEstado({ prevFecha: null, libHoyOk: true, libPrevOk: true }), 'base');
});

console.log('decidirEstado(): con día anterior, hacen falta LOS DOS libros');
t('los dos presentes -> ok', () => {
  assert.strictEqual(decidirEstado({ prevFecha: ayer, libHoyOk: true, libPrevOk: true }), 'ok');
});
t('falta el de hoy -> sin_libro', () => {
  assert.strictEqual(decidirEstado({ prevFecha: ayer, libHoyOk: false, libPrevOk: true }), 'sin_libro');
});
t('falta el del día anterior -> sin_libro', () => {
  assert.strictEqual(decidirEstado({ prevFecha: ayer, libHoyOk: true, libPrevOk: false }), 'sin_libro');
});
t('faltan los dos -> sin_libro', () => {
  assert.strictEqual(decidirEstado({ prevFecha: ayer, libHoyOk: false, libPrevOk: false }), 'sin_libro');
});

console.log('módulos del cierre diferido cargan sin romper');
t('completar-cierre, cierres-pendientes y entrega-cierres se requieren', () => {
  require('../src/lib/completar-cierre');
  require('../src/db/cierres-pendientes');
  require('../src/entrega-cierres');
  require('../src/scenes/cierre');
});

console.log(`\n✅ ${pass} tests OK`);
