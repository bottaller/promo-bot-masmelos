// Parser del Excel de ingresos del día (resumen por proveedor).
// Guardamos SOLO la columna de nombres ("Proveedor nombre"): ignoramos Bultos,
// Total y la fila "Total" del final. Detecta la columna por el encabezado.
// Además "limpia" el nombre para la web (saca la razón social entre paréntesis
// y los sufijos societarios, y pasa a Mayúscula Inicial).
const XLSX = require('xlsx');

function norm(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// "ALFAJORES RASTA (GOLOZEN S.A)" -> "Alfajores Rasta"
// "GEORGALOS HNOS. S.A.I.C.A."    -> "Georgalos Hnos."
// "LHERITIER ARGENTINA SA"        -> "Lheritier Argentina"
function limpiarNombre(raw) {
  let s = String(raw || '').trim();
  // Paréntesis al final (razón social / notas): "... (GOLOZEN S.A)", "(NUEVO)"
  s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  // Sufijos societarios al final (dotados o no): S.A. / S.R.L. / S.A.I.C.A. / SA / SRL / …
  s = s
    .replace(
      /[\s,]+(?:s\.a\.i\.c\.a\.?|s\.a\.i\.c\.?|s\.a\.c\.i\.?|s\.r\.l\.?|s\.a\.s\.?|s\.a\.?|s\.h\.?|saic|saci|srl|sas|sa|sh|ltda\.?)\s*$/i,
      '',
    )
    .trim();
  // Mayúscula Inicial (respeta separadores . - /)
  s = s.toLowerCase().replace(/(^|[\s.\-/])([a-záéíóúñü])/g, (_, p, c) => p + c.toUpperCase());
  // Conectores en minúscula (menos al inicio)
  s = s.replace(/(?<!^)\b(De|Del|La|Las|Los|El|Y|E)\b/g, (m) => m.toLowerCase());
  return s.trim();
}

function parsearIngresos(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Fila de encabezados: la primera (de las primeras 15) con una celda tipo
  // "Proveedor", "Nombre" o "Producto". Esa columna es la de nombres.
  let hIdx = -1;
  let iNombre = -1;
  for (let i = 0; i < Math.min(15, filas.length); i++) {
    const j = filas[i].findIndex((c) => /proveedor|nombre|producto/i.test(String(c).trim()));
    if (j !== -1) { hIdx = i; iNombre = j; break; }
  }
  if (hIdx === -1) {
    throw new Error('No encontré la columna de nombres (algo tipo "Proveedor nombre").');
  }

  const nombres = [];
  for (let r = hIdx + 1; r < filas.length; r++) {
    const nombre = norm(filas[r] && filas[r][iNombre]);
    if (!nombre) continue;
    if (/^total\b/i.test(nombre)) continue; // fila de total del final
    const limpio = limpiarNombre(nombre);
    if (limpio) nombres.push(limpio);
  }

  return { nombres, filasLeidas: nombres.length };
}

module.exports = { parsearIngresos, limpiarNombre };
