// Arma el texto del reporte de un proveedor (resultado de db/compras.reportePorProveedor).
// Se usa desde /reporte (a pedido) y desde /baja (aviso automático al equipo de compras).
const { fechaHoyArg, formatoVencimiento } = require('./fechas');

function formatearReporteProveedor(r, desde) {
  const m = r.metricas;
  const tasa = Math.round(m.tasaDescarte * 100);
  const hayCerradas = m.puestasCerradas > 0;
  const detalle = r.porProducto
    .map((p) => `• ${p.producto}: ${p.altas} alta(s), ${p.efectividad}% efectividad`)
    .join('\n');
  const enPromo = m.abiertas > 0
    ? `${m.puestasAbiertas} unidades (${m.abiertas} alta${m.abiertas > 1 ? 's' : ''} abierta${m.abiertas > 1 ? 's' : ''})`
    : 'nada (todo cerrado)';
  return (
    `📦 Reporte — proveedor ${r.proveedor}\n` +
    `Período: ${desde ? `desde ${formatoVencimiento(desde)} hasta hoy` : 'histórico completo'}\n` +
    `Generado: ${fechaHoyArg()}\n\n` +
    `🟢 En promoción ahora: ${enPromo}\n\n` +
    `📊 Resumen:\n` +
    `Productos distintos: ${r.productos}\n` +
    `Unidades puestas: ${m.puestasTotal}\n` +
    `Vendidas en promo: ${m.vendidas}\n` +
    `Descartadas: ${m.descartadas}\n` +
    `Efectividad global: ${hayCerradas ? m.efectividad + '%' : 'sin promociones cerradas todavía'}\n` +
    `Tasa de descarte: ${hayCerradas ? tasa + '%' : '—'}\n` +
    `\nDetalle por producto:\n${detalle}`
  );
}

// Telegram corta los mensajes de más de 4096 caracteres.
function recortarReporte(msg) {
  return msg.length > 4000 ? msg.slice(0, 4000) + '\n…(reporte cortado, afiná la búsqueda)' : msg;
}

module.exports = { formatearReporteProveedor, recortarReporte };
