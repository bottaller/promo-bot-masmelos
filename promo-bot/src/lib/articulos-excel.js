// Parser del Excel "Listado de Articulos Detallado" (export de Sigma).
// Detecta las columnas por el nombre del encabezado (no por posición fija).
// Los dos "Cod" que interesan son los que están inmediatamente a la izquierda de
// "Rubro" y de "Proveedor" (hay varias columnas "Cod", el resto se ignora).
const XLSX = require('xlsx');

function norm(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parsearArticulos(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Encontrar la fila de encabezados: la primera que tenga Codigo, Nombre y Proveedor.
  let hIdx = -1;
  for (let i = 0; i < Math.min(15, filas.length); i++) {
    const celdas = new Set(filas[i].map((c) => String(c).trim()));
    if (celdas.has('Codigo') && celdas.has('Nombre') && celdas.has('Proveedor')) {
      hIdx = i;
      break;
    }
  }
  if (hIdx === -1) {
    throw new Error('No encontré la fila de encabezados (con Codigo, Nombre y Proveedor).');
  }

  const header = filas[hIdx].map((c) => String(c).trim());
  const idx = (nombre) => header.indexOf(nombre);

  const iCodigo = idx('Codigo');
  const iNombre = idx('Nombre');
  const iEanU = idx('EAN Unidad');
  const iEanD = idx('EAN Display');
  const iEanB = idx('EAN Bulto');
  const iRubro = idx('Rubro');
  const iProv = idx('Proveedor');
  // El "Cod" que interesa es el que está inmediatamente a la izquierda.
  const iRubroCod = iRubro > 0 ? iRubro - 1 : -1;
  const iProvCod = iProv > 0 ? iProv - 1 : -1;

  if (iCodigo < 0 || iNombre < 0 || iProv < 0) {
    throw new Error('Faltan columnas esperadas en el Excel (Codigo / Nombre / Proveedor).');
  }

  const get = (fila, i) => (i >= 0 ? norm(fila[i]) : null);

  const articulos = [];
  let filasLeidas = 0;
  for (let r = hIdx + 1; r < filas.length; r++) {
    const fila = filas[r];
    if (!fila || fila.length === 0) continue;
    const codigo = get(fila, iCodigo);
    if (!codigo) continue; // sin código no es un artículo válido
    filasLeidas++;
    articulos.push({
      codigo,
      nombre: get(fila, iNombre),
      ean_unidad: get(fila, iEanU),
      ean_display: get(fila, iEanD),
      ean_bulto: get(fila, iEanB),
      rubro_cod: get(fila, iRubroCod),
      rubro: get(fila, iRubro),
      proveedor_cod: get(fila, iProvCod),
      proveedor: get(fila, iProv),
    });
  }

  return { articulos, filasLeidas };
}

module.exports = { parsearArticulos };
