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

// --- Marca de tiempo de "reloj de pared" (para el corte por hora del /cierre) ---
// El corte por hora usa timestamps SIN zona (hora argentina literal). La regla de oro:
// se representan SIEMPRE como el string canónico 'AAAA-MM-DD HH:MM:SS', se comparan como
// ::timestamp en SQL, y NUNCA se materializan como Date de JS (node-pg parsearía un
// `timestamp` a Date en el TZ del proceso —Railway=UTC— y correría 3 horas). El orden
// lexicográfico del string == el orden cronológico (por eso todo va cero-padded a segundos).
function _p2(n) { return String(n).padStart(2, '0'); }
function tsCanonico(y, mo, d, hh = 0, mm = 0, ss = 0) {
  return `${y}-${_p2(mo)}-${_p2(d)} ${_p2(hh)}:${_p2(mm)}:${_p2(ss)}`;
}
// Fin del día (23:59:59) — el default cuando no hay hora de conteo = "contado al cierre",
// que reproduce EXACTAMENTE el comportamiento viejo por día. Acepta Date o 'AAAA-MM-DD'.
function finDeDiaTs(fechaLike) {
  const iso = typeof fechaLike === 'string' ? fechaLike : fechaISO(fechaLike);
  return `${iso} 23:59:59`;
}

// Un ts canónico 'AAAA-MM-DD HH:MM:SS' -> segundos, para restar dos marcas. Se interpreta
// en UTC a propósito: es una escala arbitraria, y como AMBAS marcas pasan por acá la
// diferencia sale bien sin que el TZ del proceso (Railway=UTC) se meta. null si no cierra.
function tsASegundos(ts) {
  const m = String(ts == null ? '' : ts).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

// ISO 8601 CON offset ('2026-07-16T16:10:56.000-04:00') -> ts canónico en hora de pared
// ARGENTINA ('2026-07-16 17:10:56'). Lo usa la liquidación de Mercado Pago, que exporta en
// UTC-4 mientras que Sigma escribe la hora local: sin convertir, el match por hora se corre
// 60 minutos. Argentina no tiene horario de verano (UTC-3 fijo), por eso el -180 es constante.
// Aritmética sobre Date.UTC/getUTC* → independiente del TZ del proceso (ver regla de oro arriba).
// null si el texto no tiene la forma esperada.
function isoAHoraArg(iso) {
  const m = String(iso == null ? '' : iso).trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, off] = m;
  let offsetMin = 0;
  if (off && off !== 'Z') {
    const o = off.match(/^([+-])(\d{2}):?(\d{2})$/);
    offsetMin = (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3]));
  }
  // Instante real (UTC) = hora leída − su offset. Después lo llevamos a UTC-3.
  const arg = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss) - offsetMin * 60000 - 180 * 60000);
  return tsCanonico(
    arg.getUTCFullYear(), arg.getUTCMonth() + 1, arg.getUTCDate(),
    arg.getUTCHours(), arg.getUTCMinutes(), arg.getUTCSeconds()
  );
}

module.exports = {
  parseVencimiento, formatoVencimiento, diasHasta, fechaHoyArg, fechaHoyArgISO, fechaISO,
  sumarDias, tsCanonico, finDeDiaTs, tsASegundos, isoAHoraArg,
};
