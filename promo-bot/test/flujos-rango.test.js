// Tests del rango de fechas de /flujos.
// Es la lógica que decide QUÉ período se mira: si interpreta mal, el reporte sale de otro
// período y los montos no cuadran con nada, sin que el error se note.
//   node test/flujos-rango.test.js
const assert = require('assert');

// El wizard toca la capa DB al importarse (libro-fuente), que exige DATABASE_URL: se pone una
// ficticia porque estos tests no consultan nada.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';

const { _parsearRango: parsearRango } = require('../src/scenes/flujos');
const { fechaISO, fechaHoyArgISO } = require('../src/lib/fechas');

let pass = 0;
function t(nombre, fn) {
  try { fn(); pass++; console.log(`  ok: ${nombre}`); }
  catch (e) { console.error(`  FALLA: ${nombre}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('parsearRango(): dos fechas');
t('acepta "desde hasta" separadas por espacio', () => {
  const r = parsearRango('01/07/2026 15/07/2026');
  assert.ok(r.ok, r.error);
  assert.strictEqual(fechaISO(r.desde), '2026-07-01');
  assert.strictEqual(fechaISO(r.hasta), '2026-07-15');
});
t('acepta el "al" del medio', () => {
  const r = parsearRango('01/07/2026 al 15/07/2026');
  assert.ok(r.ok, r.error);
  assert.strictEqual(fechaISO(r.hasta), '2026-07-15');
});
t('acepta el guión', () => {
  const r = parsearRango('01/07/2026-15/07/2026');
  assert.ok(r.ok, r.error);
  assert.strictEqual(fechaISO(r.desde), '2026-07-01');
});
t('tolera texto alrededor', () => {
  const r = parsearRango('quiero del 01/07/2026 hasta el 15/07/2026 gracias');
  assert.ok(r.ok, r.error);
  assert.strictEqual(fechaISO(r.desde), '2026-07-01');
});

console.log('parsearRango(): una sola fecha = ese día');
t('desde y hasta quedan iguales', () => {
  const r = parsearRango('11/07/2026');
  assert.ok(r.ok, r.error);
  assert.strictEqual(fechaISO(r.desde), '2026-07-11');
  assert.strictEqual(fechaISO(r.hasta), '2026-07-11');
});

console.log('parsearRango(): rechazos');
t('sin ninguna fecha', () => {
  const r = parsearRango('el mes pasado');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /DD\/MM\/AAAA/);
});
t('más de dos fechas', () => {
  const r = parsearRango('01/07/2026 15/07/2026 20/07/2026');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /dos fechas/);
});
t('una fecha que no existe (31/02)', () => {
  const r = parsearRango('31/02/2026');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no existe/);
});
t('el desde posterior al hasta: lo dice, no lo corrige solo', () => {
  const r = parsearRango('15/07/2026 01/07/2026');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /posterior/);
  // A propósito NO se invierten solos: si el usuario se equivocó de orden, puede haberse
  // equivocado también de fecha, y un reporte del período que no era pasa desapercibido.
});
t('un desde en el futuro', () => {
  const [y] = fechaHoyArgISO().split('-').map(Number);
  const r = parsearRango(`01/01/${y + 1}`);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /todavía no pasó/);
});

console.log('parsearRango(): borde');
t('el mismo día de hoy se acepta (no es futuro)', () => {
  const hoy = fechaHoyArgISO(); // AAAA-MM-DD
  const dd = hoy.slice(8, 10), mm = hoy.slice(5, 7), yyyy = hoy.slice(0, 4);
  const r = parsearRango(`${dd}/${mm}/${yyyy}`);
  assert.ok(r.ok, r.error);
});
t('entrada vacía o basura no rompe', () => {
  for (const v of ['', null, undefined, '   ', 'aaaa']) {
    const r = parsearRango(v);
    assert.strictEqual(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  }
});

console.log(`\n✅ ${pass} tests OK`);
