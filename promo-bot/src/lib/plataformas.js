// Las plataformas de cobro que se arquean contra el libro (hoy: Mercado Pago y Talo).
//
// Cada una declara lo ÚNICO que la hace distinta: contra qué cuenta de Sigma asienta, cómo se
// parsea su liquidación, qué operaciones entran en el arqueo, y cuánto tarda en asentarse. El
// motor (conciliacion-mp.js) es agnóstico: apareo, tolerancias y rastreo valen para todas.
//
// Sumar una plataforma = agregar una entrada acá + su parser. Nada más.
const { parsearLiquidacion, LiquidacionError } = require('./liquidacion-excel');
const { parsearCollection, esCollection } = require('./collection-excel');
const { parsearTalo, TaloError, ESTADO_COBRO } = require('./talo-excel');

// MP puede venir en DOS formatos: el "Collection" (Cobros, disponible el MISMO día — el que se usa
// hoy) o el "settlement_v2" (a día vencido). Se detecta por los encabezados y se rutea al parser
// que corresponde; los dos producen EXACTAMENTE el mismo shape de operación. Si no se puede leer
// el archivo, cae al parser de settlement, que tira el LiquidacionError con el mensaje claro.
function parsearMp(buffer) {
  const XLSX = require('xlsx');
  let filas = [];
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (ws && ws['!ref']) filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
  } catch (e) { /* noop: cae al settlement */ }
  return esCollection(filas) ? parsearCollection(buffer) : parsearLiquidacion(buffer);
}

// --- Mercado Pago ----------------------------------------------------------
// La cuenta 422101014 recibe EXACTAMENTE las operaciones con SUB UNIT='QR Code' (adentro
// conviven dinero en cuenta, transferencia, crédito y débito). Point liquida en las cuentas de
// tarjetas, no acá. Ver docs/conciliacion-mp.md §2.
const CANAL_QR = 'QR Code';
const CANAL_POINT = 'Point';
const TIPO_COBRO = 'Approved payment';

// El arqueo de MP concilia TODA la cobranza que pasa por Mercado Pago, sin importar el canal: QR /
// transferencia (liquidan en la cuenta MP 422101014) Y Point (terminal física, que se asienta en las
// cuentas de TARJETA — se suman al lado sistema con `incluirCuenta`, ver el descriptor). La venta con
// tarjeta cuenta como cobranza aunque la plata de crédito recién entre a MP a ~18 días (es una venta
// igual). Antes Point quedaba "fuera de alcance"; ahora entra al apareo normal.
function motivoFueraMp(op) {
  if (op.unidad === 'Mercado Libre') return 'Mercado Libre: no es una venta';
  if (!op.canal) return 'Sin canal ni medio de pago: revisar con MP qué es';
  if (op.canal !== CANAL_QR && op.canal !== CANAL_POINT) return `Canal "${op.canal}": fuera del alcance`;
  if (op.tipo !== TIPO_COBRO) return `Es "${op.tipo}", no un cobro aprobado`;
  if (op.bruto <= 0) return 'Importe negativo o cero: no es una venta';
  return 'Fuera del alcance';
}

// Las cuentas de Sigma donde se asienta una venta con TARJETA (el Point liquida ahí, no en la cuenta
// de MP). Se matchea por ID conocido Y por nombre:
//  - IDs: la composición de la cuenta de control "Mercado Pago" en conciliacion.js (las tarjetas que
//    liquidan en MP) MÁS la Visa Crédito 111301001 —que allá se excluye por ser cuenta a cobrar (Visa
//    liquida a ~18 días), pero acá SÍ entra porque la VENTA con crédito es cobranza igual—.
//  - regex /^TARJETA: red por si suman una marca nueva ("TARJETA NARANJA…") sin tocar esta lista.
// Verificado 05/08: 111301001/002/304001/305001 = "TARJETA VISA CRED/DEB, MASTERCARD, AMEX MORENO".
const CUENTAS_TARJETA_ID = new Set([111301001, 111301002, 111302002, 111303001, 111304001, 111305001]);
function esCuentaTarjeta(cuentaId, nombre) {
  return CUENTAS_TARJETA_ID.has(cuentaId) || /^\s*TARJETA\b/i.test(String(nombre || ''));
}

// --- Talo ------------------------------------------------------------------
// Cuenta 42210108 "TALO HONRE S.A" — encontrada cruzando los cobros del 23/07 contra las 85
// cuentas del libro (no hay ninguna cuenta que se llame "Talo QR" ni parecido).
// Entran los movimientos RECIBIDO (cobros); los ENVIADO son salidas de plata.
function motivoFueraTalo(op) {
  if (op.estado && op.estado !== ESTADO_COBRO) return `Es "${op.estado}", no un cobro recibido`;
  if (op.bruto <= 0) return 'Importe cero o negativo: no es un cobro';
  return 'Fuera del alcance';
}

const PLATAFORMAS = [
  {
    codigo: 'mp',
    nombre: 'Mercado Pago',
    corto: 'MP',            // se repite en cada renglón del mensaje: conviene corto
    cuenta: 422101014,
    cuentaNombre: 'MERCADO PAGO MORENO',
    // Además de la cuenta MP, suma al lado sistema las cuentas de TARJETA (donde se asienta el Point).
    incluirCuenta: esCuentaTarjeta,
    archivoEsperado: 'reporte de Cobros (collection-….xlsx) del panel de Mercado Pago',
    alcanceTxt: 'cobranzas por QR, transferencia y tarjeta (Point)',
    // Acepta los dos formatos de MP (Cobros del mismo día o settlement a día vencido).
    parsear: parsearMp,
    Error: LiquidacionError, // CollectionError hereda de LiquidacionError: un solo instanceof atrapa ambos
    enAlcance: (o) => (o.canal === CANAL_QR || o.canal === CANAL_POINT) && o.tipo === TIPO_COBRO && o.bruto > 0,
    motivoFuera: motivoFueraMp,
    // Los asientos de MP se cargan a segundos del cobro (5-210 s el 16/07).
    deltaSospechosoSeg: 30 * 60,
    // Cómo se identifica una operación en el reporte.
    referencia: (o) => (o.source_id ? `id ${o.source_id}` : ''),
    // Reconoce sus DOS formatos por los encabezados: settlement ('source id') o Cobros (operation_id).
    reconoce: (encabezados) => encabezados.includes('source id')
      || encabezados.some((h) => h.includes('operation_id') || h.includes('net_received_amount')),
  },
  {
    codigo: 'talo',
    nombre: 'Talo',
    corto: 'Talo',
    cuenta: 42210108,
    cuentaNombre: 'TALO HONRE S.A',
    archivoEsperado: 'Movimientos_<desde>_<hasta>.xlsx (panel de Talo)',
    alcanceTxt: 'cobros recibidos',
    parsear: parsearTalo,
    Error: TaloError,
    enAlcance: (o) => o.estado === ESTADO_COBRO && o.bruto > 0,
    motivoFuera: motivoFueraTalo,
    // Talo se asienta MÁS LENTO que MP: el 23/07 hubo un cobro asentado 32 min después. Con el
    // umbral de MP (30 min) tiraría avisos de "hora corrida" falsos todos los días.
    deltaSospechosoSeg: 90 * 60,
    referencia: (o) => o.titular || '',
    reconoce: (encabezados) => encabezados.includes('recibido') && encabezados.includes('estado'),
    // Talo se baja SOLA por API a las 21:00 (entrega-arqueo.js::entregarTaloDelDia). Por eso el
    // recordatorio de "faltan documentos" (aviso-libro.js) NO la reclama: si la bajada falla, ese
    // barrido ya avisa a los admins. (Igual se puede subir con /carga como fallback: eso lo arquea
    // el barrido de las 08:00.)
    bajaPorApi: true,
  },
];

function porCodigo(codigo) {
  return PLATAFORMAS.find((p) => p.codigo === codigo) || null;
}

// Plataformas que se cargan A MANO: su liquidación se sube con /carga y se reclama si falta (tanto
// en /carga como en el aviso de las 21:30). Las que se bajan SOLAS por API (bajaPorApi, hoy Talo)
// NO están acá: no hay que subirlas ni reclamarlas — el barrido las baja y arquea, y avisa si falla.
// ÚNICA fuente de verdad del reparto manual/automático: antes estaba duplicado y se desincronizó
// (/carga seguía pidiendo Talo aunque el aviso de las 21:30 ya no la reclamaba).
function plataformasManuales() {
  return PLATAFORMAS.filter((p) => !p.bajaPorApi);
}

// Saca acentos/mayúsculas para comparar encabezados sin depender del encoding.
function clave(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

// ¿De qué plataforma es este archivo? Mira los encabezados de las primeras filas. Los dos
// formatos son muy distintos (MP trae "SOURCE ID"; Talo, "Recibido"+"Estado"), así que no hay
// que preguntarle al usuario de cuál es cada archivo. null si no lo reconoce.
function detectarPlataforma(buffer) {
  const XLSX = require('xlsx');
  let filas;
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws['!ref']) return null;
    filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
  } catch (e) {
    return null;
  }
  for (let i = 0; i < Math.min(filas.length, 20); i++) {
    const enc = (filas[i] || []).map(clave);
    if (!enc.length) continue;
    const p = PLATAFORMAS.find((x) => x.reconoce(enc));
    if (p) return p;
  }
  return null;
}

module.exports = { PLATAFORMAS, porCodigo, plataformasManuales, detectarPlataforma };
