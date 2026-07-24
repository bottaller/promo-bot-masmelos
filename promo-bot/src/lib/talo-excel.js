// Parser del reporte de movimientos de Talo (el "Movimientos_<desde>_<hasta>.xlsx" que se baja
// del panel), normalizado al MISMO formato que la liquidación de Mercado Pago para que el motor
// de conciliación no sepa de qué plataforma viene.
//
// Las columnas se buscan POR NOMBRE (sin acentos ni mayúsculas), no por posición: si Talo
// agrega una columna al medio, no se rompe.
//
// Tres mañas propias de este archivo, las tres con dientes:
//  1) Los importes vienen como TEXTO en formato argentino ('74950,00') PERO la misma columna
//     mezcla formatos: en el mismo archivo aparece 'Acreditado' como '74044,13' y como '-1.00'.
//     Por eso parseMonto decide por el contenido, no por una convención fija.
//  2) La fecha es 'DD/MM/AA' (año de DOS dígitos) y la hora viene en 12 h con AM/PM
//     ('04:33 PM'), con precisión de MINUTOS (sin segundos).
//  3) La hora es hora ARGENTINA local — no como MP, que liquida en UTC-4. Validado contra el
//     libro del 23/07: cada cobro tiene su asiento 1-32 min después (si hubiera desfase de
//     zona, la diferencia sería de horas).
const XLSX = require('xlsx');
const { tsCanonico } = require('./fechas');

// Errores "esperables" con mensaje para el usuario (los distingue de un bug real).
class TaloError extends Error {}

// Estado de un movimiento: cobro entrante vs salida de plata.
const ESTADO_COBRO = 'RECIBIDO';

// Nombre de la columna -> campo nuestro. Las obligatorias tienen que estar.
const COLUMNAS = [
  { nombre: 'recibido', campo: 'bruto', obligatoria: true, monto: true },
  { nombre: 'enviado', campo: 'enviado', monto: true },
  { nombre: 'comision', campo: 'comision', monto: true },
  { nombre: 'impuestos total', campo: 'impuestos', monto: true },
  { nombre: 'acreditado', campo: 'neto', monto: true },
  { nombre: 'estado', campo: 'estado', obligatoria: true },
  { nombre: 'fecha movimiento', campo: '_fecha', obligatoria: true },
  { nombre: 'hora movimiento', campo: '_hora', obligatoria: true },
  { nombre: 'titular', campo: 'titular' },
  { nombre: 'id de pago', campo: 'source_id' },
  { nombre: 'moneda', campo: 'moneda' },
];

// Saca acentos y normaliza, para machear los encabezados sin depender del encoding.
function clave(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

// Importe de Talo. La MISMA columna mezcla '74044,13' (coma decimal) y '-1.00' (punto
// decimal), así que se decide por el contenido:
//   - si hay coma -> la coma es el decimal y los puntos son separador de miles
//   - si solo hay puntos -> un único punto con <= 2 decimales es decimal; si no, son miles
// Devuelve null si no es un número (nunca 0 por defecto: un 0 silencioso en plata no se ve).
function parseMonto(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/\s/g, '');
  if (s === '' || s === '-') return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    const p = s.split('.');
    if (p.length > 2 || (p.length === 2 && p[1].length === 3)) s = p.join(''); // miles
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 'DD/MM/AA' (o 'DD/MM/AAAA') + 'hh:mm AM/PM' -> ts canónico 'AAAA-MM-DD HH:MM:SS'
// (hora de pared argentina; Talo reporta en local, ver cabecera). null si no cierra.
function interpretarMomento(fecha, hora) {
  const f = String(fecha == null ? '' : fecha).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!f) return null;
  const [, d, m] = f;
  const anio = f[3].length === 2 ? 2000 + Number(f[3]) : Number(f[3]);

  const h = String(hora == null ? '' : hora).trim().toUpperCase()
    .match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.)?$/);
  if (!h) return null;
  let hh = Number(h[1]);
  const mm = Number(h[2]);
  const ss = h[3] ? Number(h[3]) : 0;
  const meridiano = (h[4] || '').replace(/\./g, '');
  if (meridiano === 'PM' && hh < 12) hh += 12;   // 04:33 PM -> 16:33
  if (meridiano === 'AM' && hh === 12) hh = 0;   // 12:15 AM -> 00:15
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return tsCanonico(anio, Number(m), Number(d), hh, mm, ss);
}

// parsearTalo(buffer) -> { operaciones: [...] } con la MISMA forma que la liquidación de MP:
//   { source_id, hora, bruto, comision, impuestos, neto, estado, titular, moneda, fila }
// Los signos se normalizan como MP: comisión e impuestos NEGATIVOS (restan del bruto).
function parsearTalo(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) {
    throw new TaloError('El archivo no tiene ninguna hoja con datos. ¿Es el reporte de movimientos de Talo?');
  }
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  // Fila de encabezados: la primera que tenga "Recibido" y "Estado".
  let headerIdx = -1;
  for (let i = 0; i < Math.min(filas.length, 20); i++) {
    const k = (filas[i] || []).map(clave);
    if (k.includes('recibido') && k.includes('estado')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    throw new TaloError(
      'No reconozco el archivo: no encontré las columnas "Recibido" y "Estado". ' +
      'Mandame el reporte de Movimientos que bajás del panel de Talo.'
    );
  }

  const idx = new Map();
  (filas[headerIdx] || []).forEach((c, i) => { if (!idx.has(clave(c))) idx.set(clave(c), i); });
  const faltantes = COLUMNAS.filter((c) => c.obligatoria && !idx.has(c.nombre)).map((c) => c.nombre);
  if (faltantes.length) {
    throw new TaloError(`Al reporte de Talo le faltan columnas que necesito (${faltantes.join(', ')}). ¿Cambió el formato?`);
  }

  const operaciones = [];
  for (let i = headerIdx + 1; i < filas.length; i++) {
    const r = filas[i];
    if (!r) continue;
    const op = { fila: i + 1 };
    for (const c of COLUMNAS) {
      if (!idx.has(c.nombre)) { op[c.campo] = c.monto ? 0 : ''; continue; }
      const bruto = r[idx.get(c.nombre)];
      if (c.monto) {
        const n = parseMonto(bruto);
        if (n === null && c.obligatoria) {
          throw new TaloError(`Una fila de Talo (${i + 1}) tiene un importe ilegible en "${c.nombre}" (${JSON.stringify(bruto)}). ¿Cambió el formato?`);
        }
        op[c.campo] = n === null ? 0 : n;
      } else {
        op[c.campo] = String(bruto == null ? '' : bruto).trim();
      }
    }
    // Fila vacía / de pie: sin estado y sin importes.
    if (!op.estado && !op.bruto && !op.enviado) continue;

    op.hora = interpretarMomento(op._fecha, op._hora);
    if (!op.hora) {
      throw new TaloError(`Una fila de Talo (${i + 1}) tiene fecha/hora ilegible ("${op._fecha}" "${op._hora}"). ¿Cambió el formato?`);
    }
    delete op._fecha; delete op._hora;
    op.estado = op.estado.toUpperCase();
    // Signos como en MP: lo que resta del bruto va negativo.
    op.comision = -Math.abs(op.comision || 0);
    op.impuestos = -Math.abs(op.impuestos || 0);
    operaciones.push(op);
  }

  if (operaciones.length === 0) {
    throw new TaloError('No encontré ningún movimiento en el reporte de Talo. ¿Salió vacío?');
  }
  return { operaciones };
}

module.exports = { parsearTalo, TaloError, ESTADO_COBRO };
