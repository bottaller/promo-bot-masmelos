// Vocabulario común para hablar del LIBRO DIARIO en /mp, /cierre y /flujos.
//
// Dos reglas que valen para los tres:
//  1. Nunca la palabra "jornada": es una clave de tabla, no un dato del negocio. Se habla de
//     "el libro del 17/07".
//  2. Arrancar por la CONSECUENCIA, no por el dato: "voy a conciliar el 15/07 con el libro del
//     17/07" antes que "libro: 17/07". El tesorero decide con la primera línea.
const { fechaISO, formatoVencimiento } = require('./fechas');

// Escapa antes de meter texto libre (nombre de archivo) en un mensaje con parse_mode:'HTML'.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function aDate(v) {
  if (v instanceof Date) return v;
  const [y, m, d] = String(v).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// 'DD/MM/AAAA' del día del libro.
function diaLibro(meta) {
  return formatoVencimiento(aDate(meta.fecha));
}

// "17/07/2026" si cubre un día, "13/07/2026 al 17/07/2026" si cubre varios.
function describirRango(meta) {
  const d = formatoVencimiento(aDate(meta.desde));
  const h = formatoVencimiento(aDate(meta.hasta));
  return d === h ? d : `${d} al ${h}`;
}

// Antigüedad en palabras + si amerita alerta. Que sea la ANTIGÜEDAD y no "es anterior a hoy" es
// deliberado: "anterior a hoy" se cumpliría casi siempre (el libro se carga a la noche, los
// comandos se corren durante el día), así que a la semana nadie lo leería. "Hace 4 días" no.
function describirAntiguedad(dias) {
  if (dias <= 0) return { texto: 'de hoy', alerta: false };
  if (dias === 1) return { texto: 'de ayer', alerta: false };
  return { texto: `⚠️ de hace ${dias} días`, alerta: true };
}

// Bloque estándar para mostrar antes de usar el libro. `consecuencia` es la primera línea, que
// cada comando arma a su manera ("voy a conciliar el 15/07 con...", "el reporte va a cubrir...").
function describirLibro(meta, dias, consecuencia) {
  const ant = describirAntiguedad(dias);
  const L = [];
  if (consecuencia) L.push(consecuencia, '');
  L.push(`📚 Libro del <b>${diaLibro(meta)}</b> (${ant.texto})`);
  L.push(`📅 Trae movimientos del ${describirRango(meta)}`);
  L.push(`📝 ${meta.filas} movimientos · cargado el ${formatoVencimiento(new Date(meta.cargado_en))} ${new Date(meta.cargado_en).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}`);
  if (ant.alerta) L.push('', '⚠️ Ojo: no es el libro de hoy. Si necesitás datos más frescos, mandá el Excel.');
  return L.join('\n');
}

// Etiqueta del botón. Lleva la fecha ADENTRO porque en el celular los botones quedan visibles
// con el cuerpo del mensaje fuera de pantalla: es la última barrera antes de correr.
function etiquetaUsarLibro(meta) {
  return `✅ Usar el libro del ${diaLibro(meta)}`;
}

// El fallback NO puede ser mudo: si el comando pide el Excel sin explicar por qué, el usuario
// nunca se entera de que existe el libro centralizado ni de que falta — la migración se apaga
// sola y nadie lo nota. Cada motivo se cuenta distinto porque para el usuario no son lo mismo.
function textoFallback(motivo, { huecos = [] } = {}) {
  const lista = huecos.length
    ? ` (me faltan: ${huecos.map((h) => `${h.slice(8, 10)}/${h.slice(5, 7)}`).join(', ')})`
    : '';
  switch (motivo) {
    case 'sin_libro':
      return `📭 Todavía no tengo el libro diario cargado${lista}. Pedíselo al admin (comando /libro) o mandámelo vos y seguimos.`;
    case 'sin_archivo':
      return '⚠️ Tengo registrado el libro pero no encuentro el archivo guardado. Mandame el Excel y seguimos (ya le avisé al log).';
    case 'db_caida':
      return '⚠️ No pude consultar el libro guardado (problema con la base). Mandame el Excel y seguimos igual.';
    case 'sin_fecha':
      return 'Mandame el Excel y seguimos.';
    default:
      return 'Mandame el Excel y seguimos.';
  }
}

// UNA sola función para la traza de origen que va DENTRO del artefacto entregado (el caption del
// HTML, el encabezado del PDF, el pie del reporte). Motivo: esos tres archivos se reenvían, se
// archivan y se miran al día siguiente, y hoy salen idénticos vengan del libro o de un Excel
// subido a mano. Toda la info de origen vive en el mensaje previo del chat, que se va del scroll.
function lineaOrigen(meta) {
  if (!meta) return 'Origen: Excel enviado en el momento.';
  const cargado = meta.cargado_en ? new Date(meta.cargado_en) : null;
  const cuando = cargado
    ? ` (cargado ${formatoVencimiento(cargado)} ${cargado.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })})`
    : '';
  return `Origen: libro diario del ${diaLibro(meta)}${cuando} · movimientos del ${describirRango(meta)}.`;
}

module.exports = {
  esc, diaLibro, describirRango, describirAntiguedad, describirLibro,
  etiquetaUsarLibro, textoFallback, lineaOrigen,
};
