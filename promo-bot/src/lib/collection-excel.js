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

// Tipos de operación que son un COBRO (plata que ENTRA). El resto —refund, chargeback, reserve…—
// NO son cobros aunque su status sea 'approved' y su importe positivo (en Cobros el importe es el
// "Valor del producto", positivo también en una devolución). El settlement los excluía por
// TRANSACTION TYPE; acá hay que replicar ese filtro con operation_type, si no una devolución
// aprobada entraría al arqueo y falsearía la plata. Si el reporte no trae operation_type, se cae
// al comportamiento por status (backward-safe).
const TIPOS_COBRO = new Set(['regular_payment', 'pos_payment']);

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
  const s = norm(v);
  // ISO 'AAAA-MM-DD' (con hora opcional) — el date_created_short del formato nuevo. Sin hora
  // queda a las 00:00:00 (el "short" no la trae).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${_p2(iso[4] || 0)}:${_p2(iso[5] || '00')}:${_p2(iso[6] || '00')}`;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
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
  for (const k of ['operation_id', 'status', 'status_detail', 'operation_type', 'transaction_amount',
    'mercadopago_fee', 'net_received_amount', 'date_created', 'date_created_short', 'sub_unit',
    'business_unit', 'payment_type']) {
    ix[k] = colClave(H, k);
  }
  // Requeridas, con las ALTERNATIVAS del formato nuevo de MP (jul-2026: sacó status, sub_unit y
  // date_created, dejando los equivalentes). Verificado contra exports con ambas columnas:
  //   status       ← status_detail       ('accredited' = acreditado/approved)
  //   date_created ← date_created_short   (fecha sin hora)
  //   sub_unit     ← operation_type       (regular_payment=QR, pos_payment=Point; cruce 100%)
  const faltan = [];
  if (ix.operation_id < 0) faltan.push('operation_id');
  if (ix.transaction_amount < 0) faltan.push('transaction_amount');
  if (ix.status < 0 && ix.status_detail < 0) faltan.push('status (o status_detail)');
  if (ix.date_created < 0 && ix.date_created_short < 0) faltan.push('date_created (o date_created_short)');
  if (ix.sub_unit < 0 && ix.operation_type < 0) faltan.push('sub_unit (o operation_type)');
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
    // Fecha: date_created (con hora) o, en el formato nuevo, date_created_short (solo fecha).
    const fechaRaw = ix.date_created >= 0 ? r[ix.date_created] : r[ix.date_created_short];
    const hora = interpretarFecha(fechaRaw);
    if (!hora) {
      throw new CollectionError(`La operación ${opId} tiene una fecha ilegible (${JSON.stringify(fechaRaw)}). ¿Cambió el formato de MP?`);
    }
    const opTipo = ix.operation_type >= 0 ? norm(r[ix.operation_type]).toLowerCase() : '';
    // Estado: la columna status, o derivado del status_detail nuevo ('accredited' = acreditado).
    let estado;
    if (ix.status >= 0) {
      estado = norm(r[ix.status]).toLowerCase();
    } else {
      const det = norm(r[ix.status_detail]).toLowerCase();
      estado = det === 'accredited' ? 'approved' : (det || 'rejected');
    }
    // Canal: sub_unit, o derivado del operation_type. Verificado 100% contra exports con ambas:
    // regular_payment ⟺ QR (cuenta MP), pos_payment ⟺ Point (tarjetas).
    let canal;
    if (ix.sub_unit >= 0) {
      const subUnit = norm(r[ix.sub_unit]);
      canal = subUnit === 'QR' ? 'QR Code' : subUnit;
    } else {
      canal = opTipo === 'pos_payment' ? 'Point' : 'QR Code';
    }
    const comision = ix.mercadopago_fee >= 0 ? (parseMonto(r[ix.mercadopago_fee]) || 0) : 0;
    const neto = ix.net_received_amount >= 0 ? (parseMonto(r[ix.net_received_amount])) : null;

    operaciones.push({
      source_id: opId,
      fila: i + 1,
      instrumento: ix.payment_type >= 0 ? norm(r[ix.payment_type]) : '',
      estado,                                                    // 'approved' | 'rejected' | ...
      operation_type: opTipo,                                    // 'regular_payment' | 'pos_payment' | 'refund' | …
      // Cobro (→ 'Approved payment', el vocabulario del settlement) SOLO si el status es approved Y
      // es un tipo de cobro. Una devolución/chargeback aprobada NO es un cobro; queda con su tipo y
      // el alcance la excluye. Sin operation_type (formato viejo) se confía en el status SOLO para QR
      // (validado, backward-safe); para Point NO: sin operation_type no hay cómo distinguir una
      // devolución/contracargo de un cobro, y una devolución Point aprobada (importe positivo) se
      // colaría como cobranza. Entonces Point exige un operation_type de cobro explícito.
      tipo: estado === 'approved' && (TIPOS_COBRO.has(opTipo) || (!opTipo && canal !== 'Point')) ? 'Approved payment' : (opTipo || estado),
      canal,                                                     // 'QR Code' | 'Point' | …
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
