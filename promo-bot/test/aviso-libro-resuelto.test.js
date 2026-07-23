// Tests del anuncio "ya se cargó el libro" (avisarLibroResuelto).
// Lo importante a proteger: una carga NORMAL de /libro (sin que haya salido antes el aviso "falta
// el libro") NO le manda nada a nadie. Si eso se rompiera, cada carga spamearía a todos los admins.
//   node test/aviso-libro-resuelto.test.js
const assert = require('assert');

// aviso-libro importa la capa DB (pool.js), que exige DATABASE_URL. Se pone una ficticia: el camino
// que se testea (sin aviso pendiente) corta ANTES de consultar nada.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';

const { avisarLibroResuelto } = require('../src/aviso-libro');

let pass = 0;
function t(nombre, fn) {
  try { fn(); pass++; console.log(`  ok: ${nombre}`); }
  catch (e) { console.error(`  FALLA: ${nombre}\n    ${e.message}`); process.exitCode = 1; }
}

// En un proceso fresco no hay aviso pendiente (nunca corrió el chequeo de las 21:00), así que una
// carga no debe anunciar nada ni tocar Telegram.
async function main() {
  let mandados = 0;
  const telegramQueTira = { sendMessage: async () => { mandados++; throw new Error('no debería mandar nada'); } };

  const r = await avisarLibroResuelto(telegramQueTira, { subidoPorTxt: 'Renzo', subidoPorTelegramId: 123 });

  t('sin aviso pendiente: no anuncia', () => assert.strictEqual(r.anuncio, false));
  t('sin aviso pendiente: no manda ningún mensaje', () => assert.strictEqual(mandados, 0));
  t('nunca tira, devuelve forma estable', () => {
    assert.strictEqual(typeof r.anuncio, 'boolean');
    assert.strictEqual(typeof r.avisados, 'number');
  });

  // Entrada rara: no debe romper (el contrato es "nunca tira").
  const r2 = await avisarLibroResuelto(telegramQueTira, {});
  t('sin opciones: no rompe y no anuncia', () => assert.strictEqual(r2.anuncio, false));

  console.log(`\n✅ ${pass} tests OK`);
}

main();
