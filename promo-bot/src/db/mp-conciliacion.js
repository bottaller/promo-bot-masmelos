// Acceso a datos de la conciliación de Mercado Pago (/mp): guarda cómo salió el control de
// cada día y lo lee por rango para el resumen semanal. Mismo patrón que db/tesoreria.js.
const { pool } = require('./pool');
const { fechaISO } = require('../lib/fechas');
const { veredictoMP } = require('../lib/informe-mp-pdf');

// Compacta una huérfana + su primera contrapartida para guardar en jsonb. Lo justo para que
// el resumen semanal muestre el detalle (importe + dónde apareció) sin recalcular.
function huerfanaJson(lado, x, ref) {
  const c = (x.contrapartidas || [])[0];
  return {
    lado, // 'mp' | 'sistema'
    hora: x.hora || x.ingreso || null,
    importe: lado === 'mp' ? x.bruto : x.debe,
    ref,
    contrapartida: c
      ? {
        cuentas: [...c.renglones].sort((a, b) => (b.haber - b.debe) - (a.haber - a.debe)).map((g) => g.cuenta),
        concepto: c.concepto || '',
        usuario: c.usuario || '',
      }
      : null,
  };
}

function huerfanasDe(resultado) {
  return [
    ...resultado.soloMp.map((o) => huerfanaJson('mp', o, o.source_id)),
    ...resultado.soloSistema.map((m) => huerfanaJson('sistema', m, m.comprobante || `asiento ${m.asiento}`)),
  ];
}

// Guarda (upsert por día) el resultado de un /mp. Re-correr el día pisa la fila.
async function guardarMpConciliacion({ fecha, empresa = 'HONRE', resultado, fuente, usuarioId }) {
  const r = resultado.resumen;
  const veredicto = veredictoMP(resultado).ok ? 'ok' : 'diferencias';
  await pool.query(
    `insert into bot.mp_conciliacion
       (fecha, empresa, veredicto, fuente, total_sistema, total_mp, diferencia,
        n_pares, n_aviso, n_solo_mp, n_solo_sistema, n_con_contrapartida, huerfanas, generado_por)
     values ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     on conflict (fecha, empresa) do update set
       veredicto=excluded.veredicto, fuente=excluded.fuente, total_sistema=excluded.total_sistema,
       total_mp=excluded.total_mp, diferencia=excluded.diferencia, n_pares=excluded.n_pares,
       n_aviso=excluded.n_aviso, n_solo_mp=excluded.n_solo_mp, n_solo_sistema=excluded.n_solo_sistema,
       n_con_contrapartida=excluded.n_con_contrapartida, huerfanas=excluded.huerfanas,
       generado_por=excluded.generado_por, generado_en=now()`,
    [fechaISO(fecha), empresa, veredicto, fuente || null,
      r.totalSistema, r.totalMp, r.diferencia,
      r.nPares, r.nAviso, r.nSoloMp, r.nSoloSistema, r.nConContrapartida || 0,
      JSON.stringify(huerfanasDe(resultado)), usuarioId ?? null]
  );
  return { veredicto };
}

// Las conciliaciones guardadas de un rango de días (para el resumen semanal). `desde`/`hasta`
// son ISO 'AAAA-MM-DD', ambos inclusive. Devuelve las filas ordenadas por fecha.
async function conciliacionesDeRango({ desde, hasta, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select to_char(fecha, 'YYYY-MM-DD') as fecha, veredicto, fuente,
            total_sistema, total_mp, diferencia,
            n_pares, n_aviso, n_solo_mp, n_solo_sistema, n_con_contrapartida, huerfanas
       from bot.mp_conciliacion
      where empresa = $1 and fecha >= $2::date and fecha <= $3::date
      order by fecha`,
    [empresa, desde, hasta]
  );
  return rows;
}

module.exports = { guardarMpConciliacion, conciliacionesDeRango, huerfanasDe };
