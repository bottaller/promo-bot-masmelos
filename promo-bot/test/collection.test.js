// Tests del parser del reporte "Collection" (Cobros) de Mercado Pago — el formato del mismo día.
// Correr: node test/collection.test.js
const assert = require('assert');
const XLSX = require('xlsx');
const { parsearCollection, CollectionError, esCollection } = require('../src/lib/collection-excel');
const { LiquidacionError } = require('../src/lib/liquidacion-excel');
const { detectarPlataforma, porCodigo } = require('../src/lib/plataformas');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

function aBuffer(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Export collection');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
// Header con el nombre "de máquina" entre paréntesis, como el reporte real.
const HDR = [
  'Número de operación de Mercado Pago (operation_id)', 'Estado de la operación (status)',
  'Tipo de operación (operation_type)', 'Valor del producto (transaction_amount)',
  'Tarifa de Mercado Pago (mercadopago_fee)', 'Monto recibido (net_received_amount)',
  'Fecha de compra (date_created)', 'Plataforma de cobro (sub_unit)',
  'Canal de venta (business_unit)', 'Medio de pago (payment_type)',
];
// op(id, monto, fecha, {status, sub, fee, neto})
const op = (id, monto, fecha, { status = 'approved', sub = 'QR', fee = -100, neto = null, tipo = 'regular_payment', pt = 'account_money' } = {}) =>
  [id, status, tipo, String(monto), String(fee), String(neto == null ? monto + fee : neto), fecha, sub, 'Mercado Pago', pt];

console.log('parsearCollection(): lee el reporte de Cobros');
t('mapea al vocabulario del settlement: QR→"QR Code", approved→"Approved payment"', () => {
  const { operaciones } = parsearCollection(aBuffer([HDR, op('170222644764', 21364.67, '23/07/2026 17:08:42')]));
  assert.strictEqual(operaciones.length, 1);
  const o = operaciones[0];
  assert.strictEqual(o.source_id, '170222644764');
  assert.strictEqual(o.bruto, 21364.67);
  assert.strictEqual(o.canal, 'QR Code');           // sub_unit 'QR' mapeado
  assert.strictEqual(o.tipo, 'Approved payment');    // status 'approved' mapeado
  assert.strictEqual(o.estado, 'approved');
});
t('la fecha es hora ARGENTINA directa (sin offset, a diferencia del settlement UTC-4)', () => {
  const { operaciones } = parsearCollection(aBuffer([HDR, op('1', 100, '23/07/2026 08:27:45')]));
  assert.strictEqual(operaciones[0].hora, '2026-07-23 08:27:45'); // idéntica, NO +1h
});
t('deriva impuestos para que comisión+impuestos = neto−bruto', () => {
  // bruto 201304.90, fee -9134.21, neto 190960.85 -> impuestos = 190960.85-201304.90-(-9134.21) = -1209.84
  const { operaciones } = parsearCollection(aBuffer([HDR, op('1', 201304.90, '23/07/2026 17:10:44', { fee: -9134.21, neto: 190960.85 })]));
  const o = operaciones[0];
  assert.strictEqual(o.comision, -9134.21);
  assert.strictEqual(o.impuestos, -1209.84);
  assert.ok(Math.abs((o.bruto + o.comision + o.impuestos) - o.neto) < 0.01, 'bruto+comisión+impuestos = neto');
});

console.log('alcance: solo QR + approved entran a la cuenta MP');
t('QR approved entra; Point y rejected quedan fuera con su motivo', () => {
  const mp = porCodigo('mp');
  const { operaciones } = parsearCollection(aBuffer([HDR,
    op('a', 1000, '23/07/2026 10:00:00', { sub: 'QR', status: 'approved' }),
    op('b', 2000, '23/07/2026 10:01:00', { sub: 'Point', status: 'approved', tipo: 'pos_payment' }),
    op('c', 3000, '23/07/2026 10:02:00', { sub: 'QR', status: 'rejected' }),
  ]));
  const dentro = operaciones.filter(mp.enAlcance);
  const fuera = operaciones.filter((o) => !mp.enAlcance(o));
  assert.strictEqual(dentro.length, 1);
  assert.strictEqual(dentro[0].source_id, 'a');
  assert.strictEqual(fuera.length, 2);
  assert.match(mp.motivoFuera(operaciones[1]), /Point/);       // b: Point → tarjetas
  assert.match(mp.motivoFuera(operaciones[2]), /aprobado|rejected/i); // c: rechazada
});

console.log('detección y ruteo por plataformas.js');
t('esCollection reconoce el formato; el settlement NO', () => {
  const rowsCol = [HDR.map((h) => h)];
  const filas = XLSX.utils.sheet_to_json(XLSX.read(aBuffer([HDR, op('1', 1, '23/07/2026 10:00:00')]), { type: 'buffer' }).Sheets['Export collection'], { header: 1, raw: true });
  assert.strictEqual(esCollection(filas), true);
  assert.strictEqual(esCollection([['SOURCE ID', 'TRANSACTION AMOUNT']]), false);
  void rowsCol;
});
t('detectarPlataforma rutea el reporte de Cobros a MP', () => {
  const p = detectarPlataforma(aBuffer([HDR, op('1', 1000, '23/07/2026 10:00:00')]));
  assert.ok(p && p.codigo === 'mp', 'debería detectar MP');
});
t('el descriptor de MP parsea el formato Cobros vía parsearMp', () => {
  const mp = porCodigo('mp');
  const { operaciones } = mp.parsear(aBuffer([HDR, op('1', 500, '23/07/2026 10:00:00')]));
  assert.strictEqual(operaciones.length, 1);
  assert.strictEqual(operaciones[0].bruto, 500);
});

console.log('errores claros');
t('sin la columna (operation_id) tira CollectionError (y es un LiquidacionError)', () => {
  assert.throws(() => parsearCollection(aBuffer([['col a', 'col b'], ['x', 'y']])), (e) => {
    return e instanceof CollectionError && e instanceof LiquidacionError && /operation_id/.test(e.message);
  });
});
t('reporte vacío (solo header) tira error', () => {
  assert.throws(() => parsearCollection(aBuffer([HDR])), CollectionError);
});

console.log(`\n✅ ${pass} tests OK`);
