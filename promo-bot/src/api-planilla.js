// Puerta HTTP para que la PLANILLA RETIRA entre sola.
//
// La planilla vive en un servidor de archivos de la sucursal y la edita una
// persona durante todo el día. Hasta ahora alguien tenía que acordarse de
// subirla por /carga para que la pantalla de recepción se actualizara. Del otro
// lado de esto hay un script que corre en la PC de esa persona, mira el archivo
// cada pocos minutos y, cuando cambia, lo manda acá (ver Desktop/sync-planilla).
//
// POR QUÉ EL ENDPOINT ESTÁ EN EL BOT Y NO EN EL SITIO: el parser y el writer ya
// viven acá (lib/retiros-excel.js y db/retiros.js) y el bot se conecta a la base
// como postgres. Poniéndolo acá, la subida por Telegram y la automática pasan
// por EL MISMO código —no pueden divergir— y no hace falta ni duplicar el parser
// ni crear un rol nuevo con su policy de RLS.
//
// Y POR QUÉ EL QUE MANDA NO PARSEA NADA: la máquina que tiene el archivo es un
// escritorio de empleado, sin admin y sin Node. Solo manda bytes con una clave;
// ninguna credencial de la base sale de acá.
const http = require('http');
const { timingSafeEqual } = require('crypto');
const { DOCUMENTOS, DocumentoInvalido } = require('./lib/documentos-carga');
const { esPlanillaRetiros } = require('./lib/retiros-excel');
const { avisarProblema } = require('./notificar');

// La planilla real pesa ~75 KB. El tope es holgado a propósito (un Excel puede
// engordar mucho con imágenes pegadas), pero tiene que existir: sin tope, un
// POST de 2 GB se come la memoria del contenedor.
const LIMITE_BYTES = 8 * 1024 * 1024;

const RUTA = process.env.PLANILLA_API_PATH || '/planilla';

// Última planilla aceptada, para /salud y para saber si el canal está vivo. OJO:
// esto se pierde en cada redeploy, así que NO es la fuente del aviso de datos
// viejos — ese mira la base (ver aviso-planilla.js).
let ultimaOk = null;

// Guard de ruido. El script reintenta solo, y la planilla se guarda decenas de
// veces por día: sin esto, un problema que persiste avisaría cada 4 minutos para
// siempre. Se avisa cuando el problema CAMBIA, igual que aviso-libro.js.
//
// Va por TIPO de problema y no en una sola variable: con una sola, dos problemas
// distintos alternándose se pisan la firma y vuelven a avisar cada vuelta, que es
// exactamente el ruido que se quiere evitar.
const avisosVistos = new Map();

// Cuántos rechazos por clave seguidos antes de avisar. Uno solo puede ser
// cualquier cosa (un escaneo de internet, alguien probando la URL); tres seguidos
// es alguien que se equivocó al copiar el token y no se va a enterar nunca solo.
const RECHAZOS_PARA_AVISAR = 3;
let rechazosSeguidos = 0;

/** ¿Hay una importación en curso? Dos planillas a la vez no rompen (la transacción
 *  las serializa), pero encolar es más barato que dos INSERT masivos compitiendo. */
let enCurso = false;

class ErrorHttp extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.codigo = codigo;
  }
}

/** Fecha y hora argentina compacta, apta para un nombre de archivo. */
function selloArg(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '00';
  return `${g('year')}-${g('month')}-${g('day')}_${g('hour')}${g('minute')}`;
}

/**
 * Nombre para el archivo que se les manda a los admins.
 *
 * El nombre original viene en un header, o sea que lo elige quien llama: se limpia
 * de barras y caracteres raros antes de usarlo como nombre de archivo. Y va con la
 * fecha adelante porque si el problema se repite en distintos momentos, en el chat
 * quedan varios adjuntos y hay que poder distinguirlos.
 */
function nombreParaAdmins(original) {
  const base = String(original || 'planilla.xlsx')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .trim()
    .slice(0, 70) || 'planilla.xlsx';
  const conExt = /\.(xlsx|xlsm|xls)$/i.test(base) ? base : `${base}.xlsx`;
  return `RECHAZADA ${selloArg()} - ${conExt}`;
}

/**
 * Comparación en tiempo constante. El largo se chequea aparte porque
 * timingSafeEqual tira si los buffers miden distinto.
 */
function tokenValido(recibido) {
  const esperado = process.env.PLANILLA_SYNC_TOKEN || '';
  if (!esperado) return false;
  const a = Buffer.from(String(recibido || ''), 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Techo duro para el caso feo: un POST enorme. Pasado el límite se deja de
// guardar en memoria pero se SIGUE LEYENDO y descartando, porque cortar el socket
// de una hace que el cliente reciba un "conexión cerrada" en vez del 413 — y del
// otro lado hay un script que escribe en un log el motivo del rechazo, que es
// justamente lo que después sirve para entender qué pasó. Recién si el que manda
// insiste mucho más allá del límite se corta en seco.
const TECHO_BYTES = LIMITE_BYTES * 4;

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let excedido = false;
    let terminado = false;
    const fallar = (e) => { if (!terminado) { terminado = true; reject(e); } };

    req.on('data', (c) => {
      total += c.length;
      if (total > LIMITE_BYTES) {
        excedido = true;
        partes.length = 0; // soltar lo acumulado: no lo vamos a usar
        if (total > TECHO_BYTES) {
          fallar(new ErrorHttp(413, 'El archivo es demasiado grande.'));
          req.destroy();
        }
        return;
      }
      partes.push(c);
    });
    req.on('end', () => {
      if (terminado) return;
      terminado = true;
      if (excedido) {
        reject(new ErrorHttp(413, `El archivo supera los ${Math.round(LIMITE_BYTES / 1024 / 1024)} MB.`));
        return;
      }
      resolve(Buffer.concat(partes));
    });
    req.on('error', fallar);
  });
}

function responder(res, codigo, objeto) {
  const cuerpo = JSON.stringify(objeto);
  res.writeHead(codigo, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(cuerpo),
  });
  res.end(cuerpo);
}

/**
 * Avisa a los admins solo si ESTE tipo de problema cambió respecto del último
 * aviso del mismo tipo. `firma` identifica el caso concreto.
 */
async function avisarSiCambio(tipo, firma, opts) {
  if (avisosVistos.get(tipo) === firma) return false;
  avisosVistos.set(tipo, firma);
  await avisarProblema(opts).catch(() => {});
  return true;
}

/** El problema de ese tipo se resolvió: que el próximo vuelva a avisar. */
function limpiarAviso(tipo) {
  avisosVistos.delete(tipo);
}

/**
 * Procesa una planilla que llegó por HTTP. Separado del servidor para poder
 * testearlo sin abrir un puerto.
 *
 * @param {Buffer} buffer  el .xlsx crudo
 * @param {object} doc     la entrada del registro de documentos (se inyecta en los tests)
 * @param {string} equipo  qué máquina lo mandó (solo para el log y los avisos)
 */
async function procesarPlanillaHttp(buffer, { documento, equipo = 'desconocido', nombre = '' } = {}) {
  if (!buffer || !buffer.length) throw new ErrorHttp(400, 'Vino sin archivo.');

  // Cuando algo falla, el aviso va CON el archivo. Describir el problema no alcanza:
  // el que lo tiene que resolver necesita abrirlo, y si no se lo mandamos tiene que
  // ir hasta la PC de la sucursal a buscarlo.
  const adjunto = (leyenda) => ({ buffer, nombre: nombreParaAdmins(nombre), leyenda });

  // Se exige que SEA la planilla, en vez de dejar que el registro elija. Si se
  // usara detectarDocumento(), un archivo cualquiera caería en el catch-all y el
  // bot intentaría registrarlo como libro diario: esta puerta tiene una sola
  // clave y no debe poder tocar nada más que los retiros.
  if (!esPlanillaRetiros(buffer)) {
    // Con la clave correcta pero el archivo equivocado, alguien apuntó el script a
    // otro Excel. Nadie se entera solo: del otro lado es una máquina sin nadie
    // mirándola, y acá la pantalla simplemente se queda como estaba.
    await avisarSiCambio('archivo', String(buffer.length), {
      proceso: 'la planilla automática de retiros',
      que: `Desde ${equipo} está llegando un archivo que NO es la PLANILLA RETIRA.`,
      detalle: `Pesa ${Math.round(buffer.length / 1024)} KB y no tiene los encabezados de la planilla.`,
      sugerencia: 'En esa PC, revisar qué .xlsx quedó en la carpeta PEDIDOS RETIRA MORENO 2026: '
        + 'el script manda el más nuevo que encuentre ahí.',
      archivo: adjunto('Este es el archivo que llegó y no es la planilla.'),
    });
    throw new ErrorHttp(400, 'Ese archivo no es la PLANILLA RETIRA (no tiene sus encabezados).');
  }
  limpiarAviso('archivo');

  let res;
  try {
    res = await documento.procesar({ buffer, nombreArchivo: 'PLANILLA RETIRA (automática)', usuarioId: null });
  } catch (e) {
    if (e instanceof DocumentoInvalido) {
      // La planilla se reconoció pero no sirve (típico: una versión vieja, sin
      // ningún turno de hoy en adelante). Es 422 y no 400 porque el archivo está
      // bien formado: el problema es su contenido, y lo arregla una persona.
      await avisarSiCambio('invalida', String(e.message), {
        proceso: 'la planilla automática de retiros',
        que: `Llegó una planilla desde ${equipo} pero no se pudo usar.`,
        detalle: String(e.message).replace(/<[^>]+>/g, ''),
        sugerencia: 'Fijate el archivo en el servidor: puede ser una versión vieja.',
        archivo: adjunto('Esta es la planilla que llegó y no se pudo usar.'),
      });
      throw new ErrorHttp(422, String(e.message).replace(/<[^>]+>/g, '').slice(0, 200));
    }
    throw e;
  }

  ultimaOk = new Date();
  limpiarAviso('invalida');

  // Lo que sí amerita molestar a alguien: pedidos que desaparecieron del Excel
  // pero ya estaban marcados. registrarRetiros no los borra a propósito, y si
  // nadie mira quedan colgados en la pantalla para siempre.
  const conservados = res.conservados || [];
  if (conservados.length) {
    const firma = conservados.map((c) => `${c.fecha}${c.turno}`).join(',');
    await avisarSiCambio('conservados', firma, {
      proceso: 'la planilla automática de retiros',
      que: `${conservados.length} pedido(s) ya no están en la planilla pero ya estaban marcados, así que los dejé.`,
      detalle: conservados.slice(0, 8).map((c) => `${c.fecha} ${c.turno} — ${c.cliente || c.codigo_cliente} (${c.prep || c.estado_final || 'marcado'})`).join('\n'),
      sugerencia: 'Si de verdad se dieron de baja, sacalos desde el panel.',
    });
  } else {
    limpiarAviso('conservados'); // se resolvió: que el próximo vuelva a avisar
  }

  return {
    ok: true,
    dias: res.dias || [],
    // Números para el log del script que la mandó. Cortos a propósito: del otro
    // lado se guardan los primeros 400 caracteres de la respuesta.
    guardados: res.guardados ?? null,
    borrados: res.borrados ?? 0,
    conservados: conservados.length,
    anomalias: (res.anomalias || []).length,
  };
}

async function manejar(req, res, { documento }) {
  const url = (req.url || '').split('?')[0];

  // Health check sin clave y sin datos: sirve para probar desde el navegador que
  // el puerto está abierto, sin filtrar nada.
  if (req.method === 'GET' && (url === '/salud' || url === '/')) {
    return responder(res, 200, { ok: true, servicio: 'planilla-retiros' });
  }

  if (url !== RUTA) return responder(res, 404, { ok: false, error: 'No existe.' });
  if (req.method !== 'POST') return responder(res, 405, { ok: false, error: 'Solo POST.' });

  if (!tokenValido(req.headers['x-sync-token'])) {
    console.warn(`[api-planilla] token inválido desde ${req.socket.remoteAddress}`);
    rechazosSeguidos++;
    // Un token mal copiado se ve EXACTAMENTE igual que "todavía no instalé nada":
    // no pasa nada y nadie se entera. Es el error más fácil de cometer de todo
    // esto (se copia y se pega a mano en dos lugares), así que hay que avisarlo.
    if (rechazosSeguidos >= RECHAZOS_PARA_AVISAR) {
      await avisarSiCambio('token', String(req.headers['x-equipo'] || 'desconocido'), {
        proceso: 'la planilla automática de retiros',
        que: `${rechazosSeguidos} intentos seguidos con la clave equivocada. La planilla NO está entrando.`,
        detalle: `Equipo: ${String(req.headers['x-equipo'] || 'sin identificar')} · IP: ${req.socket.remoteAddress}`,
        sugerencia: 'El token de config.txt en la PC de la sucursal tiene que ser idéntico a '
          + 'PLANILLA_SYNC_TOKEN en Railway. Ojo con los espacios al copiar.',
      });
    }
    return responder(res, 401, { ok: false, error: 'Token inválido.' });
  }
  if (rechazosSeguidos) { rechazosSeguidos = 0; limpiarAviso('token'); }

  // A partir de acá el que llama está autenticado, así que los errores pueden ser
  // explícitos: le sirven al log del script para saber qué arreglar.
  if (enCurso) return responder(res, 409, { ok: false, error: 'Hay otra planilla procesándose. Reintentá.' });

  const equipo = String(req.headers['x-equipo'] || 'desconocido').slice(0, 60);
  const nombre = String(req.headers['x-archivo'] || '').slice(0, 120);
  // Declarado afuera del try para poder adjuntarlo si algo explota más abajo.
  let buffer = null;
  enCurso = true;
  try {
    buffer = await leerCuerpo(req);
    const salida = await procesarPlanillaHttp(buffer, { documento, equipo, nombre });
    console.log(`[api-planilla] ${equipo}: ${buffer.length} bytes, días ${salida.dias.join(',') || '-'}, ${salida.borrados} borrado(s)`);
    return responder(res, 200, salida);
  } catch (e) {
    if (e instanceof ErrorHttp) return responder(res, e.codigo, { ok: false, error: e.message });
    // Un error inesperado (la base caída, un bug) sí se avisa: acá no hay nadie
    // mirando una conversación de Telegram que se entere de que falló.
    console.error('[api-planilla] error:', e);
    await avisarSiCambio('error', String(e.message || ''), {
      proceso: 'la planilla automática de retiros',
      que: `Falló el procesamiento de la planilla que mandó ${equipo}.`,
      detalle: e && e.stack ? e.stack : String(e),
      nivel: '❌',
      // Puede ser la base caída (y entonces el archivo no importa) o un bug del
      // parser con este archivo puntual (y entonces el archivo es TODA la
      // evidencia). Desde acá no se distingue, así que va.
      archivo: buffer && buffer.length
        ? { buffer, nombre: nombreParaAdmins(nombre), leyenda: 'La planilla que estaba procesando cuando falló.' }
        : undefined,
    });
    return responder(res, 500, { ok: false, error: 'Error interno.' });
  } finally {
    enCurso = false;
  }
}

/**
 * Levanta el servidor HTTP. Se llama desde index.js ANTES de bot.launch()
 * (launch no resuelve nunca).
 *
 * Sin PLANILLA_SYNC_TOKEN NO se levanta nada: un endpoint que escribe en la base
 * sin clave es peor que no tener endpoint. Que falte la variable ya lo avisa
 * chequear-env al arrancar.
 */
function iniciarApiPlanilla({ puerto, documento } = {}) {
  if (!process.env.PLANILLA_SYNC_TOKEN) {
    console.warn('[api-planilla] sin PLANILLA_SYNC_TOKEN: la planilla automática queda apagada.');
    return null;
  }
  const doc = documento || DOCUMENTOS.find((d) => d.codigo === 'retiros');
  if (!doc) {
    // Si alguien renombra el código del documento en el registro, esto tiene que
    // gritar al arrancar y no fallar recién con el primer POST del día.
    console.error('[api-planilla] no encontré el documento "retiros" en el registro. No levanto el endpoint.');
    return null;
  }

  // OJO con el `||` acá: el puerto 0 es válido y significa "el que haya libre"
  // (lo usan los tests). Con `puerto || default`, un 0 explícito caía al 8080 y
  // dos servidores de prueba peleaban por el mismo puerto.
  const p = (puerto === undefined || puerto === null)
    ? Number(process.env.PLANILLA_API_PORT || process.env.PORT || 8080)
    : Number(puerto);
  const server = http.createServer((req, res) => {
    manejar(req, res, { documento: doc }).catch((e) => {
      console.error('[api-planilla] error no atrapado:', e);
      try { responder(res, 500, { ok: false, error: 'Error interno.' }); } catch {}
    });
  });
  server.on('error', (e) => {
    // Si el puerto no se puede abrir, el bot sigue andando por Telegram como si
    // nada y la planilla deja de entrar en silencio. Es de los pocos casos que
    // hay que gritar aunque no haya nadie del otro lado esperando respuesta.
    console.error('[api-planilla] no pude escuchar:', e.message);
    avisarSiCambio('puerto', String(e.code || e.message), {
      proceso: 'la planilla automática de retiros',
      que: 'No pude abrir el puerto: la planilla no va a poder entrar sola.',
      detalle: `${e.code || ''} ${e.message}`.trim(),
      sugerencia: 'Revisar el puerto del servicio en Railway (Settings → Networking).',
      nivel: '❌',
    }).catch(() => {});
  });
  // Se loguea el puerto REAL y no el pedido: con puerto 0 el sistema elige uno, y
  // ver ":0" en el log no le sirve a nadie.
  server.listen(p, () => {
    const dir = server.address();
    console.log(`[api-planilla] escuchando en :${dir && dir.port ? dir.port : p}${RUTA}`);
  });
  return server;
}

module.exports = {
  iniciarApiPlanilla,
  // exportados para los tests
  procesarPlanillaHttp, tokenValido, ErrorHttp, RUTA, LIMITE_BYTES,
  ultimaPlanillaOk: () => ultimaOk,
  RECHAZOS_PARA_AVISAR,
  _resetAvisos: () => { avisosVistos.clear(); rechazosSeguidos = 0; ultimaOk = null; },
};
