// Parser del extracto de Santander (export manual del homebanking), normalizado al MISMO
// formato que la liquidación de Mercado Pago para que el motor de conciliación no sepa de
// qué plataforma viene.
//
// Una sola columna de importe CON SIGNO ("Importe Pesos"): positivo = entra plata (Sigma
// Debe — lo que puede ser un cobro); negativo = sale plata (comisiones, impuestos,
// transferencias salientes) y queda fuera de este arqueo, porque el motor solo mira el Debe
// del sistema (ver conciliacion-mp.js). Acá se guardan los dos sentidos igual —como monto
// absoluto + `sentido`— y es `enAlcance`/`motivoFuera` (plataformas.js) quien decide qué
// entra; así el "fuera de alcance" del reporte muestra TODO, no lo esconde.
//
// [Validado contra el extracto real de julio 2026: 41/41 candidatos en alcance matchean 1:1
// contra el Mayor de la cuenta 111201014, sin ventana de hora — el extracto no trae hora.]
const XLSX = require('xlsx');
const { interpretarFecha, norm } = require('./sigma-celdas');
const { fechaISO, tsCanonico } = require('./fechas');

class SantanderError extends Error {}

// Saca acentos/mayúsculas para comparar encabezados y conceptos sin depender del encoding.
function clave(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

// Movimientos que el banco retiene/descuenta AUTOMÁTICAMENTE y no tienen asiento propio en
// Sigma: quedan agrupados en una sola categoría (no uno por concepto) para no inflar el
// reporte. "Pago...Haberes" es la excepción del lado Debe: Sigma lo asienta como UN asiento
// agregado ("Sueldos <mes>"), no línea por línea, así que tampoco matchea 1:1.
function categoriaExcluida(concepto) {
  const c = clave(concepto);
  if (/impuesto ley 25\.413/.test(c)) return 'Impuesto Ley 25.413 (retención automática, sin asiento propio)';
  if (/sircreb/.test(c)) return 'Retención SIRCREB (automática, sin asiento propio)';
  if (/iibb/.test(c)) return 'Percepción/retención IIBB (automática, sin asiento propio)';
  if (/comision/.test(c)) return 'Comisión bancaria (sin asiento propio)';
  if (/\biva\b/.test(c)) return 'IVA retenido/percibido (sin asiento propio)';
  if (/haberes/.test(c)) return 'Pago de haberes (Sigma lo asienta agrupado, no línea por línea)';
  if (/^anul/.test(c)) return 'Movimiento anulado';
  return null;
}

// parsearSantander(buffer) -> { operaciones: [...] }
//   { fila, hora, bruto, sentido:'credito'|'debito', concepto, referencia, comision, impuestos, neto }
// Sin hora (el extracto solo trae fecha): todas quedan a las 00:00:00, igual que el reporte
// "collection" de MP — el motor las aparea SOLO por importe (ver conciliarMP: `sinHora`).
function parsearSantander(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) {
    throw new SantanderError('El archivo no tiene ninguna hoja con datos. ¿Es el extracto de Santander?');
  }
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  let headerIdx = -1;
  for (let i = 0; i < Math.min(filas.length, 20); i++) {
    const k = (filas[i] || []).map(clave);
    if (k.includes('fecha') && k.includes('importe pesos')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    throw new SantanderError(
      'No reconozco el archivo: no encontré las columnas "Fecha" e "Importe Pesos". ' +
      'Mandame el extracto que se baja del homebanking de Santander.'
    );
  }

  const idx = new Map();
  (filas[headerIdx] || []).forEach((c, i) => { if (!idx.has(clave(c))) idx.set(clave(c), i); });
  const faltantes = ['fecha', 'concepto', 'importe pesos'].filter((k) => !idx.has(k));
  if (faltantes.length) {
    throw new SantanderError(`Al extracto de Santander le faltan columnas que necesito (${faltantes.join(', ')}). ¿Cambió el formato?`);
  }
  const iFecha = idx.get('fecha');
  const iConcepto = idx.get('concepto');
  const iImporte = idx.get('importe pesos');
  const iReferencia = idx.get('referencia');

  const operaciones = [];
  for (let i = headerIdx + 1; i < filas.length; i++) {
    const r = filas[i];
    if (!r) continue;
    const crudo = r[iImporte];
    if (crudo === undefined || crudo === '' || crudo === null) continue;
    const monto = Number(crudo);
    if (!Number.isFinite(monto) || monto === 0) continue;

    const fecha = interpretarFecha(r[iFecha]);
    if (!fecha) {
      throw new SantanderError(`Una fila del extracto de Santander (${i + 1}) tiene una fecha ilegible ("${r[iFecha]}"). ¿Cambió el formato?`);
    }
    const iso = fechaISO(fecha);
    const [y, m, d] = iso.split('-').map(Number);
    const bruto = Math.abs(monto);
    operaciones.push({
      fila: i + 1,
      hora: tsCanonico(y, m, d, 0, 0, 0),
      bruto,
      sentido: monto > 0 ? 'credito' : 'debito',
      comision: 0,
      impuestos: 0,
      neto: bruto,
      concepto: norm(r[iConcepto]),
      referencia: norm(r[iReferencia]),
    });
  }

  if (operaciones.length === 0) {
    throw new SantanderError('No encontré ningún movimiento en el extracto de Santander. ¿Salió vacío?');
  }
  return { operaciones };
}

module.exports = { parsearSantander, SantanderError, categoriaExcluida };
