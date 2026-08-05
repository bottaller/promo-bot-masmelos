// Tests del sistema de avisos de problemas: el FORMATO del mensaje y el chequeo de envs.
// Las partes puras (sin bot ni base). Correr: node test/avisos-problemas.test.js
const assert = require('assert');
const { formatearProblema } = require('../src/notificar');
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

console.log(`\n✅ ${pass} tests OK`);
