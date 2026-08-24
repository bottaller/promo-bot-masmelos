// Vigilancia de la pantalla de recepción.
//
// La tele fallando sigue prendida mostrando los pedidos de ayer. Es la peor forma
// de fallar, porque parece que anda: nadie reporta nada y los clientes miran una
// pantalla que miente. Por eso hay alguien preguntando cada media hora.
//
// SE VIGILAN DOS COSAS DISTINTAS, y confundirlas fue un error real:
//
//   1. EL CANAL — ¿el script de la sucursal sigue vivo? Se sabe por el latido que
//      manda en cada vuelta (cada ~4 min), aunque no tenga nada que mandar.
//   2. LOS DATOS — ¿alguien está actualizando la planilla? Se sabe por la última
//      importación, contra la BASE, que es lo único que sobrevive a un redeploy.
//
// Antes solo existía la 2, y "no llegó nada" significaba las dos cosas a la vez.
// El lunes 24/08 la última planilla era del sábado 15:49 y desde el servidor no
// había forma de saber si el sync estaba muerto o si simplemente nadie había
// tocado el Excel. Son problemas distintos, con culpables distintos y arreglos
// distintos: ahora se avisan por separado.
//
// Si el canal está caído NO se reclama por los datos: la causa es el canal, y dos
// avisos para un solo problema es ruido.
const { ultimaPlanillaImportada } = require('./db/retiros');
const { avisarProblema } = require('./notificar');
const canal = require('./lib/canal-planilla');

const INTERVALO_MS = 30 * 60 * 1000; // media hora

// Sin planilla nueva por más de esto, en horario de trabajo, se avisa.
// Tres horas es holgado a propósito: puede haber una mañana tranquila sin pedidos
// nuevos, y una falsa alarma cuesta más que enterarse tres horas más tarde.
const LIMITE_HORAS = Number(process.env.PLANILLA_LIMITE_HORAS) > 0
  ? Number(process.env.PLANILLA_LIMITE_HORAS)
  : 3;

// El script late cada 4 minutos. Veinte da margen para un par de vueltas perdidas
// por un corte de internet sin salir a gritar.
const MINUTOS_SIN_LATIDO = 20;

// Ventana en la que tiene sentido reclamar (hora argentina). Fuera de esto nadie
// está tocando la planilla, así que un silencio es normal.
const DESDE_HORA = 9;
const HASTA_HORA = 19;
const DOMINGO = 0;

// Episodios abiertos, uno por tipo de problema:
//   { desde: Date, ultimoAvisoDia: 'YYYY-MM-DD' }
// `ultimoAvisoDia` es lo que permite RECORDAR una vez por día: un problema que
// empieza un sábado a la tarde y sigue el lunes tiene que volver a avisar el
// lunes, cuando importa. Sin eso, el único aviso salía cuando la sucursal estaba
// cerrando y el lunes nadie se enteraba de nada.
const episodios = { canal: null, datos: null };

/** Hora del día (0-23) en Argentina, sin depender del TZ del contenedor. */
function horaArg(fecha) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false,
  }).format(fecha));
}

/** La fecha argentina como 'YYYY-MM-DD'. */
function fechaArg(fecha) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(fecha);
}

/** Día de la semana en Argentina. 0 = domingo. */
function diaArg(fecha) {
  // Se pasa por la fecha ARGENTINA y recién ahí se pide el día: a las 22:00 de un
  // sábado en Argentina, en UTC ya es domingo.
  return new Date(`${fechaArg(fecha)}T12:00:00Z`).getUTCDay();
}

function textoHoras(horasSin) {
  if (!Number.isFinite(horasSin)) return 'nunca entró ninguna';
  if (horasSin < 1) return `hace ${Math.round(horasSin * 60)} minutos`;
  return `hace ${Math.round(horasSin)} horas`;
}

function textoMinutos(min) {
  if (!Number.isFinite(min)) return 'nunca reportó';
  if (min < 60) return `hace ${Math.round(min)} minutos`;
  return `hace ${Math.round(min / 60)} horas`;
}

/**
 * Qué corresponde hacer. PURA: sin base, sin bot, sin reloj propio.
 *
 * @returns {Array<{tipo:'canal'|'datos', accion:'reclamar'|'recordar'|'resuelto',
 *                  horasSin:number, minSinLatido:number}>}
 */
function decidir({ ahora, ultima, latido, minutosDespierto, estado = episodios }) {
  const horasSin = ultima ? (ahora.getTime() - ultima.getTime()) / 3600000 : Infinity;
  const minSinLatido = latido ? (ahora.getTime() - latido.en.getTime()) / 60000 : Infinity;

  // Recién reiniciado el bot no hay latidos todavía y eso NO significa que el
  // script esté muerto. Se espera a llevar despierto más que la ventana.
  const confiable = minutosDespierto >= MINUTOS_SIN_LATIDO;
  const canalCaido = confiable && minSinLatido >= MINUTOS_SIN_LATIDO;
  // OJO: sano NO es "no caído". Entre los dos hay un tercer estado —recién
  // reiniciado, todavía sin latidos— donde no se sabe nada. Reclamar los datos
  // ahí sería afirmar "el sync SÍ está funcionando" sin ninguna prueba, que es
  // justamente lo que dice el mensaje. Se espera.
  const canalSano = minSinLatido < MINUTOS_SIN_LATIDO;
  const datosViejos = canalSano && horasSin >= LIMITE_HORAS;
  const mal = { canal: canalCaido, datos: datosViejos };

  const seTrabaja = diaArg(ahora) !== DOMINGO;
  const hora = horaArg(ahora);
  const enHorario = hora >= DESDE_HORA && hora < HASTA_HORA;
  const hoy = fechaArg(ahora);

  const acciones = [];
  for (const tipo of ['canal', 'datos']) {
    const ep = estado[tipo];
    if (mal[tipo]) {
      // Reclamar solo en horario laborable. Un problema que arranca de noche se
      // avisa a la mañana siguiente, que es cuando alguien puede hacer algo.
      if (!seTrabaja || !enHorario) continue;
      if (!ep) acciones.push({ tipo, accion: 'reclamar', horasSin, minSinLatido });
      else if (ep.ultimoAvisoDia !== hoy) acciones.push({ tipo, accion: 'recordar', horasSin, minSinLatido });
      continue;
    }
    if (!ep) continue;
    // El episodio de datos solo se cierra con el canal SANO: sin latidos frescos
    // no sabemos nada de los datos, y "no sé" no es "se arregló".
    if (tipo === 'datos' && !canalSano) continue;
    acciones.push({ tipo, accion: 'resuelto', horasSin, minSinLatido });
  }
  return acciones;
}

// ── Los textos ───────────────────────────────────────────────────────────────

function mensajeCanal(a, latido, recordatorio) {
  const quien = latido ? latido.equipo : 'la PC de la sucursal';
  return {
    proceso: 'la pantalla de recepción',
    nivel: '❌',
    que: `${recordatorio ? 'SIGUE sin resolverse: ' : ''}El sync de ${quien} no reporta `
      + `${textoMinutos(a.minSinLatido)}. La pantalla va a quedar con datos viejos.`,
    detalle: latido
      ? `Último reporte: ${latido.en.toISOString()} · archivo que veía: ${latido.archivo || '?'}`
      : 'Nunca reportó desde que arrancó el bot.',
    sugerencia: 'Primero: ¿esa PC está prendida y con la sesión iniciada? El sync corre '
      + 'con la sesión abierta. Si está prendida, abrir sync.log y mirar la última línea.',
  };
}

function mensajeDatos(a, latido, recordatorio) {
  const visto = latido && latido.fecha
    ? `El script está bien y ve el archivo "${latido.archivo}", modificado ${latido.fecha}.`
    : 'El script está reportando bien.';
  return {
    proceso: 'la pantalla de recepción',
    que: `${recordatorio ? 'SIGUE sin resolverse: ' : ''}No entra una planilla nueva `
      + `${textoHoras(a.horasSin)}, y el sync SÍ está funcionando.`,
    detalle: `${visto} O sea que nadie está guardando cambios en la planilla.`,
    sugerencia: 'Puede ser normal si no hubo pedidos nuevos. Si no, fijate que estén '
      + 'editando ese archivo y no una copia.',
  };
}

function mensajeResuelto(tipo) {
  return {
    proceso: 'la pantalla de recepción',
    nivel: '✅',
    que: tipo === 'canal'
      ? 'El sync de la sucursal volvió a reportar. La pantalla se está actualizando de nuevo.'
      : 'Volvió a entrar la planilla. La pantalla está al día.',
  };
}

/** Una pasada del chequeo. Devuelve lo que hizo, para el log y los tests. */
async function revisarPlanilla({ ahora = new Date() } = {}) {
  const ultima = await ultimaPlanillaImportada();
  const latido = canal.ultimoLatido();
  const acciones = decidir({
    ahora, ultima, latido, minutosDespierto: canal.minutosDespierto(ahora),
  });

  for (const a of acciones) {
    if (a.accion === 'resuelto') {
      episodios[a.tipo] = null;
      await avisarProblema(mensajeResuelto(a.tipo));
      continue;
    }
    const recordatorio = a.accion === 'recordar';
    episodios[a.tipo] = {
      desde: (episodios[a.tipo] && episodios[a.tipo].desde) || ahora,
      ultimoAvisoDia: fechaArg(ahora),
    };
    await avisarProblema(a.tipo === 'canal'
      ? mensajeCanal(a, latido, recordatorio)
      : mensajeDatos(a, latido, recordatorio));
  }
  return acciones;
}

function iniciarAvisoPlanilla() {
  const correr = async () => {
    try {
      const acciones = await revisarPlanilla();
      for (const a of acciones) console.log(`Pantalla de recepción: ${a.tipo} → ${a.accion}.`);
    } catch (e) {
      // Que falle el vigilante no puede tumbar el bot ni llenar el log de ruido.
      console.error('Error chequeando la pantalla de recepción:', e.message);
    }
  };
  // La primera pasada NO va al arranque: un redeploy a media mañana reclamaría
  // antes de que el script del otro lado tenga su próxima vuelta.
  setInterval(correr, INTERVALO_MS);
}

module.exports = {
  iniciarAvisoPlanilla, revisarPlanilla, decidir,
  horaArg, diaArg, fechaArg, textoHoras, textoMinutos,
  LIMITE_HORAS, MINUTOS_SIN_LATIDO, DESDE_HORA, HASTA_HORA,
  _reset: () => { episodios.canal = null; episodios.datos = null; },
  _episodios: () => ({ ...episodios }),
};
