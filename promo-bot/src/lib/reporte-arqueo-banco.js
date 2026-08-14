// Reporte del arqueo bancario ACUMULADO (/arqueobanco). Distinto de reporte-mp.js a propósito:
// ese arma el arqueo de UN día (tiene sentido mostrar la HORA); acá cada renglón pendiente puede
// ser de un día distinto dentro del mes acumulado, así que se muestra la FECHA. No se reusa
// lineasPlataforma() para no arriesgar el formato ya validado de MP/Talo.
const { fechaHoyArg, fechaHoyArgISO } = require('./fechas');

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

// Días de calendario entre `ts` (o 'AAAA-MM-DD...') y `hoyISO` ('AAAA-MM-DD'). Por fecha, no por
// hora: dos Date a medianoche local, así no importa el TZ del proceso.
function diasDesde(ts, hoyISO) {
  const f = String(ts || '').slice(0, 10);
  const m1 = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m1) return 0;
  const [, y1, mo1, d1] = m1;
  const [y2, mo2, d2] = hoyISO.split('-');
  const a = new Date(+y1, +mo1 - 1, +d1);
  const b = new Date(+y2, +mo2 - 1, +d2);
  return Math.round((b - a) / 86400000);
}

// Arqueo "a día vencido": la diferencia de un día o dos casi siempre es timing (Sigma todavía no
// asentó ese extracto) y se resuelve sola en cuanto llega un Mayor más nuevo — no es un problema
// real y no debería disparar la alarma cada vez que se sube algo (mismo criterio que /cierre con
// el acumulado: lo que importa es lo que sigue sin cerrar pasado el margen normal, no la
// diferencia del día). Separa soloMp/soloSistema en VENCIDO (más de `diasGracia` días sin
// aparear — hay que revisarlo) y RECIENTE (puede tardar todavía — no alarma). Devuelve un
// resultado con la MISMA forma que conciliarMP (para pasarlo tal cual a construirInformePDF),
// recortado a lo vencido, más `recientes` aparte para mostrarlo como nota informativa.
const DIAS_GRACIA_DEFAULT = 3;
function filtrarPorVencimiento(resultado, diasGracia = DIAS_GRACIA_DEFAULT) {
  const hoy = fechaHoyArgISO();
  const partir = (arr, fechaDe) => {
    const vencidos = [];
    const recientes = [];
    for (const it of arr) (diasDesde(fechaDe(it), hoy) >= diasGracia ? vencidos : recientes).push(it);
    return { vencidos, recientes };
  };
  const mp = partir(resultado.soloMp, (o) => o.hora);
  const sistema = partir(resultado.soloSistema, (m) => m.ingreso);
  const suma = (arr, f) => Math.round(arr.reduce((a, x) => a + f(x), 0) * 100) / 100;
  const resumen = {
    ...resultado.resumen,
    nSoloMp: mp.vencidos.length,
    totalSoloMp: suma(mp.vencidos, (o) => o.bruto),
    nSoloSistema: sistema.vencidos.length,
    totalSoloSistema: suma(sistema.vencidos, (m) => m.debe),
    nivel: (mp.vencidos.length || sistema.vencidos.length) ? 'alerta' : (resultado.resumen.nAviso ? 'aviso' : 'ok'),
  };
  return {
    ...resultado,
    soloMp: mp.vencidos,
    soloSistema: sistema.vencidos,
    resumen,
    recientes: { mp: mp.recientes, sistema: sistema.recientes, diasGracia },
  };
}

const MAX_LISTA = 10;

// formatearArqueoBancoAcumulado({ mesTxt, plataforma, resultado }) -> texto HTML (Telegram)
//   mesTxt:     'agosto 2026' (o similar), para el encabezado
//   plataforma: el descriptor de plataformas.js (Santander o Supervielle)
//   resultado:  YA pasado por filtrarPorVencimiento (soloMp/soloSistema = solo lo vencido)
function formatearArqueoBancoAcumulado({ mesTxt, plataforma, resultado }) {
  const { soloSistema, soloMp, resumen: r, recientes } = resultado;
  const L = [];
  L.push(`🏦 <b>Arqueo acumulado ${escapeHtml(plataforma.nombre)}</b> — ${escapeHtml(mesTxt)}`);
  L.push(`<i>Generado: ${fechaHoyArg()} · acumulado del mes, a día vencido (margen de ${recientes ? recientes.diasGracia : DIAS_GRACIA_DEFAULT} días)</i>`);
  L.push('');
  if (!soloSistema.length && !soloMp.length) {
    L.push(`🟢 <b>Aparea todo lo vencido</b>: ${r.nPares} cobranza(s) cerradas.`);
  } else {
    L.push(`🔴 <b>Hay ${soloSistema.length + soloMp.length} vencido(s) sin aparear</b> — hace más de ${recientes ? recientes.diasGracia : DIAS_GRACIA_DEFAULT} días que están pendientes.`);
  }
  L.push('');
  L.push(`<b>Totales del mes (${escapeHtml(plataforma.alcanceTxt)})</b>`);
  L.push(`Libro: <b>${fmt(r.totalSistema)}</b> · ${escapeHtml(plataforma.nombre)}: <b>${fmt(r.totalMp)}</b> · dif: <b>${fmtC(r.diferencia)}</b>`);

  if (soloMp.length) {
    L.push('');
    L.push(`🔴 <b>Cobró ${escapeHtml(plataforma.nombre)} y no está asentado (vencido)</b> — ${soloMp.length} · ${fmt(r.totalSoloMp)}`);
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
    L.push(`🔴 <b>Asentado y ${escapeHtml(plataforma.nombre)} no lo tiene (vencido)</b> — ${soloSistema.length} · ${fmt(r.totalSoloSistema)}`);
    for (const m of soloSistema.slice(0, MAX_LISTA)) {
      L.push(`• ${fechaCorta(m.ingreso)} · <b>${fmt(m.debe)}</b> · ${escapeHtml(m.comprobante || `asiento ${m.asiento}`)} · ${escapeHtml(m.cliente)}`);
    }
    if (soloSistema.length > MAX_LISTA) L.push(`<i>…y ${soloSistema.length - MAX_LISTA} más.</i>`);
  }

  // Recientes: NO alarman (no forman parte de "sin aparear"), pero se listan aparte para que no
  // parezca que desaparecieron — solo el conteo y el total, sin detalle línea por línea.
  const totalRecientes = recientes ? recientes.mp.length + recientes.sistema.length : 0;
  if (totalRecientes) {
    const totalMonto = (recientes.mp.reduce((a, o) => a + o.bruto, 0) + recientes.sistema.reduce((a, m) => a + m.debe, 0));
    L.push('');
    L.push(`🕐 <i>${totalRecientes} más, de los últimos ${recientes.diasGracia} días (${fmt(totalMonto)}) — todavía puede asentarse, no alarma.</i>`);
  }
  return L.join('\n');
}

module.exports = { formatearArqueoBancoAcumulado, filtrarPorVencimiento, DIAS_GRACIA_DEFAULT };
