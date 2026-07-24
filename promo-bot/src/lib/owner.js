// El "dueño" del bot: único destinatario de /ajuste y /promoprecios (área Calidad). NO es lo
// mismo que "admin real" — hoy hay más de un admin (ver bot.usuarios), y esto es exclusivamente
// para esta persona. Se configura por telegram_id en OWNER_TELEGRAM_ID (.env), nunca hardcodeado.
function esDueno(telegramId) {
  return !!process.env.OWNER_TELEGRAM_ID && String(telegramId) === String(process.env.OWNER_TELEGRAM_ID);
}

module.exports = { esDueno };
