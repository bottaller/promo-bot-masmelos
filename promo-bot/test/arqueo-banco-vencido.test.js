// Tests de filtrarPorVencimiento (reporte-arqueo-banco.js): el arqueo bancario reporta "a día
// vencido" — lo pendiente reciente no alarma, solo lo que pasó el margen de días.
// Correr: node test/arqueo-banco-vencido.test.js
const assert = require('assert');
const { filtrarPorVencimiento, DIAS_GRACIA_DEFAULT } = require('../src/lib/reporte-arqueo-banco');
const { fechaHoyArgISO } = require('../src/lib/fechas');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

// 'AAAA-MM-DD' de hoy menos n días, para fechar los casos de prueba relativo al día real.
function haceNDias(n) {
  const [y, m, d] = fechaHoyArgISO().split('-').map(Number);
  const f = new Date(y, m - 1, d - n);
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
}

const O = (bruto, diasAtras) => ({ hora: `${haceNDias(diasAtras)} 00:00:00`, bruto });
const M = (debe, diasAtras) => ({ ingreso: `${haceNDias(diasAtras)} 10:00:00`, debe, asiento: 1, cliente: 'X', comprobante: '' });

console.log(`DIAS_GRACIA_DEFAULT = ${DIAS_GRACIA_DEFAULT}`);

t('un pendiente de HOY no está vencido: no alarma', () => {
  const r = filtrarPorVencimiento({ soloMp: [O(1000, 0)], soloSistema: [], resumen: { nAviso: 0 } });
  assert.strictEqual(r.soloMp.length, 0);
  assert.strictEqual(r.resumen.nivel, 'ok');
  assert.strictEqual(r.recientes.mp.length, 1);
});
t(`un pendiente de justo ${DIAS_GRACIA_DEFAULT - 1} días (dentro del margen) no está vencido`, () => {
  const r = filtrarPorVencimiento({ soloMp: [O(1000, DIAS_GRACIA_DEFAULT - 1)], soloSistema: [], resumen: { nAviso: 0 } });
  assert.strictEqual(r.soloMp.length, 0);
  assert.strictEqual(r.recientes.mp.length, 1);
});
t(`un pendiente de exactamente ${DIAS_GRACIA_DEFAULT} días YA está vencido`, () => {
  const r = filtrarPorVencimiento({ soloMp: [O(1000, DIAS_GRACIA_DEFAULT)], soloSistema: [], resumen: { nAviso: 0 } });
  assert.strictEqual(r.soloMp.length, 1);
  assert.strictEqual(r.resumen.nivel, 'alerta');
  assert.strictEqual(r.recientes.mp.length, 0);
});
t('un pendiente de hace un mes está vencido, del lado del sistema también', () => {
  const r = filtrarPorVencimiento({ soloMp: [], soloSistema: [M(5000, 30)], resumen: { nAviso: 0 } });
  assert.strictEqual(r.soloSistema.length, 1);
  assert.strictEqual(r.resumen.totalSoloSistema, 5000);
});
t('mezcla: separa vencidos de recientes y ajusta los totales de resumen', () => {
  const r = filtrarPorVencimiento({
    soloMp: [O(1000, 10), O(2000, 0)], // 1 vencido, 1 reciente
    soloSistema: [M(500, 10)],
    resumen: { nAviso: 0 },
  });
  assert.strictEqual(r.soloMp.length, 1);
  assert.strictEqual(r.soloMp[0].bruto, 1000);
  assert.strictEqual(r.resumen.nSoloMp, 1);
  assert.strictEqual(r.resumen.totalSoloMp, 1000);
  assert.strictEqual(r.resumen.nSoloSistema, 1);
  assert.strictEqual(r.recientes.mp.length, 1);
  assert.strictEqual(r.recientes.mp[0].bruto, 2000);
});
t('nada vencido -> nivel ok aunque haya recientes pendientes', () => {
  const r = filtrarPorVencimiento({ soloMp: [O(1000, 0), O(500, 1)], soloSistema: [], resumen: { nAviso: 0 } });
  assert.strictEqual(r.soloMp.length, 0);
  assert.strictEqual(r.resumen.nivel, 'ok');
});
t('se puede pasar un margen de días custom', () => {
  const r = filtrarPorVencimiento({ soloMp: [O(1000, 1)], soloSistema: [], resumen: { nAviso: 0 } }, 1);
  assert.strictEqual(r.soloMp.length, 1, 'con margen de 1 día, algo de ayer ya está vencido');
});

console.log(`\n✅ ${pass} tests OK`);
