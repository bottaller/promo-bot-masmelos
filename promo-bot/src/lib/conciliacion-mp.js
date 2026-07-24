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
// esto NO es redondeo y no se aparean en la primera pasada.
const TOLERANCIA_REDONDEO = 0.05;

// Rescate por CENTAVOS (segunda pasada): la MISMA venta cuyo importe difiere por más de 4
// centavos entre el sistema y MP. Pasa en ventas con IVA: el sistema registra el total con el
// IVA calculado al centavo y MP liquida un importe redondeado apenas distinto. Casos reales:
// 20/07 ($0,54) y 22/07 ($0,30) salían como DOS 🔴 falsos (una venta = "cobró MP sin asentar"
// + "asentado sin MP"). Se apuntan con un margen mayor de importe PERO ventana corta (la misma
// operación se carga a segundos del cobro), para no aparear dos ventas distintas que por
// casualidad estén a menos de $1 pero lejos en el tiempo.
const TOLERANCIA_CENTAVOS = 1.00;
const DELTA_CENTAVOS_SEG = 5 * 60;

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

// ---------------------------------------------------------------------------
// Rastreo del contramovimiento (solo con el Diario completo)
// ---------------------------------------------------------------------------
// Cuando MP cobró algo que NO se asentó en la cuenta de MP, la plata igual entró: lo más
// común es que el cobro se haya imputado mal y aparezca en OTRA cuenta. El caso real que
// motivó esto (11/07/2026): MP cobró $152.577,45 por transferencia, nadie lo asentó como
// cobro de MP, y al cerrar la CAJA 4 dio ese faltante EXACTO, que se registró contra DESVIO
// DE CAJA. No faltaba la plata: estaba en Mercado Pago, mal imputada.
//
// Por eso, si se manda el "Diario de movimientos" (que trae TODAS las cuentas), por cada
// huérfana se busca ese importe en el resto del libro. Es una PISTA, no un veredicto: dos
// movimientos del mismo importe pueden ser casualidad (sobre todo si es redondo), así que se
// devuelve el asiento completo —con cuentas, concepto, hora y usuario— para que lo juzgue
// una persona.

// Cuántos asientos candidatos se devuelven por huérfana.
const MAX_CONTRAPARTIDAS = 3;

// El rastreo sirve porque el importe es DISTINTIVO ($152.577,45 no se repite por casualidad).
// Con importes chicos o redondos deja de ser una pista y pasa a ser ruido: en el 23/07, un
// cobro de prueba de $1 "apareció" en un asiento de proveedores de 8 renglones. Dos guardas:
//  - por debajo de este importe no se rastrea (no es distintivo);
//  - si el importe pega en MÁS asientos que el tope, tampoco: que aparezca en todos lados es
//    justamente la prueba de que no identifica nada.
const MIN_IMPORTE_RASTREO = 1000;

// Los asientos del libro que contienen un renglón por ese importe, en una cuenta que no sea
// la de MP. Devuelve [{asiento, ingreso, concepto, comprobante, usuario, renglones:[...]}]
// con TODOS los renglones del asiento (la partida doble entera: de dónde salió y adónde fue).
function buscarContrapartidas(importe, otrasCuentas) {
  if (!otrasCuentas || !otrasCuentas.length) return [];
  if (Math.abs(importe) < MIN_IMPORTE_RASTREO) return []; // importe poco distintivo: sería ruido
  const pega = (m) => Math.abs(m.debe - importe) <= TOLERANCIA_REDONDEO
    || Math.abs(m.haber - importe) <= TOLERANCIA_REDONDEO;

  const asientos = [...new Set(otrasCuentas.filter(pega).map((m) => m.asiento))];
  if (asientos.length > MAX_CONTRAPARTIDAS) return []; // aparece en todos lados: no identifica nada
  return asientos.slice(0, MAX_CONTRAPARTIDAS).map((nro) => {
    const renglones = otrasCuentas.filter((m) => m.asiento === nro);
    const cab = renglones.find(pega) || renglones[0];
    return {
      asiento: nro,
      ingreso: cab.ingreso,
      concepto: cab.concepto,
      comprobante: cab.comprobante,
      usuario: cab.usuario,
      renglones: renglones.map((m) => ({
        cuenta_id: m.cuenta_id, cuenta: m.cuenta, debe: m.debe, haber: m.haber,
      })),
    };
  });
}

// Una pasada de apareo GREEDY entre las cobranzas del sistema y las operaciones de MP libres
// (los que no marca `usadosS`/`usadosM`), con la tolerancia de importe y la ventana dadas.
// Ordena por (importe exacto primero → menor diferencia → menor distancia de hora), así los
// matches seguros cierran antes de los dudosos. Cada par apareado con diferencia lleva el
// aviso `avisoImporte` ('redondeo' o 'centavos'); si además la hora está muy corrida, 'hora'.
// Muta usadosS/usadosM/pares (para encadenar dos pasadas sobre los mismos arreglos).
function emparejar({ sistema, mp, usadosS, usadosM, pares, tolImporte, deltaMax, avisoImporte,
  deltaSospechoso = DELTA_SOSPECHOSO_SEG }) {
  const candidatos = [];
  for (let i = 0; i < sistema.length; i++) {
    if (usadosS.has(i)) continue;
    for (let j = 0; j < mp.length; j++) {
      if (usadosM.has(j)) continue;
      const dif = redondear(sistema[i].debe - mp[j].bruto);
      if (Math.abs(dif) > tolImporte) continue;
      const delta = deltaSeg(sistema[i].ingreso, mp[j].hora);
      const adelta = delta === null ? Infinity : Math.abs(delta);
      if (adelta > deltaMax) continue;
      candidatos.push({ i, j, dif, delta, exacto: dif === 0 ? 0 : 1, adif: Math.abs(dif), adelta });
    }
  }
  candidatos.sort((a, b) => a.exacto - b.exacto || a.adif - b.adif || a.adelta - b.adelta);
  for (const c of candidatos) {
    if (usadosS.has(c.i) || usadosM.has(c.j)) continue;
    usadosS.add(c.i);
    usadosM.add(c.j);
    // Los avisos son TIPOS, no texto: el importe y los segundos ya viajan en el par, y darle
    // formato de plata es tarea del reporte (reporte-mp.js::textoAvisos), no del motor.
    const avisos = [];
    if (c.dif !== 0) avisos.push(avisoImporte);
    if (c.adelta > deltaSospechoso) avisos.push('hora');
    pares.push({ mov: sistema[c.i], op: mp[c.j], dif: c.dif, delta: c.delta, nivel: avisos.length ? 'aviso' : 'ok', avisos });
  }
}

// conciliarMP({ movimientos, operaciones, otrasCuentas })
//   movimientos:  renglones de la cuenta MP (mayor-excel.js)
//   operaciones:  filas de la liquidación (liquidacion-excel.js)
//   otrasCuentas: el resto del Diario (opcional). Si viene, cada huérfana trae además
//                 `contrapartidas`: los asientos donde ese importe aparece en otra cuenta.
// ->  { pares, soloSistema, soloMp, fuera: {sistema, mp}, resumen }
//
// Apareo en DOS pasadas (ver emparejar): 1) exacto/redondeo ≤ $0,05 con ventana amplia, y
// 2) rescate por centavos (≤ $1, ventana corta) para la misma venta con importes apenas
// distintos. Con los importes casi únicos de un día real esto resuelve solo.
// `plataforma` (opcional) define QUÉ operaciones entran y cuándo la hora es sospechosa. Si no
// viene, se usan las reglas de Mercado Pago — así los llamadores viejos siguen andando igual.
// El apareo, las tolerancias y el rastreo son agnósticos: valen para cualquier plataforma.
const REGLAS_MP = {
  enAlcance: (o) => o.canal === CANAL_QR && o.tipo === TIPO_COBRO && o.bruto > 0,
  motivoFuera: motivoFueraMp,
  deltaSospechosoSeg: DELTA_SOSPECHOSO_SEG,
};

function conciliarMP({ movimientos = [], operaciones = [], otrasCuentas = [], plataforma = null }) {
  const P = plataforma || REGLAS_MP;
  const deltaSospechoso = P.deltaSospechosoSeg || DELTA_SOSPECHOSO_SEG;
  const sistema = repartir(movimientos, (m) => m.debe > 0, motivoFueraSistema);
  const mp = repartir(operaciones, P.enAlcance, P.motivoFuera);

  // El apareo va en DOS pasadas, y el EXACTO cierra primero para que nada se robe un match
  // seguro. La 2ª rescata la misma venta con centavos distintos que si no quedaba como 🔴 falso.
  const usadosS = new Set();
  const usadosM = new Set();
  const pares = [];
  emparejar({ sistema: sistema.dentro, mp: mp.dentro, usadosS, usadosM, pares, deltaSospechoso,
    tolImporte: TOLERANCIA_REDONDEO, deltaMax: DELTA_MAXIMO_SEG, avisoImporte: 'redondeo' });
  emparejar({ sistema: sistema.dentro, mp: mp.dentro, usadosS, usadosM, pares, deltaSospechoso,
    tolImporte: TOLERANCIA_CENTAVOS, deltaMax: DELTA_CENTAVOS_SEG, avisoImporte: 'centavos' });
  pares.sort((a, b) => (a.op.hora < b.op.hora ? -1 : a.op.hora > b.op.hora ? 1 : 0));

  // Las huérfanas se enriquecen con el rastreo: dónde más aparece ese importe en el libro.
  const soloSistema = sistema.dentro.filter((_, i) => !usadosS.has(i))
    .map((m) => ({ ...m, contrapartidas: buscarContrapartidas(m.debe, otrasCuentas) }));
  const soloMp = mp.dentro.filter((_, j) => !usadosM.has(j))
    .map((o) => ({ ...o, contrapartidas: buscarContrapartidas(o.bruto, otrasCuentas) }));

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

  // ¿Se pudo rastrear? (con el Mayor de una sola cuenta no hay dónde buscar).
  resumen.rastreo = otrasCuentas.length > 0;
  resumen.nConContrapartida = [...soloMp, ...soloSistema].filter((x) => x.contrapartidas.length).length;

  return { pares, soloSistema, soloMp, fuera: { sistema: sistema.fuera, mp: mp.fuera }, resumen };
}

module.exports = {
  conciliarMP, buscarContrapartidas, CUENTA_MP,
  TOLERANCIA_REDONDEO, TOLERANCIA_CENTAVOS, DELTA_MAXIMO_SEG, DELTA_CENTAVOS_SEG,
  DELTA_SOSPECHOSO_SEG, CANAL_QR, TIPO_COBRO,
};
