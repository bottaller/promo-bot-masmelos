// Tests del botón "Intentar cargarla de nuevo" que viaja con el aviso cuando falla
// la carga automática de la planilla. Correr: node test/reintento-planilla.test.js
//
// Lo que se cuida:
//   - que el botón lo pueda tocar solo un admin (un callback_data se repite a mano),
//   - que reintentar corra EL MISMO procesar que /carga, así el resultado no puede
//     diferir del que se hubiera obtenido subiéndola a mano,
//   - que si el bot se reinició y el archivo ya no está, lo diga y ofrezca la
//     salida de siempre en vez de quedarse mudo,
//   - y que la memoria no crezca sin techo: es un contenedor chico y una planilla
//     rota reintentándose sola lo llenaría en un día.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const assert = require('assert');
const { DocumentoInvalido, DOCUMENTOS } = require('../src/lib/documentos-carga');
const reintento = require('../src/lib/reintento-planilla');
const { registrarAccionesPlanilla } = require('../src/acciones-planilla');

// ── Bot de mentira: solo guarda el handler del botón ─────────────────────────
let handler = null;
const botFalso = { action(_re, fn) { handler = fn; } };
registrarAccionesPlanilla(botFalso);
assert.ok(handler, 'tiene que haberse registrado el handler del botón');

function ctxFalso({ id = 'abc1', esAdmin = true } = {}) {
  const c = {
    match: [null, id],
    state: { usuario: esAdmin ? { id: 7, es_admin: true } : { id: 8, es_admin: false } },
    cbq: [], respuestas: [], saqueBoton: false,
    async answerCbQuery(texto, opts) { c.cbq.push({ texto, opts }); },
    async editMessageReplyMarkup() { c.saqueBoton = true; },
    async reply(texto, opts) { c.respuestas.push({ texto, opts }); },
  };
  return c;
}

// El documento real del registro, con `procesar` intercambiable para no tocar la base.
const doc = DOCUMENTOS.find((d) => d.codigo === 'retiros');
const procesarReal = doc.procesar;
let procesarFalso = async () => ({ mensaje: '✅ Planilla cargada.', dias: ['2026-08-24'] });
doc.procesar = (...a) => procesarFalso(...a);

const XLSX_FALSO = Buffer.from('PK\x03\x04 planilla de mentira');

let pass = 0;
async function t(nombre, fn) {
  reintento._reset();
  procesarFalso = async () => ({ mensaje: '✅ Planilla cargada.', dias: ['2026-08-24'] });
  await fn(); pass++; console.log('  ok:', nombre);
}

(async () => {
  console.log('\nreintento de la planilla');

  // ── El almacén ─────────────────────────────────────────────────────────────

  await t('guardar devuelve un id corto: tiene que entrar en un callback_data', () => {
    const id = reintento.guardar(XLSX_FALSO, 'x.xlsx');
    // Telegram corta el callback_data en 64 bytes; un file_id suyo ni entra.
    assert.ok(`planilla_reintentar:${id}`.length <= 64);
    assert.ok(/^[A-Za-z0-9]+$/.test(id), id);
    assert.ok(reintento.tomar(id).buffer.equals(XLSX_FALSO));
  });

  await t('un buffer vacío no se guarda', () => {
    assert.equal(reintento.guardar(Buffer.alloc(0), 'x.xlsx'), null);
    assert.equal(reintento.guardar(null, 'x.xlsx'), null);
  });

  await t('un id que no existe devuelve null, no explota', () => {
    assert.equal(reintento.tomar('noexiste'), null);
    assert.equal(reintento.tomar(undefined), null);
  });

  await t('no se acumulan más de MAX_PIEZAS: las viejas se van', () => {
    const ids = [];
    for (let i = 0; i < reintento.MAX_PIEZAS + 3; i++) ids.push(reintento.guardar(XLSX_FALSO, `x${i}.xlsx`));
    assert.equal(reintento._cantidad(), reintento.MAX_PIEZAS);
    assert.equal(reintento.tomar(ids[0]), null, 'la primera ya no está');
    assert.ok(reintento.tomar(ids[ids.length - 1]), 'la última sí');
  });

  await t('dos guardados seguidos no comparten id', () => {
    assert.notEqual(reintento.guardar(XLSX_FALSO, 'a.xlsx'), reintento.guardar(XLSX_FALSO, 'b.xlsx'));
  });

  // ── El botón ───────────────────────────────────────────────────────────────

  await t('un no-admin no puede reintentar', async () => {
    const id = reintento.guardar(XLSX_FALSO, 'x.xlsx');
    let llamado = false;
    procesarFalso = async () => { llamado = true; return { mensaje: 'ok' }; };
    const ctx = ctxFalso({ id, esAdmin: false });
    await handler(ctx);
    assert.equal(llamado, false, 'no se tiene que haber procesado nada');
    assert.ok(/solo para admins/i.test(ctx.cbq[0].texto));
    assert.equal(ctx.respuestas.length, 0);
  });

  await t('un admin reintenta y ve el MISMO mensaje que muestra /carga', async () => {
    const id = reintento.guardar(XLSX_FALSO, 'PLANILLA.xlsx');
    let recibido = null;
    procesarFalso = async (args) => {
      recibido = args;
      return { mensaje: '✅ <b>Planilla de retiros</b> actualizada.\n📅 24/08: 15 pedido(s)' };
    };
    const ctx = ctxFalso({ id });
    await handler(ctx);
    assert.ok(recibido.buffer.equals(XLSX_FALSO), 'los bytes tal cual');
    assert.equal(recibido.nombreArchivo, 'PLANILLA.xlsx');
    assert.equal(recibido.usuarioId, 7, 'queda registrado quién lo reintentó');
    assert.ok(/actualizada/.test(ctx.respuestas[0].texto));
    assert.equal(ctx.respuestas[0].opts.parse_mode, 'HTML');
  });

  await t('el botón se saca ANTES de trabajar, para que no lo aprieten dos veces', async () => {
    const id = reintento.guardar(XLSX_FALSO, 'x.xlsx');
    let sacadoAlEmpezar = null;
    const ctx = ctxFalso({ id });
    procesarFalso = async () => { sacadoAlEmpezar = ctx.saqueBoton; return { mensaje: 'ok' }; };
    await handler(ctx);
    assert.equal(sacadoAlEmpezar, true, 'si tarda, un segundo toque duplicaría la importación');
  });

  await t('si el bot se reinició, lo dice y ofrece la salida de siempre', async () => {
    // El archivo vivía en memoria. No puede quedar un botón mudo.
    const ctx = ctxFalso({ id: 'yanoesta' });
    await handler(ctx);
    assert.ok(/se reinició/.test(ctx.respuestas[0].texto));
    assert.ok(/\/carga/.test(ctx.respuestas[0].texto), 'tiene que decir cómo seguir');
    assert.equal(ctx.saqueBoton, true, 'y sacar el botón que ya no sirve');
  });

  await t('si la planilla sigue sin servir, se explica en vez de fallar mudo', async () => {
    const id = reintento.guardar(XLSX_FALSO, 'x.xlsx');
    procesarFalso = async () => { throw new DocumentoInvalido('No trae ningún turno de hoy en adelante.'); };
    const ctx = ctxFalso({ id });
    await handler(ctx);
    assert.ok(/No trae ningún turno/.test(ctx.respuestas[0].texto));
  });

  await t('si vuelve a fallar por otra cosa, se dice y se sugiere reintentar despues', async () => {
    const id = reintento.guardar(XLSX_FALSO, 'x.xlsx');
    procesarFalso = async () => { throw new Error('connection terminated'); };
    const ctx = ctxFalso({ id });
    await handler(ctx);
    assert.ok(/Volvió a fallar/.test(ctx.respuestas[0].texto));
    assert.ok(/connection terminated/.test(ctx.respuestas[0].texto));
  });

  await t('reintentar dos veces con el mismo id no procesa dos veces de más', async () => {
    // El almacén no consume el id (por si el primer intento falla y se quiere
    // volver a probar), pero el botón ya no está en el mensaje. Lo que importa es
    // que la SEGUNDA vez tampoco rompa nada.
    const id = reintento.guardar(XLSX_FALSO, 'x.xlsx');
    let veces = 0;
    procesarFalso = async () => { veces++; return { mensaje: 'ok' }; };
    await handler(ctxFalso({ id }));
    await handler(ctxFalso({ id }));
    assert.equal(veces, 2, 'y el merge es idempotente, así que no duplica pedidos');
  });

  doc.procesar = procesarReal;
  console.log(`\n${pass} tests ok\n`);
})().catch((e) => { doc.procesar = procesarReal; console.error('\nFALLO:', e); process.exit(1); });
