// Motor de conciliación diaria de Tesorería (control / seguridad / auditoría).
//
// La idea, por CUENTA DE CONTROL:
//     saldo_teorico = saldo_ayer + ingresos − egresos
//     diferencia    = saldo_real − saldo_teorico
// donde ingresos/egresos salen del libro (Σ Debe / Σ Haber de las cuentas de Sigma que
// componen esa cuenta de control). Convención confirmada con el motor de /flujos y
// VALIDADA contra una semana real (01–10/07/2026): todo cierra a residuos de timing.
//
// Una "cuenta de control" agrupa:
//   - saldoKeys: uno o varios renglones del Excel de saldos (ej. Cheques A + B), y
//   - libroIds:  una o varias cuentas contables de Sigma (ej. MP + las tarjetas del Point).
// Así se resuelven de forma uniforme los grupos (cheques A+B → una sola cuenta del libro)
// y las cuentas compuestas (MP = MP + tarjetas, USD = las dos cajas dólar).

// ---------------------------------------------------------------------------
// Mapeo cuenta de control ↔ (renglones de saldo, cuentas del libro)  [validado]
// ---------------------------------------------------------------------------
// saldoKeys: nombres normalizados (norm()) tal como los guarda saldos-excel.js.
// libroIds : cuenta_id de Sigma. deudora=true → activo (Debe la sube). nominal=true → USD.
// grupo/clave: se identifica por `nombre`.
const CUENTAS_CONTROL = [
  { nombre: 'Caja Fuerte Moreno', saldoKeys: ['caja fuerte moreno'], libroIds: [111101003], moneda: 'ARS', deudora: true },
  { nombre: 'Santander',          saldoKeys: ['santander'],          libroIds: [111201014], moneda: 'ARS', deudora: true },
  { nombre: 'Supervielle',        saldoKeys: ['supervielle'],        libroIds: [111201015], moneda: 'ARS', deudora: true },
  // Mercado Pago (Point) = MP + tarjetas que liquidan en MP. Visa Crédito (111301001) NO
  // entra: es cuenta a cobrar (Visa liquida a ~18 días), la plata todavía no está en MP.
  { nombre: 'Mercado Pago',       saldoKeys: ['mercadopago'],        libroIds: [422101014, 111301002, 111304001, 111305001, 111302002, 111303001], moneda: 'ARS', deudora: true },
  // Cheques en Cartera: A y B son una división manual de la única cartera de Sigma; se
  // concilian como GRUPO (suma de los dos renglones) contra 111401001.
  { nombre: 'Cheques en Cartera', saldoKeys: ['cheques en cartera a', 'cheques en cartera b'], libroIds: [111401001], moneda: 'ARS', deudora: true },
  // E-Cheq: la cuenta ECHEQ HONRE (111401010); su neto semanal = el saldo. Bajo volumen y
  // asientos grumosos (a veces el libro los carga tarde) → puede mostrar timing propio.
  { nombre: 'E-Cheq en Cartera',  saldoKeys: ['e-cheq en cartera'],  libroIds: [111401010], moneda: 'ARS', deudora: true },
  // Caja Dólar Tesorería = SOLO la caja física del negocio (111102006), que es la que el
  // tesorero cuenta y carga a diario. La otra caja dólar (111102005 "Caja Dolares") es adonde
  // va la plata cuando SALE del negocio: es otra caja real, con su propio dinero, y su saldo NO
  // se carga en el Excel. Sumarla acá metía como "diferencia" todo lo que se le iba acumulando
  // (US$51.100 en la semana real) — ver conciliacion.md §USD. Si algún día se quiere controlar
  // la 005, va como cuenta de control PROPIA (con su propio renglón de saldo).
  { nombre: 'Caja Dólar Tesorería', saldoKeys: ['caja dólar tesorería'], libroIds: [111102006], moneda: 'USD', deudora: true, nominal: true },
];

// Tolerancia de redondeo: por debajo, la cuenta "cierra".
const TOLERANCIA = 1;

// Umbral del ACUMULADO por moneda: por encima de esto la cuenta entra "en observación".
// Es el número que importa — la diferencia de UN día sola casi siempre es timing.
// Calibrable con más historia.
const UMBRAL_ACUMULADO = { ARS: 5_000_000, USD: 3_000 };

// Override por-cuenta (pisa al de la moneda). Mercado Pago tiene un ruido estructural más
// alto: MP te descuenta la comisión (~1,6% de lo facturado) en cada cobro, pero el asiento de
// esa comisión se hace UNA vez al mes cuando llega la factura. La caja MP ya está neta a
// diario, así que ese asiento mensual le resta la comisión al libro una segunda vez → mete un
// escalón de ~10M que no se lava. Umbral más alto para no dar 🔴 falso por ese timing de
// calendario. No modelamos la comisión a propósito (decisión del dueño); ver docs/conciliacion.md.
const UMBRAL_ACUMULADO_CUENTA = { 'Mercado Pago': 20_000_000 };

// Baseline del acumulado: fecha (AAAA-MM-DD) DESDE la que se re-encadena en historialDiferencias.
// Antes había datos SEED de prueba (02–10/07/2026) con saltos irreales (−37M, +33M) que
// ensuciaban el acumulado. IMPORTANTE: avanzar esta fecha cada vez que se reconcilia la comisión
// mensual de MP — como la comisión suma un escalón permanente por mes, sin re-baseline el
// acumulado crece sin fin y el umbral pierde sentido.
const ACUMULADO_DESDE = '2026-07-13';

// Cuántos cierres seguidos puede estar el acumulado por encima del umbral antes de ALARMAR.
// El timing (un depósito/transferencia que en el banco ya pasó pero se asienta 1-3 días
// después) se resuelve solo en pocos días; si el acumulado NO baja en más de estos
// cierres, ya no es timing: es un problema real (control / seguridad). En 3 para cubrir toda
// la ventana documentada de 1-3 días (con 2, un timing legítimo de 3 días daba un 🔴 falso).
const DIAS_TOLERANCIA_TIMING = 3;

// ¿El acumulado de esta cuenta está por encima de su umbral? El override por-cuenta pisa al
// de la moneda si existe (ej. Mercado Pago). `cuenta` es el nombre de la cuenta de control.
function sobreUmbral(acumulado, moneda, cuenta) {
  const umbral = (cuenta && UMBRAL_ACUMULADO_CUENTA[cuenta]) ?? UMBRAL_ACUMULADO[moneda] ?? UMBRAL_ACUMULADO.ARS;
  return Math.abs(Number(acumulado) || 0) >= umbral;
}

function norm(s) {
  return String(s == null ? '' : s).normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// [{cuenta, monto}] -> Map(norm(cuenta) -> monto sumado)
function mapaSaldos(saldos) {
  const m = new Map();
  for (const s of saldos) {
    const k = norm(s.cuenta);
    m.set(k, (m.get(k) || 0) + Number(s.monto));
  }
  return m;
}

// Ingresos/egresos del libro para una cuenta de control (suma sus libroIds).
function movimientosDe(cuenta, movPorId) {
  let ingresos = 0, egresos = 0, hubo = false;
  for (const id of cuenta.libroIds) {
    const m = movPorId.get(id);
    if (!m) continue;
    const debe = Number(cuenta.nominal ? m.debe_nominal : m.debe) || 0;
    const haber = Number(cuenta.nominal ? m.haber_nominal : m.haber) || 0;
    if (debe !== 0 || haber !== 0) hubo = true;
    if (cuenta.deudora) { ingresos += debe; egresos += haber; }
    else { ingresos += haber; egresos += debe; }
  }
  return { ingresos, egresos, hubo };
}

// Concilia UN período (un día en el cierre diario; un lapso en el semanal/mensual).
//   saldosAyer/saldosHoy: [{cuenta, moneda, monto}] (inicio y fin del período)
//   movimientos: [{cuenta_id, debe, haber, debe_nominal, haber_nominal}] (todo el período)
// Devuelve una fila por cuenta de control:
//   {cuenta, moneda, saldo_ayer, ingresos, egresos, saldo_teorico, saldo_real, diferencia, estado}
//   estado: 'ok' | 'revisar' | 'sin_saldo_ayer' | 'sin_saldo_hoy'
function conciliar({ saldosAyer = [], saldosHoy = [], movimientos = [], cuentas = CUENTAS_CONTROL }) {
  // Agregamos por cuenta_id SUMANDO: un período puede traer varias entradas de la misma
  // cuenta (varios días — findes, feriados, o el cierre semanal/mensual). Un Map directo
  // pisaría todo menos la última y perdería movimientos.
  const movPorId = new Map();
  for (const m of movimientos) {
    const id = Number(m.cuenta_id);
    const e = movPorId.get(id) || { debe: 0, haber: 0, debe_nominal: 0, haber_nominal: 0 };
    e.debe += Number(m.debe) || 0;
    e.haber += Number(m.haber) || 0;
    e.debe_nominal += Number(m.debe_nominal) || 0;
    e.haber_nominal += Number(m.haber_nominal) || 0;
    movPorId.set(id, e);
  }
  const ayer = mapaSaldos(saldosAyer);
  const hoy = mapaSaldos(saldosHoy);

  const filas = [];
  for (const c of cuentas) {
    // Para cuentas-grupo (varios saldoKeys, ej. Cheques A+B) exigimos TODOS los renglones:
    // si falta uno, el saldo sería parcial y generaría una diferencia fantasma → mejor
    // marcar 'sin_saldo_*' que conciliar con la mitad.
    const presenteHoy = c.saldoKeys.every((k) => hoy.has(k));
    const presenteAyer = c.saldoKeys.every((k) => ayer.has(k));
    const saldo_real = c.saldoKeys.reduce((a, k) => a + (hoy.get(k) || 0), 0);
    const saldo_ayer = c.saldoKeys.reduce((a, k) => a + (ayer.get(k) || 0), 0);
    const { ingresos, egresos, hubo } = movimientosDe(c, movPorId);
    const base = { cuenta: c.nombre, moneda: c.moneda };

    if (!presenteHoy) {
      if (!hubo && !presenteAyer) continue; // nada que reportar
      filas.push({ ...base, saldo_ayer: presenteAyer ? saldo_ayer : null, ingresos, egresos, saldo_teorico: null, saldo_real: null, diferencia: null, estado: 'sin_saldo_hoy' });
      continue;
    }
    if (!presenteAyer) {
      filas.push({ ...base, saldo_ayer: null, ingresos, egresos, saldo_teorico: null, saldo_real, diferencia: null, estado: 'sin_saldo_ayer' });
      continue;
    }
    const saldo_teorico = saldo_ayer + ingresos - egresos;
    const diferencia = saldo_real - saldo_teorico;
    const estado = Math.abs(diferencia) < TOLERANCIA ? 'ok' : 'revisar';
    filas.push({ ...base, saldo_ayer, ingresos, egresos, saldo_teorico, saldo_real, diferencia, estado });
  }
  return filas;
}

// Clasifica una cuenta a partir de su diferencia del día y su acumulado. El corazón del
// control: la diferencia de UN día casi siempre es timing y se da vuelta; lo que alarma es
// que el ACUMULADO quede alto durante VARIOS cierres (ya no se resuelve solo).
//   acumulado        = acumulado por cuenta incluyendo este cierre.
//   diasSobreUmbral  = cierres SEGUIDOS (incl. hoy) con el acumulado por encima del umbral.
// Devuelve {nivel: 'ok'|'timing'|'revisar'|'alerta', motivo}.
//   ok      🟢  cierra.
//   timing  🟡  hay diferencia pero el acumulado está sano (por debajo del umbral).
//   revisar 🟠  acumulado alto pero reciente → probable depósito/transferencia en tránsito.
//   alerta  🔴  acumulado alto y persistente → no se resuelve, hay que perseguirlo.
function evaluarCuenta({ diferencia, acumulado, moneda, diasSobreUmbral = 0, cuenta }) {
  const dif = Math.abs(Number(diferencia) || 0);
  if (!sobreUmbral(acumulado, moneda, cuenta)) {
    return dif < TOLERANCIA
      ? { nivel: 'ok', motivo: 'cierra' }
      : { nivel: 'timing', motivo: 'diferencia normal, acumulado sano' };
  }
  if (diasSobreUmbral <= DIAS_TOLERANCIA_TIMING) {
    return { nivel: 'revisar', motivo: `acumulado alto (${diasSobreUmbral} cierre/s) — posible depósito/transferencia en tránsito` };
  }
  return { nivel: 'alerta', motivo: `acumulado alto hace ${diasSobreUmbral} cierres — no se resuelve, revisar` };
}

// Evaluación para los controles de PERÍODO (semanal/mensual): acá no hay "próximo cierre"
// que resuelva el timing — un residuo que sobrevivió todo el período ya es algo a mirar.
// Por eso una diferencia neta del período por encima del umbral es alerta directamente.
function evaluarPeriodo({ diferencia, moneda, cuenta }) {
  const dif = Number(diferencia) || 0;
  if (Math.abs(dif) < TOLERANCIA) return { nivel: 'ok', motivo: 'cierra en el período' };
  if (!sobreUmbral(dif, moneda, cuenta)) return { nivel: 'timing', motivo: 'diferencia chica del período (dentro de lo normal)' };
  return { nivel: 'alerta', motivo: 'el residuo sobrevivió todo el período — revisar ya' };
}

// Dada la serie ORDENADA de diferencias de una cuenta (incluyendo el cierre de hoy),
// devuelve {acumulado, diasSobreUmbral}. `diasSobreUmbral` = cierres SEGUIDOS al final de
// la serie con el acumulado corrido por encima del umbral (0 si el último cierra sano).
//   serie: [{fecha, diferencia}] ascendente por fecha.
function acumularCuenta(serie, moneda, cuenta) {
  let acumulado = 0;
  let diasSobreUmbral = 0;
  for (const d of serie) {
    acumulado += Number(d.diferencia) || 0;
    diasSobreUmbral = sobreUmbral(acumulado, moneda, cuenta) ? diasSobreUmbral + 1 : 0;
  }
  return { acumulado, diasSobreUmbral };
}

module.exports = { conciliar, evaluarCuenta, evaluarPeriodo, sobreUmbral, acumularCuenta, CUENTAS_CONTROL, TOLERANCIA, UMBRAL_ACUMULADO, UMBRAL_ACUMULADO_CUENTA, ACUMULADO_DESDE, DIAS_TOLERANCIA_TIMING, norm };
