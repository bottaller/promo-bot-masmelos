// Parser del reporte "Collection" (Cobros) de Mercado Pago — el que SÍ está disponible el MISMO
// día. El settlement_v2 que usábamos antes se genera a día vencido, así que no está a la noche
// para el arqueo automático de las 08:00; este sí.
//
// Produce EXACTAMENTE el mismo shape de operación que liquidacion-excel.js (el settlement),
// mapeando el vocabulario nuevo al viejo para que el motor de conciliación y el alcance de
// plataformas.js funcionen SIN cambios:
//   - sub_unit 'QR'  -> canal 'QR Code'   (la cuenta MP 422101014 recibe solo el QR; Point va a tarjetas)
//   - status 'approved' -> tipo 'Approved payment'
//
// La fecha (date_created, 'DD/MM/AAAA HH:MM:SS') ya viene en HORA ARGENTINA — verificado cruzando
// el 23/07 contra los ingresos de Sigma: coinciden al segundo (08:27:45 vs 08:27:58). El settlement
// venía en UTC-4 y había que sumar 1 h; este NO. Por eso no pasa por isoAHoraArg().
//
// Las columnas se buscan por su nombre "de máquina" entre paréntesis —(operation_id), (sub_unit)…—
// que es el identificador estable de MP; el rótulo en español puede cambiar, el (id) no.
const XLSX = require('xlsx');
const { LiquidacionError } = require('./liquidacion-excel');

// Hereda de LiquidacionError para que el `Error` del descriptor de MP (plataformas.js) atrape los
// dos formatos con un solo `instanceof`.
class CollectionError extends LiquidacionError {}

function norm(s) {
  return String(s == null ? '' : s).trim();
}

// Monto en formato US (decimal con punto), igual que el settlement. null si no es número.
function parseMonto(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const limpio = v.trim().replace(/,/g, '');
  if (limpio === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(limpio)) return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

const _p2 = (n) => String(n).padStart(2, '0');

// 'DD/MM/AAAA HH:MM:SS' (hora argentina) -> ts canónico 'AAAA-MM-DD HH:MM:SS'. Tolera que XLSX lo
// entregue como Date o serial (según cómo esté formateada la celda). null si no se puede leer.
function interpretarFecha(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${_p2(v.getMonth() + 1)}-${_p2(v.getDate())} ${_p2(v.getHours())}:${_p2(v.getMinutes())}:${_p2(v.getSeconds())}`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = XLSX.SSF && XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${_p2(d.m)}-${_p2(d.d)} ${_p2(d.H || 0)}:${_p2(d.M || 0)}:${_p2(Math.round(d.S || 0))}`;
  }
  const m = norm(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return `${m[3]}-${_p2(m[2])}-${_p2(m[1])} ${_p2(m[4])}:${_p2(m[5])}:${_p2(m[6] || '00')}`;
}

// Índice de la columna cuyo header contiene "(clave)". -1 si no está.
function colClave(header, clave) {
  return (header || []).findIndex((c) => String(c).includes(`(${clave})`));
}

// ¿Este buffer es un reporte Collection de MP? (para el ruteo en plataformas.js)
function esCollection(filas) {
  return (filas || []).slice(0, 20).some((r) =>
    (r || []).some((c) => String(c).includes('(operation_id)') || String(c).includes('(net_received_amount)')));
}

// parsearCollection(buffer) -> { operaciones: [{source_id, instrumento, tipo, estado, canal,
//   unidad, hora, bruto, comision, impuestos, neto, fila}] } — mismo shape que parsearLiquidacion.
function parsearCollection(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) {
    throw new CollectionError('El archivo no tiene ninguna hoja con datos. ¿Es el reporte de cobros (collection) de Mercado Pago?');
  }
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  // Header: la primera fila con la columna (operation_id).
  let hi = -1;
  for (let i = 0; i < Math.min(filas.length, 20); i++) {
    if ((filas[i] || []).some((c) => String(c).includes('(operation_id)'))) { hi = i; break; }
  }
  if (hi === -1) {
    throw new CollectionError(
      'No reconozco el archivo: no encontré la columna (operation_id). ' +
      'Mandame el reporte de Cobros (collection) que se baja del panel de Mercado Pago.'
    );
  }
  const H = filas[hi];
  const ix = {};
  for (const k of ['operation_id', 'status', 'operation_type', 'transaction_amount', 'mercadopago_fee',
    'net_received_amount', 'date_created', 'sub_unit', 'business_unit', 'payment_type']) {
    ix[k] = colClave(H, k);
  }
  const req = ['operation_id', 'status', 'transaction_amount', 'date_created', 'sub_unit'];
  const faltan = req.filter((k) => ix[k] < 0);
  if (faltan.length) {
    throw new CollectionError(`Al reporte de cobros le faltan columnas que necesito (${faltan.join(', ')}). ¿Cambió el formato de MP?`);
  }

  const operaciones = [];
  for (let i = hi + 1; i < filas.length; i++) {
    const r = filas[i];
    if (!r) continue;
    const opId = norm(r[ix.operation_id]);
    if (!opId) continue; // fila de pie/blanco

    const bruto = parseMonto(r[ix.transaction_amount]);
    if (bruto === null) {
      throw new CollectionError(`La operación ${opId} tiene un importe ilegible en (transaction_amount) (${JSON.stringify(r[ix.transaction_amount])}). ¿Cambió el formato de MP?`);
    }
    const hora = interpretarFecha(r[ix.date_created]);
    if (!hora) {
      throw new CollectionError(`La operación ${opId} tiene una fecha ilegible en (date_created) (${JSON.stringify(r[ix.date_created])}). ¿Cambió el formato de MP?`);
    }
    const estado = norm(r[ix.status]).toLowerCase();
    const subUnit = norm(r[ix.sub_unit]);
    const comision = ix.mercadopago_fee >= 0 ? (parseMonto(r[ix.mercadopago_fee]) || 0) : 0;
    const neto = ix.net_received_amount >= 0 ? (parseMonto(r[ix.net_received_amount])) : null;

    operaciones.push({
      source_id: opId,
      fila: i + 1,
      instrumento: ix.payment_type >= 0 ? norm(r[ix.payment_type]) : '',
      estado,                                                    // 'approved' | 'rejected' | ...
      tipo: estado === 'approved' ? 'Approved payment' : estado, // mapea al vocabulario del settlement
      canal: subUnit === 'QR' ? 'QR Code' : subUnit,             // 'QR Code' | 'Point' | …
      unidad: ix.business_unit >= 0 ? norm(r[ix.business_unit]) : '',
      hora,
      bruto,
      comision,
      // El reporte no trae IVA de la comisión aparte; se deriva para que comisión+impuestos = neto−bruto.
      impuestos: neto === null ? 0 : Math.round((neto - bruto - comision) * 100) / 100,
      neto: neto === null ? 0 : neto,
    });
  }

  if (operaciones.length === 0) {
    throw new CollectionError('No encontré ninguna operación en el reporte de cobros. ¿El reporte salió vacío?');
  }
  return { operaciones };
}

module.exports = { parsearCollection, CollectionError, esCollection };
