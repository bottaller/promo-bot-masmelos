// Núcleo del CIERRE DIARIO, SIN Telegram. Dado un día con saldos ya cargados, concilia contra
// el libro que esté en la base y PERSISTE el resultado (conciliación + auditoría). Lo usa el
// barrido de las 08:00 (entrega-cierres.js) para completar los cierres que quedaron pendientes.
//
// A propósito no toca ctx ni manda mensajes: devuelve un estado y el texto ya armado, y quien
// llama decide a quién entregárselo. Así la misma lógica sirve para el barrido y para tests.
//
// Estados (que un cierre "no dé todavía" es un dato normal, no un error → no tira):
//   { estado: 'base' }                       primer cierre: sin día anterior, no hay ventana que conciliar
//   { estado: 'sin_libro', faltan: [Date] }  faltan los libros de los extremos de la ventana
//   { estado: 'ok', texto, filas, nivel, libroMeta, enAlerta }
const {
  saldosAnteriores, saldosDeFecha, momentoConteo, movimientosDeRango,
  historialDiferencias, guardarConciliacion, registrarAuditoria,
} = require('../db/tesoreria');
const { procesarCierre } = require('./control-tesoreria');
const { conseguirLibro } = require('./libro-fuente');
const { formatoVencimiento } = require('./fechas');

const NIVEL_ORD = { ok: 0, timing: 1, revisar: 2, alerta: 3 };
function peorNivel(filas) {
  return filas.reduce((peor, f) => (NIVEL_ORD[f.nivel] > NIVEL_ORD[peor] ? f.nivel : peor), 'ok');
}

// Decisión PURA del gate (testeable sin DB): con qué está y qué falta, ¿se puede conciliar?
//   prevFecha  Date|null  día del conteo anterior (null = primer cierre)
//   libHoyOk / libPrevOk  bool: ¿hay libro que cubra hoy / el día anterior?
// La ventana del cierre va del conteo anterior al de hoy, así que se necesitan los DOS extremos:
// con uno solo, media ventana queda vacía y el cierre saldría corto culpando a las cuentas.
function decidirEstado({ prevFecha, libHoyOk, libPrevOk }) {
  if (!prevFecha) return 'base';                 // sin día anterior: no hay nada que conciliar
  if (!libHoyOk || !libPrevOk) return 'sin_libro';
  return 'ok';
}

// empresa/fecha: qué cierre. usuarioId/usuarioTxt: el tesorero dueño del cierre (atribución de
// la conciliación y la auditoría). Con ese contexto ya persistido, el llamador solo entrega.
async function completarCierre({ empresa = 'HONRE', fecha, usuarioId = null, usuarioTxt = null }) {
  const prev = await saldosAnteriores({ fecha, empresa });
  // Solo se piden los libros si hay día anterior (si no, es base y no se concilia).
  const libHoy = prev.fecha ? await conseguirLibro({ modo: 'cubre', fecha }) : { ok: true, meta: null };
  const libPrev = prev.fecha ? await conseguirLibro({ modo: 'cubre', fecha: prev.fecha }) : { ok: true, meta: null };

  const estado = decidirEstado({ prevFecha: prev.fecha, libHoyOk: libHoy.ok, libPrevOk: libPrev.ok });
  if (estado === 'base') return { estado: 'base' };
  if (estado === 'sin_libro') {
    const faltan = [];
    if (!libPrev.ok) faltan.push(prev.fecha);
    if (!libHoy.ok) faltan.push(fecha);
    return { estado: 'sin_libro', faltan };
  }

  // Ventana POR HORA (conteo anterior, conteo de hoy], por `ingreso`. El límite de hoy sale de
  // los saldos guardados (momentoConteo), la MISMA fuente que usaba el paso inline del wizard.
  // Si la ventana no tiene movimientos, se concilia igual: con los libros presentes (gate ok)
  // "cero movimientos" es un dato real (ventana tranquila), no un export equivocado.
  const contadoEnHoy = await momentoConteo({ fecha, empresa });
  const [saldosHoy, movs, historial] = await Promise.all([
    saldosDeFecha({ fecha, empresa }),
    movimientosDeRango({ desde: prev.contadoEn, hasta: contadoEnHoy, empresa }),
    historialDiferencias({ empresa, hasta: fecha }),
  ]);

  const { filas, texto } = procesarCierre({
    fecha: formatoVencimiento(fecha), empresa,
    saldosAyer: prev.saldos, saldosHoy, movimientos: movs, historialDiffs: historial, tipo: 'diario',
  });

  // Persistir conciliación + auditoría (misma escritura que hacía el cierre inline).
  await guardarConciliacion({ fecha, empresa, filas, usuarioId });
  const nivel = peorNivel(filas);
  const enAlerta = filas.filter((f) => f.nivel === 'alerta');
  await registrarAuditoria({
    usuarioId, usuarioTxt, accion: 'cierre_diario', empresa, fecha, nivel,
    detalle: { cuentas: filas.length, alertas: enAlerta.map((f) => f.cuenta), entrega: 'diferida' },
  });

  return { estado: 'ok', texto, filas, nivel, libroMeta: libHoy.meta, enAlerta };
}

module.exports = { completarCierre, decidirEstado };
