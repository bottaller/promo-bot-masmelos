// Arma el Excel de "control" con las altas en oferta, ordenadas por vencimiento.
const XLSX = require('xlsx');
const { parseVencimiento, diasHasta } = require('./fechas');

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
    return {
      Vencimiento: a.vencimiento || '',
      'Días restantes': dias === null ? '' : dias,
      Producto: a.producto || '',
      Proveedor: a.proveedor || '',
      Cantidad: Number(a.cantidad),
      Lote: a.lote || '',
      EAN: a.ean || '',
      'Código': a.articulo_codigo || '',
      Motivo: a.motivo || '',
      'Fecha alta': a.fecha ? new Date(a.fecha).toISOString().slice(0, 10) : '',
    };
  });

  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'En oferta');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { construirExcelControl };
