// Arma el Excel de promociones para Compras: todas las altas (abiertas y cerradas) en una sola
// hoja de detalle, agrupadas por proveedor y con AutoFilter para que Compras filtre como quiera,
// más un resumen y los informes de Depósito dirigidos a Compras.
// Todo reporte lleva la fecha de generación (ver docs/convenciones.md).
const XLSX = require('xlsx');
const { fechaHoyArg, fechaHoraArgDe } = require('./fechas');

const COLUMNAS_DETALLE = [
  'Proveedor', 'Producto', 'EAN', 'Código', 'Vencimiento', 'Cantidad', 'Descuento %', 'Precio promocional',
  'Motivo alta', 'Fecha alta', 'Estado', 'Vendida', 'Remanente', 'Motivo baja', 'Fecha baja',
];

// timestamptz -> 'AAAA-MM-DD' en hora de pared argentina (no toISOString(), que puede correr el día).
function fechaCorta(fechaLike) {
  const f = fechaHoraArgDe(fechaLike);
  return f ? f.iso : '';
}

function filaDetalle(a) {
  return [
    a.proveedor || 'Sin proveedor',
    a.producto || '',
    a.ean || '',
    a.articulo_codigo || '',
    a.vencimiento || '',
    Number(a.cantidad),
    a.descuento_pct === null || a.descuento_pct === undefined ? '' : Number(a.descuento_pct),
    a.precio_promocional === null || a.precio_promocional === undefined ? '' : Number(a.precio_promocional),
    a.motivo || '',
    fechaCorta(a.fecha),
    a.fecha_baja ? 'Cerrada' : 'Abierta',
    a.cantidad_vendida === null || a.cantidad_vendida === undefined ? '' : Number(a.cantidad_vendida),
    a.cantidad_remanente === null || a.cantidad_remanente === undefined ? '' : Number(a.cantidad_remanente),
    a.motivo_baja || '',
    fechaCorta(a.fecha_baja),
  ];
}

function construirExcelCompras(altas, informes) {
  const wb = XLSX.utils.book_new();

  // Agrupar por proveedor solo para ORDENAR el detalle (no para separar en hojas): "Sin proveedor"
  // (cargas manuales sin ese dato) al final.
  const grupos = new Map();
  for (const a of altas) {
    const clave = a.proveedor || 'Sin proveedor';
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(a);
  }
  const proveedores = [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'es'));

  // Hoja 1: resumen, una fila por proveedor.
  const filasResumen = proveedores.map((p) => {
    const g = grupos.get(p);
    const abiertas = g.filter((a) => !a.fecha_baja).length;
    return [p, g.length, abiertas, g.length - abiertas, g.reduce((s, a) => s + Number(a.cantidad), 0)];
  });
  const wsResumen = XLSX.utils.aoa_to_sheet([
    ['Promociones por proveedor — resumen'],
    [`Generado: ${fechaHoyArg()}`],
    [],
    ['Proveedor', 'Altas totales', 'Abiertas', 'Cerradas', 'Unidades puestas'],
    ...filasResumen,
  ]);
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

  // Hoja 2: detalle completo, agrupado por proveedor, con AutoFilter para filtrar por
  // proveedor (o cualquier otra columna) desde el propio Excel.
  const encabezadoFilaIdx = 3; // 0-based: título, generado, blanco, encabezado
  const filasDetalle = proveedores.flatMap((p) => grupos.get(p)
    .slice()
    .sort((x, y) => new Date(x.fecha) - new Date(y.fecha))
    .map(filaDetalle));
  const wsDetalle = XLSX.utils.aoa_to_sheet([
    ['Detalle de promociones (agrupado por proveedor)'],
    [`Generado: ${fechaHoyArg()}`],
    [],
    COLUMNAS_DETALLE,
    ...filasDetalle,
  ]);
  const ultimaFila = encabezadoFilaIdx + filasDetalle.length;
  wsDetalle['!autofilter'] = {
    ref: XLSX.utils.encode_range(
      { r: encabezadoFilaIdx, c: 0 },
      { r: ultimaFila, c: COLUMNAS_DETALLE.length - 1 }
    ),
  };
  XLSX.utils.book_append_sheet(wb, wsDetalle, 'Detalle');

  // Hoja 3: informes de Depósito dirigidos a Compras.
  const filasInformes = informes.map((i) => [
    fechaCorta(i.fecha), i.referencia || '', i.mensaje || '', i.usuario_nombre || '',
  ]);
  const wsInformes = XLSX.utils.aoa_to_sheet([
    ['Informes de Depósito para Compras'],
    [`Generado: ${fechaHoyArg()}`],
    [],
    ['Fecha', 'Proveedor/producto', 'Informe', 'Cargado por'],
    ...filasInformes,
  ]);
  XLSX.utils.book_append_sheet(wb, wsInformes, 'Informes Depósito');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { construirExcelCompras };
