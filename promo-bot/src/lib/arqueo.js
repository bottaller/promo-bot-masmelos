// Núcleo del ARQUEO DE COBROS (MP + Talo), extraído del wizard /mp para poder correrlo SIN
// Telegram: lo usa el barrido de las 08:00 (entrega-arqueo.js). Mismo criterio que
// completar-cierre.js (que sacó el núcleo de /cierre): parte pura, testeable, sin ctx.
//
// Cruza cada liquidación de plataforma contra el libro del día (una cuenta contable por
// plataforma) operación por operación, marca lo que no cierra, y devuelve TODO lo necesario para
// entregar: el texto, UN PDF POR PLATAFORMA, y lo que hay que guardar en bot.mp_conciliacion.
//
// Los avisos que el wizard mandaba como mensajes sueltos (export multi-día recortado, rangos que
// no se pisan del todo, libro cargado antes de terminar los cobros) se pliegan acá dentro del
// texto: en un barrido automático no hay con quién chatear.
const { parsearMayor, MayorError } = require('./mayor-excel');
const { conciliarMP } = require('./conciliacion-mp');
const { formatearArqueo } = require('./reporte-mp');
const { construirInformePDF } = require('./informe-mp-pdf');
const { fechaISO, formatoVencimiento, fechaHoraArgDe } = require('./fechas');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function isoADate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function isoALinda(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
// 'DD/MM/AAAA' o 'DD/MM/AAAA al DD/MM/AAAA' según el rango cubra uno o varios días.
function textoRango(desde, hasta) {
  const d = formatoVencimiento(desde);
  const h = formatoVencimiento(hasta);
  return d === h ? d : `${d} al ${h}`;
}

// Los dos archivos (libro y liquidación) tienen que hablar del mismo día, si no el control es un
// sinsentido. Devuelve { error } si no se pisan, { aviso } si se pisan solo en parte, {} si ok.
function chequearRangos({ mayor, operaciones }) {
  const diasMp = [...new Set(operaciones.map((o) => (o.hora || '').slice(0, 10)).filter(Boolean))].sort();
  if (!diasMp.length) return {};
  const desde = fechaISO(mayor.desde);
  const hasta = fechaISO(mayor.hasta);
  const rangoMp = diasMp.length === 1
    ? isoALinda(diasMp[0])
    : `${isoALinda(diasMp[0])} al ${isoALinda(diasMp[diasMp.length - 1])}`;
  const rangoSis = textoRango(mayor.desde, mayor.hasta);
  if (!diasMp.some((d) => d >= desde && d <= hasta)) {
    return { error: `el export del sistema es del ${rangoSis} y la liquidación es del ${rangoMp}: no son del mismo día` };
  }
  if (desde < diasMp[0] || hasta > diasMp[diasMp.length - 1]) {
    return { aviso: `el export del sistema abarca ${rangoSis} y la liquidación solo ${rangoMp}; los días que no estén en los dos aparecen como diferencias` };
  }
  return {};
}

// Recorta el mayor al día que se concilia. Los movimientos SÍ se filtran (gobiernan el apareo
// 1:1); otrasCuentas NO (el rastreo cross-día busca el faltante en otras cuentas otro día).
function acotarAlDia(mayor, dia) {
  if (!dia || fechaISO(mayor.desde) === fechaISO(mayor.hasta)) return { ok: true, mayor, recortado: false };
  const delDia = mayor.movimientos.filter((m) => fechaISO(m.fecha) === dia);
  if (delDia.length === 0) return { ok: false };
  const fechas = delDia.map((m) => m.fecha).sort((a, b) => a - b);
  return {
    ok: true, recortado: true,
    mayor: { ...mayor, movimientos: delDia, desde: fechas[0], hasta: fechas[fechas.length - 1] },
  };
}

// Concilia una plataforma contra el libro del día. Devuelve { resultado } o { problema } (texto).
function arquearPlataforma({ plataforma, liq, libroBuffer, dia }) {
  const avisos = [];
  let mayor;
  try {
    mayor = parsearMayor(libroBuffer, { cuentaId: plataforma.cuenta });
  } catch (e) {
    if (!(e instanceof MayorError)) throw e;
    // Esa cuenta no tiene movimientos en el libro: NO es un error, significa que todo lo que
    // cobró la plataforma quedó sin asentar, y eso es justo lo que hay que mostrar.
    mayor = {
      origen: 'diario', cuenta: plataforma.cuentaNombre, movimientos: [], otrasCuentas: [],
      desde: isoADate(dia), hasta: isoADate(dia),
    };
  }
  const acot = acotarAlDia(mayor, dia);
  const mayorDia = acot.ok ? acot.mayor : { ...mayor, movimientos: [] };
  if (acot.recortado) {
    avisos.push(`📌 ${plataforma.nombre}: el export cubría varios días, me quedé con los ${mayorDia.movimientos.length} del ${isoALinda(dia)}.`);
  }
  const rangos = chequearRangos({ mayor: mayorDia, operaciones: liq.operaciones });
  if (rangos.error) return { problema: `⚠️ ${plataforma.nombre}: no lo pude arquear — ${rangos.error}. La salteo.` };
  if (rangos.aviso) avisos.push(`⚠️ ${plataforma.nombre}: ${rangos.aviso}.`);

  const resultado = {
    plataforma,
    cuenta: mayorDia.cuenta || plataforma.cuentaNombre,
    mayor: mayorDia,
    resultado: conciliarMP({
      movimientos: mayorDia.movimientos,
      operaciones: liq.operaciones,
      otrasCuentas: mayor.otrasCuentas,
      plataforma,
    }),
  };
  return { resultado, avisos };
}

// Aviso "libro cargado antes de terminar los cobros": si el libro se archivó a las 16:00 pero hay
// cobros hasta las 17:30, faltan asientos de esa franja y saldrían decenas de falsos "no asentado".
function avisoLibroTemprano(libroMeta, operaciones) {
  if (!libroMeta || !libroMeta.cargado_en) return null;
  const horas = operaciones.map((o) => o.hora).filter(Boolean).sort();
  const ultima = horas.length ? horas[horas.length - 1] : null; // 'AAAA-MM-DD HH:MM:SS' (hora de pared)
  const cargadoArg = fechaHoraArgDe(libroMeta.cargado_en);
  if (cargadoArg && ultima && `${cargadoArg.iso} ${cargadoArg.hhmm}` < ultima.slice(0, 16)) {
    return `⚠️ Ojo: el libro se cargó a las <b>${cargadoArg.hhmm}</b> y hay cobros hasta las <b>${ultima.slice(11, 16)}</b>. Si ves muchas diferencias, puede faltar la cola de la tarde: recargá el libro con un export fresco.`;
  }
  return null;
}

// Arquea un día completo (todas sus plataformas) contra el libro. PURO (sin Telegram / sin base).
//   liquidaciones: [{ plataforma, liq }]  (liq ya parseada, con .operaciones)
//   dia: 'AAAA-MM-DD' (todas las liquidaciones tienen que ser de ese día)
//   libroBuffer: el .xlsx crudo del libro que cubre el día
//   libroMeta: metadata del libro (para la línea de origen y el aviso de "libro temprano")
// Devuelve:
//   { ok:true, dia, resultados, texto, pdfs:[{plataforma, corto, buffer, filename}], paraGuardar }
//   { ok:false, error }  (si NINGUNA plataforma se pudo arquear)
async function arquearDia({ libroBuffer, libroMeta = null, liquidaciones, dia }) {
  const resultados = [];
  const avisos = [];
  const problemas = [];

  for (const { plataforma, liq } of liquidaciones) {
    const r = arquearPlataforma({ plataforma, liq, libroBuffer, dia });
    if (r.problema) { problemas.push(r.problema); continue; }
    resultados.push(r.resultado);
    if (r.avisos && r.avisos.length) avisos.push(...r.avisos);
  }

  if (resultados.length === 0) {
    return { ok: false, error: problemas.join('\n') || 'No pude arquear ninguna plataforma.' };
  }

  const mayor0 = resultados[0].mayor;
  const fecha = textoRango(mayor0.desde, mayor0.hasta);
  const todasLasOperaciones = liquidaciones.flatMap((x) => x.liq.operaciones);

  const temprano = avisoLibroTemprano(libroMeta, todasLasOperaciones);
  if (temprano) avisos.push(temprano);

  // Texto: el arqueo de todas las plataformas + la línea de origen del libro + los avisos plegados.
  const LM = require('./libro-mensajes');
  const partes = [
    formatearArqueo({ fecha, origen: mayor0.origen, resultados }),
    '',
    `<i>${LM.esc(LM.lineaOrigen(libroMeta))}</i>`,
  ];
  if (problemas.length) partes.push('', ...problemas);
  if (avisos.length) partes.push('', ...avisos);
  const texto = partes.join('\n');

  // UN PDF POR PLATAFORMA (MP y Talo separados). Cada uno con su sección sola.
  const pdfs = [];
  for (const x of resultados) {
    try {
      const buffer = await construirInformePDF({ fecha, resultados: [x], usuario: 'Barrido automático 08:00' });
      const suf = fechaISO(mayor0.desde) === fechaISO(mayor0.hasta)
        ? fechaISO(mayor0.desde)
        : `${fechaISO(mayor0.desde)}_${fechaISO(mayor0.hasta)}`;
      pdfs.push({
        plataforma: x.plataforma.codigo,
        corto: x.plataforma.corto,
        buffer,
        filename: `arqueo_${x.plataforma.corto}_${suf}.pdf`,
      });
    } catch (e) {
      console.error(`arquearDia: no pude armar el PDF de ${x.plataforma.codigo}:`, e.message);
    }
  }

  // Lo que hay que persistir en bot.mp_conciliacion (una fila por plataforma) → resumen semanal.
  const paraGuardar = resultados.map((x) => ({
    fecha: x.mayor.desde,
    plataforma: x.plataforma.codigo,
    resultado: x.resultado,
    fuente: x.mayor.origen,
  }));

  return { ok: true, dia, resultados, texto, pdfs, paraGuardar };
}

module.exports = { arquearDia, chequearRangos, acotarAlDia, textoRango };
