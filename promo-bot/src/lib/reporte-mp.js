// Salida de la conciliación de Mercado Pago (/mp): el mensaje de Telegram (HTML) y el Excel
// con el detalle. Recibe el resultado YA calculado por conciliacion-mp.js.
//
// Criterio, igual que reporte-cierre.js: primero lo que hay que revisar, después lo sano.
// Todo reporte lleva la fecha de generación (ver docs/convenciones.md).
const XLSX = require('xlsx');
const { fechaHoyArg } = require('./fechas');

const ICONO = { ok: '🟢', aviso: '🟡', alerta: '🔴' };

// Nombre del instrumento tal como lo escribe MP -> castellano.
const INSTRUMENTO = {
  available_money: 'dinero en cuenta',
  'Bank transfer': 'transferencia',
  'Credit card': 'crédito',
  'Debit card': 'débito',
  prepaid_card: 'prepaga',
};
function instrumento(op) {
  return INSTRUMENTO[op.instrumento] || op.instrumento || '(sin dato)';
}

// Cuántos ítems como mucho se listan en el chat (el resto está en el Excel). Telegram corta
// a los 4096 caracteres: un día con muchas huérfanas no puede tumbar el mensaje.
const MAX_LISTA = 8;

const _NF0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const _NF2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Monto redondeado a peso, con signo. Para los totales.
function fmt(n) {
  if (n == null) return '—';
  return `${n < 0 ? '−' : ''}$${_NF0.format(Math.abs(Math.round(n)))}`;
}
// Monto con centavos. Para las diferencias de redondeo, donde el centavo ES el dato.
function fmtC(n) {
  if (n == null) return '—';
  return `${n < 0 ? '−' : ''}$${_NF2.format(Math.abs(n))}`;
}
// 'AAAA-MM-DD HH:MM:SS' -> 'HH:MM'
function hora(ts) {
  return ts ? ts.slice(11, 16) : '—';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Los avisos de un par apareado, de tipo (conciliacion-mp.js) a texto. El dato duro (la
// diferencia, los segundos) vive en el par; acá se le da formato.
function textoAvisos(p) {
  return p.avisos.map((tipo) => {
    if (tipo === 'redondeo') return `diferencia de ${fmtC(Math.abs(p.dif))} por redondeo`;
    if (tipo === 'hora') {
      const min = Math.round(Math.abs(p.delta) / 60);
      return `el asiento se cargó ${min} min ${p.delta < 0 ? 'ANTES' : 'después'} del cobro`;
    }
    return tipo;
  }).join('; ');
}

// Agrupa las filas fuera de alcance por motivo: {motivo, n, total}[]
function agruparPorMotivo(filas, monto) {
  const g = new Map();
  for (const f of filas) {
    const e = g.get(f.motivo) || { motivo: f.motivo, n: 0, total: 0 };
    e.n++;
    e.total += monto(f);
    g.set(f.motivo, e);
  }
  return [...g.values()].sort((a, b) => b.n - a.n);
}

// formatearMP({fecha, cuenta, resultado, origen}) -> string HTML para Telegram
function formatearMP({ fecha, cuenta, resultado, origen = 'mayor' }) {
  const { pares, soloSistema, soloMp, fuera, resumen: r } = resultado;
  const L = [];
  L.push(`🔎 <b>Conciliación Mercado Pago</b> — ${escapeHtml(cuenta)} · ${fecha}`);
  L.push(`<i>Generado: ${fechaHoyArg()} · fuente: ${origen === 'mayor' ? 'Mayor de cuenta' : 'Diario de movimientos'}</i>`);
  L.push('');

  // El titular: ¿aparea todo o no?
  if (!soloSistema.length && !soloMp.length) {
    L.push(`🟢 <b>Aparea todo</b>: ${r.nPares} cobranzas ↔ ${r.nPares} operaciones de MP (QR/transferencia).`);
  } else {
    L.push(`🔴 <b>Hay ${soloSistema.length + soloMp.length} sin aparear</b> — ${r.nPares} de ${Math.max(r.nSistema, r.nMp)} cerraron.`);
  }
  if (r.nAviso) L.push(`🟡 ${r.nAviso} apareada(s) con aviso (ver abajo).`);
  L.push('');

  // Totales.
  L.push('<b>Totales (QR / transferencia)</b>');
  L.push(`Sistema: <b>${fmt(r.totalSistema)}</b> · MP: <b>${fmt(r.totalMp)}</b> · dif: <b>${fmtC(r.diferencia)}</b>`);
  L.push(`MP acredita <b>${fmt(r.neto)}</b> — comisión ${fmt(Math.abs(r.comision))} + impuestos ${fmt(Math.abs(r.impuestos))}`);

  // Lo que está mal: operaciones de MP sin asiento (entró plata y no se registró).
  if (soloMp.length) {
    L.push('');
    L.push(`🔴 <b>Cobró MP y no está asentado</b> — ${soloMp.length} · ${fmt(r.totalSoloMp)}`);
    for (const o of soloMp.slice(0, MAX_LISTA)) {
      L.push(`• ${hora(o.hora)} · <b>${fmt(o.bruto)}</b> · ${escapeHtml(instrumento(o))} · id ${escapeHtml(o.source_id)}`);
    }
    if (soloMp.length > MAX_LISTA) L.push(`<i>…y ${soloMp.length - MAX_LISTA} más (están en el Excel).</i>`);
  }

  // Lo que está mal al revés: asentado y MP no lo tiene.
  if (soloSistema.length) {
    L.push('');
    L.push(`🔴 <b>Asentado y MP no lo tiene</b> — ${soloSistema.length} · ${fmt(r.totalSoloSistema)}`);
    for (const m of soloSistema.slice(0, MAX_LISTA)) {
      L.push(`• ${hora(m.ingreso)} · <b>${fmt(m.debe)}</b> · ${escapeHtml(m.comprobante || 'asiento ' + m.asiento)} · ${escapeHtml(m.cliente)} (${escapeHtml(m.usuario)})`);
    }
    if (soloSistema.length > MAX_LISTA) L.push(`<i>…y ${soloSistema.length - MAX_LISTA} más (están en el Excel).</i>`);
  }

  // Avisos (redondeo / hora rara): apareó, pero conviene verlo.
  const conAviso = pares.filter((p) => p.nivel === 'aviso');
  if (conAviso.length) {
    L.push('');
    L.push(`🟡 <b>Apareadas con aviso</b> — ${conAviso.length}`);
    for (const p of conAviso.slice(0, MAX_LISTA)) {
      L.push(`• ${hora(p.op.hora)} · ${fmt(p.op.bruto)} · ${escapeHtml(textoAvisos(p))} · ${escapeHtml(p.mov.cliente)}`);
    }
    if (conAviso.length > MAX_LISTA) L.push(`<i>…y ${conAviso.length - MAX_LISTA} más (están en el Excel).</i>`);
  }

  // Fuera de alcance: se listan para que quede claro que NO se ignoraron en silencio.
  const grupos = agruparPorMotivo(fuera.mp, (o) => o.bruto);
  if (grupos.length) {
    L.push('');
    L.push('<b>Fuera de alcance</b> <i>(no pasan por esta cuenta)</i>');
    for (const g of grupos) L.push(`• ${escapeHtml(g.motivo)}: ${g.n} · ${fmt(g.total)}`);
  }
  if (fuera.sistema.length) {
    L.push('');
    L.push(`<b>Movimientos del sistema que no son cobranzas</b>: ${fuera.sistema.length} · ${fmt(r.totalFueraSistema)}`);
  }

  L.push('');
  L.push('📎 El detalle operación por operación va en el Excel.');
  return L.join('\n');
}

// --- Excel -----------------------------------------------------------------
const COLS = [
  'Estado', 'Detalle', 'Hora pago', 'Hora asiento', 'Seg.', 'Asiento', 'Caja', 'Usuario',
  'Cliente', 'Comprobante', 'Debe (sistema)', 'Source ID', 'Instrumento', 'Bruto (MP)',
  'Comisión', 'Impuestos', 'Neto MP', 'Dif.',
];

function filaPar(p) {
  return [
    p.nivel === 'ok' ? 'OK' : 'Aviso',
    textoAvisos(p),
    hora(p.op.hora), hora(p.mov.ingreso), p.delta === null ? '' : p.delta,
    p.mov.asiento, p.mov.comp, p.mov.usuario, p.mov.cliente, p.mov.comprobante,
    p.mov.debe, p.op.source_id, instrumento(p.op), p.op.bruto,
    p.op.comision, p.op.impuestos, p.op.neto, p.dif,
  ];
}
function filaSoloSistema(m) {
  return [
    'SIN OPERACIÓN EN MP', 'Está asentado y MP no lo tiene',
    '', hora(m.ingreso), '', m.asiento, m.comp, m.usuario, m.cliente, m.comprobante,
    m.debe, '', '', '', '', '', '', '',
  ];
}
function filaSoloMp(o) {
  return [
    'SIN ASIENTO', 'Cobró MP y no está registrado en el sistema',
    hora(o.hora), '', '', '', '', '', '', '',
    '', o.source_id, instrumento(o), o.bruto, o.comision, o.impuestos, o.neto, '',
  ];
}

// construirExcelMP({fecha, cuenta, resultado}) -> Buffer .xlsx
// Hoja 1 "Conciliación": lo que está mal arriba, lo sano abajo.
// Hoja 2 "Fuera de alcance": lo que NO se concilió, con el motivo (nada se descarta en silencio).
function construirExcelMP({ fecha, cuenta, resultado }) {
  const { pares, soloSistema, soloMp, fuera, resumen: r } = resultado;

  const filas = [
    ...soloMp.map(filaSoloMp),
    ...soloSistema.map(filaSoloSistema),
    ...pares.filter((p) => p.nivel === 'aviso').map(filaPar),
    ...pares.filter((p) => p.nivel === 'ok').map(filaPar),
  ];
  const total = ['TOTAL', '', '', '', '', '', '', '', '', '', r.totalSistema, '', '', r.totalMp,
    r.comision, r.impuestos, r.neto, r.diferencia];

  const aoa = [
    ['Conciliación Mercado Pago — operación por operación'],
    [`${cuenta} · ${fecha}`],
    [`Generado: ${fechaHoyArg()}`],
    [`${r.nPares} apareadas (${r.nOk} exactas, ${r.nAviso} con aviso) · ${r.nSoloMp} sin asiento · ${r.nSoloSistema} sin operación en MP`],
    ['Alcance: ventas cobradas por QR / transferencia. Point, Mercado Libre y demás van en la otra hoja.'],
    [],
    COLS,
    ...filas,
    total,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Conciliación');

  const aoaFuera = [
    ['Fuera de alcance — no se concilian contra esta cuenta'],
    [`Generado: ${fechaHoyArg()}`],
    [],
    ['Origen', 'Hora', 'Source ID / Asiento', 'Instrumento', 'Unidad', 'Canal', 'Importe', 'Motivo'],
    ...fuera.mp.map((o) => ['Mercado Pago', hora(o.hora), o.source_id, instrumento(o), o.unidad || '(vacío)', o.canal || '(vacío)', o.bruto, o.motivo]),
    ...fuera.sistema.map((m) => ['Sistema', hora(m.ingreso), m.asiento, '', '', '', m.debe - m.haber, m.motivo]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaFuera), 'Fuera de alcance');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { formatearMP, construirExcelMP };
