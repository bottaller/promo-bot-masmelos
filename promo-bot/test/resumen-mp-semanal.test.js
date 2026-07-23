// Tests del resumen semanal del control de MP (parte pura: cálculo de la semana + armado).
// Correr:  node test/resumen-mp-semanal.test.js
const assert = require('assert');
const { semanaAnterior, formatearResumenSemanal, diasDelRango } = require('../src/lib/resumen-mp-semanal');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

console.log('semanaAnterior(): lunes a domingo previos');
t('corriendo un LUNES devuelve la semana que terminó ayer (dom)', () => {
  // lunes 20/07/2026 -> semana anterior lun 13 a dom 19
  assert.deepStrictEqual(semanaAnterior('2026-07-20'), { desde: '2026-07-13', hasta: '2026-07-19' });
});
t('es robusto al día en que se corra (un miércoles da la misma semana pasada)', () => {
  // miércoles 22/07 -> la semana COMPLETA anterior sigue siendo lun 13 a dom 19
  assert.deepStrictEqual(semanaAnterior('2026-07-22'), { desde: '2026-07-13', hasta: '2026-07-19' });
});
t('corriendo un domingo toma la semana anterior, no la que está por cerrar', () => {
  // domingo 19/07 -> semana anterior lun 6 a dom 12
  assert.deepStrictEqual(semanaAnterior('2026-07-19'), { desde: '2026-07-06', hasta: '2026-07-12' });
});
t('cruza el cambio de mes', () => {
  // lunes 03/08/2026 -> lun 27/07 a dom 02/08
  assert.deepStrictEqual(semanaAnterior('2026-08-03'), { desde: '2026-07-27', hasta: '2026-08-02' });
});
t('diasDelRango: 7 días inclusive', () => {
  assert.strictEqual(diasDelRango('2026-07-13', '2026-07-19').length, 7);
  assert.strictEqual(diasDelRango('2026-07-13', '2026-07-19')[0], '2026-07-13');
  assert.strictEqual(diasDelRango('2026-07-13', '2026-07-19')[6], '2026-07-19');
});

console.log('formatearResumenSemanal(): día por día');
const semana = { desde: '2026-07-13', hasta: '2026-07-19' };
const filaOK = (fecha, extra = {}) => ({ fecha, plataforma: 'mp', veredicto: 'ok', n_pares: 100, n_aviso: 0, ...extra });
const filaDif = (fecha, extra = {}) => ({ fecha, plataforma: 'mp', veredicto: 'diferencias', n_pares: 99, n_solo_mp: 1, n_solo_sistema: 0, diferencia: -152577.45, huerfanas: [], ...extra });

t('marca los días que NO se arquearon', () => {
  const filas = [filaOK('2026-07-13'), filaOK('2026-07-14')]; // faltan mié a dom
  const { lineas, stats } = formatearResumenSemanal({ ...semana, filas });
  const texto = lineas.join('\n');
  assert.match(texto, /no se arqueó/);
  assert.strictEqual(stats.sinCorrer, 5); // 15,16,17,18,19
  assert.strictEqual(stats.ok, 2);
});
t('un día con diferencias muestra el importe y, si hay, el rastreo', () => {
  const filas = [filaDif('2026-07-13', {
    huerfanas: [{ lado: 'mp', hora: '2026-07-13 14:15:12', importe: 152577.45, ref: '167476058875',
      contrapartida: { cuentas: ['CAJA 4 MORENO', 'DESVIO DE CAJA'], concepto: 'faltante caja 4', usuario: 'LATERZAFLOR' } }],
  })];
  const texto = formatearResumenSemanal({ ...semana, filas }).lineas.join('\n');
  assert.match(texto, /lunes 13\/07/);
  assert.match(texto, /1 sin aparear/);
  assert.match(texto, /aparece en CAJA 4 MORENO → DESVIO DE CAJA/);
  assert.match(texto, /faltante caja 4/);
});
t('semana perfecta: 7 días OK -> lo dice', () => {
  const filas = diasDelRango(semana.desde, semana.hasta).map((d) => filaOK(d));
  const { lineas, stats } = formatearResumenSemanal({ ...semana, filas });
  assert.strictEqual(stats.ok, 7);
  assert.strictEqual(stats.sinCorrer, 0);
  assert.match(lineas.join('\n'), /cerró completa y sin diferencias/);
});
t('el conteo del pie suma bien (ok + dif + sin correr = 7)', () => {
  const filas = [filaOK('2026-07-13'), filaDif('2026-07-14'), filaOK('2026-07-15')];
  const { stats } = formatearResumenSemanal({ ...semana, filas });
  assert.strictEqual(stats.ok + stats.conDif + stats.sinCorrer, 7);
  assert.deepStrictEqual([stats.ok, stats.conDif, stats.sinCorrer], [2, 1, 4]);
});
t('escapa el HTML del concepto (Telegram rechaza < & sueltos)', () => {
  const filas = [filaDif('2026-07-13', {
    huerfanas: [{ lado: 'sistema', importe: 100, ref: 'REC8 1',
      contrapartida: { cuentas: ['CAJA <1>'], concepto: 'ajuste & error', usuario: 'X' } }],
  })];
  const texto = formatearResumenSemanal({ ...semana, filas }).lineas.join('\n');
  assert.match(texto, /CAJA &lt;1&gt;/);
  assert.match(texto, /ajuste &amp; error/);
});

console.log(`\n✅ ${pass} tests OK`);
