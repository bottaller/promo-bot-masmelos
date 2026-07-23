// Tests del parser de Talo y del registro de plataformas.
// Correr:  node test/talo.test.js
const assert = require('assert');
const XLSX = require('xlsx');
const { parsearTalo, TaloError } = require('../src/lib/talo-excel');
const { PLATAFORMAS, porCodigo, detectarPlataforma } = require('../src/lib/plataformas');
const { conciliarMP } = require('../src/lib/conciliacion-mp');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

const HDR = ['Número de Orden', 'Enviado', 'Recibido', 'Comisión', 'Impuestos Total', 'Acreditado',
  'Moneda', 'Estado', 'Fecha Movimiento', 'Hora Movimiento', 'Titular', 'ID de pago'];
const fila = (recibido, estado, fecha, hora, extra = {}) => [
  '-', extra.enviado ?? 0, recibido, extra.comision ?? '0,00', extra.impuestos ?? '0,00',
  extra.neto ?? '0,00', 'ARS', estado, fecha, hora, extra.titular ?? 'CLIENTE', extra.id,
];
function aBuffer(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Movimientos');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

console.log('parsearTalo(): importes y horas');
t('lee el importe en formato argentino (coma decimal)', () => {
  const r = parsearTalo(aBuffer([HDR, fila('74950,00', 'RECIBIDO', '23/07/26', '12:02 PM',
    { comision: '453,45', impuestos: '452,42', neto: '74044,13' })]));
  const o = r.operaciones[0];
  assert.strictEqual(o.bruto, 74950);
  assert.strictEqual(o.comision, -453.45); // se normaliza a negativo, como MP
  assert.strictEqual(o.impuestos, -452.42);
  assert.strictEqual(o.neto, 74044.13);
});
t('la MISMA columna mezcla coma y punto decimal: lee las dos', () => {
  // Caso real del archivo del 23/07: 'Acreditado' viene como '74044,13' y como '-1.00'.
  const r = parsearTalo(aBuffer([HDR,
    fila('1,00', 'RECIBIDO', '23/07/26', '01:41 PM', { neto: '0,98' }),
    fila(0, 'ENVIADO', '23/07/26', '01:42 PM', { enviado: '-1,01', neto: '-1.00' }),
  ]));
  assert.strictEqual(r.operaciones[0].neto, 0.98);
  assert.strictEqual(r.operaciones[1].neto, -1);
});
t('separador de miles con punto no se confunde con decimal', () => {
  const r = parsearTalo(aBuffer([HDR, fila('1.399.329,00', 'RECIBIDO', '23/07/26', '10:36 AM')]));
  assert.strictEqual(r.operaciones[0].bruto, 1399329);
});
t('hora 12 h AM/PM -> 24 h', () => {
  const r = parsearTalo(aBuffer([HDR,
    fila('1,00', 'RECIBIDO', '23/07/26', '04:33 PM'),
    fila('1,00', 'RECIBIDO', '23/07/26', '10:36 AM'),
    fila('1,00', 'RECIBIDO', '23/07/26', '12:15 AM'), // medianoche
    fila('1,00', 'RECIBIDO', '23/07/26', '12:02 PM'), // mediodía
  ]));
  assert.deepStrictEqual(r.operaciones.map((o) => o.hora), [
    '2026-07-23 16:33:00', '2026-07-23 10:36:00', '2026-07-23 00:15:00', '2026-07-23 12:02:00',
  ]);
});
t('la fecha viene con año de DOS dígitos', () => {
  const r = parsearTalo(aBuffer([HDR, fila('1,00', 'RECIBIDO', '05/01/27', '09:00 AM')]));
  assert.strictEqual(r.operaciones[0].hora, '2027-01-05 09:00:00');
});
t('un archivo que no es de Talo se rechaza', () => {
  assert.throws(() => parsearTalo(aBuffer([['SOURCE ID', 'SUB UNIT'], ['1', 'QR Code']])),
    (e) => e instanceof TaloError && /Recibido/.test(e.message));
});
t('fecha/hora ilegible NO se inventa: tira error', () => {
  assert.throws(() => parsearTalo(aBuffer([HDR, fila('1,00', 'RECIBIDO', 'ayer', '25:99')])),
    (e) => e instanceof TaloError && /ilegible/.test(e.message));
});

console.log('plataformas: alcance y detección');
const TALO = porCodigo('talo');
const MP = porCodigo('mp');
t('el registro tiene las dos, con su cuenta de Sigma', () => {
  assert.strictEqual(PLATAFORMAS.length, 2);
  assert.strictEqual(MP.cuenta, 422101014);
  assert.strictEqual(TALO.cuenta, 42210108); // TALO HONRE S.A
});
t('Talo: entra RECIBIDO, queda fuera ENVIADO', () => {
  assert.strictEqual(TALO.enAlcance({ estado: 'RECIBIDO', bruto: 100 }), true);
  assert.strictEqual(TALO.enAlcance({ estado: 'ENVIADO', bruto: 0 }), false);
  assert.match(TALO.motivoFuera({ estado: 'ENVIADO', bruto: 0 }), /no un cobro recibido/);
});
t('Talo tolera más demora que MP (se asienta hasta 32 min después)', () => {
  assert.ok(TALO.deltaSospechosoSeg > MP.deltaSospechosoSeg,
    'con el umbral de MP, Talo tiraría avisos de hora falsos todos los días');
});
t('detecta la plataforma por los encabezados, sin preguntar', () => {
  const talo = aBuffer([HDR, fila('1,00', 'RECIBIDO', '23/07/26', '10:00 AM')]);
  const mp = aBuffer([['SOURCE ID', 'PAYMENT METHOD TYPE', 'TRANSACTION TYPE', 'TRANSACTION AMOUNT',
    'ORIGIN DATE', 'SUB UNIT'], ['1', 'available_money', 'Approved payment', '100.00',
    '2026-07-23T10:00:00.000-04:00', 'QR Code']]);
  assert.strictEqual(detectarPlataforma(talo).codigo, 'talo');
  assert.strictEqual(detectarPlataforma(mp).codigo, 'mp');
  assert.strictEqual(detectarPlataforma(aBuffer([['hola'], ['mundo']])), null);
});

console.log('el motor concilia Talo con las mismas reglas de apareo');
const M = (debe, ingreso, extra = {}) => ({ asiento: 1, fecha: new Date(2026, 6, 23), comp: 'PG',
  cliente: 'CLIENTE', comprobante: 'REC', usuario: 'U', ingreso, debe, haber: 0, ...extra });
const O = (bruto, hora, extra = {}) => ({ source_id: '', estado: 'RECIBIDO', hora, bruto,
  comision: 0, impuestos: 0, neto: bruto, titular: 'T', ...extra });

t('aparea un cobro de Talo con su asiento', () => {
  const r = conciliarMP({
    movimientos: [M(16320, '2026-07-23 11:43:22')],
    operaciones: [O(16320, '2026-07-23 11:42:00')],
    plataforma: TALO,
  });
  assert.strictEqual(r.resumen.nPares, 1);
  assert.strictEqual(r.resumen.nSoloMp + r.resumen.nSoloSistema, 0);
});
t('un asiento sin cobro en Talo queda 🔴 (caso real del 23/07)', () => {
  const r = conciliarMP({
    movimientos: [M(36400, '2026-07-23 12:05:54')],
    operaciones: [],
    plataforma: TALO,
  });
  assert.strictEqual(r.resumen.nSoloSistema, 1);
  assert.strictEqual(r.resumen.nivel, 'alerta');
});
t('el ENVIADO no cuenta como huérfano: queda fuera de alcance con su motivo', () => {
  const r = conciliarMP({
    movimientos: [], operaciones: [O(0, '2026-07-23 13:42:00', { estado: 'ENVIADO' })],
    plataforma: TALO,
  });
  assert.strictEqual(r.resumen.nSoloMp, 0);
  assert.strictEqual(r.fuera.mp.length, 1);
  assert.strictEqual(r.resumen.nivel, 'ok');
});
t('el cobro asentado 32 min después NO dispara aviso de hora en Talo', () => {
  // Caso real: cobro 10:36, asiento 11:08. Con el umbral de MP (30 min) sería un aviso falso.
  const r = conciliarMP({
    movimientos: [M(1399329, '2026-07-23 11:08:59')],
    operaciones: [O(1399329, '2026-07-23 10:36:00')],
    plataforma: TALO,
  });
  assert.strictEqual(r.resumen.nPares, 1);
  assert.strictEqual(r.resumen.nAviso, 0, 'no debería avisar por hora con el umbral de Talo');
});

console.log(`\n✅ ${pass} tests OK`);
