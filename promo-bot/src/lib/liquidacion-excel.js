// Parser de la liquidación de Mercado Pago (el "settlement_v2-<id>-<fecha>.xlsx" que se baja
// del panel de MP) — el lado "MP" de la conciliación de /mp.
//
// A diferencia de los exports de Sigma, este archivo tiene encabezados limpios en inglés y
// estables, así que las columnas se buscan POR NOMBRE (no por posición): si MP agrega una
// columna al medio, no se rompe.
//
// Dos mañas propias de este archivo, las dos con dientes:
//  1) Todos los valores vienen como TEXTO ('127241.52'), en formato US (decimal con punto) —
//     no se puede usar el parseNum de Sigma, que lee la coma como decimal.
//  2) Las fechas vienen en UTC-4 ('2026-07-16T16:10:56.000-04:00') mientras que Sigma escribe
//     la hora local argentina. Sin convertir, el match por hora se corre 60 minutos → se
//     normaliza todo a hora de pared argentina con isoAHoraArg().
const XLSX = require('xlsx');
const { isoAHoraArg } = require('./fechas');

// Errores "esperables" con mensaje para el tesorero (los distingue de un bug real).
class LiquidacionError extends Error {}

// Nombre de la columna en el archivo -> campo nuestro. Las marcadas obligatorias tienen que
// estar: sin ellas no hay conciliación posible.
const COLUMNAS = [
  { nombre: 'SOURCE ID', campo: 'source_id', obligatoria: true },
  { nombre: 'PAYMENT METHOD TYPE', campo: 'instrumento', obligatoria: true },
  { nombre: 'TRANSACTION TYPE', campo: 'tipo', obligatoria: true },
  { nombre: 'TRANSACTION AMOUNT', campo: 'bruto', obligatoria: true, monto: true },
  { nombre: 'ORIGIN DATE', campo: 'hora', obligatoria: true, fecha: true },
  { nombre: 'FEE AMOUNT', campo: 'comision', monto: true },
  { nombre: 'REAL AMOUNT', campo: 'neto', monto: true },
  { nombre: 'TAXES AMOUNT', campo: 'impuestos', monto: true },
  { nombre: 'BUSINESS UNIT', campo: 'unidad' },
  { nombre: 'SUB UNIT', campo: 'canal', obligatoria: true },
];

function norm(s) {
  return String(s == null ? '' : s).trim();
}

// Monto de MP: formato US (decimal con punto). Devuelve null si no es un número —
// nunca 0 por defecto: un 0 silencioso en una columna de plata es un error que no se ve.
// Tolera separador de miles por si MP algún día lo agrega ('1,208,939.26').
function parseMonto(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const limpio = v.trim().replace(/,/g, '');
  if (limpio === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(limpio)) return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// parsearLiquidacion(buffer) -> { operaciones: [{source_id, instrumento, tipo, canal, unidad,
//                                 hora, bruto, comision, impuestos, neto}] }
// `hora` = ts canónico 'AAAA-MM-DD HH:MM:SS' en hora argentina.
function parsearLiquidacion(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) {
    throw new LiquidacionError('El archivo no tiene ninguna hoja con datos. ¿Es la liquidación que baja de Mercado Pago?');
  }
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  // Fila de headers: la primera que tenga el "SOURCE ID".
  let headerIdx = -1;
  for (let i = 0; i < Math.min(filas.length, 20); i++) {
    if ((filas[i] || []).some((c) => norm(c).toUpperCase() === 'SOURCE ID')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    throw new LiquidacionError(
      'No reconozco el archivo: no encontré la columna "SOURCE ID". ' +
      'Mandame el reporte de liquidación de Mercado Pago (el settlement_v2-….xlsx del panel).'
    );
  }

  const idx = new Map();
  (filas[headerIdx] || []).forEach((c, i) => idx.set(norm(c).toUpperCase(), i));
  const faltantes = COLUMNAS.filter((c) => c.obligatoria && !idx.has(c.nombre)).map((c) => c.nombre);
  if (faltantes.length) {
    throw new LiquidacionError(
      `A la liquidación le faltan columnas que necesito (${faltantes.join(', ')}). ¿Cambió el formato del reporte de MP?`
    );
  }

  const operaciones = [];
  for (let i = headerIdx + 1; i < filas.length; i++) {
    const r = filas[i];
    if (!r) continue;
    const sourceId = norm(r[idx.get('SOURCE ID')]);
    if (!sourceId) continue; // fila de pie/blanco

    const op = { source_id: sourceId, fila: i + 1 };
    for (const c of COLUMNAS) {
      if (!idx.has(c.nombre)) { op[c.campo] = c.monto ? 0 : ''; continue; }
      const bruto = r[idx.get(c.nombre)];
      if (c.monto) {
        const n = parseMonto(bruto);
        if (n === null && c.obligatoria) {
          throw new LiquidacionError(
            `La operación ${sourceId} tiene un importe ilegible en "${c.nombre}" (${JSON.stringify(bruto)}). ¿Cambió el formato del reporte de MP?`
          );
        }
        op[c.campo] = n === null ? 0 : n;
      } else if (c.fecha) {
        const ts = isoAHoraArg(bruto);
        if (!ts && c.obligatoria) {
          throw new LiquidacionError(
            `La operación ${sourceId} tiene una fecha ilegible en "${c.nombre}" (${JSON.stringify(bruto)}). ¿Cambió el formato del reporte de MP?`
          );
        }
        op[c.campo] = ts;
      } else {
        op[c.campo] = norm(bruto);
      }
    }
    operaciones.push(op);
  }

  if (operaciones.length === 0) {
    throw new LiquidacionError('No encontré ninguna operación en la liquidación. ¿El reporte salió vacío?');
  }
  return { operaciones };
}

module.exports = { parsearLiquidacion, LiquidacionError };
