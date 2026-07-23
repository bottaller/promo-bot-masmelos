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
    if (tipo === 'centavos') return `diferencia de ${fmtC(Math.abs(p.dif))} en centavos (misma venta)`;
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

// En el CHAT se muestra una sola contrapartida por huérfana (la más probable): son líneas
// largas y con varias huérfanas el mensaje se pasa del tope de Telegram. El resto va al PDF.
const MAX_CONTRAPARTIDAS_MSG = 1;

// Las líneas de contrapartida de una huérfana (vacío si no se rastreó o no hubo hallazgo).
function lineasContrapartida(x) {
  const todas = x.contrapartidas || [];
  const lineas = todas.slice(0, MAX_CONTRAPARTIDAS_MSG).map(
    (c) => `   ↳ <i>aparece en:</i> ${escapeHtml(textoContrapartida(c))}`
  );
  const resto = todas.length - MAX_CONTRAPARTIDAS_MSG;
  if (resto > 0) lineas.push(`   <i>(ese importe está en ${resto} asiento(s) más)</i>`);
  return lineas;
}

// Tope duro de Telegram. Si un mensaje se pasa, la API lo RECHAZA entero y el control no
// llega — peor que recortarlo. Como las secciones están ordenadas por importancia (titular,
// totales, 🔴, 🟡, fuera de alcance), recortar desde el final descarta primero lo menos
// importante. Nunca se recorta en silencio: se avisa y el PDF va completo igual.
const TOPE_TELEGRAM = 4096;

function unirRecortando(L) {
  const texto = L.join('\n');
  if (texto.length <= TOPE_TELEGRAM) return texto;
  const nota = '\n<i>✂️ Mensaje recortado (tope de Telegram) — el detalle completo está en el PDF.</i>';
  const limite = TOPE_TELEGRAM - nota.length;
  let acc = '';
  for (const linea of L) {
    const siguiente = acc ? `${acc}\n${linea}` : linea;
    if (siguiente.length > limite) break;
    acc = siguiente;
  }
  return acc + nota;
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

// Las líneas del arqueo de UNA plataforma. `seccion:true` la prepara para ir dentro de un
// reporte multi-plataforma (encabezado corto, sin la línea "Generado", que va una sola vez
// arriba de todo). `plataforma` es el descriptor (plataformas.js); si no viene, Mercado Pago.
function lineasPlataforma({ fecha, cuenta, resultado, origen = 'mayor', plataforma = null, seccion = false,
  maxLista = MAX_LISTA }) {
  const { pares, soloSistema, soloMp, fuera, resumen: r } = resultado;
  const nombre = (plataforma && plataforma.nombre) || 'Mercado Pago';
  // En el CUERPO se repite en cada renglón: va el nombre corto (MP, Talo) para no inflar el
  // mensaje, que tiene tope de 4096. El largo queda para el encabezado.
  const corto = (plataforma && plataforma.corto) || 'MP';
  const alcance = (plataforma && plataforma.alcanceTxt) || 'QR / transferencia';
  const L = [];
  if (seccion) {
    L.push(`🔎 <b>${escapeHtml(nombre)}</b> — ${escapeHtml(cuenta)}`);
  } else {
    L.push(`🔎 <b>Conciliación ${escapeHtml(nombre)}</b> — ${escapeHtml(cuenta)} · ${fecha}`);
    L.push(`<i>Generado: ${fechaHoyArg()} · fuente: ${origen === 'mayor' ? 'Mayor de cuenta' : 'Diario de movimientos'}</i>`);
  }
  L.push('');

  // El titular: ¿aparea todo o no?
  if (!soloSistema.length && !soloMp.length) {
    L.push(`🟢 <b>Aparea todo</b>: ${r.nPares} cobranzas ↔ ${r.nPares} operaciones (${escapeHtml(alcance)}).`);
  } else {
    L.push(`🔴 <b>Hay ${soloSistema.length + soloMp.length} sin aparear</b> — ${r.nPares} de ${Math.max(r.nSistema, r.nMp)} cerraron.`);
  }
  // Las diferencias de centavos (redondeo ≤ $0,05 o el rescate de la misma venta con IVA/POS
  // vs MP) son ruido contable: NO se listan una por una, solo el total. Las de HORA sí se
  // muestran más abajo: un asiento cargado lejos del cobro puede ser un problema.
  const soloCentavos = pares.filter((p) => p.nivel === 'aviso' && !p.avisos.includes('hora'));
  if (soloCentavos.length) {
    const total = soloCentavos.reduce((a, p) => a + p.dif, 0);
    L.push(`🟡 ${soloCentavos.length} con diferencia de centavos · ${fmtC(total)}`);
  }
  L.push('');

  // Totales.
  L.push(`<b>Totales (${escapeHtml(alcance)})</b>`);
  L.push(`Sistema: <b>${fmt(r.totalSistema)}</b> · ${escapeHtml(corto)}: <b>${fmt(r.totalMp)}</b> · dif: <b>${fmtC(r.diferencia)}</b>`);
  L.push(`${escapeHtml(corto)} acredita <b>${fmt(r.neto)}</b> — comisión ${fmt(Math.abs(r.comision))} + impuestos ${fmt(Math.abs(r.impuestos))}`);

  // Lo que está mal: cobros de la plataforma sin asiento (entró plata y no se registró).
  if (soloMp.length) {
    L.push('');
    L.push(`🔴 <b>Cobró ${escapeHtml(corto)} y no está asentado</b> — ${soloMp.length} · ${fmt(r.totalSoloMp)}`);
    for (const o of soloMp.slice(0, maxLista)) {
      // Cómo se identifica la operación depende de la plataforma: MP tiene un id estable,
      // Talo casi nunca (pero trae el titular). Lo resuelve el descriptor.
      const ref = plataforma && plataforma.referencia ? plataforma.referencia(o) : `id ${o.source_id || ''}`;
      const partes = [hora(o.hora), `<b>${fmt(o.bruto)}</b>`];
      if (o.instrumento) partes.push(escapeHtml(instrumento(o)));
      if (ref) partes.push(escapeHtml(ref));
      L.push(`• ${partes.join(' · ')}`);
      L.push(...lineasContrapartida(o));
    }
    if (soloMp.length > maxLista) L.push(`<i>…y ${soloMp.length - maxLista} más.</i>`);
  }

  // Lo que está mal al revés: asentado y la plataforma no lo tiene.
  if (soloSistema.length) {
    L.push('');
    L.push(`🔴 <b>Asentado y ${escapeHtml(corto)} no lo tiene</b> — ${soloSistema.length} · ${fmt(r.totalSoloSistema)}`);
    for (const m of soloSistema.slice(0, maxLista)) {
      L.push(`• ${hora(m.ingreso)} · <b>${fmt(m.debe)}</b> · ${escapeHtml(m.comprobante || 'asiento ' + m.asiento)} · ${escapeHtml(m.cliente)} (${escapeHtml(m.usuario)})`);
      L.push(...lineasContrapartida(m));
    }
    if (soloSistema.length > maxLista) L.push(`<i>…y ${soloSistema.length - maxLista} más.</i>`);
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
    for (const p of avisoHora.slice(0, maxLista)) {
      L.push(`• ${hora(p.op.hora)} · ${fmt(p.op.bruto)} · ${escapeHtml(textoAvisos(p))} · ${escapeHtml(p.mov.cliente)}`);
    }
    if (avisoHora.length > maxLista) L.push(`<i>…y ${avisoHora.length - maxLista} más.</i>`);
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

  return L;
}

// Arqueo de UNA plataforma (compatibilidad: lo que se usaba cuando solo existía /mp).
function formatearMP({ fecha, cuenta, resultado, origen = 'mayor', plataforma = null }) {
  return unirRecortando(lineasPlataforma({ fecha, cuenta, resultado, origen, plataforma }));
}

// Arqueo de VARIAS plataformas en un solo mensaje: un titular global y una sección por
// plataforma. `resultados` = [{ plataforma, cuenta, resultado }].
function formatearArqueo({ fecha, origen = 'mayor', resultados }) {
  const conProblema = resultados.filter((x) => x.resultado.soloSistema.length || x.resultado.soloMp.length);
  const L = [];
  L.push(`📊 <b>Arqueo de cobros</b> — ${fecha}`);
  L.push(`<i>Generado: ${fechaHoyArg()} · fuente: ${origen === 'mayor' ? 'Mayor de cuenta' : 'Diario de movimientos'}</i>`);
  L.push('');
  if (!resultados.length) {
    L.push('No recibí ninguna liquidación para conciliar.');
    return unirRecortando(L);
  }
  // Titular global: lo primero que se lee es si el día cerró o no, sin importar cuántas
  // plataformas haya.
  if (!conProblema.length) {
    const total = resultados.reduce((a, x) => a + x.resultado.resumen.nPares, 0);
    L.push(`🟢 <b>Cerró todo</b> — ${resultados.length} plataforma(s), ${total} cobranzas apareadas.`);
  } else {
    const sinAparear = conProblema.reduce(
      (a, x) => a + x.resultado.soloSistema.length + x.resultado.soloMp.length, 0);
    L.push(`🔴 <b>${sinAparear} sin aparear</b> en ${conProblema.length} de ${resultados.length} plataforma(s).`);
  }
  // Con varias plataformas el mensaje se duplica y el tope de Telegram se alcanza enseguida:
  // se listan menos ítems por sección para que ninguna quede recortada de entrada.
  const maxLista = resultados.length > 1 ? 4 : MAX_LISTA;
  for (const x of resultados) {
    L.push('');
    L.push('━━━━━━━━━━━━━━━');
    L.push(...lineasPlataforma({ ...x, fecha, origen, seccion: true, maxLista }));
  }
  return unirRecortando(L);
}

module.exports = { formatearMP, formatearArqueo, lineasPlataforma };
