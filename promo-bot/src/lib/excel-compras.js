// Arma el Excel de promociones para Compras: todas las altas (abiertas y cerradas), una hoja
// por proveedor, más un resumen y los informes de Depósito dirigidos a Compras.
// Todo reporte lleva la fecha de generación (ver docs/convenciones.md).
const XLSX = require('xlsx');
const { fechaHoyArg, fechaHoraArgDe } = require('./fechas');

const COLUMNAS_PROMOS = [
  'Producto', 'EAN', 'Código', 'Vencimiento', 'Cantidad', 'Descuento %', 'Motivo alta', 'Fecha alta',
  'Estado', 'Vendida', 'Remanente', 'Motivo baja', 'Fecha baja',
];

// timestamptz -> 'AAAA-MM-DD' en hora de pared argentina (no toISOString(), que puede correr el día).
function fechaCorta(fechaLike) {
  const f = fechaHoraArgDe(fechaLike);
  return f ? f.iso : '';
}

function filaPromo(a) {
  return [
    a.producto || '',
    a.ean || '',
    a.articulo_codigo || '',
    a.vencimiento || '',
    Number(a.cantidad),
    a.descuento_pct === null || a.descuento_pct === undefined ? '' : Number(a.descuento_pct),
    a.motivo || '',
    fechaCorta(a.fecha),
    a.fecha_baja ? 'Cerrada' : 'Abierta',
    a.cantidad_vendida === null || a.cantidad_vendida === undefined ? '' : Number(a.cantidad_vendida),
    a.cantidad_remanente === null || a.cantidad_remanente === undefined ? '' : Number(a.cantidad_remanente),
    a.motivo_baja || '',
    fechaCorta(a.fecha_baja),
  ];
}

// Nombre de hoja válido para Excel: máx 31 caracteres, sin : \ / ? * [ ], sin repetidos
// (dos proveedores distintos podrían truncar al mismo nombre).
function nombreDeHoja(nombre, usados) {
  const base = (nombre || 'Sin proveedor').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Proveedor';
  let candidato = base;
  let i = 2;
  while (usados.has(candidato.toLowerCase())) {
    const sufijo = ` (${i})`;
    candidato = base.slice(0, 31 - sufijo.length) + sufijo;
    i++;
  }
  usados.add(candidato.toLowerCase());
  return candidato;
}

function construirExcelCompras(altas, informes) {
  const wb = XLSX.utils.book_new();
  const usados = new Set();

  // Agrupar altas por proveedor (null -> "Sin proveedor", cargas manuales sin ese dato).
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
  XLSX.utils.book_append_sheet(wb, wsResumen, nombreDeHoja('Resumen', usados));

  // Una hoja por proveedor con el detalle de cada alta, abierta o cerrada.
  for (const p of proveedores) {
    const filas = grupos.get(p)
      .slice()
      .sort((x, y) => new Date(x.fecha) - new Date(y.fecha))
      .map(filaPromo);
    const ws = XLSX.utils.aoa_to_sheet([
      [p],
      [`Generado: ${fechaHoyArg()}`],
      [],
      COLUMNAS_PROMOS,
      ...filas,
    ]);
    XLSX.utils.book_append_sheet(wb, ws, nombreDeHoja(p, usados));
  }

  // Última hoja: informes de Depósito dirigidos a Compras.
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
  XLSX.utils.book_append_sheet(wb, wsInformes, nombreDeHoja('Informes Depósito', usados));

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { construirExcelCompras };
