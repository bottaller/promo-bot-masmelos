// Orquestación del control de Tesorería (PURA — no toca la DB). Junta el motor de
// conciliación, el acumulado/persistencia y el reporte, y suma la capa de SEGURIDAD:
// detecta movimientos del libro hacia cuentas sensibles (retiros de socios/gerencia,
// desvío de caja, reintegros inter-empresa). La capa de auditoría (persistencia + trail)
// vive en la DB; acá se produce lo que el tesorero y el admin ven.
const { conciliar, evaluarCuenta, evaluarPeriodo, acumularCuenta } = require('./conciliacion');
const { formatearCierre, fmt } = require('./reporte-cierre');

// Cuentas del libro que, si se mueven, se muestran aparte para control/seguridad. Los
// códigos salen del catálogo real de Sigma (validado con la semana de prueba).
const CUENTAS_SENSIBLES = new Map([
  [211701011, 'Retiro de socios'],
  [111101004, 'Caja Gerencia (retiros)'],
  [501100006, 'Desvío de caja'],
  [111100030, 'Reintegro a Skyceo (Caja PIBA)'],
  [111102006, 'Compra/venta de USD (Tesorería)'],
]);
const UMBRAL_DESTACADO = 1_000_000; // ARS: por debajo no se destaca (ruido)

// Movimientos del período hacia cuentas sensibles. Umbraliza por el flujo BRUTO
// (debe + haber), NO por el neto: un ida-y-vuelta (compra+venta de USD, un reintegro que
// va y vuelve) se cancela en el neto pero es justo lo que hay que vigilar. Muestra el neto
// (dirección) pero también el bruto cuando difiere.
function movimientosDestacados(movimientos, umbral = UMBRAL_DESTACADO) {
  const porId = new Map();
  for (const m of movimientos) {
    const id = Number(m.cuenta_id);
    const e = porId.get(id) || { debe: 0, haber: 0, cuenta: m.cuenta };
    e.debe += Number(m.debe) || 0;
    e.haber += Number(m.haber) || 0;
    porId.set(id, e);
  }
  const out = [];
  for (const [id, label] of CUENTAS_SENSIBLES) {
    const e = porId.get(id);
    if (!e) continue;
    const neto = e.debe - e.haber;
    const bruto = e.debe + e.haber;
    if (bruto >= umbral) out.push({ cuenta_id: id, label, cuenta: e.cuenta, neto, bruto });
  }
  return out.sort((a, b) => b.bruto - a.bruto);
}

function seccionDestacados(destacados) {
  if (!destacados.length) return '';
  const L = ['', '🔎 <b>Movimientos para control:</b>'];
  for (const d of destacados) {
    // Si el bruto es bastante mayor que |neto|, hubo ida y vuelta: mostrarlo.
    const idaYVuelta = d.bruto - Math.abs(d.neto) > UMBRAL_DESTACADO / 2;
    L.push(`• ${d.label}: ${fmt(d.neto, 'ARS')}` + (idaYVuelta ? ` (movió ${fmt(d.bruto, 'ARS')} entre ida y vuelta)` : ''));
  }
  return L.join('\n');
}

// Procesa un cierre (diario / semanal / mensual). PURO.
//   saldosAyer/saldosHoy: [{cuenta, moneda, monto}] (inicio y fin del período)
//   movimientos: del libro (todo el período)
//   historialDiffs: {cuentaNombre -> [{fecha, diferencia}]} — diferencias de cierres
//                   ANTERIORES a éste (para el acumulado y la persistencia). {} si no hay.
// Devuelve { filas (evaluadas), destacados, texto }.
function procesarCierre({ fecha, empresa = 'HONRE', saldosAyer = [], saldosHoy = [], movimientos = [], historialDiffs = {}, tipo = 'diario', periodo = null }) {
  const esPeriodo = tipo !== 'diario';
  const base = conciliar({ saldosAyer, saldosHoy, movimientos });
  const filas = base.map((f) => {
    if (f.diferencia == null) {
      // sin_saldo_ayer / sin_saldo_hoy: el nivel es el estado (el reporte lo maneja).
      return { ...f, acumulado: null, nivel: f.estado, motivo: null };
    }
    if (esPeriodo) {
      // Control de período: no hay "próximo cierre" que resuelva el timing; el acumulado
      // ES la diferencia del período.
      const ev = evaluarPeriodo({ diferencia: f.diferencia, moneda: f.moneda, cuenta: f.cuenta });
      return { ...f, acumulado: f.diferencia, nivel: ev.nivel, motivo: ev.motivo };
    }
    const serie = [...(historialDiffs[f.cuenta] || []), { fecha, diferencia: f.diferencia }];
    const { acumulado, diasSobreUmbral } = acumularCuenta(serie, f.moneda, f.cuenta);
    const ev = evaluarCuenta({ diferencia: f.diferencia, acumulado, moneda: f.moneda, diasSobreUmbral, cuenta: f.cuenta });
    return { ...f, acumulado, nivel: ev.nivel, motivo: ev.motivo };
  });
  const destacados = movimientosDestacados(movimientos);
  const texto = formatearCierre({ fecha, empresa, filas, tipo, periodo }) + seccionDestacados(destacados);
  return { filas, destacados, texto };
}

module.exports = { procesarCierre, movimientosDestacados, CUENTAS_SENSIBLES };
