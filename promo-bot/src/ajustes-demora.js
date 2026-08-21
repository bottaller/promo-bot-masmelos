// Aviso de demora de /ajuste: si el dueño ya verificó un ajuste y lo mandó al rol
// "ajuste_ejecutor", pero pasaron más de 36hs sin que lo confirme, se le avisa al dueño para que
// reclame. A diferencia de los avisos diarios (avisos.js, aviso-libro.js, etc.) esto no espera a
// una hora fija: corre cada una hora, porque las 36hs se cumplen en cualquier momento del día.
const { ajustesDemorados, marcarDemoraAvisada } = require('./db/ajustes');

const HORAS_LIMITE = 36;
const INTERVALO_MS = 60 * 60 * 1000; // 1 hora

async function revisarDemoraAjustes(telegram) {
  const demorados = await ajustesDemorados(HORAS_LIMITE);
  if (demorados.length === 0) return { demorados: 0 };

  const lineas = demorados.map((a) =>
    `• Ajuste de ${a.usuario_nombre || a.usuario_telegram_id} (subido ${a.fecha.toISOString().slice(0, 10)}) — verificado hace más de ${HORAS_LIMITE}hs, sin confirmar.`
  );
  const texto = `⏰ Ajustes sin confirmar del ejecutor hace más de ${HORAS_LIMITE}hs:\n\n${lineas.join('\n')}\n\nConviene avisarle.`;

  try {
    await telegram.sendMessage(process.env.OWNER_TELEGRAM_ID, texto);
    await marcarDemoraAvisada(demorados.map((a) => a.id));
  } catch (e) {
    console.error('No pude avisarle al dueño la demora de ajustes:', e.message);
    // No marcamos demora_avisada: se reintenta en la próxima corrida.
  }
  return { demorados: demorados.length };
}

function iniciarChequeoDemoraAjustes(bot) {
  const correr = async () => {
    try {
      const r = await revisarDemoraAjustes(bot.telegram);
      if (r.demorados > 0) console.log(`Demora de ajustes: avisados ${r.demorados}.`);
    } catch (e) {
      console.error('Error chequeando demora de ajustes:', e);
      require('./notificar').avisarProblema({ proceso: 'chequeo de demora de ajustes', que: 'No pude chequear los ajustes verificados sin confirmar.', detalle: e && e.message, nivel: '❌' }).catch(() => {});
    }
  };
  correr(); // corrida inicial al arrancar, por si el proceso estuvo caído
  setInterval(correr, INTERVALO_MS);
}

module.exports = { revisarDemoraAjustes, iniciarChequeoDemoraAjustes };
