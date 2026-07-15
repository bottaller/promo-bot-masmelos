// Parser del Excel "Existencias al cierre" que sube el tesorero (/saldos).
// Lee la fecha + la HORA del conteo + una fila por cuenta (saldo, moneda) y valida todo.
// Devuelve { fecha (Date), contadoEn (string 'AAAA-MM-DD HH:MM:SS'), horaCargada (bool),
// empresa, saldos: [{cuenta, moneda, monto}] } o tira SaldosError (mensaje directo).
// La HORA es el límite de la ventana de conciliación: se cuenta a las 16:20 pero el
// negocio cierra 17:00, así que el corte tiene que ser por hora, no por día.
const XLSX = require('xlsx');
const { parseVencimiento, tsCanonico, finDeDiaTs } = require('./fechas');

// Errores "esperables" con mensaje para el tesorero (los distingue de un bug real).
class SaldosError extends Error {}

// Cuentas que esperamos en la plantilla. La CLAVE es el nombre normalizado (para
// matchear lo que venga en el Excel sin importar mayúsculas/acentos/espacios); se
// guarda el `nombre` CANÓNICO (no lo que tipeó el usuario) para que el mismo saldo
// no se duplique por diferencias de capitalización, y su `moneda` por defecto.
const CUENTAS = new Map([
  ['caja fuerte moreno',   { nombre: 'Caja Fuerte Moreno',   moneda: 'ARS' }],
  ['santander',            { nombre: 'Santander',            moneda: 'ARS' }],
  ['supervielle',          { nombre: 'Supervielle',          moneda: 'ARS' }],
  ['mercadopago',          { nombre: 'Mercadopago',          moneda: 'ARS' }],
  ['cheques en cartera a', { nombre: 'Cheques en Cartera A', moneda: 'ARS' }],
  ['cheques en cartera b', { nombre: 'Cheques en Cartera B', moneda: 'ARS' }],
  ['e-cheq en cartera',    { nombre: 'E-cheq en Cartera',    moneda: 'ARS' }],
  ['caja dólar tesorería', { nombre: 'Caja Dólar Tesorería', moneda: 'USD' }],
]);

// Normaliza un rótulo para el match: NFC (acentos precompuestos), trim, minúsculas y
// colapsa espacios internos. Sin NFC, un acento descompuesto (NFD, típico de macOS)
// no igualaría la clave y la cuenta se perdería en silencio.
function norm(s) {
  return String(s == null ? '' : s).normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Un monto puede venir como número nativo (lo normal en Excel) o como texto
// con formato argentino ("$ 100.853.730,00"). Devuelve el número o null si no es válido.
function parseMonto(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const limpio = v.replace(/[^\d,-]/g, '').replace(',', '.'); // saca $, puntos de mil y espacios
  if (limpio === '' || limpio === '-') return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// La fecha puede venir como texto DD/MM/AAAA o como serial de Excel (número).
// Devuelve un Date o null (el placeholder "DD/MM/AAAA" y lo vacío dan null a propósito).
function interpretarFecha(v) {
  if (typeof v === 'number') {
    const d = XLSX.SSF && XLSX.SSF.parse_date_code(v);
    return d ? new Date(d.y, d.m - 1, d.d) : null;
  }
  if (typeof v === 'string') {
    if (!v.trim() || norm(v) === 'dd/mm/aaaa') return null; // placeholder sin completar
    return parseVencimiento(v); // valida DD/MM/AAAA (rechaza fechas imposibles)
  }
  return null;
}

// La hora del conteo: serial de Excel (hora nativa = fracción de día, o datetime) o texto
// "HH:MM"/"HH:MM:SS". Devuelve {hh, mm, ss} o null (placeholder "HH:MM" y vacío → null).
function interpretarHora(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = XLSX.SSF && XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return { hh: d.H || 0, mm: d.M || 0, ss: Math.round(d.S || 0) };
  }
  if (v instanceof Date && !isNaN(v)) return { hh: v.getHours(), mm: v.getMinutes(), ss: v.getSeconds() };
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || norm(s) === 'hh:mm') return null; // placeholder sin completar
    const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const hh = Number(m[1]); const mm = Number(m[2]); const ss = m[3] ? Number(m[3]) : 0;
    if (hh > 23 || mm > 59 || ss > 59) return null;
    return { hh, mm, ss };
  }
  return null;
}

function parsearSaldos(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new SaldosError('El archivo no tiene ninguna hoja. Usá la plantilla de saldos.');
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  // --- Empresa (del título "EXISTENCIAS AL CIERRE — HONRE") ---
  let empresa = 'HONRE';
  const titulo = filas.find((r) => norm(r[0]).includes('existencias'));
  if (titulo && String(titulo[0]).includes('—')) empresa = String(titulo[0]).split('—').pop().trim();

  // --- Fecha (fila "Fecha:") — lo primero que validamos ---
  const filaFecha = filas.find((r) => norm(r[0]).startsWith('fecha'));
  const fecha = interpretarFecha(filaFecha ? filaFecha[1] : null);
  if (!fecha) {
    throw new SaldosError('No encontré una fecha válida. Poné la Fecha del cierre arriba, en formato DD/MM/AAAA.');
  }

  // --- Hora del conteo (fila "Hora del conteo:") — es el límite de la ventana ---
  // Si falta, se usa el fin del día (23:59:59) = comportamiento por día de antes, y se
  // avisa (horaCargada=false) para que el tesorero sepa que el corte por hora quedó apagado.
  const filaHora = filas.find((r) => norm(r[0]).startsWith('hora'));
  const hora = interpretarHora(filaHora ? filaHora[1] : null);
  const horaCargada = hora !== null;
  const contadoEn = hora
    ? tsCanonico(fecha.getFullYear(), fecha.getMonth() + 1, fecha.getDate(), hora.hh, hora.mm, hora.ss)
    : finDeDiaTs(fecha);

  // --- Filas de cuentas ---
  const saldos = [];
  const vistas = new Set();
  for (const r of filas) {
    const clave = norm(r[0]);
    const def = CUENTAS.get(clave);
    if (!def || vistas.has(clave)) continue; // ignora Total, instrucciones, etc.
    vistas.add(clave);
    const monto = parseMonto(r[1]);
    if (monto === null) {
      throw new SaldosError(`La cuenta "${def.nombre}" no tiene un saldo válido. Completá todos los saldos (poné 0 si la cuenta no tiene).`);
    }
    const moneda = (r[2] && String(r[2]).trim().toUpperCase()) || def.moneda;
    // Guardamos el nombre CANÓNICO (no lo que tipeó el usuario): así el mismo saldo
    // no se duplica si cambia la capitalización, y matchea el mapeo de la conciliación.
    saldos.push({ cuenta: def.nombre, moneda, monto });
  }

  if (saldos.length === 0) {
    throw new SaldosError('No encontré ninguna cuenta con saldo. ¿Estás usando la plantilla de saldos?');
  }

  return { fecha, contadoEn, horaCargada, empresa, saldos };
}

module.exports = { parsearSaldos, SaldosError };
