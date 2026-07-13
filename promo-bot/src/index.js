require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');

const { auth } = require('./middleware/auth');
const { setBot } = require('./notificar');
const { listarUsuarios } = require('./db/usuarios');

const calidad = require('./areas/calidad');
const compras = require('./areas/compras');
const tesoreria = require('./areas/tesoreria');
const carritoWeb = require('./areas/carritoweb');
const admin = require('./admin');
const { iniciarAvisos } = require('./avisos');

// Áreas registradas. Sumar un área = agregarla a esta lista.
const areas = [calidad, compras, tesoreria, carritoWeb];

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

// Comandos de admin que no pertenecen a un área (acceso total).
const COMANDOS_ADMIN = [
  { comando: 'usuarios', descripcion: 'Gestionar accesos' },
  { comando: 'actartic', descripcion: 'Actualizar maestro de artículos' },
  { comando: 'avisos', descripcion: 'Chequear vencimientos ahora' },
];

// Comandos de un área visibles para un usuario: los admin-only solo si es admin.
function comandosVisibles(area, usuario) {
  return (area.comandos || []).filter((c) => !c.admin || usuario.es_admin);
}

// Arma el texto del menú según las áreas del usuario.
function menuPara(usuario) {
  const misAreas = usuario.es_admin ? areas.map((a) => a.codigo) : usuario.areas || [];
  const lineas = [];
  for (const area of areas) {
    if (!misAreas.includes(area.codigo)) continue;
    const cmds = comandosVisibles(area, usuario);
    if (!cmds.length) continue;
    lineas.push(`\n${area.nombre}:`);
    for (const c of cmds) lineas.push(`  /${c.comando} — ${c.descripcion}`);
  }
  let texto = lineas.length
    ? `Comandos disponibles para vos:${lineas.join('\n')}`
    : 'Todavía no tenés comandos asignados. Pedile un área al admin.';
  if (usuario.es_admin) {
    texto += '\n\nAdmin:';
    for (const c of COMANDOS_ADMIN) texto += `\n  /${c.comando} — ${c.descripcion}`;
  }
  return texto;
}

// Publica el menú "/" de Telegram POR USUARIO (scope de chat), con el mismo criterio que
// menuPara(): cada uno ve /menu + los comandos de sus áreas (y los de admin si lo es). Antes no
// se publicaba nada, así que el menú "/" estaba vacío y había que tipear todos los comandos a
// mano. Se corre al arrancar; para reflejar un cambio de accesos hay que reiniciar el bot.
// Nunca tira error: no debe impedir el arranque.
async function publicarComandos(bot) {
  const aCmd = (c) => ({ command: c.comando, description: c.descripcion.slice(0, 256) });
  const GLOBAL = [{ command: 'menu', description: 'Ver mis comandos' }];
  try {
    await bot.telegram.setMyCommands(GLOBAL); // default: cualquiera ve al menos /menu
    for (const u of await listarUsuarios()) {
      if (!u.activo) continue;
      const lista = [...GLOBAL];
      const misAreas = u.es_admin ? areas.map((a) => a.codigo) : u.areas || [];
      for (const area of areas) {
        if (!misAreas.includes(area.codigo)) continue;
        for (const c of comandosVisibles(area, u)) lista.push(aCmd(c));
      }
      if (u.es_admin) for (const c of COMANDOS_ADMIN) lista.push(aCmd(c));
      try {
        await bot.telegram.setMyCommands(lista, { scope: { type: 'chat', chat_id: Number(u.telegram_id) } });
      } catch (e) {
        console.error(`Menú "/": no pude publicar a ${u.telegram_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Menú "/": no pude publicar los comandos:', e.message);
  }
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

// Responder callbacks sueltos (botones de flujos ya terminados) para que no queden "cargando".
bot.on('callback_query', (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.catch((err, ctx) => {
  console.error('Error en el bot:', err);
  if (ctx && typeof ctx.reply === 'function') {
    ctx.reply('Ocurrió un error. Probá de nuevo o avisá al admin.').catch(() => {});
  }
});

(async () => {
  try {
    iniciarAvisos(bot); // programa el chequeo diario de vencimientos
    await publicarComandos(bot); // publica el menú "/" de Telegram (antes de arrancar el polling)
    await bot.launch();
    console.log('Bot de Más Melos corriendo. Áreas:', areas.map((a) => a.codigo).join(', '));
  } catch (err) {
    console.error('No se pudo iniciar el bot:');
    console.error(err);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
