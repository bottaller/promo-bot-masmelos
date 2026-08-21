// Bajada AUTOMÁTICA del extracto de Talo por API, para no depender de bajar a mano el
// "Movimientos_<desde>_<hasta>.xlsx" del panel.
//
// Devuelve EXACTAMENTE la misma forma que parsearTalo() (talo-excel.js), así que el motor de
// conciliación, plataformas.js y el informe no se enteran de por dónde vino el dato.
//
// Cuatro cosas que este archivo hace distinto al parser del Excel, las cuatro con dientes:
//
//  1) LOS IMPORTES VIENEN EN FORMATO ISO, NO ARGENTINO. El panel exporta '74.950,00'; la API
//     devuelve la string '74950.00' (punto decimal, sin miles). Reusar parseMonto() del Excel
//     acá sería un error silencioso: '1.399' se leería como 1399 en vez de 1,399.
//
//  2) LA HORA VIENE EN UTC, EL EXCEL EN HORA ARGENTINA. creation_timestamp es
//     '2026-07-15T16:18:08.630Z'. Si no se convierte, TODA la conciliación se corre 3 horas y
//     no aparea nada. Por eso pasa por isoAHoraArg(), igual que la liquidación de MP.
//
//  3) EL RANGO DE FECHAS TAMBIÉN. Pedir el 23/07 argentino NO es start_date=2026-07-23T00:00Z:
//     eso arranca a las 21:00 del 22 y se come las últimas 3 horas del día. El rango se
//     construye en UTC a partir del día calendario argentino (ver rangoUtcDeDiasArg).
//
//  4) LA API DEVUELVE MENOS COLUMNAS QUE EL PANEL. El Excel trae el desglose fino de impuestos
//     (IIBB, crédito/débito, sobre movimiento y sobre comisión: 19 columnas) y el Titular del
//     pagador. La API documentada trae 'taxes[]' (total) y no documenta titular. Lo que no
//     viene se deja vacío, NUNCA en cero inventado. Antes de reemplazar el circuito manual,
//     correr `--verificar` contra un Excel del mismo día (ver abajo).
//
// Uso como CLI:
//   node src/lib/talo-api.js --desde 2026-07-23 --hasta 2026-07-23
//   node src/lib/talo-api.js --desde 2026-07-23 --salida "C:\ruta\Movimientos.xlsx"
//   node src/lib/talo-api.js --desde 2026-07-23 --verificar "C:\...\Movimientos_23-07-2026_23-07-2026.xlsx"
//
// Credenciales (Dashboard de Talo > Usuario > Credenciales), en .env:
//   TALO_USER_ID, TALO_CLIENT_ID, TALO_CLIENT_SECRET
//   TALO_BASE_URL (opcional: https://sandbox-api.talo.com.ar para probar sin plata real)
const { isoAHoraArg, tsCanonico } = require('./fechas');
const { ESTADO_COBRO } = require('./talo-excel');

// Errores "esperables" con mensaje para el usuario (los distingue de un bug real).
class TaloApiError extends Error {}

const BASE_PROD = 'https://api.talo.com.ar';

// INBOUND/OUTBOUND/REFUND (API) -> el vocabulario del Excel, que es el que ya entienden
// plataformas.js (enAlcance/motivoFuera) y los tests. REFUND no aparece en el Excel del panel:
// se mapea a su propio estado para que quede FUERA del alcance del arqueo y con motivo propio,
// en vez de colarse como un cobro.
const ESTADO_POR_TIPO = {
  INBOUND: ESTADO_COBRO,   // 'RECIBIDO'
  OUTBOUND: 'ENVIADO',
  REFUND: 'REEMBOLSO',
};

// --- Importes -------------------------------------------------------------------------------
// La API manda los montos como STRING con punto decimal ('1185.48', '1200') y a veces como
// number (commission: 1.21). Devuelve null si no es un número: nunca 0 por defecto, porque un
// cero silencioso en plata no se ve. (Mismo criterio que parseMonto() del Excel, otra sintaxis.)
function numApi(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '' || s === '-') return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null; // '74.950,00' (formato panel) NO pasa: es otro formato
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Suma el array taxes[]. La doc muestra 'taxes: []' vacío y no publica la forma de sus items,
// así que se aceptan los nombres razonables. Si el array trae items pero NINGUNO tiene un
// importe legible, tira error en vez de devolver 0: preferimos frenar a subestimar impuestos.
function sumarImpuestos(taxes, ref) {
  if (taxes == null) return 0;
  if (!Array.isArray(taxes)) {
    throw new TaloApiError(`La transacción ${ref} trae "taxes" que no es una lista (${JSON.stringify(taxes)}). ¿Cambió la API?`);
  }
  if (taxes.length === 0) return 0;
  let total = 0;
  let leidos = 0;
  for (const t of taxes) {
    if (t == null) continue;
    const n = numApi(typeof t === 'object' ? (t.tax_amount ?? t.amount ?? t.value) : t);
    if (n === null) continue;
    total += Math.abs(n);
    leidos++;
  }
  if (leidos === 0) {
    throw new TaloApiError(
      `La transacción ${ref} trae ${taxes.length} impuesto(s) que no sé leer ` +
      `(${JSON.stringify(taxes[0])}). Revisar el formato antes de confiar en el neto.`
    );
  }
  return total;
}

// --- Rango de fechas ------------------------------------------------------------------------
// Día calendario ARGENTINO -> instantes UTC para start_date/end_date.
// El 23/07 argentino va de 2026-07-23T03:00:00Z a 2026-07-24T02:59:59Z (Argentina es UTC-3 fijo,
// sin horario de verano). Pedirlo como 00:00Z arrancaría a las 21:00 del 22 y perdería las
// últimas 3 horas del día — justo las de la tarde de local.
function rangoUtcDeDiasArg(desdeIso, hastaIso) {
  const dia = (s, etiqueta) => {
    const m = String(s == null ? '' : s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new TaloApiError(`La fecha ${etiqueta} tiene que ser AAAA-MM-DD (vino "${s}").`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [y1, m1, d1] = dia(desdeIso, '--desde');
  const [y2, m2, d2] = dia(hastaIso, '--hasta');
  const ini = new Date(Date.UTC(y1, m1 - 1, d1, 3, 0, 0));            // 00:00:00 ART
  const fin = new Date(Date.UTC(y2, m2 - 1, d2, 3, 0, 0) + 86400000 - 1000); // 23:59:59 ART
  if (fin < ini) throw new TaloApiError(`El rango está al revés: --desde ${desdeIso} es posterior a --hasta ${hastaIso}.`);
  return { start_date: ini.toISOString(), end_date: fin.toISOString() };
}

// --- HTTP -----------------------------------------------------------------------------------
// `f` es el fetch a usar (inyectable desde los tests; por defecto el nativo de Node 24).
async function pedir(f, url, opciones, queHacia) {
  let r;
  try {
    r = await f(url, opciones);
  } catch (e) {
    throw new TaloApiError(`No pude conectarme a Talo ${queHacia} (${e.message}). ¿Hay internet?`);
  }
  const texto = await r.text();
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { /* respuesta no-JSON: se reporta cruda */ }
  if (!r.ok) {
    const detalle = (cuerpo && (cuerpo.message || cuerpo.error)) || texto.slice(0, 200) || '(sin cuerpo)';
    if (r.status === 401 || r.status === 403) {
      throw new TaloApiError(`Talo rechazó las credenciales ${queHacia} (HTTP ${r.status}: ${detalle}). Revisá TALO_USER_ID / TALO_CLIENT_ID / TALO_CLIENT_SECRET.`);
    }
    throw new TaloApiError(`Talo respondió HTTP ${r.status} ${queHacia}: ${detalle}`);
  }
  if (cuerpo == null) throw new TaloApiError(`Talo devolvió una respuesta vacía o ilegible ${queHacia}.`);
  return cuerpo;
}

// POST /users/:user_id/tokens -> token 'TL-...'. La doc no publica el vencimiento, así que el
// token NO se cachea en disco: se pide uno por corrida (son corridas cortas, una por día).
async function obtenerToken({ userId, clientId, clientSecret, baseUrl = BASE_PROD, fetchImpl } = {}) {
  if (!userId || !clientId || !clientSecret) {
    throw new TaloApiError('Faltan credenciales de Talo. Cargá TALO_USER_ID, TALO_CLIENT_ID y TALO_CLIENT_SECRET en el .env (Dashboard > Usuario > Credenciales).');
  }
  const f = fetchImpl || fetch;
  const cuerpo = await pedir(f, `${baseUrl}/users/${encodeURIComponent(userId)}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  }, 'al pedir el token');

  // La doc describe data como "información del token" sin fijar el nombre del campo; se aceptan
  // las variantes razonables antes de rendirse.
  const d = cuerpo.data || {};
  const token = d.token || d.access_token || d.accessToken || (typeof d === 'string' ? d : null);
  if (!token || typeof token !== 'string') {
    throw new TaloApiError(`No encontré el token en la respuesta de Talo (${JSON.stringify(cuerpo).slice(0, 200)}). ¿Cambió la API?`);
  }
  return token;
}

// GET /transactions/ paginado por cursor. Devuelve las transacciones CRUDAS, en el orden en que
// las manda la API. `limit` es por página, no un tope total.
async function listarTransacciones({
  userId, token, teamId, baseUrl = BASE_PROD, start_date, end_date, limit = 100,
  maxPaginas = 200, fetchImpl,
} = {}) {
  const f = fetchImpl || fetch;
  const todas = [];
  let cursor = null;
  let pagina = 0;

  do {
    const q = new URLSearchParams({ user_id: userId, limit: String(limit) });
    if (teamId) q.set('team_id', teamId);
    if (start_date) q.set('start_date', start_date);
    if (end_date) q.set('end_date', end_date);
    if (cursor) {
      // Los tres cursores vienen juntos en lastEvaluatedKey; van los tres o ninguno.
      if (cursor.user_id) q.set('cursor_user_id', cursor.user_id);
      if (cursor.transaction_id) q.set('cursor_transaction_id', cursor.transaction_id);
      if (cursor.creation_timestamp) q.set('cursor_creation_timestamp', cursor.creation_timestamp);
    }

    const cuerpo = await pedir(f, `${baseUrl}/transactions/?${q}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, `al listar transacciones (página ${pagina + 1})`);

    const data = cuerpo.data || {};
    const lote = data.transactions;
    if (!Array.isArray(lote)) {
      throw new TaloApiError(`Esperaba data.transactions como lista y vino ${JSON.stringify(data).slice(0, 200)}. ¿Cambió la API?`);
    }
    todas.push(...lote);

    const k = data.lastEvaluatedKey;
    cursor = k && k.transaction_id ? k : null;
    pagina++;
    if (pagina >= maxPaginas && cursor) {
      throw new TaloApiError(`Me pasé de ${maxPaginas} páginas trayendo transacciones y sigue habiendo más. Achicá el rango de fechas.`);
    }
  } while (cursor);

  return todas;
}

// Una transacción de la API -> una operación con la MISMA forma que devuelve parsearTalo():
//   { source_id, hora, bruto, enviado, comision, impuestos, neto, estado, titular, moneda, fila }
// Los signos se normalizan como en el Excel y como MP: comisión e impuestos NEGATIVOS.
function mapearTransaccion(tx, i) {
  const ref = tx.transaction_id || tx.id || `#${i + 1}`;

  const tipo = String(tx.transactionType || '').toUpperCase();
  const estado = ESTADO_POR_TIPO[tipo];
  if (!estado) {
    throw new TaloApiError(`La transacción ${ref} tiene un transactionType que no conozco ("${tx.transactionType}"). Revisar antes de arquear.`);
  }

  const hora = isoAHoraArg(tx.creation_timestamp);
  if (!hora) {
    throw new TaloApiError(`La transacción ${ref} tiene creation_timestamp ilegible ("${tx.creation_timestamp}").`);
  }

  const neto = numApi(tx.amount);
  const brutoApi = numApi(tx.gross_amount);
  if (neto === null && brutoApi === null) {
    throw new TaloApiError(`La transacción ${ref} no trae ni amount ni gross_amount legibles.`);
  }
  // El Excel separa en dos columnas lo que la API pone en un solo importe con su tipo:
  // lo que entra va a "Recibido" (bruto) y lo que sale a "Enviado".
  const magnitud = brutoApi === null ? Math.abs(neto) : Math.abs(brutoApi);
  const entra = estado === ESTADO_COBRO;

  // Lo que resta del bruto va NEGATIVO (igual que el Excel y que MP). El `|| 0` evita el -0
  // que deja `-Math.abs(0)`: es cierto que -0 === 0, pero se imprime "-0,00" en el informe.
  const neg = (n) => (n ? -Math.abs(n) : 0);
  const comision = neg(numApi(tx.commission_amount) ?? 0);
  const impuestos = neg(sumarImpuestos(tx.taxes, ref));

  return {
    fila: i + 1,
    source_id: String(tx.payment_id ?? tx.id ?? ''),
    hora,
    bruto: entra ? magnitud : 0,
    enviado: entra ? 0 : neg(magnitud),
    comision,
    impuestos,
    neto: neto === null ? 0 : neto,
    estado,
    // El panel trae el nombre del pagador; la API documentada NO. Se buscan los nombres
    // plausibles y, si no está, queda vacío (no se inventa). Ojo: address_alias es NUESTRO
    // CVU/alias de destino, no el titular que pagó — por eso no se usa como fallback.
    titular: String(tx.titular ?? tx.holder ?? tx.payer_name ?? tx.counterparty_name ?? ''),
    moneda: String(tx.currency ?? ''),
    // Extra que el Excel no tiene y sirve para rastrear: el id propio del movimiento.
    transaction_id: String(tx.transaction_id ?? tx.id ?? ''),
  };
}

// --- Entrada principal ----------------------------------------------------------------------
// bajarExtracto({desde, hasta}) -> { operaciones: [...] }, misma forma que parsearTalo(buffer).
// `desde`/`hasta` son días calendario ARGENTINOS en AAAA-MM-DD. Si falta `hasta`, es un solo día.
async function bajarExtracto({
  desde, hasta, userId, clientId, clientSecret, teamId, baseUrl, fetchImpl, limit,
} = {}) {
  const base = baseUrl || process.env.TALO_BASE_URL || BASE_PROD;
  const cred = {
    userId: userId || process.env.TALO_USER_ID,
    clientId: clientId || process.env.TALO_CLIENT_ID,
    clientSecret: clientSecret || process.env.TALO_CLIENT_SECRET,
  };
  const rango = rangoUtcDeDiasArg(desde, hasta || desde);

  const token = await obtenerToken({ ...cred, baseUrl: base, fetchImpl });
  const crudas = await listarTransacciones({
    userId: cred.userId, token, teamId: teamId || process.env.TALO_TEAM_ID,
    baseUrl: base, ...rango, limit, fetchImpl,
  });

  // Guarda de estado: solo transacciones FINALIZADAS entran al arqueo. Una con transaction_status
  // != 'PROCESSED' (pendiente, revertida, etc.) NO es un cobro cerrado y, contada como tal, falsea
  // la plata. El panel tampoco las muestra como cobro. Si el campo no viene (API vieja / cambio de
  // formato), NO se filtra (backward-safe: mejor de más que perder todo). Validado jul-2026: las
  // 581 transacciones del mes vinieron todas PROCESSED, así que hoy no descarta ninguna.
  const finalizadas = crudas.filter((tx) => !tx.transaction_status || String(tx.transaction_status).toUpperCase() === 'PROCESSED');
  const descartadas = crudas.length - finalizadas.length;
  if (descartadas > 0) {
    console.warn(`Talo API: descarté ${descartadas} transacción(es) no finalizada(s) (transaction_status != PROCESSED); no entran al arqueo.`);
  }

  const operaciones = finalizadas
    .map(mapearTransaccion)
    // La API ordena por cursor; el Excel viene cronológico y el informe lo asume.
    .sort((a, b) => (a.hora < b.hora ? -1 : a.hora > b.hora ? 1 : 0))
    .map((o, i) => ({ ...o, fila: i + 1 }));

  return { operaciones, rango, crudas, descartadas };
}

module.exports = {
  bajarExtracto, obtenerToken, listarTransacciones, mapearTransaccion,
  rangoUtcDeDiasArg, numApi, sumarImpuestos, TaloApiError, BASE_PROD, ESTADO_POR_TIPO,
};

// --- CLI ------------------------------------------------------------------------------------
if (require.main === module) {
  require('./talo-extracto-cli').main(process.argv.slice(2)).catch((e) => {
    console.error(`\n❌ ${e instanceof TaloApiError ? e.message : e.stack || e}`);
    process.exit(1);
  });
}
