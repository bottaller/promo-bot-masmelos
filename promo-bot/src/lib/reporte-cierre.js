// Arma el mensaje de un cierre para Telegram (HTML). Recibe las filas YA evaluadas por el
// motor (cada una con nivel/motivo de conciliacion.js::evaluarCuenta) y las presenta de
// forma que lo importante salte a la vista: primero lo que hay que revisar, después lo sano.

const ICONO = { ok: '🟢', timing: '🟡', revisar: '🟠', alerta: '🔴' };
const ORDEN = { alerta: 0, revisar: 1, timing: 2, ok: 3, sin_saldo_ayer: 4, sin_saldo_hoy: 4 };

function nf(moneda) {
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
}
// Monto con signo y símbolo de moneda.
function fmt(n, moneda) {
  if (n == null) return '—';
  const s = nf(moneda).format(Math.abs(Math.round(n)));
  const sig = n < 0 ? '−' : '';
  return `${sig}${moneda === 'USD' ? 'US$' : '$'}${s}`;
}

function resumen(filas) {
  const r = { total: filas.length, ok: 0, timing: 0, revisar: 0, alerta: 0, incompletas: 0 };
  for (const f of filas) {
    if (f.estado === 'sin_saldo_ayer' || f.estado === 'sin_saldo_hoy') { r.incompletas++; continue; }
    r[f.nivel] = (r[f.nivel] || 0) + 1;
  }
  return r;
}

// Título humano del tipo de cierre.
function tituloTipo(tipo) {
  return { diario: 'Cierre diario', semanal: 'Control semanal', mensual: 'Control mensual' }[tipo] || 'Cierre';
}

// filas: [{cuenta, moneda, saldo_ayer, ingresos, egresos, saldo_teorico, saldo_real,
//          diferencia, acumulado, estado, nivel, motivo}]
function formatearCierre({ fecha, empresa = 'HONRE', filas, tipo = 'diario', periodo = null }) {
  const r = resumen(filas);
  const cuando = periodo ? periodo : fecha;
  const L = [];
  L.push(`🏦 <b>${tituloTipo(tipo)}</b> — ${empresa} · ${cuando}`);

  // Resumen de una línea.
  const partes = [];
  if (r.ok) partes.push(`🟢 ${r.ok} cierran`);
  if (r.timing) partes.push(`🟡 ${r.timing} timing`);
  if (r.revisar) partes.push(`🟠 ${r.revisar} a revisar`);
  if (r.alerta) partes.push(`🔴 ${r.alerta} alerta${r.alerta > 1 ? 's' : ''}`);
  if (r.incompletas) partes.push(`⚪ ${r.incompletas} sin datos`);
  L.push(partes.join(' · '));
  L.push('');

  // Ordenar: primero lo que necesita atención.
  const ord = [...filas].sort((a, b) => (ORDEN[a.nivel] ?? 9) - (ORDEN[b.nivel] ?? 9));

  const sanos = [];
  for (const f of ord) {
    const ic = ICONO[f.nivel] || '⚪';
    if (f.estado === 'sin_saldo_ayer') { L.push(`⚪ <b>${f.cuenta}</b> — primer día, sin saldo anterior para comparar`); continue; }
    if (f.estado === 'sin_saldo_hoy') { L.push(`⚪ <b>${f.cuenta}</b> — tuvo movimientos pero no cargaste el saldo`); continue; }
    if (f.nivel === 'ok') { sanos.push(f.cuenta); continue; }
    if (f.nivel === 'timing') {
      // Una línea compacta: diferencia + acumulado.
      L.push(`${ic} <b>${f.cuenta}</b> · dif ${fmt(f.diferencia, f.moneda)} · acum ${fmt(f.acumulado, f.moneda)}`);
      continue;
    }
    // revisar / alerta: detalle.
    L.push(`${ic} <b>${f.cuenta}</b> · dif ${fmt(f.diferencia, f.moneda)} · <b>acum ${fmt(f.acumulado, f.moneda)}</b>`);
    if (f.motivo) L.push(`   <i>${f.motivo}</i>`);
  }
  if (sanos.length) L.push(`🟢 <b>Cierran ok:</b> ${sanos.join(', ')}`);

  L.push('');
  const esPeriodo = tipo !== 'diario';
  if (r.alerta) {
    L.push(esPeriodo
      ? '🔴 <b>Hay cuentas con un residuo que sobrevivió todo el período.</b> Eso ya no es timing — revisalo.'
      : '🔴 <b>Hay cuentas cuya diferencia no se resuelve.</b> Revisá esos movimientos o avisá al admin.');
  } else if (r.revisar) {
    L.push('🟠 Diferencias grandes pero recientes: suelen ser un depósito/transferencia que se asienta en los próximos días. Miralas en el próximo cierre.');
  } else if (esPeriodo) {
    L.push('✅ El período cierra: las diferencias diarias eran timing y se lavaron.');
  } else {
    L.push('✅ Todo dentro de lo normal. Las diferencias del día son timing y el acumulado está sano.');
  }
  return L.join('\n');
}

module.exports = { formatearCierre, resumen, fmt };
