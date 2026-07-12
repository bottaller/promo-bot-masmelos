// Motor de la conciliación diaria de Tesorería (función pura, testeable).
//
// La idea, por cuenta:
//     saldo_teorico = saldo_ayer + ingresos − egresos
//     diferencia    = saldo_real − saldo_teorico
// donde ingresos/egresos salen del libro (Σ Debe / Σ Haber de las cuentas de Sigma
// que mapean a esa cuenta de saldo). Convención confirmada por el motor de /flujos
// (arqueo/core.py::cascada_diaria).
//
// El mapeo cuenta_de_saldo → cuenta(s) del libro vive acá abajo (MAPEO). Es config de
// negocio, VALIDADA contra una semana real (01–10/07/2026, ver docs/conciliacion.md §10);
// se ajusta sin re-importar nada (los movimientos se guardan crudos por cuenta_id).

// --- Mapeo cuenta de saldo → cuenta(s) contables del libro (cuenta_id de Sigma) ---
// clave  = nombre normalizado (norm()); debe coincidir con el nombre canónico que
//          guarda saldos-excel.js (mismas 8 cuentas).
// nombre = display canónico (para las filas que emite el motor).
// deudora=true: cuenta de activo, el Debe la sube (ingresos=Debe, egresos=Haber).
// nominal=true: se arquea por las columnas *Nominal* (USD), no por las de ARS.
// pendiente=true: mapeo sin cerrar; la conciliación de esa cuenta se marca 'sin_mapeo'
//                 en vez de inventar una diferencia.
const MAPEO = {
  'santander':            { nombre: 'Santander',            cuentas: [111201014], moneda: 'ARS', deudora: true },
  'supervielle':          { nombre: 'Supervielle',          cuentas: [111201015], moneda: 'ARS', deudora: true },
  // Mercado Pago (Point): junta MP + las tarjetas que liquidan en MP — Visa Débito
  // (111301002), Mastercard (111304001), Amex (111305001), Naranja (111302002), Cabal
  // (111303001). Visa Crédito (111301001) NO entra (liquida a otro lado). Con esto el
  // acumulado semanal pasó de +51,8M a +1,7M. Deudora: la cobranza entra por el Debe.
  'mercadopago':          { nombre: 'Mercadopago',          cuentas: [422101014, 111301002, 111304001, 111305001, 111302002, 111303001], moneda: 'ARS', deudora: true },
  // Caja Dólar Tesorería = las DOS cajas dólar (111102005 + 111102006): el traspaso entre
  // ellas es interno y se netea. Se arquea en USD (columnas Nominal).
  'caja dólar tesorería': { nombre: 'Caja Dólar Tesorería', cuentas: [111102005, 111102006], moneda: 'USD', deudora: true, nominal: true },
  // Caja Fuerte: confirmado que es SOLA (111101003), no la cascada (la cascada daba +13,7M).
  'caja fuerte moreno':   { nombre: 'Caja Fuerte Moreno',   cuentas: [111101003], moneda: 'ARS', deudora: true },
  // Cheques en Cartera A: la cartera física (111401001). A y B comparten esta cuenta y B
  // está siempre en 0; al cablear /cierre habrá que AGRUPAR A+B (por ahora B queda
  // 'sin_mapeo' para no doble-contar).
  'cheques en cartera a': { nombre: 'Cheques en Cartera A', cuentas: [111401001], moneda: 'ARS', deudora: true },
  'cheques en cartera b': { nombre: 'Cheques en Cartera B', cuentas: [], moneda: 'ARS', deudora: true, pendiente: true },
  // E-Cheq: las cuentas ECHEQ (111401008 / 111401010) todavía no cierran (traen un Debe de
  // más); pendiente de confirmar cómo se registran los e-cheq.
  'e-cheq en cartera':    { nombre: 'E-cheq en Cartera',    cuentas: [], moneda: 'ARS', deudora: true, pendiente: true },
};

// Tolerancia de redondeo: por debajo de esto la cuenta "cierra".
const TOLERANCIA = 1;

// Normaliza un nombre de cuenta igual que saldos-excel.js (NFC + trim + minúsculas +
// colapsa espacios), para que el match con MAPEO sea robusto.
function norm(s) {
  return String(s == null ? '' : s).normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Ingresos/egresos del libro para una cuenta del mapeo (suma sus cuenta_id).
function movimientosDeCuenta(cfg, movPorCuenta) {
  let ingresos = 0;
  let egresos = 0;
  let hubo = false;
  for (const cid of cfg.cuentas) {
    const m = movPorCuenta.get(cid);
    if (!m) continue;
    const debe = Number(cfg.nominal ? m.debe_nominal : m.debe) || 0;
    const haber = Number(cfg.nominal ? m.haber_nominal : m.haber) || 0;
    if (debe !== 0 || haber !== 0) hubo = true;
    if (cfg.deudora) { ingresos += debe; egresos += haber; }
    else { ingresos += haber; egresos += debe; }
  }
  return { ingresos, egresos, hubo };
}

// Concilia un día. Recibe:
//   saldosAyer: [{cuenta, moneda, monto}]  (cierre del día anterior; puede faltar)
//   saldosHoy:  [{cuenta, moneda, monto}]  (lo que cargó el tesorero hoy)
//   movimientos:[{cuenta_id, debe, haber, debe_nominal, haber_nominal}]  (del libro, ese día)
//   mapeo: opcional (default MAPEO)
// Devuelve una fila por cuenta de saldosHoy, MÁS una fila por cada cuenta mapeada que
// tuvo movimientos en el libro pero el tesorero no cargó hoy (estado 'sin_saldo_hoy',
// para que nunca quede plata moviéndose sin aparecer en el reporte):
//   {cuenta, moneda, saldo_ayer, ingresos, egresos, saldo_teorico, saldo_real, diferencia, estado}
//   estado: 'ok' | 'revisar' | 'sin_mapeo' | 'sin_saldo_ayer' | 'sin_saldo_hoy'
function conciliar({ saldosAyer = [], saldosHoy = [], movimientos = [], mapeo = MAPEO }) {
  // cuenta_id se coerciona a Number: el parser del libro lo emite como número, pero un
  // futuro lector de la DB (bigint) lo traería como string — así matchea igual.
  const movPorCuenta = new Map(movimientos.map((m) => [Number(m.cuenta_id), m]));
  const ayerPorCuenta = new Map(saldosAyer.map((s) => [norm(s.cuenta), Number(s.monto)]));
  const presentesHoy = new Set(saldosHoy.map((s) => norm(s.cuenta)));

  const filas = saldosHoy.map((s) => {
    const clave = norm(s.cuenta);
    const cfg = mapeo[clave];
    const saldo_real = Number(s.monto);
    const base = { cuenta: s.cuenta, moneda: s.moneda };

    // Cuenta sin mapeo confirmado: no inventamos diferencia.
    if (!cfg || cfg.pendiente || !cfg.cuentas || cfg.cuentas.length === 0) {
      const saldo_ayer = ayerPorCuenta.has(clave) ? ayerPorCuenta.get(clave) : null;
      return { ...base, saldo_ayer, ingresos: null, egresos: null, saldo_teorico: null, saldo_real, diferencia: null, estado: 'sin_mapeo' };
    }

    const { ingresos, egresos } = movimientosDeCuenta(cfg, movPorCuenta);

    // Sin saldo de ayer no hay teórico (primer día de esa cuenta en el sistema).
    if (!ayerPorCuenta.has(clave)) {
      return { ...base, saldo_ayer: null, ingresos, egresos, saldo_teorico: null, saldo_real, diferencia: null, estado: 'sin_saldo_ayer' };
    }

    const saldo_ayer = ayerPorCuenta.get(clave);
    const saldo_teorico = saldo_ayer + ingresos - egresos;
    const diferencia = saldo_real - saldo_teorico;
    const estado = Math.abs(diferencia) < TOLERANCIA ? 'ok' : 'revisar';
    return { ...base, saldo_ayer, ingresos, egresos, saldo_teorico, saldo_real, diferencia, estado };
  });

  // Segundo barrido: cuentas mapeadas que se movieron en el libro pero NO se cargaron
  // hoy. Sin esto, esa plata quedaría sin conciliar y el día "cerraría" sin señal.
  for (const [clave, cfg] of Object.entries(mapeo)) {
    if (presentesHoy.has(clave) || cfg.pendiente || !cfg.cuentas || cfg.cuentas.length === 0) continue;
    const { ingresos, egresos, hubo } = movimientosDeCuenta(cfg, movPorCuenta);
    if (!hubo) continue; // sin movimientos y sin saldo -> no hay nada que reportar
    const saldo_ayer = ayerPorCuenta.has(clave) ? ayerPorCuenta.get(clave) : null;
    filas.push({
      cuenta: cfg.nombre, moneda: cfg.moneda, saldo_ayer, ingresos, egresos,
      saldo_teorico: null, saldo_real: null, diferencia: null, estado: 'sin_saldo_hoy',
    });
  }

  return filas;
}

module.exports = { conciliar, MAPEO, TOLERANCIA };
