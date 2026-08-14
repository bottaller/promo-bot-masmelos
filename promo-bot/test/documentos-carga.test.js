// Tests del registro de documentos de /carga: qué reconoce y QUIÉN puede subir cada cosa.
// Correr: node test/documentos-carga.test.js
//
// Lo que se cuida acá es lo que rompería feo si se toca sin querer:
//  - que el libro siga siendo el ÚLTIMO (es el catch-all: si otro documento quedara después,
//    nunca llegaría a su turno y el bot diría "no reconozco ese archivo"),
//  - que abrir /carga al área Retiros NO le abra el libro ni las liquidaciones.

// pool.js exige DATABASE_URL apenas se lo requiere; no se conecta a nada.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const assert = require('assert');
const XLSX = require('xlsx');
const {
  DOCUMENTOS, puedeSubir, documentosDe, puedeUsarCarga, detectarDocumento,
} = require('../src/lib/documentos-carga');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

const ENCABEZADO_RETIROS = [
  'fecha de registro de pedido', 'Horario de Registro del pedido', 'Excepcion ', 'N° de PEDIDO',
  'CODIGO del Cliente', 'CLIENTE', 'N° de Orden de Pedido', 'VENDEDOR ', 'FECHA Retiro del Pedido',
  'HORARIO de Retiro del pedido', '# Bultos', 'PALLET', 'STATUS de Preparación', 'ESTADO ',
];
function aBuffer(filas, hoja = 'AGOSTO') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), hoja);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const PLANILLA = aBuffer([ENCABEZADO_RETIROS, ['', '', '', 1, '99', 'x', '', '', 'LUNES 17 DE AGOSTO DE 2026', '09:00']]);
const CUALQUIERA = aBuffer([['Cuenta', 'Debe', 'Haber'], ['111', 10, 0]], 'Hoja1');

const admin = { id: 1, es_admin: true, areas: [] };
const deRetiros = { id: 2, es_admin: false, areas: ['retiros'] };
const deDeposito = { id: 3, es_admin: false, areas: ['deposito'] };
const deSistemas = { id: 4, es_admin: false, areas: ['sistemas'] };
const deTesoreria = { id: 5, es_admin: false, areas: ['tesoreria'] };

console.log('\ndocumentos-carga');

// ── orden del registro ───────────────────────────────────────────────────────

t('el libro es el ULTIMO: es el catch-all', () => {
  assert.equal(DOCUMENTOS[DOCUMENTOS.length - 1].codigo, 'libro');
  // y es el único que dice que sí a cualquier cosa
  assert.equal(DOCUMENTOS.filter((d) => d.detectar(CUALQUIERA)).length, 1);
});

t('la planilla de retiros se detecta ANTES que el libro', () => {
  const iRetiros = DOCUMENTOS.findIndex((d) => d.codigo === 'retiros');
  const iLibro = DOCUMENTOS.findIndex((d) => d.codigo === 'libro');
  assert.ok(iRetiros < iLibro, 'si retiros quedara después del libro, nunca se reconocería');
  assert.equal(detectarDocumento(PLANILLA).codigo, 'retiros');
});

t('un xlsx que no es de nadie cae en el libro, que lo va a rechazar', () => {
  assert.equal(detectarDocumento(CUALQUIERA).codigo, 'libro');
});

t('todos los documentos declaran area o soloAdmin: ninguno queda abierto', () => {
  for (const d of DOCUMENTOS) {
    assert.ok(d.soloAdmin || d.area, `el documento "${d.codigo}" no declara quién puede subirlo`);
  }
});

// ── permisos ─────────────────────────────────────────────────────────────────

const doc = (codigo) => DOCUMENTOS.find((d) => d.codigo === codigo);

t('el admin sube todo', () => {
  for (const d of DOCUMENTOS) assert.equal(puedeSubir(admin, d), true, d.codigo);
});

t('el area Retiros sube SOLO la planilla', () => {
  assert.equal(puedeSubir(deRetiros, doc('retiros')), true);
  assert.equal(puedeSubir(deRetiros, doc('libro')), false);
  assert.equal(puedeSubir(deRetiros, doc('liquidacion')), false);
});

t('"sistemas" llega a la planilla pero no a lo financiero', () => {
  assert.equal(puedeSubir(deSistemas, doc('retiros')), true);
  assert.equal(puedeSubir(deSistemas, doc('libro')), false);
  assert.equal(puedeSubir(deSistemas, doc('liquidacion')), false);
});

t('tesoreria sin ser admin no sube el libro (era admin-only y sigue igual)', () => {
  assert.equal(puedeSubir(deTesoreria, doc('libro')), false);
  assert.equal(puedeSubir(deTesoreria, doc('liquidacion')), false);
});

t('otra area no sube nada y ni siquiera entra a /carga', () => {
  assert.deepEqual(documentosDe(deDeposito), []);
  assert.equal(puedeUsarCarga(deDeposito), false);
  assert.equal(puedeUsarCarga(null), false);
});

t('quien puede subir algo entra a /carga', () => {
  assert.equal(puedeUsarCarga(admin), true);
  assert.equal(puedeUsarCarga(deRetiros), true);
  assert.deepEqual(documentosDe(deRetiros).map((d) => d.codigo), ['retiros']);
});

t('cada documento sabe como presentarse en el menu', () => {
  for (const d of DOCUMENTOS) {
    const e = d.etiquetas();
    assert.ok(Array.isArray(e) && e.length, `"${d.codigo}" no tiene etiqueta`);
  }
});

console.log(`\n${pass} tests ok\n`);
