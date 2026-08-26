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
const canal = require('../src/lib/canal-planilla');

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

  // ── El archivo va adjunto ──────────────────────────────────────────────────
  // Describir el problema no alcanza: el admin tiene que poder ABRIR el archivo
  // sin ir hasta la PC de la sucursal.

  await t('el aviso de archivo equivocado lleva el archivo adjunto', async () => {
    await pedir({ cuerpo: OTRO_XLSX, headers: { 'x-archivo': 'lo que sea.xlsx' } });
    const a = avisos[0].archivo;
    assert.ok(a, 'sin adjunto el aviso no sirve para nada');
    assert.ok(a.buffer.equals(OTRO_XLSX), 'tienen que ir los bytes que llegaron, tal cual');
    // El nombre ORIGINAL va primero: Telegram recorta los nombres largos por el
    // medio, y con la fecha adelante lo que desaparecía era justo el nombre.
    assert.ok(/^lo que sea \(RECHAZADA \d{4}-\d{2}-\d{2}_\d{4}\)\.xlsx$/.test(a.nombre), a.nombre);
    assert.ok(a.leyenda);
  });

  await t('la extensión sale del CONTENIDO, no del nombre que mandaron', async () => {
    // Es el error que hacía que Excel dijera "archivo dañado": se le ponía .xlsx
    // a algo que no era un Excel y parecía que el aviso estaba roto.
    await pedir({ cuerpo: Buffer.from('esto es texto plano'), headers: { 'x-archivo': 'mentira.xlsx' } });
    assert.ok(avisos[0].archivo.nombre.endsWith('.txt'), avisos[0].archivo.nombre);
  });

  await t('un xlsx de verdad conserva .xlsx aunque no sea la planilla', async () => {
    // Un Excel real que no es la planilla TIENE que abrirse con Excel.
    await pedir({ cuerpo: OTRO_XLSX, headers: { 'x-archivo': 'cualquiera.xlsx' } });
    assert.ok(avisos[0].archivo.nombre.endsWith('.xlsx'));
  });

  await t('el aviso dice el tamaño en bytes cuando es chiquito', async () => {
    // "Pesa 0 KB" hace parecer que el archivo está vacío o que el aviso falló.
    await pedir({ cuerpo: Buffer.alloc(89, 0x41) });
    assert.ok(/89 bytes/.test(avisos[0].detalle), avisos[0].detalle);
    assert.ok(!/0 KB/.test(avisos[0].detalle));
    assert.ok(/Ni siquiera parece un Excel/.test(avisos[0].detalle), 'si no es un Excel, decirlo');
  });

  await t('con un Excel de verdad no dice que no parece un Excel', async () => {
    await pedir({ cuerpo: OTRO_XLSX });
    assert.ok(!/Ni siquiera/.test(avisos[0].detalle), avisos[0].detalle);
  });

  await t('extensionReal y tamanoLegible, caso por caso', () => {
    const ex = api.extensionReal;
    assert.equal(ex(Buffer.from('PK\x03\x04algo'), '.xlsx'), '.xlsx');
    assert.equal(ex(Buffer.from('PK\x03\x04algo'), '.xlsm'), '.xlsm', 'respeta xlsm');
    assert.equal(ex(Buffer.from('PK\x03\x04algo'), '.txt'), '.xlsx', 'es un zip: manda el contenido');
    assert.equal(ex(Buffer.from('%PDF-1.7 ...'), '.xlsx'), '.pdf');
    assert.equal(ex(Buffer.from('d0cf11e0a1b11ae1', 'hex'), '.xlsx'), '.xls', 'Excel viejo (OLE2)');
    assert.equal(ex(Buffer.from('hola\nque tal'), '.xlsx'), '.txt');
    assert.equal(ex(Buffer.from([0, 1, 2, 3, 255]), '.xlsx'), '.bin', 'binario desconocido');
    assert.equal(ex(Buffer.alloc(0), '.xlsx'), '.bin');

    assert.equal(api.tamanoLegible(0), '0 bytes');
    assert.equal(api.tamanoLegible(89), '89 bytes');
    assert.equal(api.tamanoLegible(1023), '1023 bytes');
    assert.equal(api.tamanoLegible(1024), '1 KB');
    assert.equal(api.tamanoLegible(104791), '102 KB');
  });

  await t('el aviso de planilla vieja lleva la planilla', async () => {
    tirar = new DocumentoInvalido('No trae ningún turno de hoy en adelante.');
    await pedir({ cuerpo: PLANILLA });
    assert.ok(avisos[0].archivo.buffer.equals(PLANILLA));
  });

  await t('el aviso de error interno lleva el archivo que se estaba procesando', async () => {
    tirar = new Error('la base no responde');
    await pedir({ cuerpo: PLANILLA });
    assert.ok(avisos[0].archivo, 'puede ser un bug del parser con ESTE archivo: es la evidencia');
    assert.ok(avisos[0].archivo.buffer.equals(PLANILLA));
  });

  await t('el nombre del adjunto se limpia: viene de un header', async () => {
    // El nombre lo elige quien llama. Sin limpiarlo, barras y caracteres raros
    // terminan en un nombre de archivo.
    await pedir({ cuerpo: OTRO_XLSX, headers: { 'x-archivo': '../../etc/algo:raro?.xlsx' } });
    const n = avisos[0].archivo.nombre;
    assert.ok(!n.includes('/') && !n.includes('\\'), n);
    assert.ok(!/[:*?"<>|]/.test(n), n);
    assert.ok(n.endsWith('.xlsx'), n);
    assert.ok(n.includes('(RECHAZADA '), n);
  });

  await t('sin nombre en el header igual sale con extensión', async () => {
    await pedir({ cuerpo: OTRO_XLSX, headers: {} });
    assert.ok(avisos[0].archivo.nombre.endsWith('.xlsx'), avisos[0].archivo.nombre);
  });

  await t('el aviso por clave equivocada NO lleva archivo', async () => {
    // Con el token mal ni siquiera se lee el cuerpo: no hay nada que mandar, y
    // reenviar lo que sea que mandó un desconocido sería peor.
    for (let i = 0; i < api.RECHAZOS_PARA_AVISAR; i++) await pedir({ token: 'mal', cuerpo: PLANILLA });
    assert.equal(avisos.length, 1);
    assert.equal(avisos[0].archivo, undefined);
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

  // ── El latido ──────────────────────────────────────────────────────────────
  // Es lo que permite distinguir "el script murió" de "nadie tocó el Excel".
  // Sin esto las dos se ven igual desde el servidor: no llega nada.

  await t('un latido queda registrado con lo que ve el script', async () => {
    const r = await pedir({
      ruta: '/planilla/latido',
      headers: {
        'x-equipo': 'DESKTOP-GO5TPVR', 'x-estado': 'ok',
        'x-archivo': 'PLANILLA RETIRA MORENO 2026.xlsx',
        'x-archivo-fecha': '2026-08-24 10:15', 'x-archivo-tam': '104791',
      },
    });
    assert.equal(r.codigo, 200);
    const l = canal.ultimoLatido();
    assert.equal(l.equipo, 'DESKTOP-GO5TPVR');
    assert.equal(l.estado, 'ok');
    assert.equal(l.archivo, 'PLANILLA RETIRA MORENO 2026.xlsx');
    assert.equal(l.tam, 104791);
    assert.ok(l.en instanceof Date);
    assert.equal(avisos.length, 0, 'un latido sano no molesta a nadie');
  });

  await t('el latido también necesita la clave', async () => {
    const r = await pedir({ ruta: '/planilla/latido', token: 'mal' });
    assert.equal(r.codigo, 401);
    assert.equal(canal.ultimoLatido(), null);
  });

  await t('si el script dice que NO llega al archivo, se avisa en el momento', async () => {
    // El script ya sabe cuál es el problema: no hay que esperar tres horas para
    // deducirlo desde el servidor.
    await pedir({
      ruta: '/planilla/latido',
      headers: {
        'x-equipo': 'DESKTOP-GO5TPVR', 'x-estado': 'sin-archivo',
        'x-motivo': 'no se llego a la carpeta compartida',
      },
    });
    assert.equal(avisos.length, 1);
    assert.ok(/no está llegando al archivo/.test(avisos[0].que));
    assert.ok(/carpeta compartida/.test(avisos[0].detalle));
    assert.ok(/Recordar mis credenciales/.test(avisos[0].sugerencia), 'la causa más común');
  });

  await t('el problema de la sucursal no se repite, y se cierra cuando vuelve', async () => {
    const malo = {
      ruta: '/planilla/latido',
      headers: { 'x-equipo': 'X', 'x-estado': 'sin-archivo', 'x-motivo': 'mismo problema' },
    };
    await pedir(malo);
    await pedir(malo);
    assert.equal(avisos.length, 1, 'late cada 4 minutos: no puede avisar cada vez');
    await pedir({ ruta: '/planilla/latido', headers: { 'x-equipo': 'X', 'x-estado': 'ok' } });
    await pedir(malo);
    assert.equal(avisos.length, 2, 'si se arregla y vuelve a romperse, avisa de nuevo');
  });

  await t('una planilla que entra también cuenta como latido', async () => {
    // Si no, un sync que manda seguido pero cuyos latidos se pierden parecería
    // caído y saldría un aviso falso.
    assert.equal(canal.ultimoLatido(), null);
    await pedir({ cuerpo: PLANILLA, headers: { 'x-equipo': 'DESKTOP-GO5TPVR' } });
    assert.ok(canal.ultimoLatido(), 'tiene que haber quedado registrado');
    assert.equal(canal.ultimoLatido().equipo, 'DESKTOP-GO5TPVR');
  });

  await t('/planilla/estado cuenta si esta llegando el latido', async () => {
    // Sin esto, "¿el script esta reportando?" solo se podia responder yendo hasta
    // la maquina. Es la pregunta que mas veces hubo que hacerse.
    await pedir({ ruta: '/planilla/latido', headers: { 'x-equipo': 'DESKTOP-GO5TPVR', 'x-estado': 'ok', 'x-archivo': 'PLANILLA.xlsx' } });
    const r = await pedir({ metodo: 'GET', ruta: '/planilla/estado' });
    assert.equal(r.codigo, 200);
    assert.equal(r.json.latido.equipo, 'DESKTOP-GO5TPVR');
    assert.equal(r.json.latido.estado, 'ok');
    assert.equal(r.json.latido.hace_min, 0);
    assert.equal(typeof r.json.minutosDespierto, 'number');
  });

  await t('sin latidos, el estado lo dice en vez de mentir', async () => {
    const r = await pedir({ metodo: 'GET', ruta: '/planilla/estado' });
    assert.equal(r.json.latido, null);
  });

  await t('el estado necesita la clave: dice que maquina manda y a que hora', async () => {
    const r = await pedir({ metodo: 'GET', ruta: '/planilla/estado', token: 'mal' });
    assert.equal(r.codigo, 401);
  });

  await t('el estado es de lectura: un POST ahi da 405', async () => {
    const r = await pedir({ metodo: 'POST', ruta: '/planilla/estado' });
    assert.equal(r.codigo, 405);
  });

  await t('un fallo de ENVIO no se confunde con no poder leer el archivo', async () => {
    // El aviso real que salio decia "la PC de la sucursal no esta pudiendo leer la
    // planilla" cuando lo que habia fallado era el envio, por un 502 de nuestro
    // propio deploy. Mandar a revisar el servidor de archivos por un problema
    // nuestro es peor que no avisar.
    const malo = {
      ruta: '/planilla/latido',
      headers: { 'x-equipo': 'DESKTOP-GO5TPVR', 'x-estado': 'error',
                 'x-motivo': 'Error en el servidor remoto: (502) Puerta de enlace no valida.' },
    };
    await pedir(malo);
    await pedir(malo);
    assert.equal(avisos.length, 0, 'el script reintenta solo: uno o dos no son noticia');
    await pedir(malo);
    assert.equal(avisos.length, 1, `recien al intento ${api.ERRORES_PARA_AVISAR}`);
    assert.ok(/no la puede mandar/.test(avisos[0].que), avisos[0].que);
    assert.ok(!/leer/.test(avisos[0].que), 'no puede decir que no puede LEER el archivo');
    assert.ok(!/Recordar mis credenciales/.test(avisos[0].sugerencia), 'ni mandar al servidor de archivos');
    assert.ok(/502/.test(avisos[0].sugerencia), 'y si nombrar la causa mas probable');
  });

  await t('un latido bueno reinicia el contador de fallos de envio', async () => {
    const malo = { ruta: '/planilla/latido', headers: { 'x-estado': 'error', 'x-motivo': 'timeout' } };
    await pedir(malo); await pedir(malo);
    await pedir({ ruta: '/planilla/latido', headers: { 'x-estado': 'ok' } });
    await pedir(malo); await pedir(malo);
    assert.equal(avisos.length, 0, 'volvio a arrancar de cero');
    await pedir(malo);
    assert.equal(avisos.length, 1);
  });

  await t('no llegar al ARCHIVO si avisa en el primer latido', async () => {
    await pedir({
      ruta: '/planilla/latido',
      headers: { 'x-equipo': 'DESKTOP-GO5TPVR', 'x-estado': 'sin-archivo',
                 'x-motivo': 'no se llego a la carpeta compartida' },
    });
    assert.equal(avisos.length, 1, 'este si necesita una persona ya');
    assert.ok(/no está llegando al archivo/.test(avisos[0].que));
    // La ruta tiene que salir ENTERA: escrita a mano salio " 92.168.0.210Compartida".
    assert.ok(avisos[0].sugerencia.includes(api.RUTA_COMPARTIDA), avisos[0].sugerencia);
    // Se cuentan las barras en vez de usar una expresion regular: escribir barras
    // dentro de una regex es justamente donde ya se perdieron dos veces.
    const barras = api.RUTA_COMPARTIDA.split(String.fromCharCode(92)).length - 1;
    assert.equal(barras, 3, 'dos al principio y una en el medio: ' + api.RUTA_COMPARTIDA);
    assert.ok(api.RUTA_COMPARTIDA.endsWith('Compartida'));
    assert.ok(api.RUTA_COMPARTIDA.includes('192.168.0.210'));
  });

  await t('una ruta parecida pero distinta sigue dando 404', async () => {
    assert.equal((await pedir({ ruta: '/planilla/latidos' })).codigo, 404);
    assert.equal((await pedir({ ruta: '/latido' })).codigo, 404);
  });

  // ── Lo que el parser entiende A MEDIAS ─────────────────────────────────────
  // Es el caso peor: la planilla "entra bien" pero hay lineas que el bot no
  // entendio y descarto. Esos pedidos no llegan a la pantalla y, sin aviso, se
  // descubre cuando un cliente reclama.

  await t('si el parser no entendio algunas lineas, avisa CON el archivo', async () => {
    respuesta = {
      dias: ['2026-08-25'], mensaje: 'ok', guardados: 30, borrados: 0, conservados: [],
      anomalias: ['AGOSTO: un bloque no tiene las columnas de codigo y horario.',
                  'AGOSTO 2026-08-25: el cliente 41163 no tiene horario de retiro.'],
    };
    const r = await pedir({ cuerpo: PLANILLA });
    assert.equal(r.codigo, 200, 'la planilla igual entro: no es un rechazo');
    assert.equal(avisos.length, 1);
    assert.ok(/NO entendió/.test(avisos[0].que), avisos[0].que);
    assert.ok(/41163/.test(avisos[0].detalle), 'tiene que decir QUE lineas');
    assert.ok(avisos[0].archivo.buffer.equals(PLANILLA), 'y mandar el archivo para poder arreglarlo');
  });

  await t('las mismas anomalias no vuelven a avisar; unas nuevas si', async () => {
    const base = { dias: ['2026-08-25'], mensaje: 'ok', guardados: 30, borrados: 0, conservados: [] };
    respuesta = { ...base, anomalias: ['algo raro'] };
    await pedir({ cuerpo: PLANILLA });
    await pedir({ cuerpo: PLANILLA });
    assert.equal(avisos.length, 1, 'la planilla se guarda decenas de veces por dia');
    respuesta = { ...base, anomalias: ['algo raro', 'otra cosa'] };
    await pedir({ cuerpo: PLANILLA });
    assert.equal(avisos.length, 2, 'una anomalia nueva si es noticia');
  });

  await t('cuando se arreglan las anomalias, el problema queda cerrado', async () => {
    const base = { dias: ['2026-08-25'], mensaje: 'ok', guardados: 30, borrados: 0, conservados: [] };
    respuesta = { ...base, anomalias: ['algo raro'] };
    await pedir({ cuerpo: PLANILLA });
    respuesta = { ...base, anomalias: [] };
    await pedir({ cuerpo: PLANILLA });          // arreglado
    respuesta = { ...base, anomalias: ['algo raro'] };
    await pedir({ cuerpo: PLANILLA });          // vuelve a romperse
    assert.equal(avisos.length, 2, 'si vuelve a pasar hay que avisar de nuevo');
  });

  await t('una planilla limpia no avisa nada', async () => {
    respuesta = { dias: ['2026-08-25'], mensaje: 'ok', guardados: 30, borrados: 1, conservados: [], anomalias: [] };
    await pedir({ cuerpo: PLANILLA });
    assert.equal(avisos.length, 0, 'un borrado suelto es un pedido dado de baja, normal');
  });

  await t('si desaparecen muchos pedidos de golpe, avisa con el archivo', async () => {
    // Puede ser real o puede ser que el parser dejo de ver filas: desde aca no se
    // distingue, y lo segundo ya paso (una ventana fija de 16 filas por dia).
    respuesta = { dias: ['2026-08-25'], mensaje: 'ok', guardados: 20, borrados: 9, conservados: [], anomalias: [] };
    const r = await pedir({ cuerpo: PLANILLA });
    assert.equal(r.codigo, 200);
    assert.equal(avisos.length, 1);
    assert.ok(/Desaparecieron 9 pedidos/.test(avisos[0].que), avisos[0].que);
    assert.ok(avisos[0].archivo, 'con el archivo, para poder mirar que paso');
  });

  // ── Tamaño ─────────────────────────────────────────────────────────────────

  await t('un archivo más grande que el límite se rechaza CON respuesta, y se avisa', async () => {
    // Importa que conteste 413 y no que corte el socket: del otro lado hay un
    // script que guarda el motivo del rechazo en su log.
    // Y que AVISE: era el único rechazo mudo, así que la planilla dejaba de
    // entrar y de este lado no se enteraba nadie.
    const gigante = Buffer.alloc(api.LIMITE_BYTES + 100_000, 0x50);
    const r = await pedir({ cuerpo: gigante });
    assert.equal(r.codigo, 413);
    assert.equal(recibido, null);
    assert.equal(avisos.length, 1);
    assert.ok(/demasiado grande/.test(avisos[0].que));
    assert.ok(/imagen pegada/.test(avisos[0].sugerencia), 'la causa más común');
  });

  // ── El botón de reintento ──────────────────────────────────────────────────

  await t('el aviso de error interno trae el botón para reintentar', async () => {
    tirar = new Error('la base no responde');
    await pedir({ cuerpo: PLANILLA });
    const b = avisos[0].botones;
    assert.ok(b, 'un error transitorio se resuelve con un toque, no bajando el adjunto');
    assert.ok(/planilla_reintentar:/.test(b[0][0].callback_data));
    assert.ok(b[0][0].callback_data.length <= 64, 'Telegram corta el callback_data en 64 bytes');
  });

  await t('los rechazos que reintentar NO puede arreglar no traen botón', async () => {
    // Es el mismo parser: reintentar da exactamente el mismo resultado. Un botón
    // que no puede funcionar es peor que ninguno — la primera vez que alguien lo
    // aprieta y no pasa nada, deja de creerle a todo el aviso.
    await pedir({ cuerpo: OTRO_XLSX });
    assert.equal(avisos[0].botones, undefined, 'no es la planilla: reintentar no cambia nada');

    api._resetAvisos(); avisos.length = 0;
    tirar = new DocumentoInvalido('No trae ningún turno de hoy en adelante.');
    await pedir({ cuerpo: PLANILLA });
    assert.equal(avisos[0].botones, undefined, 'planilla vieja: reintentar no la hace nueva');
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
