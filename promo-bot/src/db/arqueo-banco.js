// Acceso a datos del arqueo bancario ACUMULADO (bot.arqueo_banco_movimientos / arqueo_banco_mayor,
// migración 041). A diferencia de bot.liquidaciones_pendientes (que guarda el archivo entero y se
// borra al conciliar), acá se persiste CADA RENGLÓN, uno por uno, con su propio estado
// pendiente/matcheado — así un cobro que Sigma asienta días después del extracto se matchea solo
// en cuanto llega un Mayor más nuevo, sin volver a subir nada de lo viejo.
//
// `fecha`/`ingreso` viajan como TEXTO (ver la migración): nunca pasan por un tipo date/timestamp
// de Postgres, así que node-pg no los puede correr de día por el TZ del proceso.
const { pool } = require('./pool');
const { fechaISO } = require('../lib/fechas');

// La posición (1, 2, 3…) de cada ítem entre los que comparten la MISMA clave base, en el orden en
// que aparecen — desempata filas genuinamente distintas con los mismos valores (ver migración
// 041: pasó con comisiones repetidas y con un cliente con dos recibos idénticos el mismo día).
// Re-subir el MISMO archivo reproduce el mismo orden → mismas ocurrencias → el dedup sigue andando.
function conOcurrencia(items, claveDe) {
  const contador = new Map();
  return items.map((it) => {
    const k = claveDe(it);
    const n = (contador.get(k) || 0) + 1;
    contador.set(k, n);
    return n;
  });
}

// Guarda los renglones de UN extracto bancario ya parseado (operaciones de plataformas.js). Dedup
// por (plataforma, fecha, monto, sentido, concepto, referencia, ocurrencia): re-subir un extracto
// que se pisa con uno ya cargado no duplica filas. -> { insertados, ignorados }
async function guardarMovimientosBanco({ plataforma, operaciones, nombreArchivo, usuarioId }) {
  if (!operaciones.length) return { insertados: 0, ignorados: 0 };
  const fechas = operaciones.map((o) => String(o.hora).slice(0, 10));
  const montos = operaciones.map((o) => o.bruto);
  const sentidos = operaciones.map((o) => o.sentido);
  const conceptos = operaciones.map((o) => o.concepto || '');
  const referencias = operaciones.map((o) => o.referencia || '');
  const ocurrencias = conOcurrencia(operaciones, (o) =>
    [String(o.hora).slice(0, 10), o.bruto, o.sentido, o.concepto || '', o.referencia || ''].join('|'));
  const { rows } = await pool.query(
    `insert into bot.arqueo_banco_movimientos
       (plataforma, fecha, monto, sentido, concepto, referencia, ocurrencia, nombre_archivo, usuario_id)
     select $1, t.f, t.m, t.s, t.c, t.r, t.o, $8, $9
       from unnest($2::text[], $3::numeric[], $4::text[], $5::text[], $6::text[], $7::int[]) as t(f, m, s, c, r, o)
     on conflict (plataforma, fecha, monto, sentido, concepto, referencia, ocurrencia) do nothing
     returning id`,
    [plataforma, fechas, montos, sentidos, conceptos, referencias, ocurrencias, nombreArchivo || '', usuarioId ?? null]
  );
  return { insertados: rows.length, ignorados: operaciones.length - rows.length };
}

// Guarda los renglones de UN Mayor/Diario ya parseado (movimientos de mayor-excel.js), de UNA
// cuenta. Dedup por (cuenta_id, asiento, fecha, debe, haber, comprobante, ocurrencia).
// -> { insertados, ignorados }
async function guardarMayor({ cuentaId, movimientos, nombreArchivo, usuarioId }) {
  if (!movimientos.length) return { insertados: 0, ignorados: 0 };
  const asientos = movimientos.map((m) => m.asiento);
  const fechas = movimientos.map((m) => fechaISO(m.fecha));
  const debes = movimientos.map((m) => m.debe);
  const habers = movimientos.map((m) => m.haber);
  const comprobantes = movimientos.map((m) => m.comprobante || '');
  const clientes = movimientos.map((m) => m.cliente || '');
  const usuarios = movimientos.map((m) => m.usuario || '');
  const ingresos = movimientos.map((m) => m.ingreso || null);
  const ocurrencias = conOcurrencia(movimientos, (m) =>
    [m.asiento, fechaISO(m.fecha), m.debe, m.haber, m.comprobante || ''].join('|'));
  const { rows } = await pool.query(
    `insert into bot.arqueo_banco_mayor
       (cuenta_id, asiento, fecha, debe, haber, comprobante, cliente, usuario, ingreso, ocurrencia, nombre_archivo, usuario_id)
     select $1, t.a, t.f, t.d, t.h, t.comp, t.cli, t.usr, t.ing, t.o, $11, $12
       from unnest($2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::text[], $8::text[], $9::text[], $10::int[])
            as t(a, f, d, h, comp, cli, usr, ing, o)
     on conflict (cuenta_id, asiento, fecha, debe, haber, comprobante, ocurrencia) do nothing
     returning id`,
    [cuentaId, asientos, fechas, debes, habers, comprobantes, clientes, usuarios, ingresos, ocurrencias, nombreArchivo || '', usuarioId ?? null]
  );
  return { insertados: rows.length, ignorados: movimientos.length - rows.length };
}

// Lo PENDIENTE de una plataforma/cuenta, acotado al mes ('AAAA-MM'). Devuelve ya en la forma que
// espera conciliarMP: { operaciones, movimientos }, cada renglón con `_id` (para poder marcarlo
// matcheado después). El extracto no trae hora real: `hora` queda a medianoche (mismo criterio
// que el reporte "collection" de MP — conciliarMP aparea SOLO por importe cuando pasa esto).
async function pendientesDelMes({ plataforma, cuentaId, mes }) {
  const [{ rows: mRows }, { rows: gRows }] = await Promise.all([
    pool.query(
      `select id, fecha, monto, sentido, concepto, referencia
         from bot.arqueo_banco_movimientos
        where plataforma = $1 and estado = 'pendiente' and left(fecha, 7) = $2
        order by fecha`,
      [plataforma, mes]
    ),
    pool.query(
      `select id, asiento, fecha, debe, haber, comprobante, cliente, usuario, ingreso
         from bot.arqueo_banco_mayor
        where cuenta_id = $1 and estado = 'pendiente' and left(fecha, 7) = $2
        order by fecha`,
      [cuentaId, mes]
    ),
  ]);
  const operaciones = mRows.map((r) => ({
    _id: r.id,
    hora: `${r.fecha} 00:00:00`,
    bruto: Number(r.monto),
    sentido: r.sentido,
    concepto: r.concepto,
    referencia: r.referencia,
    comision: 0,
    impuestos: 0,
    neto: Number(r.monto),
  }));
  const movimientos = gRows.map((r) => ({
    _id: r.id,
    asiento: r.asiento,
    comp: '',
    cliente: r.cliente,
    comprobante: r.comprobante,
    usuario: r.usuario,
    ingreso: r.ingreso,
    debe: Number(r.debe),
    haber: Number(r.haber),
  }));
  return { operaciones, movimientos };
}

// Marca matcheados los pares que encontró conciliarMP ({movimientoId, mayorId}[]).
async function marcarMatch(pares) {
  await Promise.all(pares.map(({ movimientoId, mayorId }) => Promise.all([
    pool.query(
      "update bot.arqueo_banco_movimientos set estado = 'matcheado', matcheado_con = $2, matcheado_en = now() where id = $1",
      [movimientoId, mayorId]
    ),
    pool.query(
      "update bot.arqueo_banco_mayor set estado = 'matcheado', matcheado_con = $2, matcheado_en = now() where id = $1",
      [mayorId, movimientoId]
    ),
  ])));
}

module.exports = { guardarMovimientosBanco, guardarMayor, pendientesDelMes, marcarMatch };
