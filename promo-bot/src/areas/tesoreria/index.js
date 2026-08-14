// Área Tesorería — control, seguridad y auditoría de la caja/bancos.
//  /carga         — carga NOCTURNA de los documentos del día: el libro diario + la liquidación
//                   de MP. El libro se archiva; la liquidación queda para el arqueo de las 08:00
//                   (ver entrega-arqueo.js). Talo NO se pide acá: se baja sola por API a las
//                   21:00 (fallback manual si falla). Reemplazó a /libro.
//                   El comando lo comparte con el área Retiros, que sube su planilla por la misma
//                   puerta: el libro y las liquidaciones siguen siendo admin-only, pero el control
//                   ahora es POR DOCUMENTO (ver lib/documentos-carga.js), no por comando.
//  /flujos        — Excel de Sigma → HTML del flujo del dinero (motor Python).
//  /cierre        — cierre DIARIO en dos tiempos: el tesorero manda SOLO los saldos y queda
//                   pendiente; a las 08:00 el barrido lo concilia contra el libro cargado de
//                   noche y entrega el reporte (ver entrega-cierres.js).
//  /semanal       — control semanal: libro del período (saldos ya cargados). No toca el diario.
//  /mensual       — control mensual: ídem, sobre el mes.
//  /reportecierre — (admin) recupera un cierre guardado de una fecha.
// (El arqueo de cobros MP/Talo ya no es un comando: sale solo a las 08:00 → Tesorería + Caja Central.)
const cargaWizard = require('../../scenes/carga');
const flujosWizard = require('../../scenes/flujos');
const cierreWizard = require('../../scenes/cierre');
const { crearControlPeriodo } = require('../../scenes/control-periodo');
const { reporteCierreHandler } = require('../../scenes/reportecierre');
const { requiereArea, requiereAdmin } = require('../../middleware/authz');
const { puertaDeCarga } = require('../../lib/documentos-carga');

const CODIGO = 'tesoreria';

const semanalWizard = crearControlPeriodo('semanal');
const mensualWizard = crearControlPeriodo('mensual');

const comandos = [
  // Sigue con `admin: true`: acá se declara la visibilidad para los de TESORERÍA, y de este lado
  // los documentos (libro y liquidaciones) siguen siendo admin-only, así que a un tesorero no-admin
  // mostrarle el comando sería ofrecerle algo que no puede usar. El área Retiros declara /carga por
  // su cuenta, sin el flag, porque los suyos sí pueden subir su planilla (ver areas/retiros).
  { comando: 'carga', descripcion: 'Cargar los documentos del día: el libro + la liquidación de MP (los reconozco solos; Talo se baja sola)', admin: true },
  { comando: 'flujos', descripcion: 'Flujo del dinero (mandás el Excel de Sigma, te devuelve el dashboard)' },
  { comando: 'cierre', descripcion: 'Cierre diario: mandás los saldos y el reporte te llega a la mañana con el libro cargado' },
  { comando: 'semanal', descripcion: 'Control semanal (mandás el libro de la semana; los saldos ya los tengo)' },
  { comando: 'mensual', descripcion: 'Control mensual (mandás el libro del mes; los saldos ya los tengo)' },
  { comando: 'reportecierre', descripcion: 'Recuperar un cierre pasado (auditoría)', admin: true },
];

function registrar(bot) {
  // /carga dejó de ser admin-only porque ya no recibe solo documentos de Tesorería: también entra
  // la planilla de retiros del área Retiros. El control pasó a ser POR DOCUMENTO, adentro del
  // wizard (ver lib/documentos-carga.js). El libro y las liquidaciones siguen siendo admin-only
  // exactamente igual que antes: si cada área pudiera pisar el libro, dos personas podrían estar
  // mirando reportes armados sobre exports distintos del mismo día. Acá solo se corta la entrada
  // a quien no puede subir ningún tipo de documento.
  bot.command('carga', puertaDeCarga(), (ctx) => ctx.scene.enter('carga-wizard'));
  bot.command('flujos', requiereArea(CODIGO), (ctx) => ctx.scene.enter('flujos-wizard'));
  bot.command('cierre', requiereArea(CODIGO), (ctx) => ctx.scene.enter('cierre-wizard'));
  bot.command('semanal', requiereArea(CODIGO), (ctx) => ctx.scene.enter('semanal-wizard'));
  bot.command('mensual', requiereArea(CODIGO), (ctx) => ctx.scene.enter('mensual-wizard'));
  // Auditoría: recuperar un cierre pasado. Solo admin (Tesorería queda afuera de "sistemas").
  bot.command('reportecierre', requiereAdmin(), reporteCierreHandler);
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Tesorería',
  scenes: [cargaWizard, flujosWizard, cierreWizard, semanalWizard, mensualWizard],
  comandos,
  registrar,
};
