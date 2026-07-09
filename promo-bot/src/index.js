require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');

const { auth } = require('./middleware/auth');
const { setBot } = require('./notificar');

const compras = require('./areas/compras');
const tesoreria = require('./areas/tesoreria');
const admin = require('./admin');

// Áreas registradas. Sumar un área = agregarla a esta lista.
const areas = [compras, tesoreria];

// Variables imprescindibles para arrancar.
const requeridas = ['BOT_TOKEN', 'DATABASE_URL'];
for (const key of requeridas) {
  if (!process.env[key]) {
    console.error(`Falta la variable de entorno ${key}. Revisá el archivo .env`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);
setBot(bot);

// Stage con todas las scenes de todas las áreas.
const scenes = [...areas.flatMap((a) => a.scenes || []), ...(admin.scenes || [])];
const stage = new Scenes.Stage(scenes);

bot.use(session());
bot.use(auth); // control de acceso: corre antes que todo
bot.use(stage.middleware());

// Arma el texto del menú según las áreas del usuario.
function menuPara(usuario) {
  const misAreas = usuario.es_admin ? areas.map((a) => a.codigo) : usuario.areas || [];
  const lineas = [];
  for (const area of areas) {
    if (!misAreas.includes(area.codigo)) continue;
    lineas.push(`\n${area.nombre}:`);
    for (const c of area.comandos) lineas.push(`  /${c.comando} — ${c.descripcion}`);
  }
  let texto = lineas.length
    ? `Comandos disponibles para vos:${lineas.join('\n')}`
    : 'Todavía no tenés comandos asignados. Pedile un área al admin.';
  if (usuario.es_admin) texto += '\n\nAdmin:\n  /usuarios — gestionar accesos\n  /actartic — actualizar maestro de artículos';
  return texto;
}

async function saludar(ctx) {
  const u = ctx.state.usuario;
  if (!u) return;
  await ctx.reply(`Hola ${u.nombre || ''}! Bot de Más Melos.\n\n${menuPara(u)}`);
}

bot.start(saludar);
bot.command('menu', saludar);

// Registrar los comandos de cada área + los de admin.
for (const area of areas) area.registrar(bot);
admin.registrar(bot);

bot.catch((err, ctx) => {
  console.error('Error en el bot:', err);
  if (ctx && typeof ctx.reply === 'function') {
    ctx.reply('Ocurrió un error. Probá de nuevo o avisá al admin.').catch(() => {});
  }
});

(async () => {
  try {
    await bot.launch();
    console.log('Bot de Más Melos corriendo. Áreas:', areas.map((a) => a.codigo).join(', '));
  } catch (err) {
    console.error('No se pudo iniciar el bot:');
    console.error(err);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
