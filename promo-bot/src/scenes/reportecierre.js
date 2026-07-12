// /reportecierre <fecha> (admin): recupera un cierre YA guardado y lo vuelve a mostrar, con
// el acumulado por cuenta calculado a esa fecha. Read-only — es la puerta de auditoría.
const { historialDiferencias, conciliacionDeFecha, registrarAuditoria } = require('../db/tesoreria');
const { acumularCuenta, evaluarCuenta } = require('../lib/conciliacion');
const { formatearCierre } = require('../lib/reporte-cierre');
const { parseVencimiento, formatoVencimiento } = require('../lib/fechas');

const num = (v) => (v == null ? null : Number(v));

async function reporteCierreHandler(ctx) {
  const text = (ctx.message && ctx.message.text) || '';
  const arg = text.split(/\s+/).slice(1).join(' ').trim();
  const fecha = parseVencimiento(arg);
  if (!fecha) { await ctx.reply('Uso: <code>/reportecierre DD/MM/AAAA</code>', { parse_mode: 'HTML' }); return; }

  const empresa = 'HONRE';
  const rows = await conciliacionDeFecha({ fecha, empresa });
  if (!rows.length) { await ctx.reply(`No tengo un cierre guardado del ${formatoVencimiento(fecha)}.`); return; }

  const historial = await historialDiferencias({ empresa, hasta: fecha, incluirHasta: true });
  const filas = rows.map((r) => {
    const moneda = r.moneda;
    if (r.estado === 'sin_saldo_ayer' || r.estado === 'sin_saldo_hoy') {
      return { cuenta: r.cuenta, moneda, saldo_ayer: num(r.saldo_ayer), ingresos: num(r.ingresos), egresos: num(r.egresos), saldo_teorico: null, saldo_real: num(r.saldo_real), diferencia: null, estado: r.estado, acumulado: null, nivel: r.estado, motivo: null };
    }
    const { acumulado, diasSobreUmbral } = acumularCuenta(historial[r.cuenta] || [], moneda);
    const ev = evaluarCuenta({ diferencia: num(r.diferencia), acumulado, moneda, diasSobreUmbral });
    return {
      cuenta: r.cuenta, moneda, saldo_ayer: num(r.saldo_ayer), ingresos: num(r.ingresos), egresos: num(r.egresos),
      saldo_teorico: num(r.saldo_teorico), saldo_real: num(r.saldo_real), diferencia: num(r.diferencia),
      estado: r.estado, acumulado, nivel: ev.nivel, motivo: ev.motivo,
    };
  });

  const texto = formatearCierre({ fecha: formatoVencimiento(fecha), empresa, filas, tipo: 'diario' });
  await ctx.reply(texto, { parse_mode: 'HTML' });

  // Auditar la consulta (es la puerta de auditoría: quién miró qué cierre y cuándo). Best-effort.
  try {
    const u = ctx.state.usuario;
    await registrarAuditoria({
      usuarioId: u ? u.id : null,
      usuarioTxt: (u && u.nombre) || (ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id)),
      accion: 'reporte_cierre', empresa, fecha,
      detalle: { cuentas: filas.length },
    });
  } catch (e) { console.error('No pude auditar /reportecierre:', e.message); }
}

module.exports = { reporteCierreHandler };
