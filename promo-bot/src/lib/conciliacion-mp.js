// Motor de la conciliación de Mercado Pago OPERACIÓN POR OPERACIÓN (/mp).
//
// Es el nivel de abajo de conciliacion.js: aquel compara SALDOS contra el libro y dice
// "Mercado Pago no cierra por $1,7M"; este agarra las cobranzas de la cuenta MP renglón por
// renglón contra la liquidación de MP y dice CUÁLES son las que no cierran.
//
// ---------------------------------------------------------------------------
// El alcance: solo las ventas por QR / transferencia   [validado con datos reales]
// ---------------------------------------------------------------------------
// La cuenta 422101014 (MERCADO PAGO MORENO) recibe EXACTAMENTE las operaciones que la
// liquidación marca con SUB UNIT = 'QR Code'. Ese canal ya contiene los dos medios que pide
// el negocio: todas las operaciones por transferencia entran escaneando el QR, así que
// "QR o transferencia" == canal QR (adentro conviven dinero en cuenta, transferencia,
// crédito y débito como INSTRUMENTO).
// Verificado contra el día 16/07/2026: 108 asientos ↔ 108 operaciones QR, con los totales
// iguales hasta los centavos ($32.334.504,52 vs $32.334.504,56).
// Lo de Point liquida en las cuentas de tarjetas (111301002 y cía., ver conciliacion.js), NO
// en esta cuenta → se lista aparte, no se concilia acá.
const { tsASegundos } = require('./fechas');

// La cuenta contable de Mercado Pago en Sigma. Es la misma que compone la cuenta de control
// "Mercado Pago" de conciliacion.js (ahí suma además las tarjetas del Point; acá NO, porque
// el Point no pasa por esta cuenta).
const CUENTA_MP = 422101014;

// Valores literales de la liquidación de MP (columnas SUB UNIT / TRANSACTION TYPE).
const CANAL_QR = 'QR Code';
const TIPO_COBRO = 'Approved payment';

// Tolerancia de importe para dar dos renglones por apareados. Sigma redondea distinto que MP
// en algunos asientos: el 16/07 pasó en 3 de 108, siempre por ≤ 4 centavos. Por encima de
// esto NO es redondeo y no se aparean (quedan como huérfanos, que es lo que hay que mirar).
const TOLERANCIA_REDONDEO = 0.05;

// Ventana máxima para considerar que un asiento y un cobro son la misma venta. El asiento se
// carga DESPUÉS del pago (el 16/07: entre 5 y 210 segundos, mediana 16). 12 h es holgadísimo
// para el día de trabajo (07-17 h) y sirve de red: evita que, si alguien manda dos archivos de
// días distintos, un importe repetido se aparee contra otro día y tape el error.
const DELTA_MAXIMO_SEG = 12 * 3600;

// Por encima de esto el par se aparea igual pero se avisa: el importe coincide y la hora no,
// así que conviene mirarlo.
const DELTA_SOSPECHOSO_SEG = 30 * 60;

function redondear(n) {
  return Math.round(n * 100) / 100;
}

// Segundos entre el asiento y el cobro (positivo = el asiento se cargó DESPUÉS del pago,
// que es lo normal). null si alguna marca no se puede leer.
function deltaSeg(ingreso, horaMp) {
  const a = tsASegundos(ingreso);
  const b = tsASegundos(horaMp);
  return a === null || b === null ? null : a - b;
}

// Por qué una operación de MP no entra en esta conciliación.
function motivoFueraMp(op) {
  if (op.unidad === 'Mercado Libre') return 'Mercado Libre: no es una venta por QR';
  if (op.canal === 'Point') return 'Point (terminal física): liquida en las cuentas de tarjetas, no en Mercado Pago';
  if (!op.canal) return 'Sin canal ni medio de pago: revisar con MP qué es';
  if (op.canal !== CANAL_QR) return `Canal "${op.canal}": fuera del alcance (acá solo van QR y transferencia)`;
  if (op.tipo !== TIPO_COBRO) return `Es "${op.tipo}", no un cobro aprobado`;
  if (op.bruto <= 0) return 'Importe negativo o cero: no es una venta';
  return 'Fuera del alcance';
}

// Por qué un movimiento del sistema no entra en esta conciliación.
function motivoFueraSistema(mov) {
  if (mov.haber > 0) return 'Es un Haber (sale plata de Mercado Pago): no es una cobranza';
  return 'Sin importe en el Debe';
}

// Separa lo conciliable de lo que no, con el motivo a la vista (nada se descarta en silencio).
function repartir(items, enAlcance, motivo) {
  const dentro = [];
  const fuera = [];
  for (const it of items) {
    if (enAlcance(it)) dentro.push(it);
    else fuera.push({ ...it, motivo: motivo(it) });
  }
  return { dentro, fuera };
}

// conciliarMP({ movimientos, operaciones })
//   movimientos: renglones de la cuenta MP (mayor-excel.js)
//   operaciones: filas de la liquidación (liquidacion-excel.js)
// ->  { pares, soloSistema, soloMp, fuera: {sistema, mp}, resumen }
//
// El apareo es GREEDY sobre los pares candidatos ordenados por (importe exacto primero,
// después menor diferencia, después menor distancia de hora). Con los importes casi únicos
// que tiene un día real, eso resuelve solo; la hora está para desempatar los repetidos (el
// 16/07 hubo dos ventas de $380 de cajas distintas) y para no aparear entre días.
function conciliarMP({ movimientos = [], operaciones = [] }) {
  const sistema = repartir(movimientos, (m) => m.debe > 0, motivoFueraSistema);
  const mp = repartir(
    operaciones,
    (o) => o.canal === CANAL_QR && o.tipo === TIPO_COBRO && o.bruto > 0,
    motivoFueraMp
  );

  const candidatos = [];
  for (let i = 0; i < sistema.dentro.length; i++) {
    for (let j = 0; j < mp.dentro.length; j++) {
      const dif = redondear(sistema.dentro[i].debe - mp.dentro[j].bruto);
      if (Math.abs(dif) > TOLERANCIA_REDONDEO) continue;
      const delta = deltaSeg(sistema.dentro[i].ingreso, mp.dentro[j].hora);
      const adelta = delta === null ? Infinity : Math.abs(delta);
      if (adelta > DELTA_MAXIMO_SEG) continue;
      candidatos.push({ i, j, dif, delta, exacto: dif === 0 ? 0 : 1, adif: Math.abs(dif), adelta });
    }
  }
  candidatos.sort((a, b) => a.exacto - b.exacto || a.adif - b.adif || a.adelta - b.adelta);

  const usadosS = new Set();
  const usadosM = new Set();
  const pares = [];
  for (const c of candidatos) {
    if (usadosS.has(c.i) || usadosM.has(c.j)) continue;
    usadosS.add(c.i);
    usadosM.add(c.j);
    // Los avisos son TIPOS, no texto: el importe y los segundos ya viajan en el par, y darle
    // formato de plata es tarea del reporte (reporte-mp.js::textoAvisos), no del motor.
    const avisos = [];
    if (c.dif !== 0) avisos.push('redondeo');
    if (c.adelta > DELTA_SOSPECHOSO_SEG) avisos.push('hora');
    pares.push({
      mov: sistema.dentro[c.i], op: mp.dentro[c.j],
      dif: c.dif, delta: c.delta,
      nivel: avisos.length ? 'aviso' : 'ok',
      avisos,
    });
  }
  pares.sort((a, b) => (a.op.hora < b.op.hora ? -1 : a.op.hora > b.op.hora ? 1 : 0));

  const soloSistema = sistema.dentro.filter((_, i) => !usadosS.has(i));
  const soloMp = mp.dentro.filter((_, j) => !usadosM.has(j));

  const suma = (arr, f) => redondear(arr.reduce((a, x) => a + f(x), 0));
  const resumen = {
    nSistema: sistema.dentro.length,
    nMp: mp.dentro.length,
    nPares: pares.length,
    nOk: pares.filter((p) => p.nivel === 'ok').length,
    nAviso: pares.filter((p) => p.nivel === 'aviso').length,
    nSoloSistema: soloSistema.length,
    nSoloMp: soloMp.length,
    totalSistema: suma(sistema.dentro, (m) => m.debe),
    totalMp: suma(mp.dentro, (o) => o.bruto),
    totalSoloSistema: suma(soloSistema, (m) => m.debe),
    totalSoloMp: suma(soloMp, (o) => o.bruto),
    comision: suma(mp.dentro, (o) => o.comision),
    impuestos: suma(mp.dentro, (o) => o.impuestos),
    neto: suma(mp.dentro, (o) => o.neto),
    totalFueraMp: suma(mp.fuera, (o) => o.bruto),
    totalFueraSistema: suma(sistema.fuera, (m) => m.debe - m.haber),
  };
  resumen.diferencia = redondear(resumen.totalSistema - resumen.totalMp);
  // 🔴 solo si hay algo sin aparear: una venta cobrada que no se asentó (o al revés) es un
  // agujero de control. Los avisos (redondeo/hora) son 🟡: hay que verlos, no alarman.
  resumen.nivel = (soloSistema.length || soloMp.length) ? 'alerta' : (resumen.nAviso ? 'aviso' : 'ok');

  return { pares, soloSistema, soloMp, fuera: { sistema: sistema.fuera, mp: mp.fuera }, resumen };
}

module.exports = {
  conciliarMP, CUENTA_MP,
  TOLERANCIA_REDONDEO, DELTA_MAXIMO_SEG, DELTA_SOSPECHOSO_SEG, CANAL_QR, TIPO_COBRO,
};
