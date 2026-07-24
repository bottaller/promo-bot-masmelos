// Tests del aviso de deploy (parte pura + la lógica de "solo commits nuevos").
// Correr: node test/aviso-deploy.test.js
const assert = require('assert');
const { infoCommit, mensajeDeploy, anunciarDeploy } = require('../src/aviso-deploy');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }
async function ta(nombre, fn) { await fn(); pass++; console.log('  ok:', nombre); }

console.log('infoCommit(): lee las env vars de Railway');
t('toma RAILWAY_GIT_* y hace trim', () => {
  const i = infoCommit({ RAILWAY_GIT_COMMIT_SHA: ' abc123def456 ', RAILWAY_GIT_AUTHOR: 'Renzo', RAILWAY_GIT_COMMIT_MESSAGE: 'Fix x\nsegunda' });
  assert.strictEqual(i.sha, 'abc123def456');
  assert.strictEqual(i.autor, 'Renzo');
  assert.strictEqual(i.mensaje, 'Fix x\nsegunda');
});
t('sin env vars -> todo vacío', () => {
  assert.strictEqual(infoCommit({}).sha, '');
});

console.log('mensajeDeploy(): formato');
t('arma "Deploy terminado" con commit corto (7) + autor + subject', () => {
  const m = mensajeDeploy({ sha: 'abc123def456789', autor: 'Renzo', mensaje: 'Arreglo el arqueo\ndetalle interno' });
  assert.match(m, /Deploy terminado/);
  assert.match(m, /abc123d/);           // 7 chars
  assert.ok(!/abc123def/.test(m));      // no más de 7
  assert.match(m, /por Renzo/);
  assert.match(m, /Arreglo el arqueo/);
  assert.ok(!/detalle interno/.test(m)); // solo la primera línea del commit
});
t('sin autor ni mensaje: no rompe', () => {
  const m = mensajeDeploy({ sha: 'abcdef1' });
  assert.match(m, /abcdef1/);
  assert.ok(!/por /.test(m));
});
t('escapa HTML del autor y el subject', () => {
  const m = mensajeDeploy({ sha: 'x', autor: 'A & B', mensaje: '<b>hola' });
  assert.match(m, /A &amp; B/);
  assert.match(m, /&lt;b&gt;hola/);
});

console.log('anunciarDeploy(): solo en commits NUEVOS');
const fakeBot = (sent) => ({ telegram: { sendMessage: async (tid, msg) => { sent.push({ tid, msg }); } } });

(async () => {
  await ta('commit nuevo -> anuncia a los admins y registra', async () => {
    const sent = []; let registrado = null;
    const r = await anunciarDeploy(fakeBot(sent), {
      infoFn: () => ({ sha: 'newsha1', autor: 'Renzo', mensaje: 'algo' }),
      ultimoFn: async () => 'oldsha0',
      registrarFn: async (d) => { registrado = d; },
      adminsFn: async () => [1, 2],
    });
    assert.strictEqual(r.anunciado, true);
    assert.strictEqual(sent.length, 2);
    assert.match(sent[0].msg, /Deploy terminado/);
    assert.strictEqual(registrado.sha, 'newsha1');
  });

  await ta('mismo commit (reinicio) -> NO anuncia ni registra', async () => {
    const sent = []; let registrado = false;
    const r = await anunciarDeploy(fakeBot(sent), {
      infoFn: () => ({ sha: 'samesha', autor: '', mensaje: '' }),
      ultimoFn: async () => 'samesha',
      registrarFn: async () => { registrado = true; },
      adminsFn: async () => [1],
    });
    assert.strictEqual(r.anunciado, false);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(registrado, false);
  });

  await ta('sin SHA (corrida local) -> no hace nada', async () => {
    const sent = [];
    const r = await anunciarDeploy(fakeBot(sent), {
      infoFn: () => ({ sha: '', autor: '', mensaje: '' }), ultimoFn: async () => null, adminsFn: async () => [1],
    });
    assert.strictEqual(r.anunciado, false);
    assert.strictEqual(sent.length, 0);
  });

  await ta('si no llegó a nadie (Telegram caído) NO registra -> se reintenta al próximo arranque', async () => {
    let registrado = false;
    const botFail = { telegram: { sendMessage: async () => { throw new Error('telegram down'); } } };
    const r = await anunciarDeploy(botFail, {
      infoFn: () => ({ sha: 'newsha2', autor: 'x', mensaje: 'y' }),
      ultimoFn: async () => null, registrarFn: async () => { registrado = true; }, adminsFn: async () => [1],
    });
    assert.strictEqual(r.avisados, 0);
    assert.strictEqual(registrado, false);
  });

  console.log(`\n✅ ${pass} tests OK`);
})();
