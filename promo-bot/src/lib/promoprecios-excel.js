// Parser del archivo de /promoprecios (Calidad): detecta, por NOMBRE de encabezado (no por
// posición fija — mismo criterio que lib/articulos-excel.js), las filas marcadas con "x" en la
// columna "Imagen" y devuelve lo necesario para generarles el cartel automático (ver
// lib/carteleria-generar.js): código, detalle, vencimiento y precio.
//
// El precio del cartel sale de "ACCION A TOMAR" (la decisión tomada para ese producto), NO de
// "precio de venta final lista 2" — esa es solo la referencia del precio actual/de lista, no el
// que hay que imprimir.
//
// Si el archivo no tiene esas columnas (formato viejo, o cualquier otra cosa) tira una excepción
// a propósito — el caller (scenes/validar-promoprecios.js) lo interpreta como "no reconocido" y
// cae al flujo manual de siempre (preguntar la cantidad de imágenes a mano).
const XLSX = require('xlsx');

const RANGO_DIACRITICOS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

function normalizarHeader(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .normalize('NFD').replace(RANGO_DIACRITICOS, '')
    .trim();
}

// Encuentra, en las primeras filas de una hoja, el índice de fila de encabezados y las
// columnas que necesitamos — o null si esta hoja no tiene todo lo necesario.
function detectarColumnas(filas) {
  for (let i = 0; i < Math.min(6, filas.length); i++) {
    const header = (filas[i] || []).map(normalizarHeader);
    const iVencimiento = header.indexOf('vencimiento');
    const iCodigo = header.indexOf('codigo');
    const iDetalle = header.indexOf('detalle');
    const iImagen = header.indexOf('imagen');
    const iPrecio = header.findIndex((h) => h.includes('accion') && h.includes('tomar'));
    if (iVencimiento >= 0 && iCodigo >= 0 && iDetalle >= 0 && iImagen >= 0 && iPrecio >= 0) {
      return { hIdx: i, iVencimiento, iCodigo, iDetalle, iImagen, iPrecio };
    }
  }
  return null;
}

// Serial de fecha de Excel (días desde el 30/12/1899) -> 'YYYY-MM-DD'. Se usa como respaldo si
// la celda llega como número crudo en vez de Date (con cellDates:true debería ser siempre Date,
// pero un archivo raro podría no traer formato de fecha en la celda).
function serialAIso(serial) {
  const fecha = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  const y = fecha.getUTCFullYear();
  const m = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  const d = String(fecha.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function celdaAIso(celda) {
  if (celda instanceof Date) {
    const y = celda.getUTCFullYear();
    const m = String(celda.getUTCMonth() + 1).padStart(2, '0');
    const d = String(celda.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof celda === 'number' && Number.isFinite(celda)) return serialAIso(celda);
  return null;
}

function celdaAPrecio(celda) {
  if (typeof celda === 'number' && Number.isFinite(celda)) return celda;
  const limpio = String(celda == null ? '' : celda).trim().replace(/\$/g, '').replace(/\./g, '').replace(',', '.');
  if (limpio === '') return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// Devuelve [{ codigo, detalle, vencimiento:'YYYY-MM-DD', precio }] de las filas marcadas con
// "x" en Imagen (puede ser un array vacío, si el archivo se reconoce pero nadie marcó nada).
// Tira Error si ninguna hoja tiene las columnas esperadas.
function parsearProductosConImagen(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  for (const nombreHoja of wb.SheetNames) {
    const ws = wb.Sheets[nombreHoja];
    const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const cols = detectarColumnas(filas);
    if (!cols) continue;

    const productos = [];
    for (let r = cols.hIdx + 1; r < filas.length; r++) {
      const fila = filas[r];
      if (!fila || !fila.length) continue;
      const marcado = String(fila[cols.iImagen] ?? '').trim().toLowerCase() === 'x';
      if (!marcado) continue;

      const codigo = String(fila[cols.iCodigo] ?? '').trim();
      const detalle = String(fila[cols.iDetalle] ?? '').trim();
      const vencimiento = celdaAIso(fila[cols.iVencimiento]);
      const precio = celdaAPrecio(fila[cols.iPrecio]);
      if (!codigo || !detalle || !vencimiento || precio === null) continue; // fila incompleta, no se puede generar el cartel

      productos.push({ codigo, detalle, vencimiento, precio });
    }
    return productos;
  }

  throw new Error('No encontré las columnas esperadas (vencimiento, codigo, detalle, ACCION A TOMAR, Imagen) en ninguna hoja del archivo.');
}

module.exports = { parsearProductosConImagen };
