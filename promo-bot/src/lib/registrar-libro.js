// Registrar el LIBRO DIARIO: parsea el export de Sigma, guarda los movimientos y guarda el
// .xlsx crudo. Es el corazón de /libro.
//
// A propósito NO sabe nada de Telegram: recibe un Buffer y devuelve un resumen. Así lo puede
// invocar tanto el wizard /libro como un script (`node src/db/cargar-libro.js <ruta>`) cuando
// se automatice la exportación desde Sigma. Si esto viviera dentro del wizard, automatizarlo
// obligaría a reescribirlo.
//
// LA JORNADA SALE DEL EXCEL, no del día en que se sube: por eso el martes se puede cargar el
// libro del lunes y queda archivado como lunes. Lo único que se rechaza es un export que diga
// ser del futuro.
const { parsearLibro, LibroError } = require('./libro-excel');
const { guardarLibro, metaLibro, diasSinLibro } = require('../db/libro');
const { guardarMovimientos } = require('../db/tesoreria');
const { fechaISO, fechaHoyArgISO, formatoVencimiento, sumarDias } = require('./fechas');

// Ventana hacia atrás en la que se buscan huecos ("cargaste el martes pero falta el lunes").
const DIAS_HUECOS = 7;

// 'AAAA-MM-DD' -> Date a medianoche local (mismo criterio que fechaISO, que usa getters locales).
function isoADate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Parsea + persiste. Tira LibroError (mensaje directo al usuario) si el Excel no tiene la
// forma esperada o si la fecha no cierra; cualquier otro error es un bug real y sube tal cual.
//
//   buffer         Buffer del .xlsx exportado de Sigma
//   fecha          fuerza la jornada; por defecto la deduce del Excel (su último día)
//   usuarioId      quién lo cargó; null si lo carga un proceso automático
//
// Devuelve { jornada, desde, hasta, filas, dias, yaHabia, previo, atrasado, hoy, huecos }.
async function registrarLibro({ buffer, nombreArchivo = '', fecha = null, empresa = 'HONRE', usuarioId = null }) {
  const libro = parsearLibro(buffer);

  // OJO: libro.desde/hasta salen del TÍTULO del export ("del DD/MM/AAAA al DD/MM/AAAA"), que es
  // el rango PEDIDO en Sigma y puede ser mucho más ancho que los datos — el propio /cierre invita
  // a "poner unos días más para atrás". Guardar ese rango rompe dos cosas:
  //   1. un export "del 01/07 al 31/07" hecho el 20/07 quedaría con hasta=31/07 (futuro) y sería
  //      rechazado, aunque sus datos sean perfectamente válidos;
  //   2. cubreFecha()/diasSinLibro() contestarían "sí tengo el día 05" sobre un día sin una sola
  //      fila, y el aviso de las 21:00 dejaría de reclamarlo.
  // Por eso el rango que se archiva es el REAL de los movimientos. El del título queda aparte,
  // solo informativo. (parsearLibro garantiza al menos un movimiento: si no, ya tiró LibroError.)
  const ordenadas = libro.movimientos.map((m) => m.fecha).sort((a, b) => a - b);
  const desdeReal = ordenadas[0];
  const hastaReal = ordenadas[ordenadas.length - 1];

  const jornada = fecha || hastaReal;
  const jornadaISO = fechaISO(jornada);
  const hoyISO = fechaHoyArgISO();

  // Un export que dice ser del futuro es un rango mal puesto en Sigma (o un reloj corrido).
  // Se rechaza: si entrara, el aviso de las 21:00 y los huecos quedarían mintiendo.
  if (jornadaISO > hoyISO) {
    throw new LibroError(
      `Ese libro dice ser del ${formatoVencimiento(jornada)}, que todavía no pasó ` +
      `(hoy es ${formatoVencimiento(isoADate(hoyISO))}). Revisá el rango que exportaste de Sigma.`
    );
  }

  // Si se FUERZA la jornada, tiene que ser un día que el export realmente cubra. Archivar como
  // "libro del 20" un export que solo trae el 11 dejaría un registro que miente: los que
  // preguntan "¿tengo el día X?" leen el rango real (desde/hasta) y no lo encontrarían, así que
  // el aviso de las 21:00 reclamaría un libro que figura cargado.
  if (fecha && (jornadaISO < fechaISO(desdeReal) || jornadaISO > fechaISO(hastaReal))) {
    throw new LibroError(
      `Pediste archivarlo como jornada ${formatoVencimiento(jornada)}, pero ese export trae ` +
      `movimientos del ${formatoVencimiento(desdeReal)} al ${formatoVencimiento(hastaReal)}. ` +
      `La jornada tiene que ser un día con datos en el export.`
    );
  }

  // ¿Ya había libro de esa jornada? Se mira ANTES de pisarlo, para poder avisar que se
  // reemplazó (si no, un export incompleto sustituye al bueno sin que nadie se entere).
  const previo = await metaLibro({ fecha: jornada, empresa });

  // 1) Los movimientos van a tesoreria_movimientos con la MISMA función que usa /cierre:
  //    borra y reinserta por día, así re-subir un export corregido pisa en vez de duplicar.
  //    Ojo: borra SOLO los días que trae el export, así que cargar el lunes no toca el martes.
  const res = await guardarMovimientos({ empresa, movimientos: libro.movimientos, usuarioId });

  // 2) El .xlsx crudo va a libro_diario, para los que necesitan el archivo y no los datos
  //    (/flujos se lo pasa al motor Python; /mp lo parsea con otro parser).
  //    No es una transacción única con el paso 1: si esto fallara quedarían los movimientos
  //    sin el archivo, y se arregla re-subiendo (los dos pasos son idempotentes).
  await guardarLibro({
    fecha: jornada,
    empresa,
    archivo: buffer,
    nombreArchivo,
    desde: desdeReal,   // rango REAL de los movimientos, no el del título (ver arriba)
    hasta: hastaReal,
    filas: libro.movimientos.length,
    usuarioId,
  });

  // Huecos de la última semana: se calculan DESPUÉS de guardar, así lo recién cargado ya cuenta
  // como cubierto. Puede incluir domingos/feriados (días sin operación); el que lo lee decide.
  const hoyDate = isoADate(hoyISO);
  let huecos = [];
  try {
    huecos = await diasSinLibro({ desde: sumarDias(hoyDate, -DIAS_HUECOS), hasta: hoyDate, empresa });
  } catch (e) {
    console.error('registrarLibro: no pude calcular los huecos (sigo igual):', e.message);
  }

  return {
    jornada,
    desde: desdeReal,           // rango real de los datos (lo que se archivó)
    hasta: hastaReal,
    desdePedido: libro.desde,   // rango del título del export, solo informativo
    hastaPedido: libro.hasta,
    filas: libro.movimientos.length,
    dias: res.dias,
    empresas: libro.empresas,
    yaHabia: !!previo,          // true = se reemplazó el libro que ya estaba de esa jornada
    previo,                     // metadata del anterior (para decir qué se pisó)
    atrasado: jornadaISO < hoyISO, // se cargó un día posterior al que cubre (caso "me olvidé")
    hoy: hoyISO,
    huecos,                     // ['AAAA-MM-DD', ...] días sin libro en la última semana
  };
}

module.exports = { registrarLibro, LibroError };
