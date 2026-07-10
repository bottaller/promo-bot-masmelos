// Arma el Excel de "control" con las altas en oferta, ordenadas por vencimiento.
// Todo reporte lleva la fecha de generación (ver docs/convenciones.md).
const XLSX = require('xlsx');
const { parseVencimiento, diasHasta, fechaHoyArg } = require('./fechas');

const COLUMNAS = ['Vencimiento', 'Días restantes', 'Producto', 'Proveedor', 'Cantidad', 'Descuento %', 'Lote', 'EAN', 'Código', 'Motivo', 'Fecha alta'];

function construirExcelControl(altas) {
  // Ordenar por fecha de vencimiento (las fechas inválidas/ausentes van al final).
  const ordenadas = [...altas].sort((a, b) => {
    const fa = parseVencimiento(a.vencimiento);
    const fb = parseVencimiento(b.vencimiento);
    if (fa && fb) return fa.getTime() - fb.getTime();
    if (fa) return -1;
    if (fb) return 1;
    return 0;
  });

  const filas = ordenadas.map((a) => {
    const dias = diasHasta(parseVencimiento(a.vencimiento));
    return [
      a.vencimiento || '',
      dias === null ? '' : dias,
      a.producto || '',
      a.proveedor || '',
      Number(a.cantidad),
      a.descuento_pct === null || a.descuento_pct === undefined ? '' : Number(a.descuento_pct),
      a.lote || '',
      a.ean || '',
      a.articulo_codigo || '',
      a.motivo || '',
      a.fecha ? new Date(a.fecha).toISOString().slice(0, 10) : '',
    ];
  });

  const aoa = [
    ['Control de ofertas en promoción'],
    [`Generado: ${fechaHoyArg()}`],
    [],
    COLUMNAS,
    ...filas,
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'En oferta');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { construirExcelControl };
