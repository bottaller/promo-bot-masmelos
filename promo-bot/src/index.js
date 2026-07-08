require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');

const altaWizard = require('./scenes/alta');
const bajaWizard = require('./scenes/baja');
const reporteWizard = require('./scenes/reporte');
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

const stage = new Scenes.Stage([altaWizard, bajaWizard, reporteWizard]);
bot.use(session());
bot.use(stage.middleware());

bot.start((ctx) =>
  ctx.reply(
    'Bot de promociones por vencimiento — Más Melos.\n\n' +
    '/alta — registrar producto pasado a promoción\n' +
    '/baja — registrar retiro de góndola (vendido o descartado)\n' +
    '/reporte — ver historial por SKU o por proveedor'
  )
);

bot.command('alta', (ctx) => ctx.scene.enter('alta-wizard'));
bot.command('baja', (ctx) => ctx.scene.enter('baja-wizard'));
bot.command('reporte', (ctx) => ctx.scene.enter('reporte-wizard'));

bot.catch((err, ctx) => {
  console.error('Error en el bot:', err);
  ctx.reply('Ocurrió un error. Probá de nuevo o avisá al admin.');
});

(async () => {
  try {
    console.log('Paso 1/3: verificando conexión con Google Sheets...');
    await ensureHeaders();
    console.log('Paso 1/3: OK, conectó con la planilla.');

    console.log('Paso 2/3: conectando con Telegram...');
    await bot.launch();
    console.log('Paso 2/3: OK, conectó con Telegram.');

    console.log('Paso 3/3: Bot de promociones (independiente) corriendo.');
  } catch (err) {
    console.error('FALLÓ EN ALGÚN PASO. Detalle del error:');
    console.error(err);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
