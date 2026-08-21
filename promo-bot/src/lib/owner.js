// El "dueño" del bot: único destinatario de /ajuste y /promoprecios (área Calidad). NO es lo
// mismo que "admin real" — hoy hay más de un admin (ver bot.usuarios), y esto es exclusivamente
// para esta persona. Se configura por telegram_id en OWNER_TELEGRAM_ID (.env), nunca hardcodeado.
function esDueno(telegramId) {
  return !!process.env.OWNER_TELEGRAM_ID && String(telegramId) === String(process.env.OWNER_TELEGRAM_ID);
}

// Mismo patrón que esDueno, para la persona de Marketing que tiene su propia copia personal de
// /carteleria (/carteleria_marketing, ver scenes/carteleria.js): todo el circuito le vuelve a
// ella en vez de salir a Marketing/Compras/dueño reales. Se configura por telegram_id en
// MARKETING_CARTELERIA_TELEGRAM_ID (.env), nunca hardcodeado.
function esMarketingCarteleria(telegramId) {
  return !!process.env.MARKETING_CARTELERIA_TELEGRAM_ID
    && String(telegramId) === String(process.env.MARKETING_CARTELERIA_TELEGRAM_ID);
}

module.exports = { esDueno, esMarketingCarteleria };
