// Tests de la RED DE RESPALDO del arqueo de Talo (recuperarTaloRezagado, src/entrega-arqueo.js).
//
// Protege el hueco real del 07/08/2026: el barrido de las 21:00 no arqueó Talo porque el libro se
// cargó recién 22:24 (después de esa hora) y no había reintento. La red de respaldo corre a las
// 08:00 —cuando el libro seguro ya está— y tiene que:
//   - NO re-entregar un día que ya se arqueó (idempotente, si no spamearía a los grupos), y
//   - reintentar el arqueo del día de AYER cuando falta,
//   - sin explotar el barrido de las 08:00 si algo tira.
// Sin DB ni Telegram: se inyectan hayConciliacionFn y entregarFn. Correr: node test/entrega-arqueo-talo.test.js
const assert = require('assert');

// entrega-arqueo importa la capa DB (pool.js), que exige DATABASE_URL para cargar. Ficticia: el
// camino testeado inyecta los deps, así que nunca se consulta la base ni Telegram de verdad.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';

const { recuperarTaloRezagado, pendienteYaArqueadaPorApi } = require('../src/entrega-arqueo');
const { porCodigo } = require('../src/lib/plataformas');

const HOY = '2026-08-08'; // hoy (ISO 'AAAA-MM-DD')
const AYER = '2026-08-07';
const telegramFake = { sendMessage: async () => {}, sendDocument: async () => {} };

let pass = 0;
async function t(nombre, fn) {
  try { await fn(); pass++; console.log('  ok:', nombre); }
  catch (e) { console.error(`  FALLA: ${nombre}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}

async function main() {
  // 1) Día ya arqueado -> no reintenta (no re-entrega lo que el barrido de las 21:00 ya mandó).
  await t('día ya arqueado -> no reintenta (idempotente)', async () => {
    let entregarLlamado = 0;
    const r = await recuperarTaloRezagado(telegramFake, {
      hoyIso: HOY,
      hayConciliacionFn: async ({ fecha, plataforma }) => {
        assert.strictEqual(fecha, AYER, 'chequea el día de AYER, no el de hoy');
        assert.strictEqual(plataforma, 'talo');
        return true;
      },
      entregarFn: async () => { entregarLlamado++; return { corrio: true }; },
    });
    assert.strictEqual(entregarLlamado, 0, 'no debe llamar a entregar si el día ya estaba');
    assert.deepStrictEqual(r, { recuperado: false, motivo: 'ya_estaba', dia: AYER });
  });

  // 2) Día sin arquear -> reintenta el arqueo de AYER y lo reporta como recuperado.
  await t('día sin arquear -> reintenta el arqueo de ayer', async () => {
    let fechaPedida = null;
    const r = await recuperarTaloRezagado(telegramFake, {
      hoyIso: HOY,
      hayConciliacionFn: async () => false,
      entregarFn: async (_tg, { fecha }) => { fechaPedida = fecha; return { corrio: true, enviados: 3, dia: fecha }; },
    });
    assert.strictEqual(fechaPedida, AYER, 'reintenta el arqueo del día de ayer');
    assert.strictEqual(r.recuperado, true);
    assert.strictEqual(r.motivo, 'recuperado');
    assert.strictEqual(r.dia, AYER);
  });

  // 3) El reintento tampoco cierra (sigue sin libro / API caída) -> no recuperado, con el motivo.
  //    entregarTaloDelDia ya le avisó a los admins por su cuenta ("subilo con /carga").
  await t('reintento que no cierra -> no recuperado, con motivo', async () => {
    const r = await recuperarTaloRezagado(telegramFake, {
      hoyIso: HOY,
      hayConciliacionFn: async () => false,
      entregarFn: async () => ({ corrio: false, motivo: 'sin_libro' }),
    });
    assert.strictEqual(r.recuperado, false);
    assert.strictEqual(r.motivo, 'sin_libro');
    assert.strictEqual(r.dia, AYER);
  });

  // 4) Un error inesperado NO explota el barrido de las 08:00: se traga y se reporta.
  await t('error inesperado -> no tira, motivo "error"', async () => {
    const r = await recuperarTaloRezagado(telegramFake, {
      hoyIso: HOY,
      hayConciliacionFn: async () => { throw new Error('base caída'); },
    });
    assert.strictEqual(r.recuperado, false);
    assert.strictEqual(r.motivo, 'error');
    assert.strictEqual(r.dia, AYER);
  });

  // 5) El cálculo de "ayer" cruza bien el fin de mes (01/08 -> 31/07).
  await t('"ayer" cruza fin de mes (01/08 -> 31/07)', async () => {
    let fechaPedida = null;
    await recuperarTaloRezagado(telegramFake, {
      hoyIso: '2026-08-01',
      hayConciliacionFn: async ({ fecha }) => { fechaPedida = fecha; return true; },
    });
    assert.strictEqual(fechaPedida, '2026-07-31');
  });

  // 6) El default de "hoy" (sin inyectar hoyIso) NO explota y calcula un "ayer" válido.
  //    Regresión: antes el default era fechaHoyArg(), que devuelve string 'DD/MM/AAAA' y hacía
  //    reventar sumarDias() ("getFullYear is not a function"). Este caso ejerce el default real.
  await t('default de hoy (sin inyectar) -> "ayer" ISO válido, no explota', async () => {
    let fechaPedida = null;
    await recuperarTaloRezagado(telegramFake, {
      hayConciliacionFn: async ({ fecha }) => { fechaPedida = fecha; return true; },
    });
    assert.match(fechaPedida, /^\d{4}-\d{2}-\d{2}$/, '"ayer" tiene que ser un ISO AAAA-MM-DD');
  });

  // ---- Guarda anti "doble entrega" del barrido de las 08:00 (pendienteYaArqueadaPorApi) ----
  // Bug: si Talo se sube a mano (fallback) Y la API la baja el mismo día, se arqueaba/entregaba dos
  // veces. La guarda saltea la pendiente manual si ese día+plataforma ya tiene conciliación.
  const talo = porCodigo('talo');
  const mp = porCodigo('mp');

  await t('guarda: Talo (API) con el día YA arqueado -> redundante (true)', async () => {
    const r = await pendienteYaArqueadaPorApi(talo, { fecha: AYER }, async ({ plataforma }) => {
      assert.strictEqual(plataforma, 'talo'); return true;
    });
    assert.strictEqual(r, true);
  });

  await t('guarda: Talo (API) SIN conciliación -> NO redundante (fallback manual legítimo)', async () => {
    const r = await pendienteYaArqueadaPorApi(talo, { fecha: AYER }, async () => false);
    assert.strictEqual(r, false);
  });

  await t('guarda: MP (manual) nunca es redundante y ni consulta la base', async () => {
    let consultada = false;
    const r = await pendienteYaArqueadaPorApi(mp, { fecha: AYER }, async () => { consultada = true; return true; });
    assert.strictEqual(r, false);
    assert.strictEqual(consultada, false, 'MP no es bajaPorApi: no debe consultar hayConciliacion');
  });

  await t('guarda: plataforma nula -> false (defensivo)', async () => {
    const r = await pendienteYaArqueadaPorApi(null, { fecha: AYER }, async () => true);
    assert.strictEqual(r, false);
  });

  console.log(`\n${pass} tests OK`);
}
main();
