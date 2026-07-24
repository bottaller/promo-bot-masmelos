// Tests del núcleo del ARQUEO (lib/arqueo.js) + el resumen semanal multi-plataforma.
// Sin DB ni Telegram: los Excel se arman en memoria. Correr: node test/arqueo.test.js
const assert = require('assert');
const XLSX = require('xlsx');
const { arquearDia, chequearRangos, acotarAlDia, textoRango } = require('../src/lib/arqueo');
const { formatearResumenSemanal } = require('../src/lib/resumen-mp-semanal');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }
const esPDF = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF' && buf.length > 800;

function aBuffer(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const HDR_DIARIO = ['Mov.', 'Fecha', 'Comp', 'Concepto', 'C.', 'Cuenta', 'C.C.', 'Centro de Costo', 'Debe',
  'Haber', 'Debe Nominal', 'Haber Nominal', 'Comprobante', 'Cuenta Asociada', 'Usuario', 'Ingreso'];
const filaDiario = (cuentaId, debe, ingreso, fecha = '16/07/2026') => [
  8300319, fecha, 'PG23', 'COBRANZA CAJA MORENO (1)', cuentaId, 'MERCADO PAGO MORENO', null, null,
  debe, 0, debe, 0, 'COBRANZA CAJA MORENO (1)', '030640-MALDONADO RAUL', 'NIEVASA', ingreso];
function diarioBuf(filas) {
  return aBuffer([
    ['Empresa: 0008-HONRE_2'],
    ['Diario de movimientos contables del 07/16/2026 al 07/16/2026'],
    HDR_DIARIO, ...filas,
  ]);
}
const HDR_LIQ = ['SOURCE ID', 'PAYMENT METHOD TYPE', 'TRANSACTION TYPE', 'TRANSACTION AMOUNT', 'ORIGIN DATE',
  'FEE AMOUNT', 'APPROVAL DATE', 'REAL AMOUNT', 'TAXES AMOUNT', 'BUSINESS UNIT', 'SUB UNIT', 'MONEY RELEASE DATE'];
function liqMpBuf(bruto, origen = '2026-07-16T16:10:56.000-04:00', sourceId = '168263949797') {
  return aBuffer([HDR_LIQ,
    [sourceId, 'available_money', 'Approved payment', String(bruto), origen,
      '-1231.70', origen, String(bruto - 1231.70), '-764.72', 'Mercado Pago', 'QR Code', '']]);
}

// --- helpers puros ---------------------------------------------------------
console.log('helpers puros del arqueo');
t('textoRango: un día vs rango', () => {
  const d = new Date(2026, 6, 16);
  assert.strictEqual(textoRango(d, d), '16/07/2026');
  assert.strictEqual(textoRango(new Date(2026, 6, 16), new Date(2026, 6, 18)), '16/07/2026 al 18/07/2026');
});
t('chequearRangos: mismo día ok / distinto día error / parcial aviso', () => {
  const un = new Date(2026, 6, 16);
  const ops16 = [{ hora: '2026-07-16 17:10:56' }];
  assert.deepStrictEqual(chequearRangos({ mayor: { desde: un, hasta: un }, operaciones: ops16 }), {});
  const r = chequearRangos({ mayor: { desde: new Date(2026, 6, 18), hasta: new Date(2026, 6, 18) }, operaciones: ops16 });
  assert.ok(r.error, 'debería marcar que no son del mismo día');
  const p = chequearRangos({ mayor: { desde: new Date(2026, 6, 15), hasta: new Date(2026, 6, 16) }, operaciones: ops16 });
  assert.ok(p.aviso, 'debería avisar que el sistema abarca más días que la liquidación');
});
t('acotarAlDia: un día = no toca; multi-día = recorta', () => {
  const un = new Date(2026, 6, 16);
  const soloUn = { desde: un, hasta: un, movimientos: [{ fecha: un, debe: 1 }] };
  assert.strictEqual(acotarAlDia(soloUn, '2026-07-16').recortado, false);
  const multi = {
    desde: new Date(2026, 6, 15), hasta: new Date(2026, 6, 16),
    movimientos: [{ fecha: new Date(2026, 6, 15), debe: 1 }, { fecha: new Date(2026, 6, 16), debe: 2 }],
  };
  const a = acotarAlDia(multi, '2026-07-16');
  assert.strictEqual(a.recortado, true);
  assert.strictEqual(a.mayor.movimientos.length, 1);
  assert.strictEqual(a.mayor.movimientos[0].debe, 2);
});

// --- arquearDia end-to-end -------------------------------------------------
console.log('arquearDia: cruza libro vs liquidación y arma texto + PDF por plataforma');
(async () => {
  const { porCodigo } = require('../src/lib/plataformas');
  const mp = porCodigo('mp');

  // Caso CON DIFERENCIAS: el asiento (99.999) no matchea el cobro de MP (127.241,52) → los dos
  // quedan huérfanos. Ejercita todo el camino sin depender de un apareo exacto.
  const libro = diarioBuf([filaDiario(422101014, 99999, '16/07/2026 12:00:00')]);
  const liq = mp.parsear(liqMpBuf(127241.52));
  const arq = await arquearDia({
    libroBuffer: libro, libroMeta: null, dia: '2026-07-16',
    liquidaciones: [{ plataforma: mp, liq }],
  });

  t('devuelve ok con un resultado por plataforma', () => {
    assert.strictEqual(arq.ok, true);
    assert.strictEqual(arq.resultados.length, 1);
    assert.strictEqual(arq.resultados[0].plataforma.codigo, 'mp');
  });
  t('genera UN PDF por plataforma (MP), válido', () => {
    assert.strictEqual(arq.pdfs.length, 1);
    assert.strictEqual(arq.pdfs[0].corto, 'MP');
    assert.match(arq.pdfs[0].filename, /^arqueo_MP_2026-07-16\.pdf$/);
    assert.ok(esPDF(arq.pdfs[0].buffer), 'no es un PDF válido');
  });
  t('el texto es HTML y nombra la plataforma', () => {
    assert.ok(typeof arq.texto === 'string' && arq.texto.length > 0);
    assert.match(arq.texto, /Mercado Pago/);
  });
  t('paraGuardar trae una fila por plataforma (para el resumen semanal)', () => {
    assert.strictEqual(arq.paraGuardar.length, 1);
    assert.strictEqual(arq.paraGuardar[0].plataforma, 'mp');
    assert.ok(arq.paraGuardar[0].resultado && arq.paraGuardar[0].resultado.resumen);
  });

  // Si NINGUNA liquidación se puede arquear contra su día → ok:false (no manda nada).
  const libro18 = aBuffer([['Empresa: X'],
    ['Diario de movimientos contables del 07/18/2026 al 07/18/2026'],
    HDR_DIARIO, filaDiario(422101014, 100, '18/07/2026 12:00:00', '18/07/2026')]);
  const rOtroDia = await arquearDia({
    libroBuffer: libro18, libroMeta: null, dia: '2026-07-18',
    liquidaciones: [{ plataforma: mp, liq: mp.parsear(liqMpBuf(127241.52)) }],
  });
  t('si la liquidación es de otro día que el libro → ok:false (no manda nada)', () => {
    assert.strictEqual(rOtroDia.ok, false); // la liq es del 16, el libro del 18: chequearRangos lo saltea
  });

  // --- resumen semanal multi-plataforma ------------------------------------
  console.log('resumen semanal: cubre MP + Talo sin pisarse');
  const filas = [
    { fecha: '2026-07-14', plataforma: 'mp', veredicto: 'ok', n_pares: 12, n_aviso: 0, diferencia: 0, n_solo_mp: 0, n_solo_sistema: 0, huerfanas: [] },
    { fecha: '2026-07-14', plataforma: 'talo', veredicto: 'diferencias', n_pares: 3, n_aviso: 0, diferencia: 5000, n_solo_mp: 1, n_solo_sistema: 0, huerfanas: [{ lado: 'mp', importe: 5000, ref: 'x' }] },
    { fecha: '2026-07-15', plataforma: 'mp', veredicto: 'ok', n_pares: 8, n_aviso: 1, diferencia: 0, n_solo_mp: 0, n_solo_sistema: 0, huerfanas: [] },
  ];
  const { titulo, lineas, stats } = formatearResumenSemanal({ desde: '2026-07-13', hasta: '2026-07-19', filas });
  const texto = [titulo, ...lineas].join('\n');
  t('el título nombra las dos plataformas', () => {
    assert.match(titulo, /Mercado Pago \+ Talo/);
  });
  t('el lunes 14 muestra MP (🟢) y Talo (🔴) por separado, sin pisarse', () => {
    assert.match(texto, /🟢 <b>MP<\/b>: cerró — 12 apareadas/);
    assert.match(texto, /🔴 <b>Talo<\/b>: 1 sin aparear/);
  });
  t('cuenta plataforma-días: 2 ok, 1 con dif, y días sin arqueo', () => {
    assert.strictEqual(stats.ok, 2);       // MP 14 + MP 15
    assert.strictEqual(stats.conDif, 1);   // Talo 14
    assert.ok(stats.sinCorrer >= 1);       // 13, 16, 17, 18, 19 sin arqueo (según la semana)
  });

  console.log(`\n✅ ${pass} tests OK`);
})();
