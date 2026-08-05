// Genera el .txt de "precio al piso" para importar en Sigma, a partir de los productos
// marcados con imagen en el archivo de /promoprecios (columna "ACCION A TOMAR", ver
// lib/promoprecios-excel.js) y el maestro de impuestos internos (bot.impuestos_internos, ver
// db/impuestos-internos.js y /actimpint).
//
// Fórmula del precio (Sigma toma el precio BRUTO, con IVA):
//   - Sin impuesto interno: precio_accion / 1.21
//   - Con impuesto interno: ((precio_accion - impuesto_interno) / 1.21) + impuesto_interno
// El resultado se TRUNCA (no se redondea) a 5 decimales.
//
// Formato: mismo esqueleto que el .txt de ejemplo que ya usa Sigma (26 columnas separadas por
// TAB, encabezado FCODIGO..FSUCURS). Se completan FCODIGO (padded a 13 caracteres, alineado a
// la derecha), FVIGDES (hoy), FVIGHAS (vencimiento de ESE producto — la promo dura hasta que
// vence), FPRECIO (calculado), FDESCUE/FDESMAX (0) y FORDMAN (95). El resto queda vacío, igual
// que en el ejemplo.
const { fechaHoyArgISO } = require('./fechas');

const IVA = 1.21;
const FORDMAN = '95';

const COLUMNAS = [
  'FCODIGO', 'FCODCLI', 'FRUBART', 'FLISPRE', 'FGRUCLI', 'FVIGDES', 'FVIGHAS', 'FDESCUE', 'FDESMAX',
  'FPRECIO', 'FMODULO', 'FCANMIN', 'FCANMAX', 'FPROVED', 'FDESACT', 'FGRUART', 'FRUBCLI', 'FCONVEN',
  'FVENDED', 'FEMPRES', 'FDIAVIS', 'FMONEDA', 'FPOLBUL', 'FORDMAN', 'FSINDES', 'FSUCURS',
];

// Trunca (no redondea) a 5 decimales. Ej: 413.214876... -> 413.21487.
function truncar5(valor) {
  return Math.trunc(valor * 100000) / 100000;
}

// precioAccion: número (columna "ACCION A TOMAR"). impuestoInterno: número o null/undefined
// si el producto no tiene. Devuelve el precio neto truncado a 5 decimales.
function calcularPrecioSigma(precioAccion, impuestoInterno) {
  if (impuestoInterno) {
    return truncar5((precioAccion - impuestoInterno) / IVA + impuestoInterno);
  }
  return truncar5(precioAccion / IVA);
}

// 'AAAA-MM-DD' -> 'D/M/AAAA' (sin ceros a la izquierda, igual que exporta/espera Sigma).
function fechaSigma(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d}/${m}/${y}`;
}

// codigo -> 13 caracteres, alineado a la derecha (mismo padding que el .txt de ejemplo de Sigma).
function codigoPadded(codigo) {
  return String(codigo).padStart(13, ' ');
}

// productos: [{ codigo, vencimiento:'AAAA-MM-DD', accionATomar }] (ver
// promoprecios-excel.js#parsearProductosConImagen) — se ignoran los que no tengan
// accionATomar (archivo viejo sin esa columna, o fila incompleta).
// mapaImpuestos: Map codigo -> monto (db/impuestos-internos.js#mapaImpuestosInternos).
// Devuelve el texto completo del .txt, o null si no hay ningún producto con precio de origen.
function generarTxtSigma(productos, mapaImpuestos) {
  const filas = productos.filter((p) => p.accionATomar !== null && p.accionATomar !== undefined);
  if (filas.length === 0) return null;

  const hoy = fechaSigma(fechaHoyArgISO());
  const lineas = [COLUMNAS.join('\t')];

  for (const p of filas) {
    const impuestoInterno = mapaImpuestos.get(p.codigo) || null;
    const precio = calcularPrecioSigma(p.accionATomar, impuestoInterno);
    const campos = {
      FCODIGO: codigoPadded(p.codigo),
      FVIGDES: hoy,
      FVIGHAS: fechaSigma(p.vencimiento),
      FDESCUE: '0',
      FDESMAX: '0',
      FPRECIO: precio.toFixed(5),
      FORDMAN,
    };
    lineas.push(COLUMNAS.map((c) => campos[c] ?? '').join('\t'));
  }

  return lineas.join('\r\n') + '\r\n';
}

module.exports = { calcularPrecioSigma, generarTxtSigma, truncar5 };
