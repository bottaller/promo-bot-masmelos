// Acceso a datos de Tesorería: saldos (realidad), movimientos (libro), conciliación
// (resultado) y auditoría (rastro). El acumulado NO se guarda: se deriva de las diferencias
// (robusto a cargas retroactivas). Todo transaccional, mismo patrón que guardarSaldos.
const { pool } = require('./pool');
const { fechaISO, finDeDiaTs } = require('../lib/fechas');
const { conciliar, ACUMULADO_DESDE } = require('../lib/conciliacion');

// El corte por hora usa timestamps de "reloj de pared" (hora argentina literal). Se guardan
// y comparan SIEMPRE como el string canónico 'AAAA-MM-DD HH:MM:SS'; se LEEN con to_char()
// para que node-pg no los parsee a Date (correría 3h en Railway/UTC). Formato de to_char:
const TS_FMT = 'YYYY-MM-DD HH24:MI:SS';

// ---------------------------------------------------------------------------
// Saldos (lado "realidad")
// ---------------------------------------------------------------------------

// Guarda (upsert) los saldos de un día. Re-subir el mismo día pisa los montos y la hora.
// `contadoEn` = momento del conteo (string canónico); si falta, fin del día (= modelo por día).
async function guardarSaldos({ fecha, empresa, saldos, usuarioId, contadoEn }) {
  const fISO = fechaISO(fecha);
  const ce = contadoEn || finDeDiaTs(fISO);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const s of saldos) {
      await client.query(
        `insert into bot.tesoreria_saldos (fecha, empresa, cuenta, moneda, monto, contado_en, cargado_por)
           values ($1::date, $2, $3, $4, $5, $6::timestamp, $7)
         on conflict (fecha, empresa, cuenta)
           do update set moneda = excluded.moneda, monto = excluded.monto, contado_en = excluded.contado_en,
                         cargado_por = excluded.cargado_por, cargado_en = now()`,
        [fISO, empresa, s.cuenta, s.moneda, s.monto, ce, usuarioId ?? null]
      );
    }
    await client.query('commit');
    return { cantidad: saldos.length };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// Saldos guardados de una fecha exacta.
async function saldosDeFecha({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select cuenta, moneda, monto from bot.tesoreria_saldos
      where fecha = $1::date and empresa = $2 order by cuenta`,
    [fechaISO(fecha), empresa]
  );
  return rows;
}

// Saldos del ÚLTIMO día cargado ANTES de `fecha` (el "ayer" real: puede ser el viernes si
// hoy es lunes), CON su momento de conteo (`contadoEn`, string canónico o fin del día si el
// saldo viejo no tiene hora) — que es el límite inferior de la ventana de conciliación.
// Devuelve { fecha, contadoEn, saldos } o { fecha: null, contadoEn: null, saldos: [] } si no hay.
async function saldosAnteriores({ fecha, empresa = 'HONRE' }) {
  const prev = await pool.query(
    `select max(fecha) as f from bot.tesoreria_saldos where empresa = $1 and fecha < $2::date`,
    [empresa, fechaISO(fecha)]
  );
  const f = prev.rows[0] && prev.rows[0].f;
  if (!f) return { fecha: null, contadoEn: null, saldos: [] };
  const fISO = fechaISO(f);
  const { rows } = await pool.query(
    `select cuenta, moneda, monto,
            coalesce(to_char(contado_en, '${TS_FMT}'), $1 || ' 23:59:59') as contado_en
       from bot.tesoreria_saldos where fecha = $2::date and empresa = $3 order by cuenta`,
    [fISO, fISO, empresa]
  );
  const contadoEn = rows.length ? rows[0].contado_en : `${fISO} 23:59:59`;
  return { fecha: f, contadoEn, saldos: rows.map((r) => ({ cuenta: r.cuenta, moneda: r.moneda, monto: r.monto })) };
}

// Momento de conteo (string canónico 'AAAA-MM-DD HH:MM:SS') de un día — el límite de la
// ventana por hora. Coalesce a fin del día si el saldo de ese día no tiene hora. Lo usan
// /semanal y /mensual para cortar en los bordes del período (denormalizado: max = el valor).
async function momentoConteo({ fecha, empresa = 'HONRE' }) {
  const fISO = fechaISO(fecha);
  const { rows } = await pool.query(
    `select coalesce(to_char(max(contado_en), '${TS_FMT}'), $1 || ' 23:59:59') as momento
       from bot.tesoreria_saldos where fecha = $2::date and empresa = $3`,
    [fISO, fISO, empresa]
  );
  return rows[0].momento;
}

// ---------------------------------------------------------------------------
// Movimientos (lado "libro")
// ---------------------------------------------------------------------------

// Guarda el libro. `movimientos` viene de parsearLibro: [{fecha (Date), cuenta_id, cuenta,
// debe, haber, debe_nominal, haber_nominal}] (puede abarcar varios días). Por cada día que
// trae, BORRA lo que hubiera de ese día e inserta lo nuevo (captura ajustes retroactivos).
async function guardarMovimientos({ empresa = 'HONRE', movimientos, usuarioId }) {
  const porDia = new Map();
  for (const m of movimientos) {
    const iso = fechaISO(m.fecha);
    if (!porDia.has(iso)) porDia.set(iso, []);
    porDia.get(iso).push(m);
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Insert EN LOTE (un query por cada LOTE filas), no uno por fila: con el grano por hora un
    // día trae miles de renglones (uno por asiento), y 1 INSERT por fila tardaba ~2 min para dos
    // días y hacía fallar el cierre (el envío del reporte expiraba). Ahora son pocas queries.
    const COLS = 10;      // columnas del insert (los 10 placeholders de cada fila)
    const LOTE = 1000;    // 1000×10 = 10.000 parámetros, holgado bajo el límite de 65.535 de pg
    for (const [iso, movs] of porDia) {
      await client.query('delete from bot.tesoreria_movimientos where fecha = $1::date and empresa = $2', [iso, empresa]);
      for (let i = 0; i < movs.length; i += LOTE) {
        const lote = movs.slice(i, i + LOTE);
        const params = [];
        const filas = lote.map((m, j) => {
          const b = j * COLS;
          params.push(iso, empresa, m.cuenta_id, m.cuenta || '', m.debe || 0, m.haber || 0,
            m.debe_nominal || 0, m.haber_nominal || 0, m.ingreso || finDeDiaTs(iso), usuarioId ?? null);
          return `($${b + 1}::date,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::timestamp,$${b + 10})`;
        }).join(',');
        await client.query(
          `insert into bot.tesoreria_movimientos
             (fecha, empresa, cuenta_id, cuenta, debe, haber, debe_nominal, haber_nominal, ingreso, cargado_por)
           values ${filas}`,
          params
        );
      }
    }
    await client.query('commit');
    return { dias: porDia.size, filas: movimientos.length };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// Movimientos guardados de una fecha (para /reportecierre).
async function movimientosDeFecha({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select cuenta_id, cuenta, debe, haber, debe_nominal, haber_nominal
       from bot.tesoreria_movimientos where fecha = $1::date and empresa = $2`,
    [fechaISO(fecha), empresa]
  );
  return rows;
}

// Movimientos guardados en la ventana (desde, hasta] POR HORA — para el cierre y el replay.
// `desde`/`hasta` son strings canónicos 'AAAA-MM-DD HH:MM:SS' (momentos de conteo). El corte
// es por `ingreso` (reloj de pared), comparado como ::timestamp; ambos límites son strings
// para no materializar Dates. Semiabierta: excluye el momento anterior, incluye el de hoy.
async function movimientosDeRango({ desde, hasta, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select cuenta_id, debe, haber, debe_nominal, haber_nominal
       from bot.tesoreria_movimientos
      where empresa = $1 and ingreso > $2::timestamp and ingreso <= $3::timestamp`,
    [empresa, desde, hasta]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Conciliación (resultado) + acumulado derivado
// ---------------------------------------------------------------------------

// Guarda (upsert) la conciliación de un día. `filas` = las que devuelve procesarCierre.
async function guardarConciliacion({ fecha, empresa = 'HONRE', filas, usuarioId }) {
  const fISO = fechaISO(fecha);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const f of filas) {
      await client.query(
        `insert into bot.tesoreria_conciliacion
           (fecha, empresa, cuenta, moneda, saldo_ayer, ingresos, egresos, saldo_teorico, saldo_real, diferencia, estado, nivel, generado_por)
         values ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (fecha, empresa, cuenta) do update set
           moneda=excluded.moneda, saldo_ayer=excluded.saldo_ayer, ingresos=excluded.ingresos,
           egresos=excluded.egresos, saldo_teorico=excluded.saldo_teorico, saldo_real=excluded.saldo_real,
           diferencia=excluded.diferencia, estado=excluded.estado, nivel=excluded.nivel,
           generado_por=excluded.generado_por, generado_en=now()`,
        [fISO, empresa, f.cuenta, f.moneda, f.saldo_ayer, f.ingresos, f.egresos, f.saldo_teorico, f.saldo_real, f.diferencia, f.estado, f.nivel, usuarioId ?? null]
      );
    }
    await client.query('commit');
    return { cantidad: filas.length };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// Historial de diferencias por cuenta hasta una fecha, para el acumulado y la persistencia.
// RE-ENCADENA desde los saldos y movimientos GUARDADOS en vez de sumar las diferencias que
// quedaron persistidas: si un día se cargó fuera de orden, su diferencia guardada pudo haberse
// calculado contra un saldo_ayer viejo, y sumarla corrompería el acumulado. Reconstruir desde
// los saldos reales (fechas consecutivas) lo hace robusto a cargas retroactivas.
//   incluirHasta=false (default): fechas ESTRICTAMENTE anteriores (el llamador le suma la diff de hoy).
//   incluirHasta=true: incluye `hasta` (para /reportecierre, acumulado a esa fecha).
// Devuelve { cuentaNombre -> [{fecha, diferencia}] } ordenado por fecha ascendente.
async function historialDiferencias({ empresa = 'HONRE', hasta, incluirHasta = false }) {
  const op = incluirHasta ? '<=' : '<';
  // Momentos de conteo consecutivos (fecha + hora). El corte por hora usa el MISMO
  // movimientosDeRango que el cierre vivo → el acumulado coincide por construcción.
  // Baseline: no encadenamos desde antes de ACUMULADO_DESDE (datos SEED de prueba con saltos
  // irreales). La primera fecha en rango queda como ancla (sin diff propia); el acumulado
  // arranca del primer par consecutivo dentro del rango.
  const filasR = await pool.query(
    `select distinct fecha,
            coalesce(to_char(contado_en, '${TS_FMT}'), to_char(fecha, 'YYYY-MM-DD') || ' 23:59:59') as momento
       from bot.tesoreria_saldos where empresa = $1 and fecha >= $3::date and fecha ${op} $2::date
      order by momento`,
    [empresa, fechaISO(hasta), ACUMULADO_DESDE]
  );
  const filas = filasR.rows; // [{ fecha (Date), momento (string canónico) }] ordenados por momento
  const out = {};
  for (let i = 1; i < filas.length; i++) {
    const dp = filas[i - 1];
    const dc = filas[i];
    const [saldosAyer, saldosHoy, movs] = await Promise.all([
      saldosDeFecha({ fecha: dp.fecha, empresa }),
      saldosDeFecha({ fecha: dc.fecha, empresa }),
      movimientosDeRango({ desde: dp.momento, hasta: dc.momento, empresa }),  // ventana por hora
    ]);
    for (const f of conciliar({ saldosAyer, saldosHoy, movimientos: movs })) {
      if (f.diferencia == null) continue;
      (out[f.cuenta] = out[f.cuenta] || []).push({ fecha: dc.fecha, diferencia: f.diferencia });
    }
  }
  return out;
}

// Conciliación guardada de una fecha (para /reportecierre).
async function conciliacionDeFecha({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select cuenta, moneda, saldo_ayer, ingresos, egresos, saldo_teorico, saldo_real, diferencia, estado, nivel, generado_en
       from bot.tesoreria_conciliacion where fecha = $1::date and empresa = $2 order by cuenta`,
    [fechaISO(fecha), empresa]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Auditoría (rastro append-only)
// ---------------------------------------------------------------------------

async function registrarAuditoria({ usuarioId, usuarioTxt, accion, empresa = 'HONRE', fecha, periodo, nivel, detalle }) {
  await pool.query(
    `insert into bot.tesoreria_auditoria (usuario_id, usuario_txt, accion, empresa, fecha, periodo, nivel, detalle)
       values ($1, $2, $3, $4, $5::date, $6, $7, $8::jsonb)`,
    [usuarioId ?? null, usuarioTxt ?? null, accion, empresa, fecha ? fechaISO(fecha) : null, periodo ?? null, nivel ?? null, detalle ? JSON.stringify(detalle) : null]
  );
}

module.exports = {
  guardarSaldos, saldosDeFecha, saldosAnteriores, momentoConteo,
  guardarMovimientos, movimientosDeFecha, movimientosDeRango,
  guardarConciliacion, historialDiferencias, conciliacionDeFecha,
  registrarAuditoria,
};
