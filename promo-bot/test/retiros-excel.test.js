// Tests del parser de la PLANILLA RETIRA (turnos de retiro → pantalla /tv_recepcion).
// Correr: node test/retiros-excel.test.js
//
// Los fixtures se arman en memoria a propósito: la planilla real tiene nombres y
// códigos de clientes, así que no entra al repo. Cada caso raro que se testea acá
// salió de mirar el archivo de julio/agosto 2026.
const assert = require('assert');
const XLSX = require('xlsx');
const {
  parsearRetiros, esPlanillaRetiros, RetirosError,
  parsearFechaEs, parsearTurno, parsearOrdenes, tituloNombre,
} = require('../src/lib/retiros-excel');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

const ENCABEZADO = [
  'fecha de registro de pedido', 'Horario de Registro del pedido', 'Excepcion ', 'N° de PEDIDO',
  'CODIGO del Cliente', 'CLIENTE', 'N° de Orden de Pedido', 'VENDEDOR ', 'FECHA Retiro del Pedido',
  'HORARIO de Retiro del pedido', '# Bultos', 'PALLET', 'STATUS de Preparación', 'ESTADO ',
  'FORMA DE ENTREGA', 'OBSERVACION',
];
const TURNOS = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
                '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30'];

// Un bloque = 1 encabezado + 16 turnos fijos. `pedidos` se indexa por turno (0..15).
// La FECHA va SOLO en la primera fila del cuerpo: en el archivo real es una celda
// combinada (I19:I34) y las otras 15 filas vienen vacías.
function bloque(fechaTexto, pedidos = {}) {
  const filas = [ENCABEZADO.slice()];
  TURNOS.forEach((turno, i) => {
    const p = pedidos[i] || {};
    filas.push([
      p.fechaReg || '', p.horaReg || '', p.excepcion || '', p.nPedido === undefined ? '' : p.nPedido,
      p.codigo === undefined ? '' : p.codigo, p.cliente || '', p.orden || '', p.vendedor || '',
      i === 0 ? fechaTexto : '', turno,
      p.bultos === undefined ? '' : p.bultos, p.pallet || '',
      p.prep || '', p.estado || '', p.entrega || '', p.obs || '',
    ]);
  });
  return filas;
}

function aBuffer(hojas) {
  const wb = XLSX.utils.book_new();
  for (const [nombre, filas] of Object.entries(hojas)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), nombre);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const unDia = (pedidos) => aBuffer({ AGOSTO: bloque('LUNES 17 DE AGOSTO DE 2026', pedidos) });
const DESDE = { desde: '2026-08-01' };

console.log('\nretiros-excel');

// ── helpers sueltos ──────────────────────────────────────────────────────────

t('lee la fecha en castellano, con y sin tilde', () => {
  assert.equal(parsearFechaEs('MIERCOLES 12 DE AGOSTO DE 2026'), '2026-08-12');
  assert.equal(parsearFechaEs('MIÉRCOLES 3 DE SEPTIEMBRE DE 2026'), '2026-09-03');
  assert.equal(parsearFechaEs('SABADO 1 DE AGOSTO DE 2026'), '2026-08-01');
  assert.equal(parsearFechaEs('setiembre nomas'), null);
  assert.equal(parsearFechaEs(''), null);
});

t('el turno entra como fraccion, Date o texto', () => {
  assert.equal(parsearTurno(0.375), '09:00');          // como lo guarda Excel
  assert.equal(parsearTurno(0.6875), '16:30');
  assert.equal(parsearTurno(new Date(1899, 11, 30, 9, 30)), '09:30');
  assert.equal(parsearTurno('09:00:00'), '09:00');
  assert.equal(parsearTurno('9:30'), '09:30');
  assert.equal(parsearTurno(''), null);
  assert.equal(parsearTurno(null), null);
});

t('separa los tres formatos de orden multiple del archivo real', () => {
  assert.deepEqual(parsearOrdenes('2653776-2653773'), ['2653776', '2653773']);
  assert.deepEqual(parsearOrdenes('2653898 / 2653942'), ['2653898', '2653942']);
  assert.deepEqual(parsearOrdenes('2653996/*2654280'), ['2653996', '2654280']);
  assert.deepEqual(parsearOrdenes('2648302'), ['2648302']);
  assert.deepEqual(parsearOrdenes(''), []);
  assert.deepEqual(parsearOrdenes('sin numero'), []);
});

t('normaliza los nombres, que vienen de cualquier forma', () => {
  assert.equal(tituloNombre('battaglia (moron)'), 'Battaglia (Moron)');
  assert.equal(tituloNombre('BIANFRAN'), 'Bianfran');
  assert.equal(tituloNombre('  paulise   claudio '), 'Paulise Claudio');
});

// ── reconocimiento del archivo ───────────────────────────────────────────────

t('reconoce la planilla y descarta cualquier otra cosa', () => {
  assert.equal(esPlanillaRetiros(unDia()), true);
  assert.equal(esPlanillaRetiros(Buffer.from('no soy un excel')), false);
  const otro = aBuffer({ Hoja1: [['Proveedor nombre', 'Bultos'], ['Arcor', 3]] });
  assert.equal(esPlanillaRetiros(otro), false);
});

t('un archivo que no es la planilla tira RetirosError, no un crash', () => {
  assert.throws(() => parsearRetiros(Buffer.from('basura')), RetirosError);
  assert.throws(() => parsearRetiros(aBuffer({ Hoja1: [['a', 'b'], [1, 2]] })), RetirosError);
});

// ── estructura ───────────────────────────────────────────────────────────────

t('la fecha de la celda combinada vale para todo el bloque', () => {
  const { filas } = parsearRetiros(unDia({
    0: { codigo: '111', cliente: 'uno', prep: 'Preparado' },
    7: { codigo: '222', cliente: 'dos', prep: 'Preparado' },
  }), DESDE);
  assert.equal(filas.length, 2);
  assert.deepEqual(filas.map((f) => f.fecha), ['2026-08-17', '2026-08-17']);
  assert.deepEqual(filas.map((f) => f.turno), ['09:00', '12:30']);
});

t('toma los dias de todas las hojas del libro', () => {
  const buf = aBuffer({
    JULIO: bloque('VIERNES 31 DE JULIO DE 2026', { 0: { codigo: '1', cliente: 'a' } }),
    AGOSTO: bloque('LUNES 17 DE AGOSTO DE 2026', { 0: { codigo: '2', cliente: 'b' } }),
    Listas: [['LISTAS DESPLEGABLES']],
  });
  const { dias } = parsearRetiros(buf, { desde: '2026-07-01' });
  assert.deepEqual(dias, ['2026-07-31', '2026-08-17']);
});

t('no confunde "N de PEDIDO" con "N de Orden de Pedido"', () => {
  const { filas } = parsearRetiros(unDia({
    0: { codigo: '777', cliente: 'x', nPedido: 4, orden: '2650000' },
  }), DESDE);
  assert.equal(filas[0].n_pedido, 4);
  assert.deepEqual(filas[0].ordenes, ['2650000']);
});

// ── traduccion de estados ────────────────────────────────────────────────────

t('traduce los estados y aguanta las mayusculas inconsistentes', () => {
  const { filas, anomalias } = parsearRetiros(unDia({
    0: { codigo: '1', cliente: 'a', prep: 'Preparado' },
    1: { codigo: '2', cliente: 'b', prep: 'PREPARADO' },        // así aparece en el archivo real
    2: { codigo: '3', cliente: 'c', prep: 'En Preparación' },
    3: { codigo: '4', cliente: 'd', prep: 'en preparacion' },   // sin tilde ni mayúsculas
    4: { codigo: '5', cliente: 'e', prep: 'Pendiente' },
    5: { codigo: '6', cliente: 'f', prep: 'Con Faltante' },
  }), DESDE);
  assert.deepEqual(filas.map((f) => f.prep),
    ['listo', 'listo', 'preparando', 'preparando', 'agendado', 'faltante']);
  assert.equal(anomalias.length, 0);
});

t('ESTADO vacio es "todavia no se retiro", no un error', () => {
  const { filas } = parsearRetiros(unDia({
    0: { codigo: '1', cliente: 'a', prep: 'Preparado', estado: '' },
    1: { codigo: '2', cliente: 'b', prep: 'Preparado', estado: 'Pendiente de Retiro' },
    2: { codigo: '3', cliente: 'c', prep: 'Preparado', estado: 'Retirado' },
  }), DESDE);
  assert.deepEqual(filas.map((f) => f.estado_final), [null, null, 'retirado']);
});

t('un estado desconocido avisa pero no rompe la importacion', () => {
  const { filas, anomalias } = parsearRetiros(unDia({
    0: { codigo: '1', cliente: 'a', prep: 'Medio Preparado' },
  }), DESDE);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].prep, null);
  assert.equal(anomalias.length, 1);
  assert.ok(anomalias[0].includes('Medio Preparado'));
});

// ── lo que NO va a la pantalla ───────────────────────────────────────────────

t('deja afuera cancelados y reprogramados', () => {
  const { filas, descartados } = parsearRetiros(unDia({
    0: { codigo: '1', cliente: 'a', estado: 'Cancelado' },
    1: { codigo: '2', cliente: 'b', estado: 'Reprogramado' },
    2: { codigo: '3', cliente: 'c', prep: 'Preparado' },
  }), DESDE);
  assert.deepEqual(filas.map((f) => f.codigo_cliente), ['3']);
  assert.equal(descartados.cancelados, 2);
});

t('deja afuera el reparto en camion pero no "RETIRA FACU CACERES"', () => {
  const { filas, descartados } = parsearRetiros(unDia({
    0: { codigo: '1', cliente: 'a', entrega: 'REPARTO CAMION' },
    1: { codigo: '2', cliente: 'b', entrega: 'RETIRA FACU CACERES' },
    2: { codigo: '3', cliente: 'c', entrega: '' },
  }), DESDE);
  assert.deepEqual(filas.map((f) => f.codigo_cliente), ['2', '3']);
  assert.equal(descartados.reparto, 1);
});

t('ignora las marcas que escribe el deposito sin codigo de cliente', () => {
  // En el archivo real aparece "CORTE" en la columna CLIENTE, sin código.
  const { filas, descartados } = parsearRetiros(unDia({
    0: { codigo: '', cliente: 'CORTE' },
    1: { codigo: '900', cliente: 'real', prep: 'Preparado' },
  }), DESDE);
  assert.deepEqual(filas.map((f) => f.codigo_cliente), ['900']);
  assert.equal(descartados.sinCodigo, 1);
});

t('solo importa de la fecha pedida en adelante', () => {
  const buf = aBuffer({
    AGOSTO: [
      ...bloque('LUNES 10 DE AGOSTO DE 2026', { 0: { codigo: '1', cliente: 'viejo' } }),
      ...bloque('LUNES 17 DE AGOSTO DE 2026', { 0: { codigo: '2', cliente: 'nuevo' } }),
    ],
  });
  const { filas, dias, descartados } = parsearRetiros(buf, { desde: '2026-08-14' });
  assert.deepEqual(dias, ['2026-08-17']);
  assert.deepEqual(filas.map((f) => f.codigo_cliente), ['2']);
  assert.equal(descartados.pasados, 1);
});

// ── campos ───────────────────────────────────────────────────────────────────

t('marca como web solo lo que vende WEB', () => {
  const { filas } = parsearRetiros(unDia({
    0: { codigo: '1', cliente: 'a', vendedor: 'WEB' },
    1: { codigo: '2', cliente: 'b', vendedor: 'SALON MORENO' },
    2: { codigo: '3', cliente: 'c', vendedor: 'BRENDA VACCARO' },
    3: { codigo: '4', cliente: 'd', vendedor: '' },
  }), DESDE);
  assert.deepEqual(filas.map((f) => f.canal), ['web', 'programado', 'programado', 'programado']);
});

t('bultos vacio queda en null, no en cero', () => {
  const { filas } = parsearRetiros(unDia({
    0: { codigo: '1', cliente: 'a', bultos: 20 },
    1: { codigo: '2', cliente: 'b', bultos: '' },
  }), DESDE);
  assert.deepEqual(filas.map((f) => f.bultos), [20, null]);
});

t('el codigo de cliente se guarda como texto (hay codigos de 3 digitos)', () => {
  const { filas } = parsearRetiros(unDia({ 0: { codigo: 774, cliente: 'ciglia' } }), DESDE);
  assert.strictEqual(filas[0].codigo_cliente, '774');
});

// ── clave del renglon ────────────────────────────────────────────────────────

t('avisa si hay dos pedidos en el mismo turno', () => {
  const buf = aBuffer({
    AGOSTO: [
      ...bloque('LUNES 17 DE AGOSTO DE 2026', { 0: { codigo: '1', cliente: 'a' } }),
      ...bloque('LUNES 17 DE AGOSTO DE 2026', { 0: { codigo: '2', cliente: 'b' } }),
    ],
  });
  const { filas, anomalias } = parsearRetiros(buf, DESDE);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].codigo_cliente, '2'); // gana el último
  assert.equal(anomalias.length, 1);
  assert.ok(anomalias[0].includes('mismo turno'));
});

t('registra los dias armados aunque queden sin pedidos', () => {
  // Un día que se vacía tiene que seguir apareciendo en diasVistos: si no, el
  // pedido dado de baja quedaría colgado en la pantalla para siempre.
  const buf = aBuffer({
    AGOSTO: [
      ...bloque('LUNES 17 DE AGOSTO DE 2026', { 0: { codigo: '1', cliente: 'a' } }),
      ...bloque('MARTES 18 DE AGOSTO DE 2026'),                       // sin pedidos
      ...bloque('LUNES 10 DE AGOSTO DE 2026', { 0: { codigo: '9', cliente: 'viejo' } }),
    ],
  });
  const { dias, diasVistos } = parsearRetiros(buf, { desde: '2026-08-14' });
  assert.deepEqual(dias, ['2026-08-17']);
  assert.deepEqual(diasVistos, ['2026-08-17', '2026-08-18']); // el pasado no entra
});

t('devuelve las filas ordenadas por fecha y turno', () => {
  const { filas } = parsearRetiros(unDia({
    5: { codigo: '3', cliente: 'c' },
    0: { codigo: '1', cliente: 'a' },
    2: { codigo: '2', cliente: 'b' },
  }), DESDE);
  assert.deepEqual(filas.map((f) => f.turno), ['09:00', '10:00', '11:30']);
});

console.log(`\n${pass} tests ok\n`);
