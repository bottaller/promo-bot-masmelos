// El texto de /pantalla: "¿está andando o no?", contestado en un mensaje.
//
// POR QUE EXISTE. Durante toda la puesta en marcha la única forma de saber si el
// sync estaba mandando era que alguien mirara la base o fuera hasta la PC de la
// sucursal. Eso no escala a la operación de todos los días: el que necesita la
// respuesta es quien está mirando la tele, y la necesita desde el teléfono.
//
// Se juntan las dos señales que ya existen, que responden preguntas distintas:
//   - el LATIDO dice si el script sigue vivo (memoria, se pierde en un redeploy),
//   - la BASE dice cuándo entró la última planilla (sobrevive a todo).
// Ninguna de las dos alcanza sola, y por eso el veredicto se arma con las dos.
const { ultimaPlanillaImportada, resumenDeHoy } = require('../db/retiros');
const canal = require('./canal-planilla');

// Mismos umbrales que el vigilante (aviso-planilla.js): si /pantalla dijera
// "todo bien" con criterios distintos a los que disparan el aviso, uno de los dos
// estaría mintiendo.
const MINUTOS_SIN_LATIDO = 20;
const LIMITE_HORAS = Number(process.env.PLANILLA_LIMITE_HORAS) > 0
  ? Number(process.env.PLANILLA_LIMITE_HORAS)
  : 3;

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function haceCuanto(ms) {
  if (!Number.isFinite(ms)) return 'nunca';
  const min = ms / 60000;
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `hace ${Math.round(h)} h`;
  return `hace ${Math.round(h / 24)} día(s)`;
}

function lindo(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/**
 * Arma el mensaje. PURA: recibe los datos ya leídos, así se puede probar sin
 * base ni bot.
 */
function armarMensaje({ latido, ultima, dias, ahora, minutosDespierto }) {
  const msLatido = latido ? (ahora.getTime() - latido.en.getTime()) : Infinity;
  const msPlanilla = ultima ? (ahora.getTime() - ultima.getTime()) : Infinity;
  const horasSinPlanilla = msPlanilla / 3600000;

  const hayLatido = !!latido;
  const latidoFresco = hayLatido && msLatido < MINUTOS_SIN_LATIDO * 60000;
  const datosFrescos = horasSinPlanilla < LIMITE_HORAS;

  // Recién reiniciado el bot todavía no llegó ningún latido, y eso NO dice nada
  // del sync. Sin este caso el veredicto acusaba al script cada vez que se
  // deployaba, que es exactamente la falsa alarma que ya salió una vez.
  const recienArrancado = !hayLatido && minutosDespierto < MINUTOS_SIN_LATIDO;

  const L = [];

  // El veredicto va PRIMERO y en una línea: es lo único que la mayoría va a leer.
  if (latidoFresco && datosFrescos) L.push('✅ <b>La pantalla está al día.</b>');
  else if (latidoFresco) L.push('🟡 <b>El sync anda, pero hace rato que nadie edita la planilla.</b>');
  else if (hayLatido) L.push('❌ <b>El sync dejó de reportar.</b>');
  else if (recienArrancado) {
    L.push(datosFrescos
      ? '✅ <b>La pantalla está al día.</b>'
      : '🟡 <b>Hace rato que no entra una planilla.</b>');
  } else if (datosFrescos) L.push('🟡 <b>Están entrando planillas, pero el sync no está reportando.</b>');
  else L.push('❌ <b>No entra la planilla y el sync no reporta.</b>');

  L.push('');
  L.push(`📥 Última planilla: <b>${haceCuanto(msPlanilla)}</b>`);

  if (latido) {
    const desde = latido.equipo ? ` desde ${escapeHtml(latido.equipo)}` : '';
    L.push(`📡 El sync reportó <b>${haceCuanto(msLatido)}</b>${desde}`);
    if (latido.estado && latido.estado !== 'ok') {
      L.push(`   ⚠️ y avisa un problema: ${escapeHtml(latido.motivo || latido.estado)}`);
    } else if (latido.fecha) {
      L.push(`   mirando "${escapeHtml(latido.archivo)}", guardada ${escapeHtml(latido.fecha)}`);
    }
  } else if (minutosDespierto < MINUTOS_SIN_LATIDO) {
    // Recién reiniciado el bot no hay latidos y eso NO significa nada malo.
    L.push('📡 El bot se reinició recién; el sync todavía no tuvo tiempo de reportar.');
  } else {
    L.push('📡 El sync <b>no está reportando</b>.');
  }

  L.push('');
  if (!dias || !dias.length) {
    L.push('La pantalla no tiene ningún pedido de hoy en adelante.');
  } else {
    L.push('<b>Lo que muestra la tele:</b>');
    for (const d of dias.slice(0, 4)) {
      const partes = [`${d.total} pedido(s)`];
      if (d.listos) partes.push(`${d.listos} listo(s)`);
      if (d.retirados) partes.push(`${d.retirados} retirado(s)`);
      L.push(`   📅 ${lindo(d.fecha)} — ${partes.join(' · ')}`);
    }
  }

  // Qué hacer, solo cuando hay algo que hacer.
  if (!latidoFresco && hayLatido) {
    L.push('');
    L.push('👉 En la PC de la sucursal: ¿está prendida y con la sesión iniciada? '
      + 'Si sí, doble clic en "MasMelos - Sync planilla" para reinstalarlo.');
  }

  return L.join('\n');
}

/** Lee todo y devuelve el mensaje listo para mandar. */
async function textoPantalla(ahora = new Date()) {
  const [ultima, dias] = await Promise.all([ultimaPlanillaImportada(), resumenDeHoy()]);
  return armarMensaje({
    latido: canal.ultimoLatido(),
    ultima,
    dias,
    ahora,
    minutosDespierto: canal.minutosDespierto(ahora),
  });
}

module.exports = { textoPantalla, armarMensaje, haceCuanto, MINUTOS_SIN_LATIDO, LIMITE_HORAS };
