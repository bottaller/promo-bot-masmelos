require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');

const altaWizard = require('./scenes/alta');
const bajaWizard = require('./scenes/baja');
const { reportePorSku } = require('./scenes/reporte');
const { ensureHeaders } = require('./sheets');
const { setBot } = require('./notificar');

const required = ['BOT_TOKEN', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Falta la variable de entorno ${key}. Revisá el archivo .env`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);
setBot(bot);

const stage = new Scenes.Stage([altaWizard, bajaWizard]);
bot.use(session());
bot.use(stage.middleware());

bot.start((ctx) =>
  ctx.reply(
    'Bot de promociones por vencimiento — Más Melos.\n\n' +
    '/alta — registrar producto pasado a promoción\n' +
    '/baja — registrar retiro de góndola (vendido o descartado)\n' +
    '/reporte SKU — ver historial de un producto'
  )
);

bot.command('alta', (ctx) => ctx.scene.enter('alta-wizard'));
bot.command('baja', (ctx) => ctx.scene.enter('baja-wizard'));
bot.command('reporte', reportePorSku);

bot.catch((err, ctx) => {
  console.error('Error en el bot:', err);
  ctx.reply('Ocurrió un error. Probá de nuevo o avisá al admin.');
});

(async () => {
  await ensureHeaders();
  await bot.launch();
  console.log('Bot de promociones (independiente) corriendo.');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
