// Aviso de PANTALLA CON DATOS VIEJOS.
//
// El script que manda la planilla (ver api-planilla.js) corre en la PC de un
// empleado. Puede pasar cualquier cosa: que apaguen la máquina, que se pierda la
// credencial del recurso compartido, que alguien lo desinstale sin querer. Nada
// de eso rompe nada visible: la pantalla de recepción sigue prendida mostrando
// los pedidos de la última vez que sí llegó. Es la peor forma de fallar, porque
// parece que anda.
//
// Que el canal esté vivo y que los datos estén frescos son DOS COSAS DISTINTAS,
// y la que le importa a la gente que mira la tele es la segunda. Por eso esto no
// pregunta "¿el script está corriendo?" sino "¿hace cuánto que no entra una
// planilla?", y lo pregunta contra la base, que es lo único que sobrevive a un
// redeploy del bot.
const { ultimaPlanillaImportada } = require('./db/retiros');
const { avisarProblema } = require('./notificar');

const INTERVALO_MS = 30 * 60 * 1000; // media hora

// Sin planilla por más de esto, en horario de trabajo, se avisa.
// Tres horas es holgado: la planilla se guarda muchas veces por día, pero puede
// haber una mañana tranquila sin ningún pedido nuevo y no queremos falsas alarmas.
const LIMITE_HORAS = Number(process.env.PLANILLA_LIMITE_HORAS) > 0
  ? Number(process.env.PLANILLA_LIMITE_HORAS)
  : 3;

// Ventana en la que tiene sentido reclamar (hora argentina). Fuera de esto nadie
// está tocando la planilla, así que un silencio es normal.
const DESDE_HORA = 9;
const HASTA_HORA = 19;

// Episodio en curso: cuándo se avisó. Null = no hay reclamo abierto. Sirve para
// avisar UNA vez por episodio y para poder anunciar cuando se resuelve.
let reclamadoEn = null;

/** Hora del día (0-23) en Argentina, sin depender del TZ del contenedor. */
function horaArg(fecha) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false,
  }).format(fecha);
  return Number(h);
}

/**
 * Qué corresponde hacer. PURA: sin base, sin bot, sin reloj propio.
 *
 * @param {Date|null} ultima   última planilla importada
 * @param {Date}      ahora
 * @param {boolean}   hayReclamo  ¿ya se avisó y sigue abierto?
 * @returns {{accion:'nada'|'reclamar'|'resuelto', horasSin:number}}
 */
function decidir({ ultima, ahora, hayReclamo }) {
  const horasSin = ultima ? (ahora.getTime() - ultima.getTime()) / 3600000 : Infinity;

  // Con un reclamo abierto lo único que importa es si volvió, y eso se chequea a
  // cualquier hora: si la planilla se destrabó a las 19:30, el "ya volvió" tiene
  // que salir esa misma noche y no al otro día.
  if (hayReclamo) {
    return { accion: horasSin < LIMITE_HORAS ? 'resuelto' : 'nada', horasSin };
  }

  const hora = horaArg(ahora);
  if (hora < DESDE_HORA || hora >= HASTA_HORA) return { accion: 'nada', horasSin };
  return { accion: horasSin >= LIMITE_HORAS ? 'reclamar' : 'nada', horasSin };
}

function textoHoras(horasSin) {
  if (!Number.isFinite(horasSin)) return 'nunca entró ninguna';
  if (horasSin < 1) return `hace ${Math.round(horasSin * 60)} minutos`;
  return `hace ${Math.round(horasSin)} horas`;
}

/**
 * Una pasada del chequeo. Devuelve qué se hizo, para el log y los tests.
 */
async function revisarPlanilla({ ahora = new Date() } = {}) {
  const ultima = await ultimaPlanillaImportada();
  const { accion, horasSin } = decidir({ ultima, ahora, hayReclamo: !!reclamadoEn });

  if (accion === 'reclamar') {
    reclamadoEn = ahora;
    await avisarProblema({
      proceso: 'la pantalla de recepción',
      que: `No llega la planilla de retiros ${textoHoras(horasSin)}. La tele sigue mostrando datos viejos.`,
      detalle: ultima
        ? `Última planilla: ${ultima.toISOString()}`
        : 'No hay ninguna planilla importada todavía.',
      sugerencia: 'Revisar en la PC que manda la planilla: abrir sync.log y ver la última línea. '
        + 'Si dice "no se llegó a la carpeta compartida", se perdió el acceso al servidor de archivos.',
    });
    return { accion, horasSin };
  }

  if (accion === 'resuelto') {
    reclamadoEn = null;
    await avisarProblema({
      proceso: 'la pantalla de recepción',
      que: 'Ya está entrando de nuevo la planilla de retiros. La pantalla vuelve a estar al día.',
      nivel: '✅',
    });
    return { accion, horasSin };
  }

  return { accion: 'nada', horasSin };
}

function iniciarAvisoPlanilla() {
  const correr = async () => {
    try {
      const r = await revisarPlanilla();
      if (r.accion !== 'nada') console.log(`Planilla de retiros: ${r.accion} (${textoHoras(r.horasSin)}).`);
    } catch (e) {
      // Que falle el vigilante no puede tumbar el bot ni llenar el log de ruido.
      console.error('Error chequeando la frescura de la planilla:', e.message);
    }
  };
  // La primera pasada NO va al arranque: un redeploy a media mañana dispararía el
  // reclamo antes de que el script del otro lado tenga su próxima vuelta.
  setInterval(correr, INTERVALO_MS);
}

module.exports = {
  iniciarAvisoPlanilla, revisarPlanilla, decidir, horaArg, textoHoras,
  LIMITE_HORAS, DESDE_HORA, HASTA_HORA,
  _reset: () => { reclamadoEn = null; },
  _hayReclamo: () => !!reclamadoEn,
};
