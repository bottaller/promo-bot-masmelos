// Parser del extracto de Supervielle (export manual del homebanking), normalizado al MISMO
// formato que la liquidación de Mercado Pago para que el motor de conciliación no sepa de
// qué plataforma viene.
//
// A diferencia de Santander, acá el importe viene en DOS columnas SIN signo: "Débito" y
// "Crédito". Un Crédito (plata que ENTRA) es Sigma Debe — lo que puede ser un cobro; un
// Débito (plata que SALE) es Sigma Haber y queda fuera de este arqueo.
//
// Las transferencias de clientes ("Crédito por Transferencia", "Credito DEBIN") SON ventas
// cobradas y matchean 1:1 contra el Mayor (validado: p.ej. la transferencia de $2.746.076,00
// de Daniel Aguero del 19/07 matchea exacto contra el asiento "AGUERO 19-7"). Lo que se
// excluye son los movimientos que el banco acredita/descuenta AUTOMÁTICAMENTE y que Sigma no
// asienta 1:1 (comisiones, percepciones/acreditaciones de IIBB).
const XLSX = require('xlsx');
const { interpretarFecha, norm } = require('./sigma-celdas');
const { fechaISO, tsCanonico } = require('./fechas');

class SupervielleError extends Error {}

// Saca acentos/mayúsculas para comparar encabezados y conceptos sin depender del encoding.
function clave(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

// Igual criterio que Santander (ver santander-excel.js::categoriaExcluida): movimientos
// automáticos del banco, sin asiento propio en Sigma, agrupados en una sola categoría. Mira
// concepto Y referencia: "CUENTAS PROPIAS" (transferencias entre las cuentas del propio HONRE —
// validado: 6 movimientos reales de julio, hasta $140.000.000, con esa leyenda en Referencia, no
// en Concepto) es un caso real que solo aparece ahí, no es un cobro y no tiene por qué asentarse
// como venta en Sigma.
function categoriaExcluida(texto, referencia = '') {
  const c = clave(`${texto} ${referencia}`);
  if (/comision/.test(c)) return 'Comisión bancaria (sin asiento propio)';
  if (/iibb/.test(c)) return 'Percepción/acreditación IIBB (automática, sin asiento propio)';
  if (/impuesto ley 25\.413/.test(c)) return 'Impuesto Ley 25.413 (retención automática, sin asiento propio)';
  if (/\biva\b/.test(c)) return 'IVA retenido/percibido (sin asiento propio)';
  if (/haberes/.test(c)) return 'Pago de haberes (Sigma lo asienta agrupado, no línea por línea)';
  if (/cuentas propias/.test(c)) return 'Transferencia entre cuentas propias (no es una venta)';
  if (/remuneracion de saldo/.test(c)) return 'Remuneración de saldo (interés que paga el banco, no una venta)';
  if (/^anul/.test(c)) return 'Movimiento anulado';
  return null;
}

// parsearSupervielle(buffer) -> { operaciones: [...] }
//   { fila, hora, bruto, sentido:'credito'|'debito', concepto, referencia, comision, impuestos, neto }
// Sin hora (el extracto solo trae fecha): el motor aparea SOLO por importe (`sinHora`).
function parsearSupervielle(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) {
    throw new SupervielleError('El archivo no tiene ninguna hoja con datos. ¿Es el extracto de Supervielle?');
  }
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

  let headerIdx = -1;
  for (let i = 0; i < Math.min(filas.length, 20); i++) {
    const k = (filas[i] || []).map(clave);
    if (k.includes('debito') && k.includes('credito')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    throw new SupervielleError(
      'No reconozco el archivo: no encontré las columnas "Débito" y "Crédito". ' +
      'Mandame el extracto que se baja del homebanking de Supervielle.'
    );
  }

  const idx = new Map();
  (filas[headerIdx] || []).forEach((c, i) => { if (!idx.has(clave(c))) idx.set(clave(c), i); });
  const faltantes = ['fecha', 'concepto', 'debito', 'credito'].filter((k) => !idx.has(k));
  if (faltantes.length) {
    throw new SupervielleError(`Al extracto de Supervielle le faltan columnas que necesito (${faltantes.join(', ')}). ¿Cambió el formato?`);
  }
  const iFecha = idx.get('fecha');
  const iConcepto = idx.get('concepto');
  const iDetalle = idx.get('detalle');
  const iDebito = idx.get('debito');
  const iCredito = idx.get('credito');

  const operaciones = [];
  for (let i = headerIdx + 1; i < filas.length; i++) {
    const r = filas[i];
    if (!r) continue;
    const deb = Number(r[iDebito]) || 0;
    const cred = Number(r[iCredito]) || 0;
    if (deb === 0 && cred === 0) continue;

    const fecha = interpretarFecha(r[iFecha]);
    if (!fecha) {
      throw new SupervielleError(`Una fila del extracto de Supervielle (${i + 1}) tiene una fecha ilegible ("${r[iFecha]}"). ¿Cambió el formato?`);
    }
    const iso = fechaISO(fecha);
    const [y, m, d] = iso.split('-').map(Number);
    const bruto = cred > 0 ? cred : deb;
    const detalle = iDetalle != null ? norm(r[iDetalle]) : '';
    operaciones.push({
      fila: i + 1,
      hora: tsCanonico(y, m, d, 0, 0, 0),
      bruto,
      sentido: cred > 0 ? 'credito' : 'debito',
      comision: 0,
      impuestos: 0,
      neto: bruto,
      concepto: norm(r[iConcepto]),
      referencia: detalle,
    });
  }

  if (operaciones.length === 0) {
    throw new SupervielleError('No encontré ningún movimiento en el extracto de Supervielle. ¿Salió vacío?');
  }
  return { operaciones };
}

module.exports = { parsearSupervielle, SupervielleError, categoriaExcluida };
