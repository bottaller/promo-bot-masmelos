// Área Retiros — quien mantiene la PLANILLA RETIRA de Moreno y la sube para que alimente la
// pantalla de recepción (/tv_recepcion en el sitio).
//
//  /carga — la misma puerta que usa Tesorería. Se manda la planilla y el bot la reconoce sola.
//
// Va como área propia y no dentro de Depósito a propósito: quien carga la planilla no tiene por
// qué acceder al resto de los comandos de Depósito.
//
// OJO: el handler de /carga NO se registra acá — ya lo registra areas/tesoreria/index.js y
// registrarlo dos veces haría que el wizard se abra por duplicado. Acá solo se DECLARA el comando
// para que aparezca en el menú de quien tiene esta área (ver comandosVisibles en src/index.js).
// Lo que puede subir realmente cada uno lo decide lib/documentos-carga.js, documento por documento.
const { requiereArea } = require('../../middleware/authz');
const { textoPantalla } = require('../../lib/pantalla-estado');

const CODIGO = 'retiros';

const comandos = [
  { comando: 'carga', descripcion: 'Subir la planilla de retiros (actualiza la pantalla de recepción)' },
  { comando: 'pantalla', descripcion: '¿La pantalla de recepción está al día? (y si no, por qué)' },
];

function registrar(bot) {
  // /carga NO se registra acá: ya lo hace areas/tesoreria (ver el comentario de arriba).
  //
  // /pantalla sí. Durante toda la puesta en marcha, saber si la planilla estaba
  // entrando exigía mirar la base o ir hasta la PC de la sucursal. El que necesita
  // esa respuesta es quien mira la tele, y la necesita desde el teléfono.
  bot.command('pantalla', requiereArea(CODIGO), async (ctx) => {
    try {
      await ctx.reply(await textoPantalla(), { parse_mode: 'HTML' });
    } catch (e) {
      console.error('/pantalla:', e);
      await ctx.reply('No pude leer el estado de la pantalla. Probá de nuevo en un rato.');
    }
  });
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Retiros',
  scenes: [],
  comandos,
  registrar,
};
