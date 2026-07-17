// Primitivos para leer las celdas de un export de Sigma (Excel).
//
// Sigma exporta el mismo dato de varias formas ("Diario de movimientos contables",
// "Mayor de cuenta", …) y todas comparten las mismas mañas: los headers vienen con el
// encoding roto, los números pueden ser nativos o texto con formato AR, y las fechas
// pueden ser serial de Excel, Date o texto. Estas funciones son el piso común de todos
// los parsers (libro-excel.js, mayor-excel.js) para que no se les vaya la mano por
// separado: si Sigma cambia un formato, se arregla acá una sola vez.
const XLSX = require('xlsx');
const { parseVencimiento, tsCanonico, finDeDiaTs } = require('./fechas');

function norm(s) {
  return String(s == null ? '' : s).trim();
}

// Debe/Haber pueden venir como número nativo o texto con formato AR. 0 si vacío/no válido.
function parseNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return 0;
  const limpio = v.replace(/[^\d,-]/g, '').replace(',', '.');
  if (limpio === '' || limpio === '-') return 0;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : 0;
}

// Entero (mov, cuenta_id): número nativo o texto. null si no es un entero.
// Conserva el punto decimal para no romper un "111201014.0" (Excel a veces
// serializa enteros como float): Number lo lee bien y truncamos.
function parseEntero(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const limpio = v.replace(/[^\d.-]/g, '');
    if (limpio === '' || limpio === '-' || limpio === '.') return null;
    const n = Number(limpio);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

// La fecha de un asiento: serial de Excel (número) o texto DD/MM/AAAA. null si no cierra.
function interpretarFecha(v) {
  if (typeof v === 'number') {
    const d = XLSX.SSF && XLSX.SSF.parse_date_code(v);
    return d ? new Date(d.y, d.m - 1, d.d) : null;
  }
  if (v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // Sigma suele exportar "DD/MM/AAAA" (a veces con hora detrás): tomamos la fecha.
    // Aceptamos día/mes de 1-2 dígitos ("7/7/2026"); parseVencimiento valida el resto.
    const m = s.match(/^(\d{1,2}\/\d{1,2}\/\d{4})/);
    return m ? parseVencimiento(m[1]) : null;
  }
  return null;
}

// La marca de tiempo "Ingreso" de un movimiento: cuándo se cargó en Sigma. Es el corte fino
// de las ventanas. Serial de Excel (datetime), Date, o texto "DD/MM/AAAA HH:MM(:SS)" /
// "AAAA-MM-DD HH:MM(:SS)". Devuelve el string canónico 'AAAA-MM-DD HH:MM:SS'. Si no viene o
// no cierra → fin del día de la fecha (default = por día).
function interpretarTimestamp(v, fechaFallback) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = XLSX.SSF && XLSX.SSF.parse_date_code(v);
    if (d) return tsCanonico(d.y, d.m, d.d, d.H || 0, d.M || 0, Math.round(d.S || 0));
  } else if (v instanceof Date && !isNaN(v)) {
    return tsCanonico(v.getFullYear(), v.getMonth() + 1, v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds());
  } else if (typeof v === 'string') {
    const s = v.trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) return tsCanonico(+m[3], +m[2], +m[1], +m[4], +m[5], m[6] ? +m[6] : 0);
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) return tsCanonico(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }
  return fechaFallback ? finDeDiaTs(fechaFallback) : null;
}

// Busca la fila de headers por su primera celda (ej. 'Mov.' en el Diario, 'Cuenta' en el
// Mayor). No se asume la posición: cuando el export incluye MUCHAS empresas, el título
// "Empresa: ..." se parte en varias filas y empuja todo hacia abajo. -1 si no está.
function buscarHeader(filas, titulo, maxFilas = 40) {
  for (let i = 0; i < Math.min(filas.length, maxFilas); i++) {
    if (norm(filas[i] && filas[i][0]) === titulo) return i;
  }
  return -1;
}

module.exports = {
  norm, parseNum, parseEntero, interpretarFecha, interpretarTimestamp, buscarHeader,
};
