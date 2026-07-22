// Fuente del LIBRO DIARIO para los comandos que lo consumen (/mp, /cierre, /flujos).
//
// CONTRATO INNEGOCIABLE: ninguna función de acá tira NUNCA. Devuelven { ok:false, motivo }.
// El motivo es estructural: estos helpers se llaman DENTRO de wizards de Telegraf, y si un step
// tira, el cursor de la escena NO avanza — bot.catch contesta un error genérico y cada mensaje
// siguiente vuelve a ejecutar el mismo step y a tirar. El usuario queda ATRAPADO: "cancelar" no
// lo saca (solo se chequea en el step siguiente) y el comando tampoco (stage.middleware() corre
// antes que los bot.command). Un hipo de Supabase dejaría el comando muerto hasta que vuelva.
// Por eso: todo try/catch adentro, console.error, y ok:false.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fechaISO, fechaHoyArgISO } = require('./fechas');

// El require de la capa DB es LAZY (adentro de las funciones) A PROPÓSITO: db/pool.js TIRA al
// cargarse si falta DATABASE_URL, y /mp se podía requerir sin base — así corren hoy sus tests
// (test/tesoreria-mp.test.js). Importarlo arriba los rompería a todos.
// Y encaja con el contrato: si la env no está, el catch de cada función lo convierte en
// { ok:false, motivo:'db_caida' }, que es justo lo que este módulo promete.
function db() {
  return require('../db/libro'); // require() cachea: esto no cuesta nada después de la 1ª vez
}

// Una sola constante para el eje libro↔movimientos. control-periodo.js y reportecierre.js ya
// hardcodean 'HONRE'; el sistema es mono-empresa de facto.
const EMPRESA = 'HONRE';

// 'AAAA-MM-DD' -> Date a medianoche local (mismo criterio que fechaISO, que usa getters locales).
function isoADate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Días de diferencia entre la jornada del libro y hoy (0 = de hoy, 1 = de ayer...).
function antiguedadEnDias(fechaLibro) {
  const hoy = isoADate(fechaHoyArgISO());
  const f = fechaLibro instanceof Date ? fechaLibro : isoADate(fechaLibro);
  const dif = hoy.getTime() - new Date(f.getFullYear(), f.getMonth(), f.getDate()).getTime();
  return Math.round(dif / 86400000);
}

// Consigue la METADATA del libro a usar. No baja el archivo (son ~280 KB; se piden aparte).
//   modo 'ultimo' -> el último cargado. Para /flujos, que no tiene un día objetivo.
//   modo 'cubre'  -> el que cubre `fecha`. Para /mp y /cierre, que sí razonan por día.
// Devuelve { ok:true, meta, antiguedadDias, esDeHoy } | { ok:false, motivo }
async function conseguirLibro({ modo = 'ultimo', fecha = null, empresa = EMPRESA } = {}) {
  try {
    const { libroQueCubre, metaLibro, ultimoLibro } = db();
    let meta = null;
    if (modo === 'cubre') {
      if (!fecha) return { ok: false, motivo: 'sin_fecha' };
      meta = await libroQueCubre({ fecha, empresa });
      // Si no lo cubre por rango, probar la jornada exacta: un libro puede haberse archivado
      // con esa fecha aunque su rango se haya recalculado después.
      if (!meta) meta = await metaLibro({ fecha, empresa });
    } else {
      meta = await ultimoLibro({ empresa });
    }
    if (!meta) return { ok: false, motivo: 'sin_libro' };
    const antiguedadDias = antiguedadEnDias(meta.fecha);
    return { ok: true, meta, antiguedadDias, esDeHoy: antiguedadDias === 0 };
  } catch (e) {
    console.error('conseguirLibro:', e.message);
    return { ok: false, motivo: 'db_caida' };
  }
}

// El .xlsx crudo del libro. SIEMPRE por meta.fecha (la jornada con la que se archivó), nunca por
// el día que pidió el usuario: archivoLibro() busca por jornada exacta, así que pedirle un día
// del MEDIO del rango devolvería null sin excepción y sin log — el usuario vería "tengo el libro
// del 15", elegiría usarlo, y el bot igual le pediría el archivo.
async function bufferLibro(meta, { empresa = EMPRESA } = {}) {
  if (!meta || !meta.fecha) return { ok: false, motivo: 'sin_libro' };
  try {
    const { archivoLibro } = db();
    const fila = await archivoLibro({ fecha: meta.fecha, empresa });
    if (!fila || !fila.archivo) {
      // Metadata sin bytea = inconsistencia real (los dos se escriben en pasos separados).
      console.error(`bufferLibro: hay metadata del ${fechaISO(meta.fecha)} pero no el archivo.`);
      return { ok: false, motivo: 'sin_archivo' };
    }
    return { ok: true, buffer: fila.archivo, nombre: fila.nombre_archivo || '' };
  } catch (e) {
    console.error('bufferLibro:', e.message);
    return { ok: false, motivo: 'db_caida' };
  }
}

// Materializa el libro en un archivo temporal. Solo lo necesita /flujos, que le pasa una RUTA al
// motor Python. El nombre es sintético a propósito: no se usa `nombre_archivo` ni el file_name de
// Telegram para no arrastrar texto del usuario a un path.join.
// Devuelve { ok:true, ruta, limpiar() } | { ok:false, motivo }
async function materializarLibro(meta, { empresa = EMPRESA } = {}) {
  const buf = await bufferLibro(meta, { empresa });
  if (!buf.ok) return buf;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libro-'));
    const ruta = path.join(dir, 'libro.xlsx');
    fs.writeFileSync(ruta, buf.buffer);
    return {
      ok: true,
      ruta,
      limpiar() {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e) { console.error('materializarLibro/limpiar:', e.message); }
      },
    };
  } catch (e) {
    console.error('materializarLibro:', e.message);
    return { ok: false, motivo: 'sin_disco' };
  }
}

// Días sin libro en una ventana, para decirle al usuario QUÉ falta y no solo que falta.
// Nunca tira: si falla, devuelve [] y el llamador simplemente no lista los días.
async function huecosEntre({ desde, hasta, empresa = EMPRESA }) {
  try {
    const { diasSinLibro } = db();
    return await diasSinLibro({ desde, hasta, empresa });
  } catch (e) {
    console.error('huecosEntre:', e.message);
    return [];
  }
}

module.exports = { EMPRESA, conseguirLibro, bufferLibro, materializarLibro, huecosEntre, antiguedadEnDias };
