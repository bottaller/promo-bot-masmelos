// Tests de db/retiros.js — el que escribe los turnos que muestra la pantalla de recepción.
// Correr: node test/retiros-db.test.js
//
// Este módulo no tenía ningún test y guarda los dos frenos que más caro salieron:
//
//   FRENO 1 — una planilla sin turnos NO borra nada. Reenviar por error una versión
//   vieja del Excel parseaba cero filas pero traía los días armados: el DELETE corría
//   igual y vaciaba el día entero (28 pedidos en la prueba real, 16 ya listos).
//
//   FRENO 2 — no se borra lo que alguien ya marcó. Si el pedido está en 'listo' o lo
//   tocó el panel, se conserva y se informa, en vez de desaparecer en silencio.
//
// No hace falta una base: se reemplaza src/db/pool.js por un doble que anota las
// consultas. Lo que se verifica es estructural —qué consultas salen y con qué
// parámetros—, que es exactamente donde viven las dos regresiones de arriba.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const assert = require('assert');
const Module = require('module');

// ── El doble del pool ────────────────────────────────────────────────────────
let consultas = [];      // todas las que se ejecutaron, en orden
let conexiones = 0;      // cuántas veces se pidió un client
let liberaciones = 0;    // cuántas se devolvieron (tiene que dar igual)
let conservadosFalsos = []; // lo que devuelve la consulta de "los que ya estaban marcados"
let borradosFalsos = 0;
let porDiaFalso = [];
let romperEn = null;     // si una consulta contiene este texto, explota

function clasificar(sql) {
  const s = String(sql).trim().toLowerCase();
  if (s === 'begin' || s === 'commit' || s === 'rollback') return s;
  if (s.startsWith('insert into public.retiros')) return 'insert';
  if (s.startsWith('delete from public.retiros')) return 'delete';
  if (s.includes('group by fecha')) return 'resumen';
  if (s.startsWith('select')) return 'conservados';
  return 'otra';
}

const client = {
  async query(sql, params) {
    const tipo = clasificar(sql);
    consultas.push({ tipo, sql: String(sql), params });
    if (romperEn && String(sql).includes(romperEn)) throw new Error('boom');
    if (tipo === 'conservados') return { rows: conservadosFalsos };
    if (tipo === 'delete') return { rowCount: borradosFalsos };
    if (tipo === 'resumen') return { rows: porDiaFalso };
    return { rows: [] };
  },
  release() { liberaciones++; },
};

const poolPath = require.resolve('../src/db/pool');
const mod = new Module(poolPath, null);
mod.filename = poolPath;
mod.loaded = true;
mod.exports = {
  pool: {
    async connect() { conexiones++; return client; },
    async query() { return { rows: [{ ultima: null }] }; },
  },
};
require.cache[poolPath] = mod;

const { registrarRetiros, ultimaPlanillaImportada } = require('../src/db/retiros');

// ── Utilidades ───────────────────────────────────────────────────────────────
function reset() {
  consultas = []; conexiones = 0; liberaciones = 0;
  conservadosFalsos = []; borradosFalsos = 0; porDiaFalso = []; romperEn = null;
}
const tipos = () => consultas.map((c) => c.tipo);
const unaSola = (tipo) => consultas.filter((c) => c.tipo === tipo);

function fila(over = {}) {
  return {
    fecha: '2026-08-21', turno: '09:00', codigo_cliente: '1234', cliente: 'ALGUIEN',
    n_pedido: 1, ordenes: ['A1'], canal: 'programado', bultos: 3,
    prep: 'preparando', estado_final: null, ...over,
  };
}

let pass = 0;
async function t(nombre, fn) { reset(); await fn(); pass++; console.log('  ok:', nombre); }

(async () => {
  console.log('\ndb/retiros');

  // ── Los dos frenos ─────────────────────────────────────────────────────────

  await t('FRENO 1: una planilla sin turnos NO borra nada, aunque traiga los días', async () => {
    // Este es el caso que borraba el día entero: cero filas pero diasVistos cargado.
    const r = await registrarRetiros({ filas: [], diasVistos: ['2026-08-21', '2026-08-22'] });
    assert.ok(!tipos().includes('delete'), 'no tiene que salir ningún DELETE');
    assert.ok(!tipos().includes('insert'), 'ni ningún INSERT');
    assert.equal(r.borrados, 0);
    // Igual se consulta el resumen: hay que poder contar lo que quedó en pantalla.
    assert.ok(tipos().includes('resumen'));
  });

  await t('FRENO 2: el DELETE solo alcanza lo que nadie tocó nunca', async () => {
    await registrarRetiros({ filas: [fila()], diasVistos: ['2026-08-21'] });
    const del = unaSola('delete')[0];
    assert.ok(del, 'tiene que haber un DELETE');
    const sql = del.sql.replace(/\s+/g, ' ');
    // Las tres condiciones que hacen que no se borre nada marcado.
    assert.ok(sql.includes("r.origen = 'planilla'"), 'no filtra por origen: borraría lo que marcó el panel');
    assert.ok(sql.includes('r.prep is null'), 'no filtra por prep: borraría un pedido ya listo');
    assert.ok(sql.includes('r.estado_final is null'), 'no filtra por estado_final: borraría uno ya retirado');
  });

  await t('FRENO 2: los que sobran pero ya estaban marcados se devuelven, no se borran', async () => {
    conservadosFalsos = [
      { fecha: '2026-08-21', turno: '10:00', codigo_cliente: '99', cliente: 'X', prep: 'listo', estado_final: null, origen: 'panel' },
    ];
    borradosFalsos = 2;
    const r = await registrarRetiros({ filas: [fila()], diasVistos: ['2026-08-21'] });
    assert.equal(r.conservados.length, 1);
    assert.equal(r.conservados[0].prep, 'listo');
    assert.equal(r.borrados, 2);
    // Y se consultan ANTES de borrar: si se leyeran después, ya no estarían.
    const iSel = tipos().indexOf('conservados');
    const iDel = tipos().indexOf('delete');
    assert.ok(iSel >= 0 && iDel >= 0 && iSel < iDel, 'hay que leerlos antes del DELETE');
  });

  // ── Transacción ────────────────────────────────────────────────────────────

  await t('todo va en una transacción y el client siempre se devuelve', async () => {
    await registrarRetiros({ filas: [fila()], diasVistos: ['2026-08-21'] });
    assert.equal(tipos()[0], 'begin');
    assert.equal(tipos()[tipos().length - 1], 'commit');
    assert.equal(conexiones, 1);
    assert.equal(liberaciones, 1, 'sin release el pool se queda sin conexiones');
  });

  await t('si algo falla se hace rollback y igual se devuelve el client', async () => {
    romperEn = 'delete from public.retiros';
    await assert.rejects(() => registrarRetiros({ filas: [fila()], diasVistos: ['2026-08-21'] }));
    assert.ok(tipos().includes('rollback'), 'sin rollback la transacción queda abierta');
    assert.ok(!tipos().includes('commit'));
    assert.equal(liberaciones, 1);
  });

  // ── Sin nada que hacer ─────────────────────────────────────────────────────

  await t('sin filas y sin días no se conecta siquiera a la base', async () => {
    const r = await registrarRetiros({ filas: [], diasVistos: [] });
    assert.deepEqual(r, { guardados: 0, borrados: 0, porDia: [] });
    assert.equal(conexiones, 0, 'no tiene sentido abrir una transacción para no hacer nada');
  });

  await t('llamarlo sin argumentos no explota', async () => {
    const r = await registrarRetiros({});
    assert.equal(r.guardados, 0);
    assert.equal(conexiones, 0);
  });

  // ── Qué días se tocan ──────────────────────────────────────────────────────

  await t('los días salen de diasVistos, deduplicados', async () => {
    await registrarRetiros({
      filas: [fila()],
      diasVistos: ['2026-08-21', '2026-08-21', '2026-08-22'],
    });
    assert.deepEqual(unaSola('resumen')[0].params[0], ['2026-08-21', '2026-08-22']);
  });

  await t('sin diasVistos se usan las fechas de las filas', async () => {
    // Importa: si se cayera a "todos los días", una planilla de un día borraría
    // pedidos de otros días que no estaban en el archivo.
    await registrarRetiros({
      filas: [fila({ turno: '09:00' }), fila({ fecha: '2026-08-25', turno: '10:00' })],
    });
    assert.deepEqual(unaSola('resumen')[0].params[0], ['2026-08-21', '2026-08-25']);
  });

  // ── El INSERT ──────────────────────────────────────────────────────────────

  await t('el INSERT manda las 11 columnas por fila, en orden', async () => {
    await registrarRetiros({
      filas: [fila({ codigo_cliente: '777', cliente: 'PEPE', bultos: 5 })],
      diasVistos: ['2026-08-21'],
    });
    const ins = unaSola('insert')[0];
    assert.equal(ins.params.length, 11, 'una fila = 11 parámetros');
    // `agenda` va tercera y cae a 'general' cuando la fila no la trae: es la hoja
    // del mes de siempre. Las hojas de NEGOCIOS mandan su propio valor.
    assert.deepEqual(ins.params, [
      '2026-08-21', '09:00', 'general', '777', 'PEPE', 1, ['A1'], 'programado', 5, 'preparando', null,
    ]);
  });

  await t('dos filas = 22 parámetros y placeholders correlativos', async () => {
    await registrarRetiros({
      filas: [fila({ turno: '09:00' }), fila({ turno: '09:30' })],
      diasVistos: ['2026-08-21'],
    });
    const ins = unaSola('insert')[0];
    assert.equal(ins.params.length, 22);
    assert.ok(ins.sql.includes('$12::date'), 'la segunda fila tiene que arrancar en $12');
    assert.ok(ins.sql.includes('$22'));
  });

  await t('los campos que pueden faltar viajan como null, no como undefined', async () => {
    // pg manda undefined como null igual, pero un undefined que se cuela suele ser
    // un typo en el nombre del campo: mejor que el default sea explícito.
    await registrarRetiros({
      filas: [{ fecha: '2026-08-21', turno: '09:00', codigo_cliente: '1', canal: 'web' }],
      diasVistos: ['2026-08-21'],
    });
    const p = unaSola('insert')[0].params;
    assert.equal(p.filter((x) => x === undefined).length, 0, 'no puede quedar ningún undefined');
    // Orden de COLUMNAS: fecha, turno, agenda, codigo_cliente, cliente, n_pedido,
    // ordenes, … — `ordenes` es el séptimo (índice 6).
    assert.deepEqual(p[6], [], 'ordenes vacío es un array, no null: la columna es not null');
    assert.equal(p[2], 'general', 'sin agenda explícita, la fila es de la hoja del mes');
  });

  await t('el estado solo puede avanzar: el UPDATE compara rangos', async () => {
    await registrarRetiros({ filas: [fila()], diasVistos: ['2026-08-21'] });
    const sql = unaSola('insert')[0].sql.replace(/\s+/g, ' ');
    // La AGENDA es parte de la clave: la hoja del mes y las de negocios comparten
    // los mismos 16 horarios, así que sin ella un pedido pisaba al otro.
    assert.ok(sql.includes('on conflict (fecha, turno, agenda) do update'));
    assert.ok(sql.includes('retiros_rango_prep'), 'sin esto una subida vieja pisaría un "listo"');
    assert.ok(sql.includes('retiros_rango_final'));
    assert.ok(sql.includes('excluded.prep is null then retiros.prep'), 'una celda vacía no debe borrar el estado');
  });

  // ── El resumen ─────────────────────────────────────────────────────────────

  await t('el resumen sale de la base DESPUÉS del merge, no de lo que traía el Excel', async () => {
    // Es lo que se le muestra a quien subió el archivo: tiene que describir lo que
    // va a mostrar la pantalla, no lo que decía la planilla antes de mezclarse.
    porDiaFalso = [{ fecha: '2026-08-21', total: 9, listos: 4, preparando: 2, retirados: 1, sin_estado: 2 }];
    const r = await registrarRetiros({ filas: [fila()], diasVistos: ['2026-08-21'] });
    assert.equal(r.guardados, 1, 'guardados sí es lo que traía el Excel');
    assert.deepEqual(r.porDia, porDiaFalso);
    assert.equal(r.porDia[0].total, 9);
  });

  await t('los cuatro contadores del resumen suman el total', async () => {
    // 'faltante' y 'agendado' no entraban en ninguno y los números no cerraban.
    await registrarRetiros({ filas: [fila()], diasVistos: ['2026-08-21'] });
    const s = unaSola('resumen')[0].sql.replace(/\s+/g, ' ');
    assert.ok(s.includes('as listos') && s.includes('as preparando'));
    assert.ok(s.includes('as retirados') && s.includes('as sin_estado'));
    assert.ok(s.includes('prep is null or prep in'), 'sin_estado se calcula por descarte');
  });

  // ── El chequeo de frescura ─────────────────────────────────────────────────

  await t('ultimaPlanillaImportada mira solo lo que escribió la planilla', async () => {
    const v = await ultimaPlanillaImportada();
    assert.equal(v, null, 'sin filas devuelve null, no una fecha inventada');
  });

  console.log(`\n${pass} tests ok\n`);
})().catch((e) => { console.error('\nFALLO:', e); process.exit(1); });
