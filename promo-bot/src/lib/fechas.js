// Parseo de la fecha de vencimiento, que se guarda como texto DD/MM/AAAA.

// Devuelve un Date (a medianoche local) o null si el texto no es una fecha válida.
// El año debe ser de 2 o 4 dígitos: así '31/12/202' (se comió un dígito) no se toma
// como el año 202 d.C. y ensucia el orden del control y los avisos.
function parseVencimiento(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  const year = Number(y);
  if (year < 2000 || year > 2100) return null; // fuera de rango razonable -> dedazo
  const fecha = new Date(year, Number(mo) - 1, Number(d));
  // Chequeo de validez (rechaza 31/02, etc.)
  if (Number.isNaN(fecha.getTime()) || fecha.getMonth() !== Number(mo) - 1) return null;
  return fecha;
}

// Date -> texto DD/MM/AAAA con ceros. Normaliza lo que tipeó el usuario (5/3/26 -> 05/03/2026).
function formatoVencimiento(fecha) {
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${fecha.getFullYear()}`;
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

// Date -> texto AAAA-MM-DD (para filtros de rango en SQL, ::date). Usa los getters locales
// (igual que formatoVencimiento) y no toISOString(), que convierte a UTC y puede correr el día.
function fechaISO(fecha) {
  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Date + n días (n puede ser negativo), a medianoche local. Construye la fecha con los
// componentes locales —igual criterio que fechaISO/formatoVencimiento— así el JS normaliza
// el cambio de mes/año y no arrastra el corrimiento de UTC.
function sumarDias(fecha, n) {
  return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() + n);
}

module.exports = { parseVencimiento, formatoVencimiento, diasHasta, fechaHoyArg, fechaHoyArgISO, fechaISO, sumarDias };
