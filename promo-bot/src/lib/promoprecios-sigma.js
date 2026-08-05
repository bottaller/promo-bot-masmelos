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
// Formato: 31 columnas separadas por TAB — medido contra la pantalla real de Sigma ("Opciones de
// importación", panel Columna -> Campo), NO por posición fija de un archivo de ejemplo viejo (esa
// versión tenía 26 columnas, con FCODIGO primero — está mal, Sigma la mapeaba corrida). El orden
// real es FORDMAN primero, FCODIGO segundo, y hay 8 columnas sin campo asignado intercaladas
// (Cod.Referencia, Cod.Basket, Q.Bonif., Puntos, 3 "Codigo" sueltas, Cant.mínima en Bultos,
// Canal) que hay que dejar vacías para que el resto caiga en la posición correcta — Sigma arma
// las columnas por POSICIÓN, no por el nombre que tenga el encabezado.
const { fechaHoyArgISO } = require('./fechas');

const IVA = 1.21;
const FORDMAN = '95';

// Columna -> campo interno que llena esa posición, o null si Sigma no la usa acá (va vacía).
const COLUMNAS = [
  'FORDMAN', // 1  Orden
  'FCODIGO', // 2  Cod.Art
  null,      // 3  Cod.Referencia
  null,      // 4  Cod.Basket
  'FRUBART', // 5  Cod.
  'FLISPRE', // 6  Lista
  'FGRUCLI', // 7  Codigo
  'FVIGDES', // 8  Desde
  'FVIGHAS', // 9  Hasta
  'FDESCUE', // 10 Desc.
  'FDESMAX', // 11 Desc.Max
  null,      // 12 Q.Bonif.
  'FPRECIO', // 13 Precio
  null,      // 14 Puntos
  'FMODULO', // 15 Modulo
  null,      // 16 Codigo
  'FCANMIN', // 17 Q. Min.
  'FCANMAX', // 18 Q. Max.
  null,      // 19 Codigo
  'FGRUART', // 20 Codigo
  'FRUBCLI', // 21 Codigo
  'FCONVEN', // 22 Cond.Venta
  'FVENDED', // 23 Vendedor
  'FEMPRES', // 24 Empresa
  'FDIAVIS', // 25 Dia
  'FMONEDA', // 26 Moneda
  'FPOLBUL', // 27 Pol. por Bulto
  'FSINDES', // 28 sDes
  'FSUCURS', // 29 Suc.
  null,      // 30 Cant.mínima en Bultos
  null,      // 31 Canal
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

// codigo -> 13 caracteres, alineado a la derecha (mismo padding que ya usa Sigma para este campo).
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
  const lineas = [COLUMNAS.map((c) => c || '').join('\t')];

  for (const p of filas) {
    const impuestoInterno = mapaImpuestos.get(p.codigo) || null;
    const precio = calcularPrecioSigma(p.accionATomar, impuestoInterno);
    const campos = {
      FORDMAN,
      FCODIGO: codigoPadded(p.codigo),
      FVIGDES: hoy,
      FVIGHAS: fechaSigma(p.vencimiento),
      FDESCUE: '0',
      FDESMAX: '0',
      FPRECIO: precio.toFixed(5),
    };
    lineas.push(COLUMNAS.map((c) => (c ? (campos[c] ?? '') : '')).join('\t'));
  }

  return lineas.join('\r\n') + '\r\n';
}

module.exports = { calcularPrecioSigma, generarTxtSigma, truncar5 };
