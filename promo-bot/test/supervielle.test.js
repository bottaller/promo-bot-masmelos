// Tests del parser de Supervielle.
// Correr:  node test/supervielle.test.js
const assert = require('assert');
const XLSX = require('xlsx');
const { parsearSupervielle, SupervielleError } = require('../src/lib/supervielle-excel');
const { porCodigo, detectarPlataformaBanco } = require('../src/lib/plataformas');
const { conciliarMP } = require('../src/lib/conciliacion-mp');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

const HDR = ['Fecha', 'Concepto', 'Detalle', 'Débito', 'Crédito', 'Saldo'];
const filaCredito = (fecha, concepto, credito, detalle = '') => [fecha, concepto, detalle, 0, credito, 0];
const filaDebito = (fecha, concepto, debito, detalle = '') => [fecha, concepto, detalle, debito, 0, 0];
function aBuffer(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'HONRE JULIO 26');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

console.log('parsearSupervielle(): columnas separadas Débito/Crédito');
t('Crédito -> sentido credito; Débito -> sentido debito', () => {
  const r = parsearSupervielle(aBuffer([HDR,
    filaCredito('19/07/2026', 'Crédito por Transferencia', 2746076, 'NOMBRE: DANIEL AGUERO'),
    filaDebito('19/07/2026', 'Comisión Mantenimiento Cuenta', 80602),
  ]));
  assert.strictEqual(r.operaciones[0].sentido, 'credito');
  assert.strictEqual(r.operaciones[0].bruto, 2746076);
  assert.strictEqual(r.operaciones[0].referencia, 'NOMBRE: DANIEL AGUERO');
  assert.strictEqual(r.operaciones[1].sentido, 'debito');
  assert.strictEqual(r.operaciones[1].bruto, 80602);
});
t('fila sin Débito ni Crédito se descarta', () => {
  const r = parsearSupervielle(aBuffer([HDR, filaCredito('19/07/2026', 'x', 100), [
    '19/07/2026', 'vacía', '', 0, 0, 0,
  ]]));
  assert.strictEqual(r.operaciones.length, 1);
});
t('un archivo que no es de Supervielle se rechaza', () => {
  assert.throws(() => parsearSupervielle(aBuffer([['a', 'b'], ['1', '2']])),
    (e) => e instanceof SupervielleError && /Débito.*Crédito/.test(e.message));
});

console.log('plataformas: alcance de Supervielle');
const SUPERVIELLE = porCodigo('supervielle');
t('un Débito nunca entra en alcance', () => {
  assert.strictEqual(SUPERVIELLE.enAlcance({ sentido: 'debito', bruto: 500, concepto: 'x' }), false);
});
t('un Crédito de una percepción/comisión automática queda fuera con su motivo', () => {
  const op = { sentido: 'credito', bruto: 100, concepto: 'Cobro Percepción IIBB' };
  assert.strictEqual(SUPERVIELLE.enAlcance(op), false);
  assert.match(SUPERVIELLE.motivoFuera(op), /IIBB/);
});
t('una transferencia de un cliente SÍ entra en alcance (son cobros de ventas)', () => {
  const op = { sentido: 'credito', bruto: 2746076, concepto: 'Crédito por Transferencia' };
  assert.strictEqual(SUPERVIELLE.enAlcance(op), true);
});
t('detecta el archivo por sus encabezados (registro de bancos, separado del de /carga)', () => {
  const buf = aBuffer([HDR, filaCredito('19/07/2026', 'Crédito por Transferencia', 1000)]);
  assert.strictEqual(detectarPlataformaBanco(buf).codigo, 'supervielle');
});

console.log('el motor concilia Supervielle con las mismas reglas de apareo');
const M = (debe, ingreso, extra = {}) => ({ asiento: 1, fecha: new Date(2026, 6, 19), comp: 'PG',
  cliente: 'AGUERO 19-7', comprobante: 'REC', usuario: 'U', ingreso, debe, haber: 0, ...extra });

t('aparea la transferencia de un cliente con su asiento (caso real: Aguero 19/07)', () => {
  const r = conciliarMP({
    movimientos: [M(2746076, '2026-07-19 12:00:00')],
    operaciones: [{ hora: '2026-07-19 00:00:00', bruto: 2746076, sentido: 'credito', comision: 0, impuestos: 0, neto: 2746076, concepto: 'Crédito por Transferencia' }],
    plataforma: SUPERVIELLE,
  });
  assert.strictEqual(r.resumen.nPares, 1);
  assert.strictEqual(r.resumen.nSoloMp + r.resumen.nSoloSistema, 0);
});
t('una comisión/percepción automática no genera un falso 🔴 (queda fuera de alcance)', () => {
  const r = conciliarMP({
    movimientos: [],
    operaciones: [{ hora: '2026-07-19 00:00:00', bruto: 8802.85, sentido: 'credito', comision: 0, impuestos: 0, neto: 8802.85, concepto: 'IIBB Acred. Banc. Tuc. 80/03' }],
    plataforma: SUPERVIELLE,
  });
  assert.strictEqual(r.resumen.nSoloMp, 0);
  assert.strictEqual(r.fuera.mp.length, 1);
  assert.strictEqual(r.resumen.nivel, 'ok');
});

console.log(`\n✅ ${pass} tests OK`);
