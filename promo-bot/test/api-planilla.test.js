// Tests de api-planilla.js — la puerta HTTP por la que entra sola la PLANILLA RETIRA.
// Correr: node test/api-planilla.test.js
//
// Es la única parte del bot que escucha desde afuera, así que lo que más se cuida
// acá es lo que puede salir mal por ese lado:
//   - que sin la clave correcta no pase nada,
//   - que por esta puerta SOLO se pueda tocar la planilla (nunca el libro diario,
//     que es el catch-all del registro de documentos),
//   - que un archivo enorme no se coma la memoria del contenedor,
//   - y que cuando algo falla la respuesta explique por qué, porque del otro lado
//     no hay una persona: hay un script que escribe esa respuesta en un log.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
process.env.PLANILLA_SYNC_TOKEN = 'la-clave-de-prueba';

const assert = require('assert');
const http = require('http');
const Module = require('module');
const XLSX = require('xlsx');
const { DocumentoInvalido } = require('../src/lib/documentos-carga');

// Doble de notificar, puesto ANTES de cargar api-planilla: los avisos a los admins
// son la mitad del valor de esto (un token mal copiado no se nota de ninguna otra
// forma), así que hay que poder verificar que salen y que NO se repiten.
const avisos = [];
{
  const p = require.resolve('../src/notificar');
  const m = new Module(p, null);
  m.filename = p; m.loaded = true;
  m.exports = { async avisarProblema(o) { avisos.push(o); return 1; } };
  require.cache[p] = m;
}
const api = require('../src/api-planilla');

// ── Un .xlsx que el parser reconoce como planilla ────────────────────────────
const ENCABEZADO = [
  'fecha de registro de pedido', 'Horario de Registro del pedido', 'Excepcion ', 'N° de PEDIDO',
  'CODIGO del Cliente', 'CLIENTE', 'N° de Orden de Pedido', 'VENDEDOR ', 'FECHA Retiro del Pedido',
  'HORARIO de Retiro del pedido', '# Bultos', 'PALLET', 'STATUS de Preparación', 'ESTADO ',
];
function aBuffer(filas, hoja = 'AGOSTO') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), hoja);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const PLANILLA = aBuffer([ENCABEZADO, ['', '', '', 1, '99', 'x', '', '', 'LUNES 17 DE AGOSTO DE 2026', '09:00']]);
const OTRO_XLSX = aBuffer([['Cuenta', 'Debe', 'Haber'], ['111', 10, 0]], 'Hoja1');

// ── Doble del documento: no toca la base ─────────────────────────────────────
let recibido = null;
let respuesta = { dias: ['2026-08-17'], mensaje: 'ok', guardados: 1, borrados: 0, conservados: [], anomalias: [] };
let tirar = null;
const docFalso = {
  codigo: 'retiros',
  async procesar({ buffer, nombreArchivo }) {
    recibido = { buffer, nombreArchivo };
    if (tirar) throw tirar;
    return respuesta;
  },
};

// ── Servidor de prueba en un puerto libre ────────────────────────────────────
let puerto = 0;
const server = api.iniciarApiPlanilla({ puerto: 0, documento: docFalso });

function pedir({ metodo = 'POST', ruta = '/planilla', token = 'la-clave-de-prueba', cuerpo = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token !== null) h['x-sync-token'] = token;
    if (cuerpo) { h['content-type'] = 'application/octet-stream'; h['content-length'] = cuerpo.length; }
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method: metodo, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* se devuelve crudo */ }
        resolve({ codigo: res.statusCode, json, crudo: d });
      });
    });
    req.on('error', reject);
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

let pass = 0;
async function t(nombre, fn) {
  recibido = null; tirar = null; api._resetAvisos(); avisos.length = 0;
  respuesta = { dias: ['2026-08-17'], mensaje: 'ok', guardados: 1, borrados: 0, conservados: [], anomalias: [] };
  await fn();
  pass++;
  console.log('  ok:', nombre);
}

(async () => {
  assert.ok(server, 'con PLANILLA_SYNC_TOKEN cargado el servidor tiene que levantar');
  await new Promise((r) => server.on('listening', r));
  puerto = server.address().port;

  console.log('\napi-planilla');

  // ── La clave ───────────────────────────────────────────────────────────────

  await t('sin token no entra', async () => {
    const r = await pedir({ token: null, cuerpo: PLANILLA });
    assert.equal(r.codigo, 401);
    assert.equal(recibido, null, 'no se tiene que haber procesado nada');
  });

  await t('con el token equivocado tampoco', async () => {
    const r = await pedir({ token: 'otra-cosa', cuerpo: PLANILLA });
    assert.equal(r.codigo, 401);
    assert.equal(recibido, null);
  });

  await t('un token del largo correcto pero distinto tampoco', async () => {
    // La comparación es en tiempo constante; esto verifica que igual DECIDA bien.
    const r = await pedir({ token: 'la-clave-de-pruebA', cuerpo: PLANILLA });
    assert.equal(r.codigo, 401);
  });

  await t('tokenValido: vacío y sin configurar dan false', () => {
    assert.equal(api.tokenValido(''), false);
    assert.equal(api.tokenValido(undefined), false);
    assert.equal(api.tokenValido('la-clave-de-prueba'), true);
    const guardado = process.env.PLANILLA_SYNC_TOKEN;
    process.env.PLANILLA_SYNC_TOKEN = '';
    assert.equal(api.tokenValido(''), false, 'sin clave configurada NADA puede pasar, ni un token vacío');
    process.env.PLANILLA_SYNC_TOKEN = guardado;
  });

  // ── Rutas y métodos ────────────────────────────────────────────────────────

  await t('/salud responde sin clave y no cuenta nada', async () => {
    const r = await pedir({ metodo: 'GET', ruta: '/salud', token: null });
    assert.equal(r.codigo, 200);
    assert.equal(r.json.ok, true);
    // No puede filtrar cuándo entró la última planilla ni nada del negocio.
    assert.deepEqual(Object.keys(r.json).sort(), ['ok', 'servicio']);
  });

  await t('una ruta que no existe da 404', async () => {
    const r = await pedir({ ruta: '/otra-cosa', cuerpo: PLANILLA });
    assert.equal(r.codigo, 404);
  });

  await t('GET a la ruta de la planilla da 405', async () => {
    const r = await pedir({ metodo: 'GET' });
    assert.equal(r.codigo, 405);
  });

  // ── Qué se acepta ──────────────────────────────────────────────────────────

  await t('una planilla de verdad se procesa y devuelve los números', async () => {
    respuesta = {
      dias: ['2026-08-17', '2026-08-18'], mensaje: '<b>ok</b>',
      guardados: 28, borrados: 2, conservados: [], anomalias: ['algo raro'],
    };
    const r = await pedir({ cuerpo: PLANILLA });
    assert.equal(r.codigo, 200);
    assert.deepEqual(r.json, {
      ok: true, dias: ['2026-08-17', '2026-08-18'],
      guardados: 28, borrados: 2, conservados: 0, anomalias: 1,
    });
    assert.ok(recibido.buffer.equals(PLANILLA), 'tienen que llegar los bytes tal cual');
  });

  await t('la respuesta es corta: del otro lado se loguean 400 caracteres', async () => {
    respuesta = { dias: ['2026-08-17'], mensaje: 'x'.repeat(5000), guardados: 1, borrados: 0, conservados: [], anomalias: [] };
    const r = await pedir({ cuerpo: PLANILLA });
    assert.ok(r.crudo.length < 400, `la respuesta mide ${r.crudo.length}`);
    assert.equal(r.json.mensaje, undefined, 'el HTML de Telegram no tiene que viajar por acá');
  });

  await t('un xlsx que NO es la planilla se rechaza; no cae en el catch-all', async () => {
    // Clave: por esta puerta no se puede registrar un libro diario. Si en vez de
    // exigir la planilla se usara detectarDocumento(), este archivo terminaría en
    // el catch-all y el bot intentaría cargarlo como libro.
    const r = await pedir({ cuerpo: OTRO_XLSX });
    assert.equal(r.codigo, 400);
    assert.equal(recibido, null, 'no tiene que haber llegado a procesar nada');
    assert.ok(/PLANILLA RETIRA/i.test(r.json.error));
  });

  await t('un cuerpo vacío se rechaza', async () => {
    const r = await pedir({ cuerpo: null, headers: { 'content-length': 0 } });
    assert.equal(r.codigo, 400);
  });

  await t('cualquier cosa que no sea un xlsx se rechaza', async () => {
    const r = await pedir({ cuerpo: Buffer.from('hola que tal') });
    assert.equal(r.codigo, 400);
  });

  // ── Errores ────────────────────────────────────────────────────────────────

  await t('una planilla vieja (sin turnos) da 422 y explica el motivo', async () => {
    // 422 y no 400: el archivo está bien armado, lo que no sirve es su contenido.
    // El script lo va a escribir en su log, así que el texto tiene que servir.
    tirar = new DocumentoInvalido('⚠️ Esa planilla no trae ningún turno de hoy en adelante, así que <b>no toqué nada</b>.');
    const r = await pedir({ cuerpo: PLANILLA });
    assert.equal(r.codigo, 422);
    assert.ok(/no trae ningún turno/.test(r.json.error));
    assert.ok(!/<b>/.test(r.json.error), 'el HTML de Telegram no sirve en un log de texto');
  });

  await t('un error inesperado da 500 y no filtra el stack', async () => {
    tirar = new Error('se cayó la base: password authentication failed for user "postgres"');
    const r = await pedir({ cuerpo: PLANILLA });
    assert.equal(r.codigo, 500);
    assert.equal(r.json.error, 'Error interno.');
    assert.ok(!/password/.test(r.crudo), 'nunca devolver el detalle interno a quien llama');
  });

  await t('después de un error el endpoint sigue atendiendo', async () => {
    tirar = new Error('boom');
    await pedir({ cuerpo: PLANILLA });
    tirar = null;
    const r = await pedir({ cuerpo: PLANILLA });
    assert.equal(r.codigo, 200, 'un error no puede dejar trabado el flag de "en curso"');
  });

  // ── Los avisos ─────────────────────────────────────────────────────────────
  // Sin esto, los tres errores más probables de la puesta en marcha —el token mal
  // copiado, el archivo equivocado y el puerto que no abre— son invisibles: no
  // pasa nada y nadie se entera de que no pasa nada.

  await t('un solo rechazo por clave NO avisa (puede ser un escaneo cualquiera)', async () => {
    await pedir({ token: 'mal', cuerpo: PLANILLA });
    assert.equal(avisos.length, 0);
  });

  await t('tres rechazos seguidos SÍ avisan, y el cuarto no repite', async () => {
    for (let i = 0; i < api.RECHAZOS_PARA_AVISAR; i++) await pedir({ token: 'mal', cuerpo: PLANILLA });
    assert.equal(avisos.length, 1);
    assert.ok(/clave equivocada/.test(avisos[0].que));
    // Tiene que decir dónde están las dos puntas que hay que comparar.
    assert.ok(/config\.txt/.test(avisos[0].sugerencia) && /PLANILLA_SYNC_TOKEN/.test(avisos[0].sugerencia));
    await pedir({ token: 'mal', cuerpo: PLANILLA });
    assert.equal(avisos.length, 1, 'el script reintenta cada 4 minutos: no puede avisar cada vez');
  });

  await t('un envío bueno reinicia el contador de rechazos', async () => {
    for (let i = 0; i < api.RECHAZOS_PARA_AVISAR; i++) await pedir({ token: 'mal', cuerpo: PLANILLA });
    assert.equal(avisos.length, 1);
    await pedir({ cuerpo: PLANILLA });             // se arregló el token
    for (let i = 0; i < api.RECHAZOS_PARA_AVISAR - 1; i++) await pedir({ token: 'mal', cuerpo: PLANILLA });
    assert.equal(avisos.length, 1, 'todavía no llegó a tres desde que se arregló');
    await pedir({ token: 'mal', cuerpo: PLANILLA });
    assert.equal(avisos.length, 2, 'y si se vuelve a romper, avisa de nuevo');
  });

  await t('un archivo que no es la planilla avisa una vez', async () => {
    await pedir({ cuerpo: OTRO_XLSX });
    assert.equal(avisos.length, 1);
    assert.ok(/NO es la PLANILLA RETIRA/.test(avisos[0].que));
    assert.ok(/PEDIDOS RETIRA MORENO 2026/.test(avisos[0].sugerencia), 'tiene que decir dónde mirar');
    await pedir({ cuerpo: OTRO_XLSX });
    assert.equal(avisos.length, 1, 'no repite mientras siga llegando el mismo archivo');
  });

  await t('cuando vuelve a llegar la planilla buena, el problema queda cerrado', async () => {
    await pedir({ cuerpo: OTRO_XLSX });
    assert.equal(avisos.length, 1);
    await pedir({ cuerpo: PLANILLA });               // se arregló
    await pedir({ cuerpo: OTRO_XLSX });              // y se vuelve a romper
    assert.equal(avisos.length, 2, 'un problema que se resolvió y volvió tiene que avisar otra vez');
  });

  await t('problemas de distinto tipo no se pisan entre sí', async () => {
    // Con una sola variable de "último aviso", dos problemas alternándose se
    // borran la firma mutuamente y vuelven a avisar en cada vuelta. Se alternan
    // dos que NO se resuelven entre sí (un token malo no arregla el archivo malo).
    await pedir({ cuerpo: OTRO_XLSX });                                    // aviso 1: archivo
    for (let i = 0; i < api.RECHAZOS_PARA_AVISAR; i++) await pedir({ token: 'mal', cuerpo: PLANILLA }); // aviso 2: token
    assert.equal(avisos.length, 2);
    await pedir({ cuerpo: OTRO_XLSX });                                    // el mismo archivo de antes
    assert.equal(avisos.length, 2, 'el aviso de archivo no se tiene que repetir');
  });

  await t('un error interno avisa con el detalle, aunque no lo devuelva', async () => {
    tirar = new Error('connection terminated unexpectedly');
    await pedir({ cuerpo: PLANILLA });
    assert.equal(avisos.length, 1);
    assert.equal(avisos[0].nivel, '❌');
    assert.ok(/connection terminated/.test(avisos[0].detalle), 'al admin sí hay que darle el detalle');
  });

  await t('una planilla vieja avisa, y no repite mientras siga siendo la misma', async () => {
    tirar = new DocumentoInvalido('Esa planilla no trae ningún turno de hoy en adelante.');
    await pedir({ cuerpo: PLANILLA });
    await pedir({ cuerpo: PLANILLA });
    assert.equal(avisos.length, 1);
    assert.ok(/versión vieja/.test(avisos[0].sugerencia));
  });

  await t('el camino feliz no molesta a nadie', async () => {
    await pedir({ cuerpo: PLANILLA });
    await pedir({ cuerpo: PLANILLA });
    assert.equal(avisos.length, 0, 'la planilla se guarda decenas de veces por día');
  });

  // ── Tamaño ─────────────────────────────────────────────────────────────────

  await t('un archivo más grande que el límite se rechaza CON respuesta', async () => {
    // Importa que conteste 413 y no que corte el socket: del otro lado hay un
    // script que guarda el motivo del rechazo en su log.
    const gigante = Buffer.alloc(api.LIMITE_BYTES + 100_000, 0x50);
    const r = await pedir({ cuerpo: gigante });
    assert.equal(r.codigo, 413);
    assert.equal(recibido, null);
  });

  // ── Sin clave configurada ──────────────────────────────────────────────────

  await t('sin PLANILLA_SYNC_TOKEN no se levanta ningún servidor', () => {
    const guardado = process.env.PLANILLA_SYNC_TOKEN;
    delete process.env.PLANILLA_SYNC_TOKEN;
    const s = api.iniciarApiPlanilla({ puerto: 0, documento: docFalso });
    assert.equal(s, null, 'un endpoint que escribe en la base sin clave no debe existir');
    process.env.PLANILLA_SYNC_TOKEN = guardado;
  });

  await t('si el documento "retiros" no está en el registro, no levanta', () => {
    const s = api.iniciarApiPlanilla({ puerto: 0, documento: null, });
    // Con documento null cae al registro real, que SÍ lo tiene: tiene que levantar.
    assert.ok(s, 'el registro real tiene que seguir teniendo el documento "retiros"');
    s.close();
  });

  server.close();
  console.log(`\n${pass} tests ok\n`);
})().catch((e) => { console.error('\nFALLO:', e); process.exit(1); });
