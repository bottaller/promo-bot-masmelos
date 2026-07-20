// Tests de la conciliación de Mercado Pago operación por operación (/mp, área Caja Central).
// Sin DB ni archivos: los Excel se arman en memoria con la misma forma que los reales.
// Correr:  node test/tesoreria-mp.test.js
const assert = require('assert');
const XLSX = require('xlsx');
const cajaCentral = require('../src/areas/cajacentral');
const mpWizard = require('../src/scenes/mp');
const { conciliarMP, CUENTA_MP } = require('../src/lib/conciliacion-mp');
const { parsearMayor, MayorError } = require('../src/lib/mayor-excel');
const { parsearLiquidacion, LiquidacionError } = require('../src/lib/liquidacion-excel');
const { formatearMP } = require('../src/lib/reporte-mp');
const { construirInformePDF, veredictoMP } = require('../src/lib/informe-mp-pdf');
const { isoAHoraArg, tsASegundos, fechaHoraArg } = require('../src/lib/fechas');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

// Un movimiento del sistema (cobranza) y una operación de MP, con lo mínimo para el motor.
const M = (debe, ingreso, extra = {}) => ({
  asiento: 8301513, fecha: new Date(2026, 6, 16), comp: 'PG23', cliente: 'GALVAN DEBORA',
  comprobante: 'REC8 00002668', usuario: 'NIEVASA', ingreso, debe, haber: 0, empresa: '0008-HONRE 2', ...extra,
});
const O = (bruto, hora, extra = {}) => ({
  source_id: '168263949797', instrumento: 'available_money', tipo: 'Approved payment',
  canal: 'QR Code', unidad: 'Mercado Pago', hora, bruto, comision: 0, impuestos: 0, neto: bruto, ...extra,
});

console.log('fechas: la liquidación viene en UTC-4 y Sigma en hora local');
t('isoAHoraArg: UTC-4 -> hora argentina (+1 h)', () => {
  assert.strictEqual(isoAHoraArg('2026-07-16T16:10:56.000-04:00'), '2026-07-16 17:10:56');
});
t('isoAHoraArg: cruza el día', () => {
  assert.strictEqual(isoAHoraArg('2026-07-16T23:30:00.000-04:00'), '2026-07-17 00:30:00');
});
t('isoAHoraArg: acepta Z y otros offsets', () => {
  assert.strictEqual(isoAHoraArg('2026-07-16T12:00:00Z'), '2026-07-16 09:00:00');
  assert.strictEqual(isoAHoraArg('2026-07-16T12:00:00.000-03:00'), '2026-07-16 12:00:00');
});
t('isoAHoraArg: basura -> null (no inventa una hora)', () => {
  assert.strictEqual(isoAHoraArg('16/07/2026'), null);
  assert.strictEqual(isoAHoraArg(''), null);
  assert.strictEqual(isoAHoraArg(null), null);
});
t('tsASegundos: la resta entre dos marcas da los segundos', () => {
  assert.strictEqual(tsASegundos('2026-07-16 08:13:48') - tsASegundos('2026-07-16 08:13:42'), 6);
  assert.strictEqual(tsASegundos('no es un ts'), null);
});

console.log('conciliarMP(): el apareo');
t('match exacto 1 a 1', () => {
  const r = conciliarMP({
    movimientos: [M(24320.61, '2026-07-16 08:13:48')],
    operaciones: [O(24320.61, '2026-07-16 08:13:42')],
  });
  assert.strictEqual(r.pares.length, 1);
  assert.strictEqual(r.pares[0].dif, 0);
  assert.strictEqual(r.pares[0].delta, 6);
  assert.strictEqual(r.pares[0].nivel, 'ok');
  assert.strictEqual(r.resumen.nivel, 'ok');
  assert.strictEqual(r.soloSistema.length + r.soloMp.length, 0);
});
t('diferencia de centavos: aparea igual, con aviso de redondeo', () => {
  const r = conciliarMP({
    movimientos: [M(357358.76, '2026-07-16 14:25:07')],
    operaciones: [O(357358.80, '2026-07-16 14:24:50')],
  });
  assert.strictEqual(r.pares.length, 1);
  assert.strictEqual(r.pares[0].dif, -0.04);
  assert.strictEqual(r.pares[0].nivel, 'aviso');
  assert.deepStrictEqual(r.pares[0].avisos, ['redondeo']);
  assert.strictEqual(r.resumen.nivel, 'aviso'); // 🟡: hay que verlo, no alarma
});
t('diferencia MAYOR a la tolerancia: NO aparea (quedan los dos huérfanos)', () => {
  const r = conciliarMP({
    movimientos: [M(1000.00, '2026-07-16 10:00:10')],
    operaciones: [O(1000.50, '2026-07-16 10:00:00')],
  });
  assert.strictEqual(r.pares.length, 0);
  assert.strictEqual(r.soloSistema.length, 1);
  assert.strictEqual(r.soloMp.length, 1);
  assert.strictEqual(r.resumen.nivel, 'alerta');
});
t('cobró MP y no está asentado -> soloMp + 🔴', () => {
  const r = conciliarMP({ movimientos: [], operaciones: [O(50000, '2026-07-16 10:00:00')] });
  assert.strictEqual(r.soloMp.length, 1);
  assert.strictEqual(r.resumen.totalSoloMp, 50000);
  assert.strictEqual(r.resumen.nivel, 'alerta');
});
t('asentado y MP no lo tiene -> soloSistema + 🔴', () => {
  const r = conciliarMP({ movimientos: [M(50000, '2026-07-16 10:00:00')], operaciones: [] });
  assert.strictEqual(r.soloSistema.length, 1);
  assert.strictEqual(r.resumen.totalSoloSistema, 50000);
  assert.strictEqual(r.resumen.nivel, 'alerta');
});
t('importes repetidos: desempata por hora (el caso real de las dos ventas de $380)', () => {
  const r = conciliarMP({
    movimientos: [M(380, '2026-07-16 08:55:40', { usuario: 'ROCIOP' }), M(380, '2026-07-16 13:28:13', { usuario: 'NIEVASA' })],
    operaciones: [O(380, '2026-07-16 13:28:06', { source_id: 'tarde' }), O(380, '2026-07-16 08:55:27', { source_id: 'temprano' })],
  });
  assert.strictEqual(r.pares.length, 2);
  const rocio = r.pares.find((p) => p.mov.usuario === 'ROCIOP');
  assert.strictEqual(rocio.op.source_id, 'temprano'); // no se cruzaron
  assert.strictEqual(r.pares.find((p) => p.mov.usuario === 'NIEVASA').op.source_id, 'tarde');
});
t('el exacto le gana al redondeo aunque esté más lejos en el tiempo', () => {
  const r = conciliarMP({
    movimientos: [M(100, '2026-07-16 10:00:05')],
    operaciones: [O(100.01, '2026-07-16 10:00:00', { source_id: 'cerca-redondeo' }), O(100, '2026-07-16 10:20:00', { source_id: 'lejos-exacto' })],
  });
  assert.strictEqual(r.pares.length, 1);
  assert.strictEqual(r.pares[0].op.source_id, 'lejos-exacto');
  assert.strictEqual(r.soloMp[0].source_id, 'cerca-redondeo');
});
t('fuera de la ventana de 12 h: no aparea (no cruza días)', () => {
  const r = conciliarMP({
    movimientos: [M(5000, '2026-07-16 20:00:00')],
    operaciones: [O(5000, '2026-07-16 07:00:00')],
  });
  assert.strictEqual(r.pares.length, 0);
  assert.strictEqual(r.soloSistema.length, 1);
  assert.strictEqual(r.soloMp.length, 1);
});
t('apareada pero con la hora muy corrida -> aviso', () => {
  const r = conciliarMP({
    movimientos: [M(5000, '2026-07-16 12:00:00')],
    operaciones: [O(5000, '2026-07-16 10:00:00')],
  });
  assert.strictEqual(r.pares.length, 1);
  assert.strictEqual(r.pares[0].nivel, 'aviso');
  assert.deepStrictEqual(r.pares[0].avisos, ['hora']);
  assert.strictEqual(r.pares[0].delta, 7200);
  // el texto (y el formato de la plata) lo arma el reporte, no el motor
  const txt = formatearMP({ fecha: '16/07/2026', cuenta: 'MP', resultado: r });
  assert.match(txt, /120 min después del cobro/);
});

console.log('conciliarMP(): el alcance (lo que NO se concilia contra esta cuenta)');
t('Point queda fuera aunque el importe coincida', () => {
  const r = conciliarMP({
    movimientos: [M(180000, '2026-07-16 16:30:20')],
    operaciones: [O(180000, '2026-07-16 16:30:10', { canal: 'Point', instrumento: 'Credit card' })],
  });
  assert.strictEqual(r.pares.length, 0);
  assert.strictEqual(r.fuera.mp.length, 1);
  assert.match(r.fuera.mp[0].motivo, /Point/);
  assert.strictEqual(r.soloSistema.length, 1); // el asiento sí queda señalado
});
t('Mercado Libre (importe negativo) queda fuera', () => {
  const r = conciliarMP({
    movimientos: [],
    operaciones: [O(-2924560.09, '2026-07-16 16:26:32', { unidad: 'Mercado Libre', canal: '' })],
  });
  assert.strictEqual(r.fuera.mp.length, 1);
  assert.match(r.fuera.mp[0].motivo, /Mercado Libre/);
  assert.strictEqual(r.resumen.nivel, 'ok');
});
t('fila sin canal ni medio de pago: fuera, pero con motivo a la vista', () => {
  const r = conciliarMP({ movimientos: [], operaciones: [O(324915.32, '2026-07-16 06:16:11', { canal: '', unidad: '', instrumento: '' })] });
  assert.strictEqual(r.fuera.mp.length, 1);
  assert.match(r.fuera.mp[0].motivo, /revisar con MP/);
});
t('el crédito/débito POR QR sí entra (el canal manda, no el instrumento)', () => {
  const r = conciliarMP({
    movimientos: [M(382534.78, '2026-07-16 16:57:20')],
    operaciones: [O(382534.78, '2026-07-16 16:57:06', { instrumento: 'Credit card', canal: 'QR Code' })],
  });
  assert.strictEqual(r.pares.length, 1);
  assert.strictEqual(r.fuera.mp.length, 0);
});
t('un Haber (sale plata de MP) no es cobranza: fuera, NO huérfano', () => {
  const r = conciliarMP({
    movimientos: [M(0, '2026-07-16 18:00:00', { debe: 0, haber: 5000000 })],
    operaciones: [],
  });
  assert.strictEqual(r.soloSistema.length, 0); // no es un 🔴 falso
  assert.strictEqual(r.fuera.sistema.length, 1);
  assert.match(r.fuera.sistema[0].motivo, /no es una cobranza/);
  assert.strictEqual(r.resumen.nivel, 'ok');
});
t('un "Refund" de MP no se toma como cobro', () => {
  const r = conciliarMP({ movimientos: [], operaciones: [O(1000, '2026-07-16 10:00:00', { tipo: 'Refund' })] });
  assert.strictEqual(r.fuera.mp.length, 1);
  assert.match(r.fuera.mp[0].motivo, /no un cobro aprobado/);
});

console.log('conciliarMP(): los totales');
t('resumen: totales, diferencia y lo que acredita MP', () => {
  const r = conciliarMP({
    movimientos: [M(127241.52, '2026-07-16 17:11:07')],
    operaciones: [O(127241.52, '2026-07-16 17:10:56', { comision: -1231.70, impuestos: -764.72, neto: 125245.10 })],
  });
  assert.strictEqual(r.resumen.totalSistema, 127241.52);
  assert.strictEqual(r.resumen.totalMp, 127241.52);
  assert.strictEqual(r.resumen.diferencia, 0);
  assert.strictEqual(r.resumen.comision, -1231.70);
  assert.strictEqual(r.resumen.impuestos, -764.72);
  assert.strictEqual(r.resumen.neto, 125245.10);
});
t('los totales NO cuentan lo que está fuera de alcance', () => {
  const r = conciliarMP({
    movimientos: [M(100, '2026-07-16 10:00:10')],
    operaciones: [O(100, '2026-07-16 10:00:00'), O(999999, '2026-07-16 11:00:00', { canal: 'Point' })],
  });
  assert.strictEqual(r.resumen.totalMp, 100);
  assert.strictEqual(r.resumen.totalFueraMp, 999999);
});

console.log('conciliarMP(): rastreo del contramovimiento (con el Diario completo)');
// Caso REAL del 11/07/2026: MP cobró $152.577,45 por transferencia, nadie lo asentó como
// cobro de MP, y al cerrar la CAJA 4 dio ese faltante exacto contra DESVIO DE CAJA.
const ASIENTO_FALTANTE = [
  { asiento: 8299656, cuenta_id: 111100004, cuenta: 'CAJA 4 MORENO', comp: 'DIFC',
    concepto: 'faltante caja 4 camila 11-7', comprobante: 'DIFERENCIA DE CAJA', cliente: '',
    usuario: 'LATERZAFLOR', ingreso: '2026-07-11 17:21:50', debe: 0, haber: 152577.45 },
  { asiento: 8299656, cuenta_id: 501100006, cuenta: 'DESVIO DE CAJA', comp: 'DIFC',
    concepto: 'faltante caja 4 camila 11-7', comprobante: 'DIFERENCIA DE CAJA', cliente: '',
    usuario: 'LATERZAFLOR', ingreso: '2026-07-11 17:21:50', debe: 152577.45, haber: 0 },
  { asiento: 8299600, cuenta_id: 111100002, cuenta: 'CAJA 2 MORENO', comp: 'DIFC',
    concepto: 'sobrante caja 2 sabrina 11-7', comprobante: 'DIFERENCIA DE CAJA', cliente: '',
    usuario: 'LATERZAFLOR', ingreso: '2026-07-11 17:14:54', debe: 300, haber: 0 },
];
const soloMpDe = (r) => r.soloMp[0];

t('encuentra el faltante de caja que explica el cobro sin asentar', () => {
  const r = conciliarMP({
    movimientos: [], operaciones: [O(152577.45, '2026-07-11 14:15:12', { instrumento: 'Bank transfer' })],
    otrasCuentas: ASIENTO_FALTANTE,
  });
  const c = soloMpDe(r).contrapartidas;
  assert.strictEqual(c.length, 1, 'debería encontrar UN asiento');
  assert.strictEqual(c[0].asiento, 8299656);
  assert.match(c[0].concepto, /faltante caja 4/);
  assert.strictEqual(c[0].usuario, 'LATERZAFLOR');
  // trae la partida doble entera: de dónde salió y adónde fue
  assert.deepStrictEqual(c[0].renglones.map((g) => g.cuenta), ['CAJA 4 MORENO', 'DESVIO DE CAJA']);
  assert.strictEqual(r.resumen.rastreo, true);
  assert.strictEqual(r.resumen.nConContrapartida, 1);
});
t('no inventa contrapartida si el importe no está en ninguna otra cuenta', () => {
  const r = conciliarMP({
    movimientos: [], operaciones: [O(99999.99, '2026-07-11 14:15:12')],
    otrasCuentas: ASIENTO_FALTANTE,
  });
  assert.deepStrictEqual(soloMpDe(r).contrapartidas, []);
  assert.strictEqual(r.resumen.nConContrapartida, 0);
});
t('sin el Diario (solo el Mayor) no hay rastreo, pero tampoco rompe', () => {
  const r = conciliarMP({ movimientos: [], operaciones: [O(152577.45, '2026-07-11 14:15:12')] });
  assert.deepStrictEqual(soloMpDe(r).contrapartidas, []);
  assert.strictEqual(r.resumen.rastreo, false);
});
t('también rastrea al revés: asentado que MP no tiene', () => {
  const r = conciliarMP({
    movimientos: [M(152577.45, '2026-07-11 10:00:00')], operaciones: [],
    otrasCuentas: ASIENTO_FALTANTE,
  });
  assert.strictEqual(r.soloSistema[0].contrapartidas.length, 1);
});
t('el mensaje muestra dónde apareció el importe', () => {
  const r = conciliarMP({
    movimientos: [], operaciones: [O(152577.45, '2026-07-11 14:15:12', { instrumento: 'Bank transfer' })],
    otrasCuentas: ASIENTO_FALTANTE,
  });
  const txt = formatearMP({ fecha: '11/07/2026', cuenta: 'MP', resultado: r, origen: 'diario' });
  assert.match(txt, /aparece en:/);
  assert.match(txt, /CAJA 4 MORENO → DESVIO DE CAJA/); // Haber primero: de dónde salió
  assert.match(txt, /faltante caja 4 camila/);
  assert.match(txt, /LATERZAFLOR/);
});
t('si NO se pudo rastrear, el mensaje sugiere mandar el Diario', () => {
  const r = conciliarMP({ movimientos: [], operaciones: [O(50000, '2026-07-11 14:15:12')] });
  const txt = formatearMP({ fecha: '11/07/2026', cuenta: 'MP', resultado: r, origen: 'mayor' });
  assert.match(txt, /Diario de movimientos.*otra cuenta/s);
});
t('sin huérfanas no molesta con la sugerencia del Diario', () => {
  const r = conciliarMP({ movimientos: [M(100, '2026-07-11 10:00:10')], operaciones: [O(100, '2026-07-11 10:00:00')] });
  const txt = formatearMP({ fecha: '11/07/2026', cuenta: 'MP', resultado: r, origen: 'mayor' });
  assert.ok(!/Mandame el "Diario/.test(txt));
});

// --- parsers ---------------------------------------------------------------
function aBuffer(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const HDR_MAYOR = ['Cuenta', 'Nombre cuenta', 'Asiento', 'Fecha', 'Comp.', 'SubCta Nombre', 'Cuenta Asociada',
  'Compr.Rel.', 'Concepto', 'C.C.', 'Debe', 'Haber', 'Saldo', 'Referencia', 'Observacion', 'Empresa',
  'Sucursal', 'Ingreso', 'Usuario', 'UsuMod', 'UltMod'];
const filaMayor = (asiento, debe, ingreso, concepto = null) => [
  422101014, 'MERCADO PAGO MORENO', asiento, '16/07/2026', 'PG23', null, '411829-GALVAN VERGER DEBORA',
  'REC8 00002668', concepto, null, debe, 0, 0, null, null, '0008-HONRE 2', '0001-MORENO', ingreso, 'NIEVASA', null, null];
const HDR_DIARIO = ['Mov.', 'Fecha', 'Comp', 'Concepto', 'C.', 'Cuenta', 'C.C.', 'Centro de Costo', 'Debe',
  'Haber', 'Debe Nominal', 'Haber Nominal', 'Comprobante', 'Cuenta Asociada', 'Usuario', 'Ingreso'];
const filaDiario = (cuentaId, debe, ingreso) => [
  8300319, '14/07/2026', 'PG23', 'COBRANZA CAJA MORENO (1)', cuentaId, 'MERCADO PAGO MORENO', null, null,
  debe, 0, debe, 0, 'COBRANZA CAJA MORENO (1)', '030640-MALDONADO RAUL', 'NIEVASA', ingreso];

console.log('parsearMayor(): acepta los dos exports de Sigma');
t('Mayor de cuenta: lee los renglones y DESCARTA el saldo anterior', () => {
  const buf = aBuffer([
    ['Empresa: 0008-HONRE_2  del 07/16/2026 al 07/16/2026'],
    ['Mayor de Cta 422101014 - MERCADO PAGO MORENO  en Moneda Nominal'],
    HDR_MAYOR,
    filaMayor(0, 586353935.51, null, 'Saldo anterior'), // el arrastre: NO es un movimiento
    filaMayor(8301513, 24320.61, '16/07/2026 08:13:48'),
  ]);
  const r = parsearMayor(buf, { cuentaId: CUENTA_MP });
  assert.strictEqual(r.origen, 'mayor');
  assert.strictEqual(r.cuenta, 'MERCADO PAGO MORENO');
  assert.strictEqual(r.movimientos.length, 1); // sin el saldo anterior
  assert.strictEqual(r.movimientos[0].debe, 24320.61);
  assert.strictEqual(r.movimientos[0].ingreso, '2026-07-16 08:13:48');
  assert.strictEqual(r.movimientos[0].comprobante, 'REC8 00002668');
});
t('Diario de movimientos: filtra la cuenta de MP y deja las otras', () => {
  const buf = aBuffer([
    ['Empresa: 0001-SKYCEO,0008-HONRE_2'],
    ['Diario de movimientos contables del 07/14/2026 al 07/14/2026'],
    HDR_DIARIO,
    filaDiario(111201014, 999999, '14/07/2026 08:00:00'), // Santander: no es MP
    filaDiario(422101014, 88146.06, '14/07/2026 08:38:28'),
  ]);
  const r = parsearMayor(buf, { cuentaId: CUENTA_MP });
  assert.strictEqual(r.origen, 'diario');
  assert.strictEqual(r.movimientos.length, 1);
  assert.strictEqual(r.movimientos[0].debe, 88146.06);
  assert.strictEqual(r.movimientos[0].ingreso, '2026-07-14 08:38:28');
});
t('NO agrega los renglones del mismo segundo (romperia el match 1 a 1)', () => {
  // Caso real: un recibo con DOS cobros de MP cargados en el mismo instante.
  const buf = aBuffer([
    ['Empresa: 0008-HONRE_2'], ['Mayor de Cta 422101014'], HDR_MAYOR,
    filaMayor(8301645, 100000, '16/07/2026 10:30:26'),
    filaMayor(8301645, 111393.93, '16/07/2026 10:30:26'),
  ]);
  const r = parsearMayor(buf, { cuentaId: CUENTA_MP });
  assert.strictEqual(r.movimientos.length, 2);
  assert.deepStrictEqual(r.movimientos.map((m) => m.debe), [100000, 111393.93]);
});
t('el Diario CONSERVA las otras cuentas (para rastrear el contramovimiento)', () => {
  const buf = aBuffer([
    ['Empresa: 0008-HONRE_2'],
    ['Diario de movimientos contables del 07/11/2026 al 07/11/2026'],
    HDR_DIARIO,
    filaDiario(422101014, 88146.06, '11/07/2026 08:38:28'),
    filaDiario(111100004, 152577.45, '11/07/2026 17:21:50'), // CAJA 4: otra cuenta
    filaDiario(501100006, 152577.45, '11/07/2026 17:21:50'), // DESVIO: otra cuenta
  ]);
  const r = parsearMayor(buf, { cuentaId: CUENTA_MP });
  assert.strictEqual(r.movimientos.length, 1);          // la cuenta MP
  assert.strictEqual(r.otrasCuentas.length, 2);          // el resto del libro
  assert.deepStrictEqual(r.otrasCuentas.map((m) => m.cuenta_id), [111100004, 501100006]);
  assert.ok(r.otrasCuentas.every((m) => m.cuenta_id !== CUENTA_MP), 'no debe colar la cuenta de MP');
});
t('el Mayor (una sola cuenta) no trae otras cuentas: rastreo no disponible', () => {
  const buf = aBuffer([
    ['Empresa: 0008-HONRE_2'], ['Mayor de Cta 422101014'], HDR_MAYOR,
    filaMayor(8301513, 24320.61, '16/07/2026 08:13:48'),
  ]);
  assert.deepStrictEqual(parsearMayor(buf, { cuentaId: CUENTA_MP }).otrasCuentas, []);
});
t('el Mayor de OTRA cuenta se rechaza con un mensaje claro', () => {
  const buf = aBuffer([['Empresa: X'], ['Mayor de Cta 111201014'], HDR_MAYOR,
    [111201014, 'SANTANDER', 8301513, '16/07/2026', 'PG23', null, 'X', 'REC8 1', null, null, 100, 0, 0,
      null, null, '0008', '0001', '16/07/2026 08:13:48', 'NIEVASA', null, null]]);
  assert.throws(() => parsearMayor(buf, { cuentaId: CUENTA_MP }), (e) => e instanceof MayorError && /cuenta correcta/.test(e.message));
});
t('un archivo que no es de Sigma se rechaza', () => {
  assert.throws(() => parsearMayor(aBuffer([['hola'], ['mundo']]), { cuentaId: CUENTA_MP }),
    (e) => e instanceof MayorError && /No reconozco el archivo/.test(e.message));
});

console.log('parsearLiquidacion()');
const HDR_LIQ = ['SOURCE ID', 'PAYMENT METHOD TYPE', 'TRANSACTION TYPE', 'TRANSACTION AMOUNT', 'ORIGIN DATE',
  'FEE AMOUNT', 'APPROVAL DATE', 'REAL AMOUNT', 'TAXES AMOUNT', 'BUSINESS UNIT', 'SUB UNIT', 'MONEY RELEASE DATE'];
t('lee los importes en formato US y pasa la hora a horario argentino', () => {
  const r = parsearLiquidacion(aBuffer([HDR_LIQ,
    ['168263949797', 'available_money', 'Approved payment', '127241.52', '2026-07-16T16:10:56.000-04:00',
      '-1231.70', '2026-07-16T16:10:56.000-04:00', '125245.10', '-764.72', 'Mercado Pago', 'QR Code', '']]));
  assert.strictEqual(r.operaciones.length, 1);
  const o = r.operaciones[0];
  assert.strictEqual(o.bruto, 127241.52);
  assert.strictEqual(o.comision, -1231.70);
  assert.strictEqual(o.neto, 125245.10);
  assert.strictEqual(o.hora, '2026-07-16 17:10:56'); // +1 h respecto del archivo
  assert.strictEqual(o.canal, 'QR Code');
});
t('las columnas se buscan por NOMBRE (tolera que MP las reordene)', () => {
  const r = parsearLiquidacion(aBuffer([
    ['SUB UNIT', 'SOURCE ID', 'TRANSACTION AMOUNT', 'ORIGIN DATE', 'PAYMENT METHOD TYPE', 'TRANSACTION TYPE'],
    ['QR Code', '999', '100.50', '2026-07-16T10:00:00.000-04:00', 'Bank transfer', 'Approved payment'],
  ]));
  assert.strictEqual(r.operaciones[0].bruto, 100.50);
  assert.strictEqual(r.operaciones[0].instrumento, 'Bank transfer');
});
t('si falta una columna obligatoria, avisa cuál', () => {
  assert.throws(() => parsearLiquidacion(aBuffer([['SOURCE ID', 'SUB UNIT'], ['1', 'QR Code']])),
    (e) => e instanceof LiquidacionError && /TRANSACTION AMOUNT/.test(e.message));
});
t('un importe ilegible NO se toma como 0: tira error', () => {
  assert.throws(() => parsearLiquidacion(aBuffer([HDR_LIQ,
    ['1', 'available_money', 'Approved payment', 'N/D', '2026-07-16T10:00:00.000-04:00', '0', '', '0', '0', 'Mercado Pago', 'QR Code', '']])),
  (e) => e instanceof LiquidacionError && /ilegible/.test(e.message));
});
t('un archivo que no es la liquidación se rechaza', () => {
  assert.throws(() => parsearLiquidacion(aBuffer([['Mov.', 'Fecha'], [1, '16/07/2026']])),
    (e) => e instanceof LiquidacionError && /SOURCE ID/.test(e.message));
});

console.log('reporte');
t('el mensaje pone lo que está mal arriba y escapa el HTML', () => {
  const resultado = conciliarMP({
    movimientos: [M(100, '2026-07-16 10:00:10', { cliente: 'FIERRO & <HIJOS>' })],
    operaciones: [O(50000, '2026-07-16 11:00:00')],
  });
  const txt = formatearMP({ fecha: '16/07/2026', cuenta: 'MERCADO PAGO MORENO', resultado });
  assert.match(txt, /Cobró MP y no está asentado/);
  assert.match(txt, /Asentado y MP no lo tiene/);
  assert.match(txt, /FIERRO &amp; &lt;HIJOS&gt;/); // sin esto Telegram rechaza el mensaje
  assert.ok(!/FIERRO & <HIJOS>/.test(txt));
  assert.ok(txt.length < 4096); // tope de Telegram
});
t('el mensaje se mantiene bajo el tope de Telegram con muchas huérfanas', () => {
  const operaciones = Array.from({ length: 300 }, (_, i) => O(1000 + i, '2026-07-16 10:00:00', { source_id: `id-${i}` }));
  const resultado = conciliarMP({ movimientos: [], operaciones });
  const txt = formatearMP({ fecha: '16/07/2026', cuenta: 'MERCADO PAGO MORENO', resultado });
  assert.ok(txt.length < 4096, `el mensaje mide ${txt.length}`);
  assert.match(txt, /y 292 más/);
});
// Si el mensaje se pasa de 4096, la API de Telegram RECHAZA el envío entero y el control no
// llega — peor que recortarlo. Las líneas del rastreo son largas: sin tope duro, 40 huérfanas
// con contrapartidas daban 5334 caracteres y el reporte no se enviaba.
function escenarioHuerfanasConRastreo(n, largoNombre) {
  const ops = [], movs = [], otras = [];
  for (let i = 0; i < n; i++) {
    const monto = 100000 + i;
    ops.push(O(monto, `2026-07-11 1${i % 10}:00:00`, { source_id: `1684${i}` }));
    movs.push(M(monto + 1000, `2026-07-11 09:00:0${i % 10}`, { cliente: 'C'.repeat(largoNombre) + i }));
    for (let k = 0; k < 3; k++) {
      const asiento = 900000 + i * 10 + k;
      const base = { asiento, concepto: 'faltante caja 4 camila 11-7 revisar con tesoreria',
        comprobante: 'DIFERENCIA DE CAJA', cliente: '', usuario: 'LATERZAFLOR', ingreso: '2026-07-11 17:21:50' };
      otras.push({ ...base, cuenta_id: 111100004, cuenta: 'CAJA 4 MORENO SUCURSAL CENTRO', debe: 0, haber: monto });
      otras.push({ ...base, cuenta_id: 501100006, cuenta: 'DESVIO DE CAJA MORENO', debe: monto, haber: 0 });
    }
  }
  return conciliarMP({ movimientos: movs, operaciones: ops, otrasCuentas: otras });
}
t('peor caso realista (40 huérfanas con rastreo): entra sin recortar', () => {
  const resultado = escenarioHuerfanasConRastreo(40, 25);
  assert.strictEqual(resultado.resumen.nSoloMp, 40);
  const txt = formatearMP({ fecha: '11/07/2026', cuenta: 'MERCADO PAGO MORENO', resultado, origen: 'diario' });
  assert.ok(txt.length <= 4096, `mide ${txt.length}: Telegram lo rechazaría`);
  assert.ok(!/recortado/.test(txt), 'no debería hacer falta recortar en un caso realista');
  assert.match(txt, /aparece en:/); // el rastreo se sigue viendo
});
t('caso extremo: recorta para no pasarse, y AVISA que recortó', () => {
  const resultado = escenarioHuerfanasConRastreo(100, 300); // nombres absurdos
  const txt = formatearMP({ fecha: '11/07/2026', cuenta: 'MERCADO PAGO MORENO', resultado, origen: 'diario' });
  assert.ok(txt.length <= 4096, `mide ${txt.length}: Telegram lo rechazaría`);
  assert.match(txt, /recortado/);          // nunca en silencio
  assert.match(txt, /sin aparear/);        // lo importante sobrevive: va primero
  assert.match(txt, /Totales/);
});
t('el redondeo se RESUME en una línea con el total, no se lista uno por uno', () => {
  // 3 diferencias de redondeo, como el 16/07 real. No tienen que aparecer las 3 líneas
  // con cliente; solo "N por redondeo · $total".
  const resultado = conciliarMP({
    movimientos: [
      M(357358.76, '2026-07-16 14:25:07', { cliente: 'MELLADO' }),
      M(111189.72, '2026-07-16 14:36:32', { cliente: 'ESCOBAR' }),
      M(408351.70, '2026-07-16 15:33:54', { cliente: 'RAMIREZ' }),
    ],
    operaciones: [
      O(357358.80, '2026-07-16 14:24:50'),
      O(111189.71, '2026-07-16 14:36:26'),
      O(408351.71, '2026-07-16 15:33:45'),
    ],
  });
  const txt = formatearMP({ fecha: '16/07/2026', cuenta: 'MP', resultado });
  assert.match(txt, /🟡 3 por redondeo · −\$0,04/); // 3 pares, neto -0,04 (-0,04+0,01-0,01)
  assert.ok(!/MELLADO/.test(txt), 'no debe listar el cliente de un redondeo');
  assert.ok(!/por redondeo · .*MELLADO/s.test(txt));
  assert.ok(!/14:24/.test(txt), 'no debe listar la hora de un redondeo');
});
t('las salidas de dinero (Mercado Libre negativo, Haber) NO van al mensaje', () => {
  const resultado = conciliarMP({
    movimientos: [
      M(100, '2026-07-16 10:00:10'),
      M(0, '2026-07-16 18:00:00', { debe: 0, haber: 20000000, cliente: 'TRANSFER A SANTANDER' }), // Haber = salida
    ],
    operaciones: [
      O(100, '2026-07-16 10:00:00'),
      O(-2924560.09, '2026-07-16 16:26:32', { unidad: 'Mercado Libre', canal: '' }), // salida
      O(324915.32, '2026-07-16 06:16:11', { canal: '', unidad: '', instrumento: '' }), // fuera pero POSITIVO: sí se muestra
    ],
  });
  const txt = formatearMP({ fecha: '16/07/2026', cuenta: 'MP', resultado });
  assert.ok(!/Mercado Libre/.test(txt), 'la salida de ML no debe aparecer en el mensaje');
  assert.ok(!/2\.924\.560/.test(txt));
  assert.ok(!/no son cobranzas/.test(txt), 'los Haber no van al mensaje');
  assert.ok(!/20\.000\.000/.test(txt));
  assert.match(txt, /revisar con MP/); // lo positivo fuera de alcance SÍ sigue
});
t('el reporte no arma ningún archivo: solo exporta el mensaje', () => {
  // /mp ya no devuelve Excel. Si vuelve a exportar un builder, revisar el wizard (mp.js).
  const rep = require('../src/lib/reporte-mp');
  assert.deepStrictEqual(Object.keys(rep), ['formatearMP']);
});

console.log('área Caja Central (el rol dueño del comando)');
t('expone el comando y su escena', () => {
  assert.strictEqual(cajaCentral.codigo, 'cajacentral'); // == bot.areas.codigo (migración 014)
  assert.strictEqual(cajaCentral.nombre, 'Caja Central');
  assert.deepStrictEqual(cajaCentral.comandos.map((c) => c.comando), ['mp']);
  assert.ok(cajaCentral.scenes.some((s) => s.id === 'mp-wizard'));
});
t('la descripción del menú dice qué recibe y qué devuelve', () => {
  const d = cajaCentral.comandos[0].descripcion;
  assert.match(d, /mandás/i);      // qué le doy
  assert.match(d, /liquidación/i); // ...y el otro archivo
  assert.ok(d.length <= 256);      // tope de setMyCommands (index.js::publicarComandos)
});
t('registra el comando UNA sola vez (si no, se ejecutaría duplicado)', () => {
  const registrados = [];
  cajaCentral.registrar({ command: (n) => registrados.push(n) });
  assert.deepStrictEqual(registrados, ['mp']);
});

console.log('informe PDF: el veredicto (control bien/mal)');
t('aparea todo -> CONTROL OK', () => {
  const r = conciliarMP({
    movimientos: [M(100, '2026-07-16 10:00:10')],
    operaciones: [O(100, '2026-07-16 10:00:00')],
  });
  const v = veredictoMP(r);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.sinAparear, 0);
  assert.strictEqual(v.titulo, 'CONTROL OK');
});
t('las diferencias de redondeo NO tumban el control (siguen siendo OK)', () => {
  const r = conciliarMP({
    movimientos: [M(357358.76, '2026-07-16 14:25:07')],
    operaciones: [O(357358.80, '2026-07-16 14:24:50')], // dif 0,04 -> aviso, no huérfano
  });
  assert.strictEqual(r.resumen.nAviso, 1);
  assert.strictEqual(veredictoMP(r).ok, true);
});
t('cobró MP y no está asentado -> CONTROL CON DIFERENCIAS', () => {
  const r = conciliarMP({ movimientos: [], operaciones: [O(50000, '2026-07-16 10:00:00')] });
  const v = veredictoMP(r);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.sinAparear, 1);
  assert.strictEqual(v.titulo, 'CONTROL CON DIFERENCIAS');
});
t('asentado y MP no lo tiene -> también CON DIFERENCIAS', () => {
  const r = conciliarMP({ movimientos: [M(50000, '2026-07-16 10:00:00')], operaciones: [] });
  assert.strictEqual(veredictoMP(r).ok, false);
});
t('fechaHoraArg: DD/MM/AAAA HH:MM, sin coma', () => {
  assert.match(fechaHoraArg(), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
});

// --- el wizard: los textos que ve el usuario -------------------------------
// "El comando debe decir qué info recibe": se testea de verdad, corriendo el paso.
function ctxFalso() {
  const replies = [];
  return {
    replies,
    reply: async (t) => { replies.push(t); },
    state: { usuario: { es_admin: false, areas: ['cajacentral'] } },
    message: {},
    wizard: { state: {}, next() {}, selectStep() {} },
    scene: { leave: async () => {} },
  };
}

(async () => {
  console.log('el comando dice qué info recibe');
  const ctx = ctxFalso();
  await mpWizard.steps[0](ctx);
  const txt = ctx.replies[0];
  t('el primer mensaje enumera los 2 archivos, de dónde salen y de qué día', () => {
    assert.match(txt, /2 archivos/);
    assert.match(txt, /MISMO día/);
    assert.match(txt, /Diario de movimientos contables/);
    assert.match(txt, /Mayor de cuenta/);
    assert.match(txt, /liquidación de Mercado Pago/i);
    assert.match(txt, new RegExp(String(CUENTA_MP)));  // la cuenta, para que sepa cuál exportar
    assert.match(txt, /Exportá.*el día que querés conciliar/s);
  });
  t('el primer mensaje deja claro el alcance (QR/transferencia, Point no)', () => {
    assert.match(txt, /QR o transferencia/);
    assert.match(txt, /Point/);
  });
  t('el HTML del mensaje está balanceado (si no, Telegram lo rechaza entero)', () => {
    assert.strictEqual((txt.match(/<b>/g) || []).length, (txt.match(/<\/b>/g) || []).length);
    assert.strictEqual((txt.match(/<code>/g) || []).length, (txt.match(/<\/code>/g) || []).length);
    assert.ok(!/&(?!amp;|lt;|gt;|#)/.test(txt)); // ningún & suelto
  });

  console.log('informe PDF: se genera un PDF válido');
  const esPDF = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF' && buf.length > 800;
  const okRes = conciliarMP({ movimientos: [M(100, '2026-07-16 10:00:10')], operaciones: [O(100, '2026-07-16 10:00:00')] });
  const malRes = conciliarMP({ movimientos: [], operaciones: [O(50000, '2026-07-16 10:00:00'), O(70000, '2026-07-16 11:00:00', { source_id: 'x2' })] });
  const pdfOk = await construirInformePDF({ fecha: '16/07/2026', cuenta: 'MERCADO PAGO MORENO', resultado: okRes, generadoEn: '17/07/2026 15:42' });
  const pdfMal = await construirInformePDF({ fecha: '16/07/2026', cuenta: 'MERCADO PAGO MORENO', resultado: malRes, generadoEn: '17/07/2026 15:42' });
  t('control OK -> PDF válido', () => { assert.ok(esPDF(pdfOk), 'no es un PDF'); });
  t('control con diferencias -> PDF válido', () => { assert.ok(esPDF(pdfMal), 'no es un PDF'); });
  t('el PDF con diferencias pesa más (lista lo que no cierra)', () => { assert.ok(pdfMal.length > pdfOk.length); });

  // El RE-CHEQUEO de acceso del wizard tiene que ser la MISMA área que registra el comando.
  // Regresión: quedó pidiendo 'tesoreria' al mudar /mp a Caja Central -> un usuario CON el rol
  // entraba pero se trababa al mandar el archivo. Se maneja el paso 1 con distintos usuarios.
  console.log('acceso: el rol cajacentral puede usar /mp de punta a punta');
  const mayorBuf = aBuffer([
    ['Empresa: 0008-HONRE_2  del 07/16/2026 al 07/16/2026'], ['Mayor de Cta 422101014'], HDR_MAYOR,
    filaMayor(8301513, 24320.61, '16/07/2026 08:13:48'),
  ]);
  async function correrPaso1(usuario) {
    const replies = []; let salio = false;
    global.fetch = async () => ({ arrayBuffer: async () => mayorBuf.buffer.slice(mayorBuf.byteOffset, mayorBuf.byteOffset + mayorBuf.byteLength) });
    const ctx = {
      state: { usuario },
      message: { document: { file_id: 'mem://mayor', file_name: 'mayor.xlsx' } },
      telegram: { getFileLink: async () => ({ href: 'mem://mayor' }) },
      reply: async (t) => { replies.push(t); },
      scene: { leave: async () => { salio = true; } },
      wizard: { state: { data: {} }, next() {}, selectStep() {} }, // el paso 0 crea state.data
    };
    await mpWizard.steps[1](ctx);
    return { replies, salio };
  }
  const rolSolo = await correrPaso1({ es_admin: false, areas: ['cajacentral'] });
  t('un usuario con SOLO el rol cajacentral NO se traba en el paso del archivo', () => {
    assert.ok(!rolSolo.replies.some((r) => /no tenés acceso/i.test(r)), 'lo bloqueó teniendo el rol correcto');
    assert.ok(rolSolo.replies.some((r) => /Leí .*cobranza/i.test(r)), 'no avanzó a pedir la liquidación');
    assert.strictEqual(rolSolo.salio, false);
  });
  const otroRol = await correrPaso1({ es_admin: false, areas: ['tesoreria'] });
  t('un usuario sin el rol cajacentral SÍ queda bloqueado (y se nombra Caja Central)', () => {
    assert.ok(otroRol.replies.some((r) => /acceso al área Caja Central/i.test(r)));
    assert.strictEqual(otroRol.salio, true);
  });
  const admin = await correrPaso1({ es_admin: true, areas: [] });
  t('un admin pasa igual (acceso total)', () => {
    assert.ok(admin.replies.some((r) => /Leí .*cobranza/i.test(r)));
  });

  console.log(`\n✅ ${pass} tests OK`);
})();
