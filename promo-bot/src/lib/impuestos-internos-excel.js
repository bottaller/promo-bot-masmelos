// Parser del Excel "art impuestos internos" (export de Sigma): lista SOLO los artículos que
// tienen impuesto interno, con su monto (columna "Imp.Interno"). Detecta las columnas por
// nombre de encabezado (no por posición fija) — mismo criterio que lib/articulos-excel.js.
const XLSX = require('xlsx');

function norm(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parsearImpuestosInternos(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  let hIdx = -1;
  for (let i = 0; i < Math.min(10, filas.length); i++) {
    const celdas = new Set(filas[i].map((c) => String(c).trim()));
    if (celdas.has('Código') && celdas.has('Imp.Interno')) { hIdx = i; break; }
  }
  if (hIdx === -1) {
    throw new Error('No encontré la fila de encabezados (con Código e Imp.Interno).');
  }

  const header = filas[hIdx].map((c) => String(c).trim());
  const iCodigo = header.indexOf('Código');
  const iImp = header.indexOf('Imp.Interno');

  const impuestos = [];
  let filasLeidas = 0;
  for (let r = hIdx + 1; r < filas.length; r++) {
    const fila = filas[r];
    if (!fila || fila.length === 0) continue;
    const codigo = norm(fila[iCodigo]);
    if (!codigo) continue;
    const monto = Number(fila[iImp]);
    if (!Number.isFinite(monto) || monto === 0) continue; // sin monto no aporta nada
    filasLeidas++;
    impuestos.push({ codigo, monto });
  }

  return { impuestos, filasLeidas };
}

module.exports = { parsearImpuestosInternos };
