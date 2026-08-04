// Tests de la bajada automática del extracto de Talo por API (src/lib/talo-api.js).
// No necesitan credenciales ni internet: el fetch se inyecta.
// Correr:  node test/talo-api.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const {
  bajarExtracto, listarTransacciones, mapearTransaccion, rangoUtcDeDiasArg,
  numApi, sumarImpuestos, TaloApiError,
} = require('../src/lib/talo-api');
const { escribirXlsx, totales } = require('../src/lib/talo-extracto-cli');
const { parsearTalo } = require('../src/lib/talo-excel');
const { detectarPlataforma, porCodigo } = require('../src/lib/plataformas');
const { conciliarMP } = require('../src/lib/conciliacion-mp');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }
async function ta(nombre, fn) { await fn(); pass++; console.log('  ok:', nombre); }

// Transacción tal como la documenta Talo (docs.talo.com.ar/transfers/transactions-api).
const TX = {
  transaction_id: 'TX#87723204-ba9e-4e70-afba-da165eac4a32',
  id: '87723204-ba9e-4e70-afba-da165eac4a32',
  user_id: 'f61876b0-10a5-4e39-8e2c-17343b3fa1b6',
  transactionType: 'INBOUND',
  amount: '1185.48',
  gross_amount: '1200',
  address: '0000716149000693369021',
  address_alias: 'jul.807995.talo',
  currency: 'ARS',
  network: 'POLLUX',
  commission: 1.21,
  commission_amount: '14.52',
  taxes: [],
  transaction_status: 'PROCESSED',
  payment_id: 'VAR-f61876b0-DOCFIX-1784132231',
  creation_timestamp: '2026-07-15T16:18:08.630Z',
};

// fetch falso: primero el token, después N páginas de transacciones.
function fetchFalso(paginas, espia = {}) {
  espia.urls = [];
  let i = 0;
  return async (url, opciones) => {
    espia.urls.push(String(url));
    if (String(url).includes('/tokens')) {
      espia.tokenBody = JSON.parse(opciones.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ message: 'ok', error: false, data: { token: 'TL-token-de-prueba' } }) };
    }
    espia.authHeader = opciones.headers.Authorization;
    const p = paginas[i++] || { transactions: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: 'ok', error: false, code: 200, data: p }) };
  };
}
const CRED = { userId: 'U1', clientId: 'C1', clientSecret: 'S1' };

console.log('numApi(): la API manda formato ISO, NO argentino');
t('lee string con punto decimal', () => {
  assert.strictEqual(numApi('1185.48'), 1185.48);
  assert.strictEqual(numApi('1200'), 1200);
  assert.strictEqual(numApi(1.21), 1.21);
});
t('RECHAZA el formato del panel: no puede confundir miles con decimales', () => {
  // Si esto devolviera un número, '1.399.329,00' del Excel entraría como basura por la API.
  assert.strictEqual(numApi('74.950,00'), null);
  assert.strictEqual(numApi('1.399.329,00'), null);
});
t('vacío/ilegible da null, nunca 0', () => {
  assert.strictEqual(numApi(''), null);
  assert.strictEqual(numApi('-'), null);
  assert.strictEqual(numApi('ocho'), null);
  assert.strictEqual(numApi(null), null);
});

console.log('\nrangoUtcDeDiasArg(): el día argentino no arranca a las 00:00Z');
t('un día ARG = 03:00Z a 02:59:59Z del día siguiente', () => {
  const r = rangoUtcDeDiasArg('2026-07-23', '2026-07-23');
  assert.strictEqual(r.start_date, '2026-07-23T03:00:00.000Z');
  assert.strictEqual(r.end_date, '2026-07-24T02:59:59.000Z');
});
t('rango de varios días', () => {
  const r = rangoUtcDeDiasArg('2026-07-01', '2026-07-23');
  assert.strictEqual(r.start_date, '2026-07-01T03:00:00.000Z');
  assert.strictEqual(r.end_date, '2026-07-24T02:59:59.000Z');
});
t('rango al revés o fecha mal formada: error claro', () => {
  assert.throws(() => rangoUtcDeDiasArg('2026-07-23', '2026-07-01'), (e) => e instanceof TaloApiError && /al revés/.test(e.message));
  assert.throws(() => rangoUtcDeDiasArg('23/07/2026', '23/07/2026'), (e) => e instanceof TaloApiError && /AAAA-MM-DD/.test(e.message));
});

console.log('\nmapearTransaccion(): UTC -> hora argentina y signos');
t('convierte el timestamp UTC a hora de pared argentina (-3)', () => {
  // Sin esta conversión la conciliación se corre 3 h y no aparea NADA contra el libro.
  assert.strictEqual(mapearTransaccion(TX, 0).hora, '2026-07-15 13:18:08');
});
t('INBOUND -> RECIBIDO, con bruto/comisión/neto de la doc', () => {
  const o = mapearTransaccion(TX, 0);
  assert.strictEqual(o.estado, 'RECIBIDO');
  assert.strictEqual(o.bruto, 1200);
  assert.strictEqual(o.comision, -14.52); // negativo, como en el Excel y en MP
  assert.strictEqual(o.impuestos, 0);
  assert.strictEqual(o.neto, 1185.48);
  assert.strictEqual(o.enviado, 0);
  assert.strictEqual(o.moneda, 'ARS');
  assert.strictEqual(o.source_id, 'VAR-f61876b0-DOCFIX-1784132231');
});
t('OUTBOUND -> ENVIADO y el importe va con signo negativo en "enviado"', () => {
  const o = mapearTransaccion({ ...TX, transactionType: 'OUTBOUND', amount: '-1.00', gross_amount: '1.01' }, 0);
  assert.strictEqual(o.estado, 'ENVIADO');
  assert.strictEqual(o.bruto, 0);
  assert.strictEqual(o.enviado, -1.01);
});
t('REFUND tiene estado propio: no se cuela como cobro', () => {
  assert.strictEqual(mapearTransaccion({ ...TX, transactionType: 'REFUND' }, 0).estado, 'REEMBOLSO');
});
t('un transactionType desconocido NO se ignora: tira error', () => {
  assert.throws(() => mapearTransaccion({ ...TX, transactionType: 'CHARGEBACK' }, 0),
    (e) => e instanceof TaloApiError && /no conozco/.test(e.message));
});
t('timestamp ilegible NO se inventa: tira error', () => {
  assert.throws(() => mapearTransaccion({ ...TX, creation_timestamp: 'ayer' }, 0),
    (e) => e instanceof TaloApiError && /ilegible/.test(e.message));
});
t('el titular no viene documentado: queda vacío, no se usa address_alias', () => {
  // address_alias es NUESTRO CVU/alias de destino: ponerlo de titular sería mentir en el informe.
  const o = mapearTransaccion(TX, 0);
  assert.strictEqual(o.titular, '');
  assert.strictEqual(mapearTransaccion({ ...TX, payer_name: 'RODRIGUEZ HECTOR MAU' }, 0).titular, 'RODRIGUEZ HECTOR MAU');
});

console.log('\nsumarImpuestos(): plata que no se puede leer frena, no vale 0');
t('suma los importes del array', () => {
  assert.strictEqual(sumarImpuestos([{ tax_amount: '0.01' }, { tax_amount: '0.60' }], 'TX#1'), 0.61);
});
t('array vacío o ausente = 0 impuestos', () => {
  assert.strictEqual(sumarImpuestos([], 'TX#1'), 0);
  assert.strictEqual(sumarImpuestos(undefined, 'TX#1'), 0);
});
t('impuestos presentes pero ilegibles: tira error en vez de subestimar el costo', () => {
  assert.throws(() => sumarImpuestos([{ vaya_a_saber: 'x' }], 'TX#1'),
    (e) => e instanceof TaloApiError && /no sé leer/.test(e.message));
});

(async () => {
  console.log('\nlistarTransacciones(): paginación por cursor');
  await ta('sigue el lastEvaluatedKey hasta que no hay más', async () => {
    const espia = {};
    const f = fetchFalso([
      { transactions: [TX], lastEvaluatedKey: { user_id: 'U1', transaction_id: 'TX#1', creation_timestamp: '2026-07-15T16:18:08.630Z' } },
      { transactions: [{ ...TX, id: 'b' }] }, // sin lastEvaluatedKey -> corta
    ], espia);
    const r = await listarTransacciones({ userId: 'U1', token: 'TL-x', fetchImpl: f, start_date: 'A', end_date: 'B' });
    assert.strictEqual(r.length, 2);
    assert.strictEqual(espia.urls.length, 2);
    assert.match(espia.urls[1], /cursor_transaction_id=TX%231/);
    assert.match(espia.urls[1], /cursor_creation_timestamp=/);
    assert.strictEqual(espia.authHeader, 'Bearer TL-x');
  });
  await ta('no cicla para siempre si la API nunca deja de mandar cursor', async () => {
    const pagInfinita = { transactions: [TX], lastEvaluatedKey: { user_id: 'U1', transaction_id: 'TX#1', creation_timestamp: 'x' } };
    await assert.rejects(
      listarTransacciones({ userId: 'U1', token: 'x', fetchImpl: fetchFalso(Array(300).fill(pagInfinita)), maxPaginas: 5 }),
      (e) => e instanceof TaloApiError && /Achicá el rango/.test(e.message));
  });

  console.log('\nbajarExtracto(): extremo a extremo');
  await ta('pide el token con las credenciales y devuelve las operaciones ordenadas', async () => {
    const espia = {};
    const f = fetchFalso([{ transactions: [
      { ...TX, creation_timestamp: '2026-07-23T19:33:00.000Z' },  // 16:33 ART
      { ...TX, creation_timestamp: '2026-07-23T13:36:00.000Z' },  // 10:36 ART
    ] }], espia);
    const { operaciones } = await bajarExtracto({ desde: '2026-07-23', ...CRED, fetchImpl: f });
    assert.deepStrictEqual(espia.tokenBody, { client_id: 'C1', client_secret: 'S1' });
    assert.match(espia.urls[0], /\/users\/U1\/tokens$/);
    assert.deepStrictEqual(operaciones.map((o) => o.hora), ['2026-07-23 10:36:00', '2026-07-23 16:33:00']);
    assert.deepStrictEqual(operaciones.map((o) => o.fila), [1, 2]);
  });
  await ta('guarda de estado: descarta transacciones NO finalizadas (transaction_status != PROCESSED)', async () => {
    // Una pendiente/revertida no es un cobro cerrado: no puede contar en el arqueo (el panel tampoco
    // la muestra como cobro). Validado jul-2026: las 581 del mes vinieron todas PROCESSED.
    const f = fetchFalso([{ transactions: [
      { ...TX, payment_id: 'ok', transaction_status: 'PROCESSED', gross_amount: '1000', amount: '1000' },
      { ...TX, id: 'x', payment_id: 'pend', transaction_status: 'PENDING', gross_amount: '9999', amount: '9999' },
    ] }]);
    const { operaciones, descartadas } = await bajarExtracto({ desde: '2026-07-23', ...CRED, fetchImpl: f });
    assert.strictEqual(operaciones.length, 1);
    assert.strictEqual(operaciones[0].source_id, 'ok');
    assert.strictEqual(descartadas, 1);
  });
  await ta('guarda de estado: sin el campo transaction_status (API vieja) NO filtra — backward-safe', async () => {
    const sinStatus = { ...TX }; delete sinStatus.transaction_status;
    const f = fetchFalso([{ transactions: [sinStatus] }]);
    const { operaciones, descartadas } = await bajarExtracto({ desde: '2026-07-23', ...CRED, fetchImpl: f });
    assert.strictEqual(operaciones.length, 1);
    assert.strictEqual(descartadas, 0);
  });
  await ta('credenciales rechazadas: mensaje que dice qué revisar', async () => {
    const f = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid credentials' }) });
    await assert.rejects(bajarExtracto({ desde: '2026-07-23', ...CRED, fetchImpl: f }),
      (e) => e instanceof TaloApiError && /TALO_CLIENT_SECRET/.test(e.message));
  });
  await ta('sin credenciales avisa dónde se generan, sin salir a la red', async () => {
    const previo = { u: process.env.TALO_USER_ID, c: process.env.TALO_CLIENT_ID, s: process.env.TALO_CLIENT_SECRET };
    delete process.env.TALO_USER_ID; delete process.env.TALO_CLIENT_ID; delete process.env.TALO_CLIENT_SECRET;
    try {
      await assert.rejects(bajarExtracto({ desde: '2026-07-23', fetchImpl: async () => { throw new Error('no debería llamar a la red'); } }),
        (e) => e instanceof TaloApiError && /Dashboard/.test(e.message));
    } finally {
      if (previo.u) process.env.TALO_USER_ID = previo.u;
      if (previo.c) process.env.TALO_CLIENT_ID = previo.c;
      if (previo.s) process.env.TALO_CLIENT_SECRET = previo.s;
    }
  });

  console.log('\nel archivo generado es un reemplazo DIRECTO del que se baja del panel');
  await ta('ida y vuelta: API -> xlsx -> parsearTalo da los mismos importes y horas', async () => {
    const f = fetchFalso([{ transactions: [
      { ...TX, gross_amount: '74950.00', amount: '74044.13', commission_amount: '453.45',
        taxes: [{ tax_amount: '452.42' }], creation_timestamp: '2026-07-23T15:02:00.000Z' },
      { ...TX, transactionType: 'OUTBOUND', gross_amount: '1.01', amount: '-1.00',
        commission_amount: '0', taxes: [], creation_timestamp: '2026-07-23T16:42:00.000Z' },
    ] }]);
    const { operaciones } = await bajarExtracto({ desde: '2026-07-23', ...CRED, fetchImpl: f });

    const destino = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'talo-')), 'Movimientos.xlsx');
    escribirXlsx(operaciones, destino);
    const releido = parsearTalo(fs.readFileSync(destino)).operaciones;

    assert.strictEqual(releido.length, 2);
    assert.strictEqual(releido[0].bruto, 74950);
    assert.strictEqual(releido[0].comision, -453.45);
    assert.strictEqual(releido[0].impuestos, -452.42);
    assert.strictEqual(releido[0].neto, 74044.13);
    assert.strictEqual(releido[0].estado, 'RECIBIDO');
    assert.strictEqual(releido[0].hora, '2026-07-23 12:02:00'); // 15:02Z -> 12:02 ART, con segundos
    assert.strictEqual(releido[1].estado, 'ENVIADO');
    assert.strictEqual(releido[1].neto, -1);
    // Los totales tienen que sobrevivir el ida y vuelta al centavo.
    const a = totales(operaciones); const b = totales(releido);
    assert.strictEqual(a.bruto.toFixed(2), b.bruto.toFixed(2));
    assert.strictEqual(a.neto.toFixed(2), b.neto.toFixed(2));
  });
  await ta('detectarPlataforma() reconoce el archivo generado como de Talo', async () => {
    const f = fetchFalso([{ transactions: [TX] }]);
    const { operaciones } = await bajarExtracto({ desde: '2026-07-15', ...CRED, fetchImpl: f });
    const destino = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'talo-')), 'Movimientos.xlsx');
    escribirXlsx(operaciones, destino);
    assert.strictEqual(detectarPlataforma(fs.readFileSync(destino)).codigo, 'talo');
  });

  console.log('\nel motor de conciliación acepta las operaciones de la API sin cambios');
  await ta('aparea un cobro bajado por API contra su asiento de Sigma', async () => {
    const f = fetchFalso([{ transactions: [
      { ...TX, gross_amount: '16320', amount: '16320', commission_amount: '0',
        creation_timestamp: '2026-07-23T14:42:00.000Z' }, // 11:42 ART
    ] }]);
    const { operaciones } = await bajarExtracto({ desde: '2026-07-23', ...CRED, fetchImpl: f });
    const r = conciliarMP({
      movimientos: [{ asiento: 1, fecha: new Date(2026, 6, 23), comp: 'PG', cliente: 'CLIENTE',
        comprobante: 'REC', usuario: 'U', ingreso: '2026-07-23 11:43:22', debe: 16320, haber: 0 }],
      operaciones,
      plataforma: porCodigo('talo'),
    });
    assert.strictEqual(r.resumen.nPares, 1);
    assert.strictEqual(r.resumen.nSoloMp + r.resumen.nSoloSistema, 0);
  });
  await ta('el REEMBOLSO queda fuera del alcance, con su motivo', async () => {
    const f = fetchFalso([{ transactions: [{ ...TX, transactionType: 'REFUND' }] }]);
    const { operaciones } = await bajarExtracto({ desde: '2026-07-15', ...CRED, fetchImpl: f });
    const TALO = porCodigo('talo');
    assert.strictEqual(TALO.enAlcance(operaciones[0]), false);
    assert.match(TALO.motivoFuera(operaciones[0]), /REEMBOLSO/);
  });

  console.log(`\n✅ ${pass} tests OK`);
})().catch((e) => { console.error('\n❌', e); process.exit(1); });
