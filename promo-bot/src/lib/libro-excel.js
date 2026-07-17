// Parser del Excel "Diario de movimientos contables" que exporta el tesorero de Sigma.
// Es el MISMO archivo que consume el motor de /flujos; el formato está calcado de
// arqueo/src/masmelos/arqueo/parse.py (18 columnas posicionales, partida doble).
//
// Agrega, por día y por cuenta contable (cuenta_id de Sigma), el total de Debe y Haber
// (y sus Nominales en USD, para la caja dólar). Ese agregado es el lado "libro" de la
// conciliación:  saldo_teorico = saldo_ayer + Σdebe − Σhaber.
//
// Devuelve { empresas, desde (Date), hasta (Date), movimientos: [{fecha, cuenta_id,
// cuenta, debe, haber, debe_nominal, haber_nominal}] } o tira LibroError (mensaje directo
// al usuario) si el archivo no tiene la forma esperada.
const XLSX = require('xlsx');
const { parseVencimiento, fechaISO } = require('./fechas');
const {
  norm, parseNum, parseEntero, interpretarFecha, interpretarTimestamp, buscarHeader,
} = require('./sigma-celdas');

// Errores "esperables" con mensaje para el tesorero (los distingue de un bug real).
class LibroError extends Error {}

// Posición de las columnas del export (renombre POSICIONAL como en parse.py: la fila 3
// de headers a veces trae encoding roto, así que no se confía en el nombre).
// El export estándar de Sigma trae 16 columnas (Mov. … Ingreso). Una variante con
// "Últ.Modif./Últ.Usuario" al final trae 18. Solo usamos las primeras 12 (0-11,
// idénticas en ambas), así que aceptamos 16+ columnas.
const COL = {
  mov: 0, fecha: 1, comp: 2, concepto: 3, cuenta_id: 4, cuenta: 5,
  cc: 6, centro_costo: 7, debe: 8, haber: 9, debe_nominal: 10, haber_nominal: 11,
  comprobante: 12, cuenta_asociada: 13, usuario: 14, ingreso: 15,
};
const MIN_COLUMNAS = 16;

const _RE_PERIODO = /del\s+(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})/i;

function parsearLibro(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) {
    throw new LibroError('El archivo no tiene ninguna hoja con datos. ¿Es el "Diario de movimientos contables" de Sigma?');
  }

  const ancho = XLSX.utils.decode_range(ws['!ref']).e.c + 1;
  if (ancho < MIN_COLUMNAS) {
    throw new LibroError(
      `El export tiene ${ancho} columnas y se esperaban al menos ${MIN_COLUMNAS}. ¿Cambió el formato del reporte en Sigma?`
    );
  }

  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  // Normalmente el header "Mov." está en la fila 3, pero cuando el export incluye MUCHAS
  // empresas el título "Empresa: ..." se parte en varias filas y empuja todo hacia abajo.
  // Por eso BUSCAMOS la fila del header en vez de asumir su posición.
  const headerIdx = buscarHeader(filas, 'Mov.');
  if (headerIdx === -1) {
    throw new LibroError('No encontré la fila de encabezados ("Mov."). ¿Es realmente un "Diario de movimientos" de Sigma?');
  }

  // El título de período ("...del DD/MM/YYYY al DD/MM/YYYY") y el de empresa están en las
  // filas anteriores al header (el de empresa puede ocupar varias).
  let tituloPeriodo = '';
  const partesEmpresa = [];
  for (let i = 0; i < headerIdx; i++) {
    const t = norm(filas[i] && filas[i][0]);
    if (!t) continue;
    if (_RE_PERIODO.test(t)) tituloPeriodo = t;
    else partesEmpresa.push(t);
  }
  const tituloEmpresa = partesEmpresa.join('');

  // Agregación por (fecha ISO, cuenta_id, INGRESO): preserva la hora de cada movimiento
  // (necesaria para el corte por hora del /cierre). Los renglones del mismo cuenta_id con el
  // MISMO Ingreso se suman (lossless: caen siempre en la misma ventana); horas distintas
  // quedan en filas separadas (que es justo lo que permite partir el día por el conteo).
  const acc = new Map(); // clave `${fISO}|${cuenta_id}|${ingreso}` -> {fecha, ingreso, cuenta_id, cuenta, debe, haber, debe_nominal, haber_nominal}
  let minFecha = null;
  let maxFecha = null;
  let nFilas = 0;

  for (let i = headerIdx + 1; i < filas.length; i++) {
    const r = filas[i];
    const mov = parseEntero(r[COL.mov]);
    if (mov === null) continue; // fila sin Mov. (totales, blancos, pie) -> se ignora, como dropna(mov) en parse.py

    const cuentaId = parseEntero(r[COL.cuenta_id]);
    if (cuentaId === null) continue; // renglón sin cuenta contable: no aporta al arqueo
    const fecha = interpretarFecha(r[COL.fecha]);
    if (!fecha) {
      throw new LibroError(
        `Una fila del libro (Mov. ${mov}) no tiene una fecha válida. ¿El export salió completo?`
      );
    }

    const fISO = fechaISO(fecha);
    const ingreso = interpretarTimestamp(r[COL.ingreso], fecha);
    const clave = `${fISO}|${cuentaId}|${ingreso}`;
    let e = acc.get(clave);
    if (!e) {
      e = { fecha, ingreso, cuenta_id: cuentaId, cuenta: norm(r[COL.cuenta]), debe: 0, haber: 0, debe_nominal: 0, haber_nominal: 0 };
      acc.set(clave, e);
    } else if (!e.cuenta) {
      e.cuenta = norm(r[COL.cuenta]);
    }
    e.debe += parseNum(r[COL.debe]);
    e.haber += parseNum(r[COL.haber]);
    e.debe_nominal += parseNum(r[COL.debe_nominal]);
    e.haber_nominal += parseNum(r[COL.haber_nominal]);

    if (!minFecha || fecha < minFecha) minFecha = fecha;
    if (!maxFecha || fecha > maxFecha) maxFecha = fecha;
    nFilas++;
  }

  if (nFilas === 0) {
    throw new LibroError('No encontré ningún asiento en el libro. ¿Estás mandando el "Diario de movimientos contables" de Sigma?');
  }

  // Período: preferí el título ("del ... al ...") y caé al rango de fechas real.
  const m = _RE_PERIODO.exec(tituloPeriodo);
  const desde = (m && parseVencimiento(m[1])) || minFecha;
  const hasta = (m && parseVencimiento(m[2])) || maxFecha;

  const empresas = tituloEmpresa.replace(/^Empresa:\s*/i, '').trim();
  const movimientos = Array.from(acc.values());
  return { empresas, desde, hasta, movimientos };
}

module.exports = { parsearLibro, LibroError };
