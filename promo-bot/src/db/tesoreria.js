// Acceso a datos de Tesorería: saldos (realidad), movimientos (libro), conciliación
// (resultado) y auditoría (rastro). El acumulado NO se guarda: se deriva de las diferencias
// (robusto a cargas retroactivas). Todo transaccional, mismo patrón que guardarSaldos.
const { pool } = require('./pool');
const { fechaISO } = require('../lib/fechas');
const { conciliar } = require('../lib/conciliacion');

// ---------------------------------------------------------------------------
// Saldos (lado "realidad")
// ---------------------------------------------------------------------------

// Guarda (upsert) los saldos de un día. Re-subir el mismo día pisa los montos.
async function guardarSaldos({ fecha, empresa, saldos, usuarioId }) {
  const fISO = fechaISO(fecha);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const s of saldos) {
      await client.query(
        `insert into bot.tesoreria_saldos (fecha, empresa, cuenta, moneda, monto, cargado_por)
           values ($1::date, $2, $3, $4, $5, $6)
         on conflict (fecha, empresa, cuenta)
           do update set moneda = excluded.moneda, monto = excluded.monto,
                         cargado_por = excluded.cargado_por, cargado_en = now()`,
        [fISO, empresa, s.cuenta, s.moneda, s.monto, usuarioId ?? null]
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
// hoy es lunes). Devuelve { fecha, saldos } o { fecha: null, saldos: [] } si no hay.
async function saldosAnteriores({ fecha, empresa = 'HONRE' }) {
  const prev = await pool.query(
    `select max(fecha) as f from bot.tesoreria_saldos where empresa = $1 and fecha < $2::date`,
    [empresa, fechaISO(fecha)]
  );
  const f = prev.rows[0] && prev.rows[0].f;
  if (!f) return { fecha: null, saldos: [] };
  const { rows } = await pool.query(
    `select cuenta, moneda, monto from bot.tesoreria_saldos
      where fecha = $1::date and empresa = $2 order by cuenta`,
    [fechaISO(f), empresa]
  );
  return { fecha: f, saldos: rows };
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
    for (const [iso, movs] of porDia) {
      await client.query('delete from bot.tesoreria_movimientos where fecha = $1::date and empresa = $2', [iso, empresa]);
      for (const m of movs) {
        await client.query(
          `insert into bot.tesoreria_movimientos
             (fecha, empresa, cuenta_id, cuenta, debe, haber, debe_nominal, haber_nominal, cargado_por)
           values ($1::date, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [iso, empresa, m.cuenta_id, m.cuenta || '', m.debe || 0, m.haber || 0, m.debe_nominal || 0, m.haber_nominal || 0, usuarioId ?? null]
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

// Movimientos guardados en un rango (desde, hasta] — para re-encadenar la conciliación.
async function movimientosDeRango({ desde, hasta, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select cuenta_id, debe, haber, debe_nominal, haber_nominal
       from bot.tesoreria_movimientos where empresa = $1 and fecha > $2::date and fecha <= $3::date`,
    [empresa, fechaISO(desde), fechaISO(hasta)]
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
  const fechasR = await pool.query(
    `select distinct fecha from bot.tesoreria_saldos where empresa = $1 and fecha ${op} $2::date order by fecha`,
    [empresa, fechaISO(hasta)]
  );
  const fechas = fechasR.rows.map((r) => r.fecha);
  const out = {};
  for (let i = 1; i < fechas.length; i++) {
    const dp = fechas[i - 1];
    const dc = fechas[i];
    const [saldosAyer, saldosHoy, movs] = await Promise.all([
      saldosDeFecha({ fecha: dp, empresa }),
      saldosDeFecha({ fecha: dc, empresa }),
      movimientosDeRango({ desde: dp, hasta: dc, empresa }),
    ]);
    for (const f of conciliar({ saldosAyer, saldosHoy, movimientos: movs })) {
      if (f.diferencia == null) continue;
      (out[f.cuenta] = out[f.cuenta] || []).push({ fecha: dc, diferencia: f.diferencia });
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
  guardarSaldos, saldosDeFecha, saldosAnteriores,
  guardarMovimientos, movimientosDeFecha, movimientosDeRango,
  guardarConciliacion, historialDiferencias, conciliacionDeFecha,
  registrarAuditoria,
};
