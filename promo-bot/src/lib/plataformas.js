// Las plataformas de cobro que se arquean contra el libro (hoy: Mercado Pago y Talo).
//
// Cada una declara lo ÚNICO que la hace distinta: contra qué cuenta de Sigma asienta, cómo se
// parsea su liquidación, qué operaciones entran en el arqueo, y cuánto tarda en asentarse. El
// motor (conciliacion-mp.js) es agnóstico: apareo, tolerancias y rastreo valen para todas.
//
// Sumar una plataforma = agregar una entrada acá + su parser. Nada más.
const { parsearLiquidacion, LiquidacionError } = require('./liquidacion-excel');
const { parsearTalo, TaloError, ESTADO_COBRO } = require('./talo-excel');

// --- Mercado Pago ----------------------------------------------------------
// La cuenta 422101014 recibe EXACTAMENTE las operaciones con SUB UNIT='QR Code' (adentro
// conviven dinero en cuenta, transferencia, crédito y débito). Point liquida en las cuentas de
// tarjetas, no acá. Ver docs/conciliacion-mp.md §2.
const CANAL_QR = 'QR Code';
const TIPO_COBRO = 'Approved payment';

function motivoFueraMp(op) {
  if (op.unidad === 'Mercado Libre') return 'Mercado Libre: no es una venta por QR';
  if (op.canal === 'Point') return 'Point (terminal física): liquida en las cuentas de tarjetas, no en Mercado Pago';
  if (!op.canal) return 'Sin canal ni medio de pago: revisar con MP qué es';
  if (op.canal !== CANAL_QR) return `Canal "${op.canal}": fuera del alcance (acá solo van QR y transferencia)`;
  if (op.tipo !== TIPO_COBRO) return `Es "${op.tipo}", no un cobro aprobado`;
  if (op.bruto <= 0) return 'Importe negativo o cero: no es una venta';
  return 'Fuera del alcance';
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
    archivoEsperado: 'settlement_v2-….xlsx (panel de Mercado Pago)',
    alcanceTxt: 'ventas cobradas por QR / transferencia',
    parsear: parsearLiquidacion,
    Error: LiquidacionError,
    enAlcance: (o) => o.canal === CANAL_QR && o.tipo === TIPO_COBRO && o.bruto > 0,
    motivoFuera: motivoFueraMp,
    // Los asientos de MP se cargan a segundos del cobro (5-210 s el 16/07).
    deltaSospechosoSeg: 30 * 60,
    // Cómo se identifica una operación en el reporte.
    referencia: (o) => (o.source_id ? `id ${o.source_id}` : ''),
    // Reconoce su propio archivo por los encabezados (para detectar sin preguntar).
    reconoce: (encabezados) => encabezados.includes('source id'),
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
  },
];

function porCodigo(codigo) {
  return PLATAFORMAS.find((p) => p.codigo === codigo) || null;
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

module.exports = { PLATAFORMAS, porCodigo, detectarPlataforma };
