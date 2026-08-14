// Área Administración — rol NUEVO, distinto de admin del bot (es_admin): se asigna con
// /usuarios como cualquier otra área.
//  /arqueobanco — arqueo de cobros de Santander/Supervielle BAJO DEMANDA (mandás el extracto de
//                 un día + el libro/Mayor de Sigma, te devuelvo el arqueo en el momento). Todavía
//                 no está enganchado al circuito automático de /carga ni al barrido de las 08:00
//                 — ver la nota en src/lib/plataformas.js.
const arqueoBancoWizard = require('../../scenes/arqueo-banco');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'administracion';

const comandos = [
  { comando: 'arqueobanco', descripcion: 'Arqueo de cobros de Santander/Supervielle (extracto de un día + libro de Sigma)' },
];

function registrar(bot) {
  bot.command('arqueobanco', requiereArea(CODIGO), (ctx) => ctx.scene.enter('arqueo-banco-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Administración',
  scenes: [arqueoBancoWizard],
  comandos,
  registrar,
};
