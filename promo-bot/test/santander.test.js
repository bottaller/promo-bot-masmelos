// Tests del parser de Santander.
// Correr:  node test/santander.test.js
const assert = require('assert');
const XLSX = require('xlsx');
const { parsearSantander, SantanderError } = require('../src/lib/santander-excel');
const { porCodigo, detectarPlataforma, detectarPlataformaBanco } = require('../src/lib/plataformas');
const { conciliarMP } = require('../src/lib/conciliacion-mp');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

const HDR = ['Fecha', 'Suc. Origen', 'Desc. Sucursal', 'Cod. Operativo', 'Referencia', 'Concepto', 'Importe Pesos', 'Saldo Pesos'];
const fila = (fecha, concepto, importe, extra = {}) => [
  fecha, extra.suc ?? '1', extra.desc ?? 'CASA CENTRAL', extra.cod ?? '01', extra.ref ?? '', concepto, importe, extra.saldo ?? 0,
];
function aBuffer(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'HONRE JULIO');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

console.log('parsearSantander(): signo, fecha y exclusiones');
t('importe positivo -> credito; negativo -> debito (monto siempre absoluto)', () => {
  const r = parsearSantander(aBuffer([HDR,
    fila('01/07/2026', 'Transferencia recibida', 100000),
    fila('01/07/2026', 'Comision Por Servicio', -500),
  ]));
  assert.strictEqual(r.operaciones[0].sentido, 'credito');
  assert.strictEqual(r.operaciones[0].bruto, 100000);
  assert.strictEqual(r.operaciones[1].sentido, 'debito');
  assert.strictEqual(r.operaciones[1].bruto, 500);
});
t('fecha DD/MM/AAAA en texto', () => {
  const r = parsearSantander(aBuffer([HDR, fila('15/07/2026', 'Transferencia recibida', 1000)]));
  assert.strictEqual(r.operaciones[0].hora, '2026-07-15 00:00:00');
});
t('un importe en cero se descarta (no es un movimiento)', () => {
  const r = parsearSantander(aBuffer([HDR,
    fila('01/07/2026', 'Transferencia recibida', 1000),
    fila('01/07/2026', 'Fila vacía', 0),
  ]));
  assert.strictEqual(r.operaciones.length, 1);
});
t('un archivo que no es de Santander se rechaza', () => {
  assert.throws(() => parsearSantander(aBuffer([['a', 'b'], ['1', '2']])),
    (e) => e instanceof SantanderError && /Importe Pesos/.test(e.message));
});

console.log('plataformas: alcance de Santander');
const SANTANDER = porCodigo('santander');
t('un Débito nunca entra en alcance (es un egreso, no un cobro)', () => {
  assert.strictEqual(SANTANDER.enAlcance({ sentido: 'debito', bruto: 500, concepto: 'x' }), false);
  assert.match(SANTANDER.motivoFuera({ sentido: 'debito', bruto: 500, concepto: 'x' }), /Egreso/);
});
t('un Crédito de un impuesto/comisión automático queda fuera con su motivo', () => {
  const op = { sentido: 'credito', bruto: 100, concepto: 'Impuesto Ley 25.413' };
  assert.strictEqual(SANTANDER.enAlcance(op), false);
  assert.match(SANTANDER.motivoFuera(op), /Ley 25\.413/);
});
t('una transferencia recibida normal SÍ entra en alcance', () => {
  const op = { sentido: 'credito', bruto: 100000, concepto: 'Transferencia recibida de un cliente' };
  assert.strictEqual(SANTANDER.enAlcance(op), true);
});
t('detecta el archivo por sus encabezados (registro de bancos, separado del de /carga)', () => {
  const buf = aBuffer([HDR, fila('01/07/2026', 'Transferencia recibida', 1000)]);
  assert.strictEqual(detectarPlataformaBanco(buf).codigo, 'santander');
});
t('/carga NO lo reconoce: el circuito automático (MP/Talo) no ve los bancos', () => {
  const buf = aBuffer([HDR, fila('01/07/2026', 'Transferencia recibida', 1000)]);
  assert.strictEqual(detectarPlataforma(buf), null);
});

console.log('el motor concilia Santander con las mismas reglas de apareo (sin hora: aparea solo por importe)');
const M = (debe, ingreso, extra = {}) => ({ asiento: 1, fecha: new Date(2026, 6, 8), comp: 'PG',
  cliente: 'CLIENTE', comprobante: 'REC', usuario: 'U', ingreso, debe, haber: 0, ...extra });

t('aparea un depósito de Santander con su asiento (sin hora, ventana infinita)', () => {
  const r = conciliarMP({
    movimientos: [M(4132982, '2026-07-08 12:00:00')],
    operaciones: [{ hora: '2026-07-08 00:00:00', bruto: 4132982, sentido: 'credito', comision: 0, impuestos: 0, neto: 4132982, concepto: 'Transferencia recibida' }],
    plataforma: SANTANDER,
  });
  assert.strictEqual(r.resumen.nPares, 1);
  assert.strictEqual(r.resumen.nAviso, 0, 'sin hora en el extracto no debería avisar por hora');
  assert.strictEqual(r.resumen.nSoloMp + r.resumen.nSoloSistema, 0);
});
t('un cobro sin asentar en Sigma queda 🔴', () => {
  const r = conciliarMP({
    movimientos: [],
    operaciones: [{ hora: '2026-07-08 00:00:00', bruto: 500000, sentido: 'credito', comision: 0, impuestos: 0, neto: 500000, concepto: 'Transferencia recibida' }],
    plataforma: SANTANDER,
  });
  assert.strictEqual(r.resumen.nSoloMp, 1);
  assert.strictEqual(r.resumen.nivel, 'alerta');
});

console.log(`\n✅ ${pass} tests OK`);
