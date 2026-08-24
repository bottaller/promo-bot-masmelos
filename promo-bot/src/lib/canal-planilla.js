// Estado del canal por el que entra la PLANILLA RETIRA.
//
// POR QUÉ EXISTE ESTE MÓDULO. El script de la sucursal solo manda el Excel
// cuando cambia. Eso es lo correcto —no tiene sentido remandar 100 KB cada 4
// minutos— pero deja al servidor sin poder distinguir dos cosas muy distintas:
//
//   a) el script está corriendo y nadie tocó la planilla, y
//   b) el script se murió (apagaron la PC, se perdió el acceso al servidor de
//      archivos, alguien borró la carpeta).
//
// Desde afuera las dos se ven igual: no llega nada. Pasó de verdad el lunes
// 24/08: la última planilla era del sábado a las 15:49 y no había forma de saber,
// sin ir hasta la máquina, si el sync estaba vivo.
//
// Por eso ahora el script manda un LATIDO en cada vuelta, aunque no haya nada que
// mandar, y de paso cuenta qué archivo está viendo. Con eso las dos preguntas se
// responden por separado:
//
//   ¿hay latidos?        -> ¿el script está vivo?
//   ¿entran planillas?   -> ¿alguien está actualizando el Excel?
//
// El estado vive en memoria y se pierde en cada redeploy. Es a propósito: la
// alternativa era una tabla nueva (y las migraciones acá se corren a mano). Para
// que un redeploy no dispare un "no hay latidos" falso, se guarda ARRANQUE y
// quien lea espera a llevar despierto más que la ventana de tolerancia.
let arranque = new Date();
let latido = null;
let planillaOk = null;

/**
 * Lo que reporta el script en cada vuelta.
 * @param {object} d
 * @param {string} d.equipo   qué máquina
 * @param {string} d.estado   'ok' | 'sin-archivo' | 'error' — cómo le fue A ÉL
 * @param {string} [d.archivo] nombre del .xlsx que está viendo
 * @param {string} [d.fecha]   fecha de modificación de ese archivo (ISO)
 * @param {number} [d.tam]     su tamaño en bytes
 * @param {string} [d.motivo]  si estado != 'ok', por qué
 */
function registrarLatido(d = {}) {
  latido = {
    en: new Date(),
    equipo: String(d.equipo || 'desconocido').slice(0, 60),
    estado: ['ok', 'sin-archivo', 'error'].includes(d.estado) ? d.estado : 'ok',
    archivo: d.archivo ? String(d.archivo).slice(0, 120) : null,
    fecha: d.fecha ? String(d.fecha).slice(0, 40) : null,
    tam: Number.isFinite(Number(d.tam)) ? Number(d.tam) : null,
    motivo: d.motivo ? String(d.motivo).slice(0, 300) : null,
  };
  return latido;
}

/** Una planilla entró y se guardó bien. */
function registrarPlanillaOk() {
  planillaOk = new Date();
  return planillaOk;
}

function ultimoLatido() { return latido; }
function ultimaPlanillaOk() { return planillaOk; }
function arranqueEn() { return arranque; }

/** Minutos desde que arrancó el proceso. Lo usa el chequeo para no gritar
 *  "no hay latidos" cuando en realidad el bot acaba de reiniciarse. */
function minutosDespierto(ahora = new Date()) {
  return (ahora.getTime() - arranque.getTime()) / 60000;
}

/** Solo para los tests. */
function _reset() {
  arranque = new Date();
  latido = null;
  planillaOk = null;
}
function _fijarArranque(fecha) { arranque = fecha; }

module.exports = {
  registrarLatido, registrarPlanillaOk,
  ultimoLatido, ultimaPlanillaOk, arranqueEn, minutosDespierto,
  _reset, _fijarArranque,
};
