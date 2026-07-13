// Tests del motor de conciliación de Tesorería (sin DB ni archivos — datos sintéticos).
// Correr:  node test/tesoreria-conciliacion.test.js
const assert = require('assert');
const { conciliar, acumularCuenta, evaluarCuenta, evaluarPeriodo, sobreUmbral } = require('../src/lib/conciliacion');
const { procesarCierre, movimientosDestacados } = require('../src/lib/control-tesoreria');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }
const S = (cuenta, monto, moneda = 'ARS') => ({ cuenta, monto, moneda });
const M = (cuenta_id, debe, haber, dn = 0, hn = 0) => ({ cuenta_id, debe, haber, debe_nominal: dn, haber_nominal: hn });
const byName = (r, n) => r.find((x) => x.cuenta === n);

console.log('conciliar()');
t('cierre exacto', () => {
  const r = conciliar({ saldosAyer: [S('Santander', 1000)], saldosHoy: [S('Santander', 1100)], movimientos: [M(111201014, 100, 0)] });
  const s = byName(r, 'Santander');
  assert.strictEqual(s.saldo_teorico, 1100); assert.strictEqual(s.diferencia, 0); assert.strictEqual(s.estado, 'ok');
});
t('detecta faltante', () => {
  const r = conciliar({ saldosAyer: [S('Santander', 1000)], saldosHoy: [S('Santander', 1050)], movimientos: [M(111201014, 100, 0)] });
  assert.strictEqual(byName(r, 'Santander').diferencia, -50);
  assert.strictEqual(byName(r, 'Santander').estado, 'revisar');
});
t('grupo cheques A+B contra una cuenta (no doble-cuenta)', () => {
  const r = conciliar({
    saldosAyer: [S('Cheques en cartera A', 3000), S('Cheques en cartera B', 0)],
    saldosHoy: [S('Cheques en cartera A', 6000), S('Cheques en cartera B', 0)],
    movimientos: [M(111401001, 3000, 0)],
  });
  const ch = byName(r, 'Cheques en Cartera');
  assert.strictEqual(ch.saldo_ayer, 3000); assert.strictEqual(ch.ingresos, 3000); assert.strictEqual(ch.diferencia, 0);
});
t('MP = MP + tarjetas (menos Visa Crédito)', () => {
  const r = conciliar({
    saldosAyer: [S('Mercadopago', 1000)], saldosHoy: [S('Mercadopago', 1150)],
    movimientos: [M(422101014, 100, 0), M(111301002, 50, 0), M(111301001, 999, 0)], // Visa Crédito NO cuenta
  });
  const mp = byName(r, 'Mercado Pago');
  assert.strictEqual(mp.ingresos, 150); assert.strictEqual(mp.diferencia, 0);
});
t('USD por columnas nominal: SOLO la caja física 006 (la 005 no cuenta)', () => {
  // 2750 USD salen de la caja física del negocio (006 haber) hacia la otra caja (005 debe).
  // El control es SOLO la 006: el saldo real baja a 0, y la entrada a la 005 se ignora.
  const r = conciliar({
    saldosAyer: [S('Caja Dólar Tesorería', 2750, 'USD')], saldosHoy: [S('Caja Dólar Tesorería', 0, 'USD')],
    movimientos: [M(111102006, 0, 3987500, 0, 2750), M(111102005, 3987500, 0, 2750, 0)], // la 005 NO cuenta
  });
  const usd = byName(r, 'Caja Dólar Tesorería');
  assert.strictEqual(usd.moneda, 'USD');
  assert.strictEqual(usd.ingresos, 0);    // la entrada a la 005 no suma
  assert.strictEqual(usd.egresos, 2750);  // solo la salida de la caja física
  assert.strictEqual(usd.diferencia, 0);  // 2750 - 2750 = 0 = saldo real
});
t('REGRESIÓN multi-día: suma (no pisa) movimientos de la misma cuenta', () => {
  // 3 entradas de la misma cuenta (3 días) deben SUMARSE.
  const r = conciliar({
    saldosAyer: [S('Santander', 0)], saldosHoy: [S('Santander', 600)],
    movimientos: [M(111201014, 100, 0), M(111201014, 200, 0), M(111201014, 300, 0)],
  });
  const s = byName(r, 'Santander');
  assert.strictEqual(s.ingresos, 600, 'debe sumar 100+200+300'); assert.strictEqual(s.diferencia, 0);
});
t('sin_saldo_ayer y sin_saldo_hoy', () => {
  const r1 = conciliar({ saldosAyer: [], saldosHoy: [S('Santander', 100)], movimientos: [M(111201014, 100, 0)] });
  assert.strictEqual(byName(r1, 'Santander').estado, 'sin_saldo_ayer');
  const r2 = conciliar({ saldosAyer: [S('Santander', 100)], saldosHoy: [], movimientos: [M(111201014, 50, 0)] });
  assert.strictEqual(byName(r2, 'Santander').estado, 'sin_saldo_hoy');
});

console.log('acumularCuenta()');
t('suma corrida y diasSobreUmbral', () => {
  const serie = [{ diferencia: 6000000 }, { diferencia: -6000000 }, { diferencia: 100 }];
  const a = acumularCuenta(serie, 'ARS');
  assert.strictEqual(a.acumulado, 100); assert.strictEqual(a.diasSobreUmbral, 0, 'volvió bajo umbral');
});
t('persistencia sobre umbral', () => {
  const serie = [{ diferencia: 6000000 }, { diferencia: 0 }, { diferencia: 0 }]; // 3 cierres > 5M
  assert.strictEqual(acumularCuenta(serie, 'ARS').diasSobreUmbral, 3);
});

console.log('evaluarCuenta()');
t('ok / timing / revisar / alerta', () => {
  assert.strictEqual(evaluarCuenta({ diferencia: 0, acumulado: 0, moneda: 'ARS', diasSobreUmbral: 0 }).nivel, 'ok');
  assert.strictEqual(evaluarCuenta({ diferencia: 500, acumulado: 500, moneda: 'ARS', diasSobreUmbral: 0 }).nivel, 'timing');
  assert.strictEqual(evaluarCuenta({ diferencia: 9000000, acumulado: 9000000, moneda: 'ARS', diasSobreUmbral: 1 }).nivel, 'revisar');
  assert.strictEqual(evaluarCuenta({ diferencia: 0, acumulado: 9000000, moneda: 'ARS', diasSobreUmbral: 5 }).nivel, 'alerta');
});
t('timing grande pero acumulado sano NO alarma', () => {
  // Diferencia enorme del día pero acumulado bajo umbral (se dio vuelta).
  assert.strictEqual(evaluarCuenta({ diferencia: 150000000, acumulado: 1000, moneda: 'ARS', diasSobreUmbral: 0 }).nivel, 'timing');
});

console.log('procesarCierre()');
t('end-to-end: filas evaluadas + destacados de seguridad', () => {
  const out = procesarCierre({
    fecha: '07/07/2026',
    saldosAyer: [S('Santander', 20000000)],
    saldosHoy: [S('Santander', 14000000)],
    movimientos: [M(111201014, 0, 6000000), M(211701011, 6000000, 0)], // retiro de socios
    historialDiffs: {},
  });
  const s = byName(out.filas, 'Santander');
  assert.strictEqual(s.diferencia, 0); assert.strictEqual(s.nivel, 'ok');
  assert.ok(out.destacados.some((d) => d.cuenta_id === 211701011), 'detecta el retiro de socios');
  assert.ok(out.texto.includes('Retiro de socios'), 'el reporte incluye la sección de control');
});

console.log('fixes de la revisión adversarial');
t('cheques grupo con una fila faltante -> sin_saldo_hoy (no diferencia fantasma)', () => {
  const r = conciliar({
    saldosAyer: [S('Cheques en cartera A', 10000000), S('Cheques en cartera B', 5000000)],
    saldosHoy: [S('Cheques en cartera A', 10000000)], // falta la fila B
    movimientos: [],
  });
  assert.strictEqual(byName(r, 'Cheques en Cartera').estado, 'sin_saldo_hoy');
});
t('evaluarPeriodo: residuo sobre umbral -> alerta (no timing)', () => {
  assert.strictEqual(evaluarPeriodo({ diferencia: 6000000, moneda: 'ARS' }).nivel, 'alerta');
  assert.strictEqual(evaluarPeriodo({ diferencia: 0, moneda: 'ARS' }).nivel, 'ok');
  assert.strictEqual(evaluarPeriodo({ diferencia: 1000000, moneda: 'ARS' }).nivel, 'timing');
});
t('timing de 3 días NO alarma (tolerancia=3), 4 sí', () => {
  assert.strictEqual(evaluarCuenta({ diferencia: 0, acumulado: 6000000, moneda: 'ARS', diasSobreUmbral: 3 }).nivel, 'revisar');
  assert.strictEqual(evaluarCuenta({ diferencia: 0, acumulado: 6000000, moneda: 'ARS', diasSobreUmbral: 4 }).nivel, 'alerta');
});
t('movimientosDestacados: ida-y-vuelta se detecta por bruto (neto 0)', () => {
  const d = movimientosDestacados([M(111100030, 5000000, 0), M(111100030, 0, 5000000)]);
  assert.ok(d.some((x) => x.cuenta_id === 111100030), 'reintegro Skyceo ida-y-vuelta (neto 0, bruto 10M) detectado');
});

console.log(`\n✅ ${pass} tests OK`);
