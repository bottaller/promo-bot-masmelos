// Parseo de la fecha de vencimiento, que se guarda como texto DD/MM/AAAA.

// Devuelve un Date (a medianoche local) o null si el texto no es una fecha válida.
function parseVencimiento(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  const fecha = new Date(Number(y), Number(mo) - 1, Number(d));
  // Chequeo de validez (rechaza 31/02, etc.)
  if (Number.isNaN(fecha.getTime()) || fecha.getMonth() !== Number(mo) - 1) return null;
  return fecha;
}

// Días entre hoy (a medianoche) y una fecha. Negativo = ya vencido.
function diasHasta(fecha) {
  if (!fecha) return null;
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  return Math.round((fecha.getTime() - hoy.getTime()) / 86400000);
}

module.exports = { parseVencimiento, diasHasta };
