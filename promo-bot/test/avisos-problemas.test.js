// Tests del sistema de avisos de problemas: el FORMATO del mensaje y el chequeo de envs.
// Las partes puras (sin bot ni base). Correr: node test/avisos-problemas.test.js

// notificar.js arrastra db/usuarios → db/pool, y pool exige DATABASE_URL apenas se lo
// requiere. No se conecta a nada; sin esta línea el test solo pasaba si la variable ya
// estaba exportada en la shell.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const assert = require('assert');
const Module = require('module');

// Doble de db/usuarios, para poder probar el ENVÍO de avisarProblema (no solo el
// formato) sin base. Va antes de requerir notificar.
let adminsFalsos = ['111', '222'];
{
  const p = require.resolve('../src/db/usuarios');
  const m = new Module(p, null);
  m.filename = p; m.loaded = true;
  m.exports = {
    async telegramIdsAdmins() { return adminsFalsos; },
    async telegramIdsPorRol() { return []; },
  };
  require.cache[p] = m;
}

const { formatearProblema, avisarProblema, setBot } = require('../src/notificar');
const { funcionalesFaltantes, FUNCIONALES, falta } = require('../src/lib/chequear-env');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

console.log('formatearProblema(): mensaje consistente para los admins');
t('arma el mensaje con proceso, qué, detalle y sugerencia', () => {
  const msg = formatearProblema({ proceso: 'arqueo Talo', que: 'no bajó', detalle: 'timeout', sugerencia: 'revisá', nivel: '❌' });
  assert.match(msg, /❌ <b>Problema en arqueo Talo<\/b>/);
  assert.match(msg, /no bajó/);
  assert.match(msg, /timeout/);
  assert.match(msg, /👉 revisá/);
});
t('escapa el HTML (si no, Telegram rechaza el mensaje entero)', () => {
  const msg = formatearProblema({ proceso: 'x', que: 'falló <tag> & "cosa"' });
  assert.match(msg, /&lt;tag&gt; &amp;/);
  assert.ok(!/<tag>/.test(msg));
});
t('sin detalle ni sugerencia no rompe y usa el nivel default (⚠️)', () => {
  const msg = formatearProblema({ proceso: 'x', que: 'y' });
  assert.match(msg, /⚠️ <b>Problema en x<\/b>/);
});
t('recorta el detalle largo para no pasarse del tope de Telegram', () => {
  const msg = formatearProblema({ proceso: 'x', que: 'y', detalle: 'z'.repeat(5000) });
  assert.ok(msg.length < 2000, `mide ${msg.length}`);
});

console.log('\nchequear-env: detecta variables funcionales faltantes');
t('una variable ausente o vacía (solo espacios) cuenta como faltante', () => {
  const prev = process.env.OWNER_TELEGRAM_ID;
  delete process.env.OWNER_TELEGRAM_ID;
  assert.strictEqual(falta('OWNER_TELEGRAM_ID'), true);
  process.env.OWNER_TELEGRAM_ID = '   ';
  assert.strictEqual(falta('OWNER_TELEGRAM_ID'), true);
  process.env.OWNER_TELEGRAM_ID = '123';
  assert.strictEqual(falta('OWNER_TELEGRAM_ID'), false);
  if (prev === undefined) delete process.env.OWNER_TELEGRAM_ID; else process.env.OWNER_TELEGRAM_ID = prev;
});
t('funcionalesFaltantes() devuelve las que faltan, cada una con su "rompe"', () => {
  const backup = {};
  for (const v of FUNCIONALES) { backup[v.nombre] = process.env[v.nombre]; delete process.env[v.nombre]; }
  try {
    const faltan = funcionalesFaltantes();
    assert.strictEqual(faltan.length, FUNCIONALES.length);
    assert.ok(faltan.every((v) => v.nombre && v.rompe), 'cada faltante trae nombre y qué rompe');
    process.env.TALO_USER_ID = 'U1';
    assert.strictEqual(funcionalesFaltantes().length, FUNCIONALES.length - 1);
  } finally {
    for (const v of FUNCIONALES) { if (backup[v.nombre] === undefined) delete process.env[v.nombre]; else process.env[v.nombre] = backup[v.nombre]; }
  }
});

// ── avisarProblema(): el envío, con y sin archivo adjunto ───────────────────
// Cuando el problema ES un archivo (una planilla que no se pudo procesar), el aviso
// va con el archivo pegado: si no, el admin tiene que ir hasta la PC de la sucursal
// a buscarlo, que es justo lo que hace que nadie lo mire.

function botFalso({ fallarDocA = null, fallarMsgA = null } = {}) {
  const mensajes = [];
  const documentos = [];
  return {
    mensajes,
    documentos,
    telegram: {
      async sendMessage(tid, texto, opts) {
        if (fallarMsgA === tid) throw new Error('bloqueado por el usuario');
        mensajes.push({ tid, texto, opts });
      },
      async sendDocument(tid, doc, opts) {
        if (fallarDocA === tid) throw new Error('no pude subir');
        documentos.push({ tid, doc, opts });
        // Telegram devuelve el file_id del archivo que acaba de subir.
        return { document: { file_id: 'FILEID-1' } };
      },
    },
  };
}

const XLSX_FALSO = Buffer.from('PKcontenido');

async function ta(nombre, fn) { await fn(); pass++; console.log('  ok:', nombre); }

(async () => {
  console.log('\navisarProblema(): envío a los admins');

  await ta('sin archivo manda solo el texto, a cada admin una vez', async () => {
    const b = botFalso(); setBot(b);
    const n = await avisarProblema({ proceso: 'algo', que: 'falló' });
    assert.strictEqual(n, 2);
    assert.strictEqual(b.mensajes.length, 2);
    assert.strictEqual(b.documentos.length, 0);
  });

  await ta('con archivo manda el texto Y el archivo', async () => {
    const b = botFalso(); setBot(b);
    await avisarProblema({
      proceso: 'la planilla', que: 'no se pudo usar',
      archivo: { buffer: XLSX_FALSO, nombre: 'RECHAZADA.xlsx', leyenda: 'mirá esto' },
    });
    assert.strictEqual(b.documentos.length, 2, 'a los dos admins');
    assert.deepStrictEqual(b.documentos[0].doc, { source: XLSX_FALSO, filename: 'RECHAZADA.xlsx' });
    assert.strictEqual(b.documentos[0].opts.caption, 'mirá esto');
  });

  await ta('el archivo se SUBE una sola vez y a los demás va el file_id', async () => {
    // Con 4 admins, subir 4 veces el mismo Excel es tirar ancho de banda y tiempo
    // del bot, que mientras tanto no atiende a nadie.
    const b = botFalso(); setBot(b);
    await avisarProblema({
      proceso: 'la planilla', que: 'no se pudo usar',
      archivo: { buffer: XLSX_FALSO, nombre: 'x.xlsx' },
    });
    assert.strictEqual(typeof b.documentos[0].doc, 'object', 'el primero sube el archivo');
    assert.strictEqual(b.documentos[1].doc, 'FILEID-1', 'el segundo reusa el file_id');
  });

  await ta('si falla el adjunto, el aviso de texto sale igual', async () => {
    const b = botFalso({ fallarDocA: '111' }); setBot(b);
    const n = await avisarProblema({
      proceso: 'la planilla', que: 'no se pudo usar',
      archivo: { buffer: XLSX_FALSO, nombre: 'x.xlsx' },
    });
    assert.strictEqual(n, 2, 'los dos avisos de texto llegaron');
    assert.strictEqual(b.documentos.length, 1, 'al que falló no le llegó el archivo, al otro sí');
  });

  await ta('a quien no se le puede escribir tampoco se le manda el archivo', async () => {
    const b = botFalso({ fallarMsgA: '111' }); setBot(b);
    const n = await avisarProblema({
      proceso: 'la planilla', que: 'no se pudo usar',
      archivo: { buffer: XLSX_FALSO, nombre: 'x.xlsx' },
    });
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(b.documentos.map((d) => d.tid), ['222']);
  });

  await ta('un archivo enorme no se adjunta, pero el aviso sale', async () => {
    const b = botFalso(); setBot(b);
    const enorme = Buffer.alloc(21 * 1024 * 1024);
    const n = await avisarProblema({
      proceso: 'la planilla', que: 'no se pudo usar',
      archivo: { buffer: enorme, nombre: 'x.xlsx' },
    });
    assert.strictEqual(n, 2);
    assert.strictEqual(b.documentos.length, 0, 'el aviso no puede quedarse colgado subiendo');
  });

  await ta('un archivo vacío se ignora como si no viniera', async () => {
    const b = botFalso(); setBot(b);
    await avisarProblema({ proceso: 'x', que: 'y', archivo: { buffer: Buffer.alloc(0), nombre: 'x.xlsx' } });
    assert.strictEqual(b.documentos.length, 0);
  });

  await ta('los botones van pegados al ARCHIVO, que es lo último que se ve', async () => {
    const b = botFalso(); setBot(b);
    const botones = [[{ text: '🔁 Reintentar', callback_data: 'planilla_reintentar:abc' }]];
    await avisarProblema({
      proceso: 'la planilla', que: 'falló',
      archivo: { buffer: XLSX_FALSO, nombre: 'x.xlsx' }, botones,
    });
    assert.deepStrictEqual(b.documentos[0].opts.reply_markup, { inline_keyboard: botones });
    assert.strictEqual(b.mensajes[0].opts.reply_markup, undefined, 'no duplicados en el texto');
  });

  await ta('sin archivo, los botones van con el texto', async () => {
    const b = botFalso(); setBot(b);
    const botones = [[{ text: 'Dale', callback_data: 'x:1' }]];
    await avisarProblema({ proceso: 'algo', que: 'falló', botones });
    assert.deepStrictEqual(b.mensajes[0].opts.reply_markup, { inline_keyboard: botones });
  });

  await ta('sin botones no se manda ningún reply_markup', async () => {
    const b = botFalso(); setBot(b);
    await avisarProblema({ proceso: 'algo', que: 'falló', archivo: { buffer: XLSX_FALSO, nombre: 'x.xlsx' } });
    assert.strictEqual(b.mensajes[0].opts.reply_markup, undefined);
    // Sin caption ni botones no se manda ningún objeto de opciones: la llamada
    // queda igual a como era antes de que existieran los botones.
    assert.strictEqual(b.documentos[0].opts, undefined);
  });

  await ta('sin bot seteado no explota', async () => {
    setBot(null);
    const n = await avisarProblema({
      proceso: 'x', que: 'y', archivo: { buffer: XLSX_FALSO, nombre: 'x.xlsx' },
    });
    assert.strictEqual(n, 0);
  });

  console.log(`\n✅ ${pass} tests OK`);
})().catch((e) => { console.error('\nFALLO:', e); process.exit(1); });
