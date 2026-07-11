// Parser del Excel "Existencias al cierre" que sube el tesorero (/saldos).
// Lee la fecha del cierre + una fila por cuenta (saldo, moneda) y valida todo.
// Devuelve { fecha (Date), empresa, saldos: [{cuenta, moneda, monto}] } o tira SaldosError
// (mensaje directo para el usuario) si algo no cierra.
const XLSX = require('xlsx');
const { parseVencimiento } = require('./fechas');

// Errores "esperables" con mensaje para el tesorero (los distingue de un bug real).
class SaldosError extends Error {}

// Cuentas que esperamos en la plantilla -> su moneda por defecto.
const CUENTAS = new Map([
  ['caja fuerte moreno', 'ARS'],
  ['santander', 'ARS'],
  ['supervielle', 'ARS'],
  ['mercadopago', 'ARS'],
  ['cheques en cartera a', 'ARS'],
  ['cheques en cartera b', 'ARS'],
  ['e-cheq en cartera', 'ARS'],
  ['caja dólar tesorería', 'USD'],
]);

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
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

  // --- Filas de cuentas ---
  const saldos = [];
  const vistas = new Set();
  for (const r of filas) {
    const clave = norm(r[0]);
    if (!CUENTAS.has(clave) || vistas.has(clave)) continue; // ignora Total, instrucciones, etc.
    vistas.add(clave);
    const monto = parseMonto(r[1]);
    if (monto === null) {
      throw new SaldosError(`La cuenta "${String(r[0]).trim()}" no tiene un saldo válido. Completá todos los saldos (poné 0 si la cuenta no tiene).`);
    }
    const moneda = (r[2] && String(r[2]).trim().toUpperCase()) || CUENTAS.get(clave);
    saldos.push({ cuenta: String(r[0]).trim(), moneda, monto });
  }

  if (saldos.length === 0) {
    throw new SaldosError('No encontré ninguna cuenta con saldo. ¿Estás usando la plantilla de saldos?');
  }

  return { fecha, empresa, saldos };
}

module.exports = { parsearSaldos, SaldosError };
