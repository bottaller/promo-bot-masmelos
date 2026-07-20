// Parser de los movimientos de UNA cuenta contable, renglón por renglón — el lado "sistema"
// de la conciliación de Mercado Pago (/mp).
//
// Acepta los DOS exports de Sigma que traen ese dato, y los distingue solo (sniff) por su
// fila de encabezados:
//   - "Diario de movimientos contables" (header "Mov.")  → el MISMO archivo que ya se sube
//     todos los días para /cierre. Trae todas las cuentas: filtramos la que interesa.
//   - "Mayor de cuenta"                 (header "Cuenta") → el export de una sola cuenta.
//     Trae además el comprobante relacionado (REC8 …), que el Diario no tiene.
//
// OJO — por qué NO se reusa parsearLibro() (libro-excel.js): ese AGREGA por
// (fecha, cuenta_id, ingreso) sumando Debe/Haber, y eso rompe el match uno a uno. Un mismo
// recibo puede tener DOS cobros de MP cargados en el mismo segundo (visto en datos reales:
// REC8 00002698 = $100.000 + $111.393,93, dos pagos distintos en la liquidación de MP); si
// se suman, quedan 1 renglón contra 2 operaciones y las dos caen como huérfanas. Acá cada
// renglón se conserva tal cual.
const XLSX = require('xlsx');
const {
  norm, parseNum, parseEntero, interpretarFecha, interpretarTimestamp, buscarHeader,
} = require('./sigma-celdas');

// Errores "esperables" con mensaje para el tesorero (los distingue de un bug real).
class MayorError extends Error {}

// Posiciones POSICIONALES (como en libro-excel.js / parse.py): la fila de headers a veces
// trae el encoding roto, así que no se confía en el nombre de la columna.
const COL_DIARIO = {
  asiento: 0, fecha: 1, comp: 2, concepto: 3, cuenta_id: 4, cuenta: 5,
  debe: 8, haber: 9, comprobante: 12, cliente: 13, usuario: 14, ingreso: 15,
};
const COL_MAYOR = {
  cuenta_id: 0, cuenta: 1, asiento: 2, fecha: 3, comp: 4, cliente: 6, comprobante: 7,
  concepto: 8, debe: 10, haber: 11, empresa: 15, ingreso: 17, usuario: 18,
};

// Cada formato: cómo se reconoce y cuántas columnas necesita como mínimo.
// EL ORDEN IMPORTA: el Diario se prueba primero porque su header ("Mov.") es el más específico;
// "Cuenta" es una palabra que podría aparecer suelta en otro export.
const FORMATOS = [
  { origen: 'diario', header: 'Mov.', col: COL_DIARIO, minColumnas: 16, nombre: 'Diario de movimientos contables' },
  { origen: 'mayor', header: 'Cuenta', col: COL_MAYOR, minColumnas: 19, nombre: 'Mayor de cuenta' },
];

function detectarFormato(filas) {
  for (const f of FORMATOS) {
    const idx = buscarHeader(filas, f.header);
    if (idx !== -1) return { ...f, headerIdx: idx };
  }
  return null;
}

// parsearMayor(buffer, { cuentaId }) -> { origen, cuenta, desde, hasta, movimientos }
// movimientos: [{asiento, fecha, comp, cliente, comprobante, usuario, ingreso, debe, haber}]
// en el orden del export (uno por renglón, sin agregar). `ingreso` es el ts canónico
// 'AAAA-MM-DD HH:MM:SS' (hora de pared, ver fechas.js).
function parsearMayor(buffer, { cuentaId }) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) {
    throw new MayorError('El archivo no tiene ninguna hoja con datos. ¿Es un export de Sigma?');
  }
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  const fmt = detectarFormato(filas);
  if (!fmt) {
    throw new MayorError(
      'No reconozco el archivo: no encontré la fila de encabezados ("Mov." o "Cuenta"). ' +
      'Mandame el "Diario de movimientos contables" o el "Mayor de cuenta" de Sigma.'
    );
  }

  const ancho = XLSX.utils.decode_range(ws['!ref']).e.c + 1;
  if (ancho < fmt.minColumnas) {
    throw new MayorError(
      `El export de "${fmt.nombre}" tiene ${ancho} columnas y se esperaban al menos ${fmt.minColumnas}. ` +
      '¿Cambió el formato del reporte en Sigma?'
    );
  }

  const C = fmt.col;
  const movimientos = [];
  const otrasCuentas = []; // el resto del Diario: sirve para rastrear dónde quedó imputado
  let cuenta = '';
  let minFecha = null;
  let maxFecha = null;
  let filasDeLaCuenta = 0;

  for (let i = fmt.headerIdx + 1; i < filas.length; i++) {
    const r = filas[i];
    if (!r) continue;

    const cid = parseEntero(r[C.cuenta_id]);
    if (cid === null) continue; // fila de pie/total/blanco

    // Las OTRAS cuentas no se descartan: con el Diario completo, un cobro que MP hizo y no
    // se asentó en la cuenta de MP suele aparecer en otra cuenta (ej.: como faltante de una
    // caja física). Guardarlas permite decir DÓNDE quedó, no solo que falta.
    if (cid !== cuentaId) {
      const asientoOtra = parseEntero(r[C.asiento]);
      if (asientoOtra === null || asientoOtra === 0) continue;
      if (norm(r[C.concepto]).toLowerCase() === 'saldo anterior') continue;
      const fechaOtra = interpretarFecha(r[C.fecha]);
      otrasCuentas.push({
        asiento: asientoOtra,
        cuenta_id: cid,
        cuenta: norm(r[C.cuenta]),
        comp: norm(r[C.comp]),
        concepto: norm(r[C.concepto]),
        comprobante: norm(r[C.comprobante]),
        cliente: norm(r[C.cliente]),
        usuario: norm(r[C.usuario]),
        ingreso: interpretarTimestamp(r[C.ingreso], fechaOtra),
        debe: parseNum(r[C.debe]),
        haber: parseNum(r[C.haber]),
      });
      continue;
    }
    filasDeLaCuenta++;

    // El Mayor abre con el renglón "Saldo anterior": es el arrastre del saldo, NO un
    // movimiento (y su Debe es enorme: se colaría como una cobranza gigante). Se descarta
    // por concepto y, por las dudas, por asiento vacío/0 (no tiene número de asiento).
    const asiento = parseEntero(r[C.asiento]);
    if (norm(r[C.concepto]).toLowerCase() === 'saldo anterior') continue;
    if (asiento === null || asiento === 0) continue;

    const fecha = interpretarFecha(r[C.fecha]);
    if (!fecha) {
      throw new MayorError(
        `Una fila de la cuenta ${cuentaId} (asiento ${asiento}) no tiene una fecha válida. ¿El export salió completo?`
      );
    }

    if (!cuenta) cuenta = norm(r[C.cuenta]);
    if (!minFecha || fecha < minFecha) minFecha = fecha;
    if (!maxFecha || fecha > maxFecha) maxFecha = fecha;

    movimientos.push({
      asiento,
      fecha,
      comp: norm(r[C.comp]),
      cliente: norm(r[C.cliente]),
      comprobante: norm(r[C.comprobante]),
      usuario: norm(r[C.usuario]),
      ingreso: interpretarTimestamp(r[C.ingreso], fecha),
      debe: parseNum(r[C.debe]),
      haber: parseNum(r[C.haber]),
      empresa: C.empresa === undefined ? '' : norm(r[C.empresa]),
    });
  }

  if (filasDeLaCuenta === 0) {
    throw new MayorError(
      `El export de "${fmt.nombre}" no tiene ningún movimiento de la cuenta ${cuentaId}. ` +
      (fmt.origen === 'mayor'
        ? '¿Exportaste el Mayor de la cuenta correcta?'
        : '¿El libro cubre el día que querés conciliar?')
    );
  }
  if (movimientos.length === 0) {
    throw new MayorError(
      `Encontré la cuenta ${cuentaId} pero sin ningún asiento (solo el saldo anterior). ` +
      '¿El export cubre el día que querés conciliar?'
    );
  }

  return { origen: fmt.origen, cuenta, desde: minFecha, hasta: maxFecha, movimientos, otrasCuentas };
}

module.exports = { parsearMayor, MayorError };
