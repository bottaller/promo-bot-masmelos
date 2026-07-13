// Área Tesorería — control, seguridad y auditoría de la caja/bancos.
//  /flujos        — Excel de Sigma → HTML del flujo del dinero (motor Python).
//  /cierre        — cierre DIARIO: saldos + libro del día → concilia, guarda y avisa 🔴.
//  /semanal       — control semanal: libro del período (saldos ya cargados). No toca el diario.
//  /mensual       — control mensual: ídem, sobre el mes.
//  /reportecierre — (admin) recupera un cierre guardado de una fecha.
const flujosWizard = require('../../scenes/flujos');
const cierreWizard = require('../../scenes/cierre');
const { crearControlPeriodo } = require('../../scenes/control-periodo');
const { reporteCierreHandler } = require('../../scenes/reportecierre');
const { requiereArea, requiereAdmin } = require('../../middleware/authz');

const CODIGO = 'tesoreria';

const semanalWizard = crearControlPeriodo('semanal');
const mensualWizard = crearControlPeriodo('mensual');

const comandos = [
  { comando: 'flujos', descripcion: 'Flujo del dinero (mandás el Excel de Sigma, te devuelve el dashboard)' },
  { comando: 'cierre', descripcion: 'Cierre diario: mandás los saldos + el libro del día, te marco las diferencias' },
  { comando: 'semanal', descripcion: 'Control semanal (mandás el libro de la semana; los saldos ya los tengo)' },
  { comando: 'mensual', descripcion: 'Control mensual (mandás el libro del mes; los saldos ya los tengo)' },
  { comando: 'reportecierre', descripcion: 'Recuperar un cierre pasado (auditoría)', admin: true },
];

function registrar(bot) {
  bot.command('flujos', requiereArea(CODIGO), (ctx) => ctx.scene.enter('flujos-wizard'));
  bot.command('cierre', requiereArea(CODIGO), (ctx) => ctx.scene.enter('cierre-wizard'));
  bot.command('semanal', requiereArea(CODIGO), (ctx) => ctx.scene.enter('semanal-wizard'));
  bot.command('mensual', requiereArea(CODIGO), (ctx) => ctx.scene.enter('mensual-wizard'));
  // Auditoría: recuperar un cierre pasado. Solo admin.
  bot.command('reportecierre', requiereAdmin(), reporteCierreHandler);
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Tesorería',
  scenes: [flujosWizard, cierreWizard, semanalWizard, mensualWizard],
  comandos,
  registrar,
};
