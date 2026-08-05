// Arma el Excel de faltantes para Compras: una hoja, UNA fila por producto (ya consolidado por
// db/faltantes.js -> faltantesConsolidados), lo más urgente arriba, con AutoFilter. Lleva la
// fecha de generación (ver docs/convenciones.md). Molde: lib/excel-compras.js.
const XLSX = require('xlsx');
const { fechaHoyArg, fechaHoraArgDe } = require('./fechas');

const COLUMNAS = ['Producto', 'Código', 'Situación', 'Reportado por', 'Avisos', 'Última', 'Notas'];

const SIT_TXT = { falta: 'Falta (no hay)', poco: 'Queda poco', vende_mucho: 'Se vende mucho' };
const SIT_ORDEN = ['falta', 'poco', 'vende_mucho']; // para mostrarlas siempre en el mismo orden
const AREA_TXT = { ventas: 'Ventas', deposito: 'Depósito' };

// timestamptz -> 'AAAA-MM-DD' en hora de pared argentina (no toISOString(), que puede correr el día).
function fechaCorta(fechaLike) {
  const f = fechaHoraArgDe(fechaLike);
  return f ? f.iso : '';
}

function fila(g) {
  const situaciones = SIT_ORDEN
    .filter((s) => (g.situaciones || []).includes(s))
    .map((s) => SIT_TXT[s])
    .join(' / ');
  const reportadoPor = (g.origenes || []).map((o) => AREA_TXT[o] || o).join(', ');
  const notas = (g.notas || []).join(' · ');
  return [
    g.producto || '',
    g.articulo_codigo || '',
    situaciones,
    reportadoPor,
    Number(g.avisos),
    fechaCorta(g.ultima),
    notas,
  ];
}

function construirExcelFaltantes(grupos, dias = 14) {
  const wb = XLSX.utils.book_new();
  const filas = grupos.map(fila);

  const semanas = Math.max(1, Math.round(dias / 7));
  const ws = XLSX.utils.aoa_to_sheet([
    [`Faltantes reportados — últimas ${semanas} semana(s)`],
    [`Generado: ${fechaHoyArg()}`],
    [],
    COLUMNAS,
    ...filas,
  ]);

  const encabezadoFilaIdx = 3; // 0-based: título, generado, blanco, encabezado
  const ultimaFila = encabezadoFilaIdx + filas.length;
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range(
      { r: encabezadoFilaIdx, c: 0 },
      { r: ultimaFila, c: COLUMNAS.length - 1 }
    ),
  };
  XLSX.utils.book_append_sheet(wb, ws, 'Faltantes');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { construirExcelFaltantes };
