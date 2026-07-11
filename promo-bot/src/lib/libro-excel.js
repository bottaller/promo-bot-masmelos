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

// Errores "esperables" con mensaje para el tesorero (los distingue de un bug real).
class LibroError extends Error {}

// Posición de las 18 columnas del export (renombre POSICIONAL como en parse.py:
// la fila 3 de headers a veces trae encoding roto, así que no se confía en el nombre).
const COL = {
  mov: 0, fecha: 1, comp: 2, concepto: 3, cuenta_id: 4, cuenta: 5,
  cc: 6, centro_costo: 7, debe: 8, haber: 9, debe_nominal: 10, haber_nominal: 11,
  comprobante: 12, cuenta_asociada: 13, usuario: 14, ingreso: 15,
  ult_modif: 16, ult_usuario: 17,
};
const N_COLUMNAS = 18;

const _RE_PERIODO = /del\s+(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})/i;

function norm(s) {
  return String(s == null ? '' : s).trim();
}

// Debe/Haber pueden venir como número nativo o texto con formato AR. 0 si vacío/no válido.
function parseNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return 0;
  const limpio = v.replace(/[^\d,-]/g, '').replace(',', '.');
  if (limpio === '' || limpio === '-') return 0;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : 0;
}

// Entero (mov, cuenta_id): número nativo o texto. null si no es un entero.
// Conserva el punto decimal para no romper un "111201014.0" (Excel a veces
// serializa enteros como float): Number lo lee bien y truncamos.
function parseEntero(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const limpio = v.replace(/[^\d.-]/g, '');
    if (limpio === '' || limpio === '-' || limpio === '.') return null;
    const n = Number(limpio);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

// La fecha de cada asiento: serial de Excel (número) o texto DD/MM/AAAA. null si no cierra.
function interpretarFecha(v) {
  if (typeof v === 'number') {
    const d = XLSX.SSF && XLSX.SSF.parse_date_code(v);
    return d ? new Date(d.y, d.m - 1, d.d) : null;
  }
  if (v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // Sigma suele exportar "DD/MM/AAAA" (a veces con hora detrás): tomamos la fecha.
    // Aceptamos día/mes de 1-2 dígitos ("7/7/2026"); parseVencimiento valida el resto.
    const m = s.match(/^(\d{1,2}\/\d{1,2}\/\d{4})/);
    return m ? parseVencimiento(m[1]) : null;
  }
  return null;
}

function parsearLibro(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) {
    throw new LibroError('El archivo no tiene ninguna hoja con datos. ¿Es el "Diario de movimientos contables" de Sigma?');
  }

  const ancho = XLSX.utils.decode_range(ws['!ref']).e.c + 1;
  if (ancho !== N_COLUMNAS) {
    throw new LibroError(
      `El export tiene ${ancho} columnas y se esperaban ${N_COLUMNAS}. ¿Cambió el formato del reporte en Sigma?`
    );
  }

  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  // Fila 1: "Empresa: 0008-HONRE_2,...". Fila 2: "...del DD/MM/YYYY al DD/MM/YYYY".
  // Fila 3: headers, arranca con "Mov.". (Índices 0/1/2.)
  const tituloEmpresa = norm(filas[0] && filas[0][0]);
  const tituloPeriodo = norm(filas[1] && filas[1][0]);
  const header = norm(filas[2] && filas[2][0]);
  if (header !== 'Mov.') {
    throw new LibroError(
      `La fila 3 debería arrancar con "Mov." y trae "${header}". ¿Es realmente un "Diario de movimientos" de Sigma?`
    );
  }

  // Agregación por (fecha ISO, cuenta_id).
  const acc = new Map(); // clave `${fISO}|${cuenta_id}` -> {fecha, cuenta_id, cuenta, debe, haber, debe_nominal, haber_nominal}
  let minFecha = null;
  let maxFecha = null;
  let nFilas = 0;

  for (let i = 3; i < filas.length; i++) {
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
    const clave = `${fISO}|${cuentaId}`;
    let e = acc.get(clave);
    if (!e) {
      e = { fecha, cuenta_id: cuentaId, cuenta: norm(r[COL.cuenta]), debe: 0, haber: 0, debe_nominal: 0, haber_nominal: 0 };
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
