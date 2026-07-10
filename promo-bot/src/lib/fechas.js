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

// Días entre hoy (según el calendario de ARGENTINA, no el del servidor) y una fecha.
// Negativo = ya vencido. Si usáramos la medianoche del servidor, en Railway (UTC)
// el día cambiaría a las 21:00 hora argentina y los cálculos nocturnos darían un día menos.
function diasHasta(fecha) {
  if (!fecha) return null;
  const [y, m, d] = fechaHoyArgISO().split('-').map(Number);
  const hoy = new Date(y, m - 1, d); // medianoche del día calendario argentino
  return Math.round((fecha.getTime() - hoy.getTime()) / 86400000);
}

// Fecha de hoy en horario de Argentina, formato DD/MM/AAAA (para fechar los reportes).
function fechaHoyArg() {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date());
}

// Fecha de hoy en Argentina, formato AAAA-MM-DD (para nombres de archivo ordenables).
function fechaHoyArgISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

module.exports = { parseVencimiento, diasHasta, fechaHoyArg, fechaHoyArgISO };
