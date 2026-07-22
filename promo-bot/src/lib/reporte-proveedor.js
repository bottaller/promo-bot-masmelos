// Arma el texto del reporte de un proveedor (resultado de db/compras.reportePorProveedor).
// Se usa desde /reporte (a pedido) y desde /baja (aviso automático al equipo de compras).
const { fechaHoyArg, formatoVencimiento } = require('./fechas');

// Uno o varios valores (% de descuento y/o precio promocional; varias camadas del mismo
// producto pueden llevar un valor distinto).
function formatoPromos(p) {
  const partes = [...p.descuentos.map((d) => `${d}%`), ...p.precios.map((pr) => `$${pr}`)];
  return partes.length ? partes.join(' / ') : 'sin dato de promo';
}

// "30% → 80u, 50% → 20u, $500 → 15u" — unidades vendidas por cada valor aplicado.
function formatoVendidoPorValor(vendidoPorPct, vendidoPorPrecio) {
  const partes = [
    ...vendidoPorPct.map((v) => `${v.valor}% → ${v.unidades}u`),
    ...vendidoPorPrecio.map((v) => `$${v.valor} → ${v.unidades}u`),
  ];
  return partes.join(', ');
}

// Bloque global (todo el proveedor): una línea por valor, con el total vendido a ese valor.
function bloqueVendido(titulo, esPrecio, pares) {
  if (!pares.length) return '';
  const lineas = pares.map((v) => `  ${esPrecio ? '$' + v.valor : v.valor + '%'}: ${v.unidades} unidad(es)`);
  return `\n\n${titulo}:\n${lineas.join('\n')}`;
}

function formatearReporteProveedor(r, desde) {
  const m = r.metricas;
  const tasa = Math.round(m.tasaDescarte * 100);
  const hayCerradas = m.puestasCerradas > 0;
  const detalle = r.porProducto
    .map((p) => {
      const vendido = formatoVendidoPorValor(p.vendidoPorPct, p.vendidoPorPrecio);
      let linea = `• ${p.producto}: ${p.altas} alta(s), ${formatoPromos(p)}, ${p.hayCerradas ? p.efectividad + '% efectividad' : 'sin promociones cerradas todavía'}`;
      if (vendido) linea += `\n   vendido: ${vendido}`;
      return linea;
    })
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
    `Tasa de descarte: ${hayCerradas ? tasa + '%' : '—'}` +
    bloqueVendido('💰 Vendido por % de descuento', false, r.vendidoPorPct) +
    bloqueVendido('💵 Vendido por precio promocional', true, r.vendidoPorPrecio) +
    `\n\nDetalle por producto:\n${detalle}`
  );
}

// Telegram corta los mensajes de más de 4096 caracteres. Mensaje neutro porque este reporte se
// usa tanto en /reporte (a pedido) como en el aviso automático de /baja (donde nadie "buscó" nada).
function recortarReporte(msg) {
  return msg.length > 4000 ? msg.slice(0, 4000) + '\n…(reporte recortado por longitud)' : msg;
}

module.exports = { formatearReporteProveedor, recortarReporte };
