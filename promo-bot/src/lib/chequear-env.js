// Registro de las variables de entorno que le importan al bot, para poder chequear al arrancar qué
// falta y avisarle a los admins (ver index.js). La idea: nadie se entera "en silencio" de que un
// feature quedó apagado porque faltó una variable en Railway.
//
// CRÍTICAS: sin ellas el bot no puede ni arrancar (index.js corta con process.exit ANTES de esto).
// Están acá igual para documentarlas en un solo lugar.
const CRITICAS = [
  { nombre: 'BOT_TOKEN', rompe: 'el bot no puede ni arrancar (token de Telegram)' },
  { nombre: 'DATABASE_URL', rompe: 'no hay base de datos (Supabase)' },
];

// FUNCIONALES: si faltan, el bot ARRANCA igual pero un feature queda deshabilitado. Cada una dice
// QUÉ se rompe, para que el aviso al admin sea accionable. Las que tienen un default sano
// (PYTHON_BIN -> 'python', los *_HORA_UTC, TALO_BASE_URL, TALO_TEAM_ID) NO van acá: no rompen nada.
const FUNCIONALES = [
  { nombre: 'OWNER_TELEGRAM_ID', rompe: '/ajuste y /promoprecios no le avisan a nadie (Calidad)' },
  { nombre: 'TALO_USER_ID', rompe: 'no se baja Talo por API (arqueo Talo de las 21:00)' },
  { nombre: 'TALO_CLIENT_ID', rompe: 'no se baja Talo por API (arqueo Talo de las 21:00)' },
  { nombre: 'TALO_CLIENT_SECRET', rompe: 'no se baja Talo por API (arqueo Talo de las 21:00)' },
  { nombre: 'ANTHROPIC_API_KEY', rompe: '/carteleria no genera el diseño (cae al flujo viejo, foto cruda)' },
  { nombre: 'SUPABASE_STORAGE_URL', rompe: '/carteleria no encuentra las fotos del catálogo de producto' },
  { nombre: 'GRAFICA_WHATSAPP_NUMBER', rompe: '/carteleria no arma el link de WhatsApp a la gráfica' },
];

// Una variable "falta" si no está o está vacía (espacios no cuentan).
function falta(nombre) {
  return !process.env[nombre] || !String(process.env[nombre]).trim();
}

function faltantes(lista) {
  return lista.filter((v) => falta(v.nombre));
}

// Las funcionales que faltan (para el aviso al admin al arrancar). [] si está todo.
function funcionalesFaltantes() {
  return faltantes(FUNCIONALES);
}

module.exports = { CRITICAS, FUNCIONALES, falta, faltantes, funcionalesFaltantes };
