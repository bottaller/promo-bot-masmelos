// Reporte del arqueo bancario ACUMULADO (/arqueobanco). Distinto de reporte-mp.js a propósito:
// ese arma el arqueo de UN día (tiene sentido mostrar la HORA); acá cada renglón pendiente puede
// ser de un día distinto dentro del mes acumulado, así que se muestra la FECHA. No se reusa
// lineasPlataforma() para no arriesgar el formato ya validado de MP/Talo.
const { fechaHoyArg } = require('./fechas');

const _NF0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const _NF2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmt(n) {
  if (n == null) return '—';
  return `${n < 0 ? '−' : ''}$${_NF0.format(Math.abs(Math.round(n)))}`;
}
function fmtC(n) {
  if (n == null) return '—';
  return `${n < 0 ? '−' : ''}$${_NF2.format(Math.abs(n))}`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// 'AAAA-MM-DD HH:MM:SS' -> 'DD/MM'
function fechaCorta(ts) {
  const f = String(ts || '').slice(0, 10);
  const m = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}` : '—';
}

const MAX_LISTA = 10;

// formatearArqueoBancoAcumulado({ mesTxt, plataforma, resultado }) -> texto HTML (Telegram)
//   mesTxt:     'agosto 2026' (o similar), para el encabezado
//   plataforma: el descriptor de plataformas.js (Santander o Supervielle)
//   resultado:  lo que devuelve conciliarMP({movimientos, operaciones, plataforma})
function formatearArqueoBancoAcumulado({ mesTxt, plataforma, resultado }) {
  const { soloSistema, soloMp, resumen: r } = resultado;
  const L = [];
  L.push(`🏦 <b>Arqueo acumulado ${escapeHtml(plataforma.nombre)}</b> — ${escapeHtml(mesTxt)}`);
  L.push(`<i>Generado: ${fechaHoyArg()} · acumulado del mes, no un día puntual</i>`);
  L.push('');
  if (!soloSistema.length && !soloMp.length) {
    L.push(`🟢 <b>Aparea todo</b>: ${r.nPares} cobranza(s) ↔ ${r.nPares} movimiento(s) del libro.`);
  } else {
    L.push(`🔴 <b>Hay ${soloSistema.length + soloMp.length} sin aparear</b> — ${r.nPares} de ${Math.max(r.nSistema, r.nMp)} cerraron.`);
  }
  L.push('');
  L.push(`<b>Totales del mes (${escapeHtml(plataforma.alcanceTxt)})</b>`);
  L.push(`Libro: <b>${fmt(r.totalSistema)}</b> · ${escapeHtml(plataforma.nombre)}: <b>${fmt(r.totalMp)}</b> · dif: <b>${fmtC(r.diferencia)}</b>`);

  if (soloMp.length) {
    L.push('');
    L.push(`🔴 <b>Cobró ${escapeHtml(plataforma.nombre)} y no está asentado</b> — ${soloMp.length} · ${fmt(r.totalSoloMp)}`);
    for (const o of soloMp.slice(0, MAX_LISTA)) {
      const ref = plataforma.referencia ? plataforma.referencia(o) : '';
      const partes = [fechaCorta(o.hora), `<b>${fmt(o.bruto)}</b>`];
      if (ref) partes.push(escapeHtml(ref));
      L.push(`• ${partes.join(' · ')}`);
    }
    if (soloMp.length > MAX_LISTA) L.push(`<i>…y ${soloMp.length - MAX_LISTA} más.</i>`);
  }
  if (soloSistema.length) {
    L.push('');
    L.push(`🔴 <b>Asentado y ${escapeHtml(plataforma.nombre)} no lo tiene</b> — ${soloSistema.length} · ${fmt(r.totalSoloSistema)}`);
    for (const m of soloSistema.slice(0, MAX_LISTA)) {
      L.push(`• ${fechaCorta(m.ingreso)} · <b>${fmt(m.debe)}</b> · ${escapeHtml(m.comprobante || `asiento ${m.asiento}`)} · ${escapeHtml(m.cliente)}`);
    }
    if (soloSistema.length > MAX_LISTA) L.push(`<i>…y ${soloSistema.length - MAX_LISTA} más.</i>`);
  }
  return L.join('\n');
}

module.exports = { formatearArqueoBancoAcumulado };
