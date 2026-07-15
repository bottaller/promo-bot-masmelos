// Tests del corte por HORA del /cierre (helpers de tiempo + parsers + ventana).
// Correr:  node test/cierre-por-hora.test.js
const assert = require('assert');
const XLSX = require('xlsx');
const { tsCanonico, finDeDiaTs, fechaISO } = require('../src/lib/fechas');
const { parsearLibro } = require('../src/lib/libro-excel');
const { parsearSaldos } = require('../src/lib/saldos-excel');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

// Arma un .xlsx en memoria desde una matriz de filas.
function xlsx(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

console.log('helpers de tiempo (reloj de pared, string canónico)');
t('tsCanonico cero-padea y ordena cronológicamente', () => {
  assert.strictEqual(tsCanonico(2026, 7, 4, 9, 5, 3), '2026-07-04 09:05:03');
  assert.strictEqual(tsCanonico(2026, 12, 31), '2026-12-31 00:00:00');
  // orden lexicográfico == cronológico (clave del diseño)
  assert.ok('2026-07-14 16:20:00' < '2026-07-14 16:50:00');
  assert.ok('2026-07-13 23:59:59' < '2026-07-14 00:00:01');
});
t('finDeDiaTs = 23:59:59 (default = modelo por día)', () => {
  assert.strictEqual(finDeDiaTs(new Date(2026, 6, 14)), '2026-07-14 23:59:59');
  assert.strictEqual(finDeDiaTs('2026-07-14'), '2026-07-14 23:59:59');
});

console.log('parser de saldos (Hora del conteo)');
function saldosBuf({ conHora }) {
  const rows = [
    ['EXISTENCIAS AL CIERRE — HONRE'],
    ['Fecha:', '14/07/2026'],
  ];
  if (conHora) rows.push(['Hora del conteo:', '16:20']);
  rows.push(['Cuenta', 'Saldo', 'Moneda'], ['Santander', 1000, 'ARS']);
  return xlsx(rows);
}
t('con hora → contadoEn con la hora + horaCargada true', () => {
  const r = parsearSaldos(saldosBuf({ conHora: true }));
  assert.strictEqual(r.contadoEn, '2026-07-14 16:20:00');
  assert.strictEqual(r.horaCargada, true);
  assert.strictEqual(fechaISO(r.fecha), '2026-07-14');
});
t('sin hora → default fin del día + horaCargada false (no rompe, avisa)', () => {
  const r = parsearSaldos(saldosBuf({ conHora: false }));
  assert.strictEqual(r.contadoEn, '2026-07-14 23:59:59');
  assert.strictEqual(r.horaCargada, false);
});

console.log('parser del libro (columna Ingreso)');
// Header de 16 columnas + filas: 2 al mismo instante (se suman) y 1 a otra hora (separada).
function libroBuf() {
  const H = ['Mov.', 'Fecha', 'Comp', 'Concepto', 'Cuenta', 'Nombre', 'CC', 'CCosto',
    'Debe', 'Haber', 'DebeNom', 'HaberNom', 'Comprob', 'CtaAsoc', 'Usuario', 'Ingreso'];
  const fila = (mov, cta, debe, ingreso) =>
    [mov, '14/07/2026', 'PG23', 'Cobranza', cta, 'CAJA 1', '', '', debe, 0, 0, 0, 'PG', '', 'NIEVASA', ingreso];
  return xlsx([
    ['Empresa: 0008-HONRE'],
    ['Diario de movimientos contables del 14/07/2026 al 14/07/2026'],
    H,
    fila(1, 111100001, 100, '14/07/2026 16:20:00'),
    fila(2, 111100001, 50, '14/07/2026 16:20:00'),   // mismo cuenta+ingreso → se suma con la anterior
    fila(3, 111100001, 30, '14/07/2026 16:50:00'),   // otra hora → fila separada
  ]);
}
t('agrupa por (cuenta, ingreso): mismo instante suma, distinto instante separa', () => {
  const { movimientos } = parsearLibro(libroBuf());
  assert.strictEqual(movimientos.length, 2);
  const m1620 = movimientos.find((m) => m.ingreso === '2026-07-14 16:20:00');
  const m1650 = movimientos.find((m) => m.ingreso === '2026-07-14 16:50:00');
  assert.strictEqual(m1620.debe, 150); // 100 + 50 sumados
  assert.strictEqual(m1650.debe, 30);
  assert.ok(movimientos.every((m) => m.cuenta_id === 111100001));
});

console.log('ventana semiabierta (conteo_anterior, conteo_hoy] por comparación de strings');
t('un movimiento post-conteo (16:50) queda FUERA si el conteo fue 16:20', () => {
  const { movimientos } = parsearLibro(libroBuf());
  const desde = '2026-07-14 16:20:00', hasta = '2026-07-14 17:00:00';
  const enVentana = movimientos.filter((m) => m.ingreso > desde && m.ingreso <= hasta);
  // el de 16:20 se excluye (semiabierta: > desde), el de 16:50 entra
  assert.strictEqual(enVentana.length, 1);
  assert.strictEqual(enVentana[0].ingreso, '2026-07-14 16:50:00');
});
t('con conteo al fin del día (default), entra TODO (= modelo por día)', () => {
  const { movimientos } = parsearLibro(libroBuf());
  const desde = '2026-07-13 23:59:59', hasta = '2026-07-14 23:59:59';
  const enVentana = movimientos.filter((m) => m.ingreso > desde && m.ingreso <= hasta);
  assert.strictEqual(enVentana.length, 2); // los dos movimientos del 14 entran
});

console.log(`\n✅ ${pass} tests OK`);
