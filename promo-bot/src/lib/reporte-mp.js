// Salida de la conciliación de Mercado Pago (/mp): el mensaje de Telegram (HTML).
// Recibe el resultado YA calculado por conciliacion-mp.js.
//
// Criterio, igual que reporte-cierre.js: primero lo que hay que revisar, después lo sano.
// Todo reporte lleva la fecha de generación (ver docs/convenciones.md).
const { fechaHoyArg } = require('./fechas');

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

// Cuántos ítems como mucho se listan en el chat. Telegram corta a los 4096 caracteres, así
// que un día con MUCHAS huérfanas no puede tumbar el mensaje: se listan las primeras y se
// dice cuántas más hubo (el titular ya trae el total). El dato crudo siempre está en la
// liquidación que se subió.
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

// Una contrapartida rastreada (dónde más aparece ese importe en el libro), en una línea.
// El orden Haber → Debe cuenta la historia: de dónde salió la plata y adónde fue.
// Ej.: 'CAJA 4 MORENO → DESVIO DE CAJA · "faltante caja 4 camila 11-7" · 17:21 · LATERZAFLOR'
function textoContrapartida(c) {
  const cuentas = [...c.renglones]
    .sort((a, b) => (b.haber - b.debe) - (a.haber - a.debe))
    .map((g) => g.cuenta)
    .join(' → ');
  const partes = [cuentas];
  if (c.concepto) partes.push(`"${c.concepto}"`);
  partes.push(hora(c.ingreso));
  if (c.usuario) partes.push(c.usuario);
  return partes.join(' · ');
}

// Las líneas de contrapartida de una huérfana (vacío si no se rastreó o no hubo hallazgo).
function lineasContrapartida(x) {
  return (x.contrapartidas || []).map(
    (c) => `   ↳ <i>aparece en:</i> ${escapeHtml(textoContrapartida(c))}`
  );
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
  // Las diferencias de redondeo son ruido contable: NO se listan una por una, solo el total.
  // (Las de HORA sí se muestran más abajo: un asiento cargado lejos del cobro puede ser un problema.)
  const soloRedondeo = pares.filter((p) => p.nivel === 'aviso' && !p.avisos.includes('hora'));
  if (soloRedondeo.length) {
    const totalRedondeo = soloRedondeo.reduce((a, p) => a + p.dif, 0);
    L.push(`🟡 ${soloRedondeo.length} por redondeo · ${fmtC(totalRedondeo)}`);
  }
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
      L.push(...lineasContrapartida(o));
    }
    if (soloMp.length > MAX_LISTA) L.push(`<i>…y ${soloMp.length - MAX_LISTA} más.</i>`);
  }

  // Lo que está mal al revés: asentado y MP no lo tiene.
  if (soloSistema.length) {
    L.push('');
    L.push(`🔴 <b>Asentado y MP no lo tiene</b> — ${soloSistema.length} · ${fmt(r.totalSoloSistema)}`);
    for (const m of soloSistema.slice(0, MAX_LISTA)) {
      L.push(`• ${hora(m.ingreso)} · <b>${fmt(m.debe)}</b> · ${escapeHtml(m.comprobante || 'asiento ' + m.asiento)} · ${escapeHtml(m.cliente)} (${escapeHtml(m.usuario)})`);
      L.push(...lineasContrapartida(m));
    }
    if (soloSistema.length > MAX_LISTA) L.push(`<i>…y ${soloSistema.length - MAX_LISTA} más.</i>`);
  }

  // Si hay huérfanas y NO se pudo rastrear (mandaron el Mayor, que trae una sola cuenta),
  // decirlo: con el Diario el bot puede indicar en qué otra cuenta quedó imputado el importe.
  if ((soloMp.length || soloSistema.length) && !r.rastreo) {
    L.push('');
    L.push('<i>💡 Mandame el "Diario de movimientos" (en vez del Mayor) y te digo si ese importe aparece en otra cuenta — ej.: como faltante de una caja.</i>');
  }

  // Apareadas con la HORA corrida: sí se listan (el importe coincide pero el asiento se
  // cargó lejos del cobro → conviene mirarlo). El redondeo ya se resumió arriba.
  const avisoHora = pares.filter((p) => p.nivel === 'aviso' && p.avisos.includes('hora'));
  if (avisoHora.length) {
    L.push('');
    L.push(`🟡 <b>Apareadas con la hora corrida</b> — ${avisoHora.length}`);
    for (const p of avisoHora.slice(0, MAX_LISTA)) {
      L.push(`• ${hora(p.op.hora)} · ${fmt(p.op.bruto)} · ${escapeHtml(textoAvisos(p))} · ${escapeHtml(p.mov.cliente)}`);
    }
    if (avisoHora.length > MAX_LISTA) L.push(`<i>…y ${avisoHora.length - MAX_LISTA} más.</i>`);
  }

  // Fuera de alcance: se listan para que quede claro que NO se ignoraron en silencio, PERO
  // las salidas de dinero (importe negativo: Mercado Libre, devoluciones) no van al mensaje —
  // no son ventas por QR y ensucian el control. Los Haber (salidas de MP al banco) tampoco.
  // Su dato crudo sigue en la liquidación que se subió.
  const grupos = agruparPorMotivo(fuera.mp.filter((o) => o.bruto >= 0), (o) => o.bruto);
  if (grupos.length) {
    L.push('');
    L.push('<b>Fuera de alcance</b> <i>(no pasan por esta cuenta)</i>');
    for (const g of grupos) L.push(`• ${escapeHtml(g.motivo)}: ${g.n} · ${fmt(g.total)}`);
  }

  return L.join('\n');
}

module.exports = { formatearMP };
