// Arma el resumen SEMANAL del control de Mercado Pago: día por día de la semana pasada,
// cómo salió (cerró / con diferencias / no se corrió). Parte pura (sin base ni Telegram) →
// testeable. El scheduler (aviso-mp-semanal.js) lo llena con lo que hay en la base y lo manda.

const _NF0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
function fmt(n) {
  if (n == null) return '—';
  return `${n < 0 ? '−' : ''}$${_NF0.format(Math.abs(Math.round(n)))}`;
}

const DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// ISO 'AAAA-MM-DD' -> Date a medianoche local (para aritmética de días; Argentina no tiene
// horario de verano, así que sumar/restar días enteros es seguro sin cuidar el TZ).
function isoADate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function dateAISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ddmm(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// La semana completa (lunes a domingo) ANTERIOR a `hoyISO`. Robusto al día en que se corra:
// toma el lunes de la semana de hoy y devuelve los 7 días previos. -> { desde, hasta } (ISO).
function semanaAnterior(hoyISO) {
  const hoy = isoADate(hoyISO);
  const dow = hoy.getDay(); // 0=domingo .. 6=sábado
  const diasDesdeLunes = (dow + 6) % 7; // lunes=0, domingo=6
  const lunesEstaSemana = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - diasDesdeLunes);
  const hasta = new Date(lunesEstaSemana.getFullYear(), lunesEstaSemana.getMonth(), lunesEstaSemana.getDate() - 1); // domingo
  const desde = new Date(lunesEstaSemana.getFullYear(), lunesEstaSemana.getMonth(), lunesEstaSemana.getDate() - 7); // lunes
  return { desde: dateAISO(desde), hasta: dateAISO(hasta) };
}

// Los 7 días ISO de desde..hasta (inclusive).
function diasDelRango(desde, hasta) {
  const out = [];
  let d = isoADate(desde);
  const fin = isoADate(hasta);
  while (d <= fin) {
    out.push(dateAISO(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return out;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// El detalle de una huérfana guardada (jsonb) en una línea: importe y, si se rastreó, dónde apareció.
function lineaHuerfana(h) {
  const que = h.lado === 'mp' ? 'cobró MP y no está asentado' : 'asentado y MP no lo tiene';
  let s = `   ↳ ${fmt(h.importe)} · ${que}`;
  if (h.contrapartida && h.contrapartida.cuentas && h.contrapartida.cuentas.length) {
    const c = h.contrapartida;
    s += ` · <i>aparece en ${escapeHtml(c.cuentas.join(' → '))}`;
    if (c.concepto) s += ` ("${escapeHtml(c.concepto)}")`;
    s += '</i>';
  }
  return s;
}

const MAX_HUERFANAS_DIA = 3; // hasta 3 por plataforma-día (el detalle fino está en el arqueo de ese día)
const NOMBRE_PLAT = { mp: 'MP', talo: 'Talo' };

// Una fila (una plataforma de un día) → líneas de reporte. Suma a los contadores.
function lineasDeFila(f, cont) {
  const plat = NOMBRE_PLAT[f.plataforma] || f.plataforma;
  const out = [];
  if (f.veredicto === 'ok') {
    cont.ok++;
    const nota = f.n_aviso ? ` (${f.n_aviso} aviso menor)` : '';
    out.push(`   🟢 <b>${plat}</b>: cerró — ${f.n_pares} apareadas${nota}`);
  } else {
    cont.conDif++;
    const sinAparear = (f.n_solo_mp || 0) + (f.n_solo_sistema || 0);
    out.push(`   🔴 <b>${plat}</b>: ${sinAparear} sin aparear · dif ${fmt(f.diferencia)}`);
    const hs = Array.isArray(f.huerfanas) ? f.huerfanas : [];
    for (const h of hs.slice(0, MAX_HUERFANAS_DIA)) out.push(lineaHuerfana(h));
    if (hs.length > MAX_HUERFANAS_DIA) out.push(`      <i>…y ${hs.length - MAX_HUERFANAS_DIA} más (ver el arqueo de ese día)</i>`);
  }
  return out;
}

// formatearResumenSemanal({ desde, hasta, filas }) -> { titulo, lineas, stats }
//   filas: lo que devuelve conciliacionesDeRango() — 0..N por día (una POR PLATAFORMA). Un día
//   sin ninguna fila = no se arqueó. ok/conDif cuentan plataforma-días; sinCorrer cuenta días.
function formatearResumenSemanal({ desde, hasta, filas }) {
  const porFecha = new Map();
  for (const f of filas) {
    if (!porFecha.has(f.fecha)) porFecha.set(f.fecha, []);
    porFecha.get(f.fecha).push(f);
  }
  const dias = diasDelRango(desde, hasta);

  const titulo = `📆 <b>Resumen semanal — Control de cobros (Mercado Pago + Talo)</b>\nSemana del ${ddmm(desde)} al ${ddmm(hasta)}`;
  const lineas = [];
  const cont = { ok: 0, conDif: 0, sinCorrer: 0 };

  for (const iso of dias) {
    const nombre = DIA[isoADate(iso).getDay()];
    const etiqueta = `<b>${nombre} ${ddmm(iso)}</b>`;
    const rows = (porFecha.get(iso) || []).slice().sort((a, b) => String(a.plataforma).localeCompare(String(b.plataforma)));
    if (!rows.length) {
      cont.sinCorrer++;
      lineas.push(`⚪ ${etiqueta}: <i>no se arqueó</i>`);
      continue;
    }
    lineas.push(etiqueta);
    for (const f of rows) lineas.push(...lineasDeFila(f, cont));
  }

  const resumen = [];
  if (cont.ok) resumen.push(`🟢 ${cont.ok} cerraron`);
  if (cont.conDif) resumen.push(`🔴 ${cont.conDif} con diferencias`);
  if (cont.sinCorrer) resumen.push(`⚪ ${cont.sinCorrer} día(s) sin arqueo`);
  lineas.push('');
  lineas.push(resumen.length ? resumen.join(' · ') : 'Sin datos de la semana.');
  if (cont.conDif === 0 && cont.sinCorrer === 0) lineas.push('✅ La semana cerró completa y sin diferencias.');

  return { titulo, lineas, stats: cont };
}

module.exports = { semanaAnterior, formatearResumenSemanal, diasDelRango };
