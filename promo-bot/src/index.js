require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');

const { auth } = require('./middleware/auth');
const { tieneAccesoTotal, AREAS_SIN_BYPASS_SISTEMAS } = require('./middleware/authz');
const { setBot, avisarProblema } = require('./notificar');
const { listarUsuarios } = require('./db/usuarios');
const { funcionalesFaltantes } = require('./lib/chequear-env');

const calidad = require('./areas/calidad');
const compras = require('./areas/compras');
const tesoreria = require('./areas/tesoreria');
const cajaCentral = require('./areas/cajacentral');
const carritoWeb = require('./areas/carritoweb');
const deposito = require('./areas/deposito');
const marketing = require('./areas/marketing');
const ventas = require('./areas/ventas');
const retiros = require('./areas/retiros');
const admin = require('./admin');
const { iniciarAvisos } = require('./avisos');
const { iniciarAvisoLibro } = require('./aviso-libro');
const { iniciarAvisoMpSemanal } = require('./aviso-mp-semanal');
const { iniciarEntregaCierres } = require('./entrega-cierres');
const { registrarAccionesCalidad } = require('./acciones-calidad');
const { registrarAccionesDeposito } = require('./acciones-deposito');
const { iniciarEntregaArqueo, iniciarEntregaTaloApi } = require('./entrega-arqueo');
const { anunciarDeploy } = require('./aviso-deploy');
const { iniciarChequeoDemoraAjustes } = require('./ajustes-demora');

// Áreas registradas. Sumar un área = agregarla a esta lista.
const areas = [calidad, compras, tesoreria, cajaCentral, carritoWeb, deposito, marketing, ventas, retiros];

// Variables imprescindibles para arrancar.
const requeridas = ['BOT_TOKEN', 'DATABASE_URL'];
for (const key of requeridas) {
  if (!process.env[key]) {
    console.error(`Falta la variable de entorno ${key}. Revisá el archivo .env`);
    process.exit(1);
  }
}
// OWNER_TELEGRAM_ID no corta el arranque (no queremos tirar abajo TODO el bot por esto), pero
// sin él /ajuste y /promoprecios no tienen a quién avisarle: se advierte fuerte en el log.
if (!process.env.OWNER_TELEGRAM_ID) {
  console.error('⚠️  Falta OWNER_TELEGRAM_ID en el .env: /ajuste y /promoprecios no van a poder avisarle a nadie.');
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
  { comando: 'actimpint', descripcion: 'Actualizar impuestos internos (para el .txt de Sigma)' },
  { comando: 'avisos', descripcion: 'Chequear vencimientos ahora' },
];

// Comandos de un área visibles para un usuario: los admin-only solo si tiene acceso total
// (admin real o rol "sistemas" — ver src/middleware/authz.js). Como Tesorería ya queda afuera
// de `misAreas` para "sistemas" (ver areasDe), este filtro ni se llega a evaluar para ella.
function comandosVisibles(area, usuario) {
  return (area.comandos || []).filter((c) => !c.admin || tieneAccesoTotal(usuario));
}

// Áreas que ve un usuario: admin real, todas; "sistemas", todas MENOS las excluidas (Tesorería
// hoy) salvo que además tenga esa área asignada de verdad; el resto, solo las suyas.
function areasDe(usuario) {
  if (usuario.es_admin) return areas.map((a) => a.codigo);
  const propias = usuario.areas || [];
  if (propias.includes('sistemas')) {
    return areas.map((a) => a.codigo).filter((c) => !AREAS_SIN_BYPASS_SISTEMAS.includes(c) || propias.includes(c));
  }
  return propias;
}

// Arma el texto del menú según las áreas del usuario.
function menuPara(usuario) {
  const veTodo = tieneAccesoTotal(usuario);
  const misAreas = areasDe(usuario);
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
  if (veTodo) {
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
      const veTodo = tieneAccesoTotal(u);
      const misAreas = areasDe(u);
      for (const area of areas) {
        if (!misAreas.includes(area.codigo)) continue;
        for (const c of comandosVisibles(area, u)) lista.push(aCmd(c));
      }
      if (veTodo) for (const c of COMANDOS_ADMIN) lista.push(aCmd(c));
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

// Botones de /ajuste y /promoprecios (notificaciones proactivas, no comandos de un área).
registrarAccionesCalidad(bot);
// Botón de /carteleria (Marketing confirma que ya pidió los carteles a la gráfica).
registrarAccionesDeposito(bot);

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
    iniciarAvisoLibro(bot); // 21:30 ART: avisa a los admins qué documentos del día faltan (libro/MP/Talo)
    iniciarAvisoMpSemanal(bot); // lunes 8:00 ART: resumen semanal MP + Talo a admins + Caja Central
    iniciarEntregaCierres(bot); // 08:00 ART: concilia los cierres pendientes y entrega el reporte
    iniciarEntregaArqueo(bot); // 08:00 ART: arquea MP/Talo del día y manda los reportes a Tesorería + Caja Central
    iniciarEntregaTaloApi(bot); // 21:00 ART: baja Talo del día por API y lo arquea solo; avisa a los admins si falla
    iniciarChequeoDemoraAjustes(bot); // cada 1h: avisa al dueño si un ajuste verificado lleva +36hs sin confirmar
    await publicarComandos(bot); // publica el menú "/" de Telegram (antes de arrancar el polling)
    // OJO: bot.launch() NO resuelve — startPolling corre el loop de polling para siempre. Por eso
    // TODO lo que tenga que pasar al arrancar (aviso de deploy, log) va ANTES; launch() queda último
    // y mantiene vivo el proceso. (sendMessage no necesita el polling, así que el aviso funciona acá.)
    await anunciarDeploy(bot); // avisa a los admins "Deploy terminado: commit X por Y" si es un commit nuevo
    // Chequeo de envs: si falta alguna variable FUNCIONAL, avisar a los admins qué feature quedó
    // apagado. No corta el arranque (las CRÍTICAS ya cortaron arriba con process.exit).
    const envFaltan = funcionalesFaltantes();
    if (envFaltan.length) {
      await avisarProblema({
        proceso: 'arranque del bot',
        que: `Faltan ${envFaltan.length} variable(s) de entorno; hay features deshabilitados:`,
        detalle: envFaltan.map((v) => `• ${v.nombre} → ${v.rompe}`).join('\n'),
        sugerencia: 'Cargá las que falten en las Variables de Railway y redeployá.',
      });
    }
    console.log('Bot de Más Melos corriendo. Áreas:', areas.map((a) => a.codigo).join(', '));
    await bot.launch();
  } catch (err) {
    console.error('No se pudo iniciar el bot:');
    console.error(err);
  }
})();

// Red de seguridad: cualquier error que se escape de los try/catch (una promesa sin catch, una
// excepción no atrapada) se loguea y se avisa a los admins. NO se hace process.exit: la mayoría de
// estos en un bot no son fatales, y matar el proceso cortaría el bot para todos; Railway lo reinicia
// solo si el proceso muere de verdad.
process.on('unhandledRejection', (motivo) => {
  const detalle = motivo && motivo.stack ? motivo.stack : String(motivo);
  avisarProblema({ proceso: 'el bot (promesa sin catch)', que: 'Una promesa falló sin manejo de error.', detalle, nivel: '❌' }).catch(() => {});
});
process.on('uncaughtException', (err) => {
  const detalle = err && err.stack ? err.stack : String(err);
  avisarProblema({ proceso: 'el bot (excepción no atrapada)', que: 'Saltó una excepción que nadie atrapó.', detalle, nivel: '❌' }).catch(() => {});
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
