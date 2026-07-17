// Área Caja Central — quien maneja la caja central del negocio y controla que lo que cobró
// Mercado Pago sea exactamente lo que quedó asentado en el sistema.
//  /mp — conciliación de Mercado Pago operación por operación (sistema vs liquidación de MP).
//
// El rol se asigna con: /usuarios agregar <telegram_id> cajacentral (migración 014).
// /mp vivía en Tesorería hasta el 17/07/2026; se movió acá porque es Caja Central quien lo
// corre. Un comando pertenece a UNA sola área (ver D9 de docs/arquitectura.md): registrarlo
// desde dos lo ejecutaría dos veces. Los admins lo siguen viendo (tienen acceso total).
const mpWizard = require('../../scenes/mp');
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'cajacentral';

const comandos = [
  { comando: 'mp', descripcion: 'Conciliar Mercado Pago: mandás los movimientos del sistema + la liquidación, te marco lo que no cierra' },
];

function registrar(bot) {
  bot.command('mp', requiereArea(CODIGO), (ctx) => ctx.scene.enter('mp-wizard'));
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Caja Central',
  scenes: [mpWizard],
  comandos,
  registrar,
};
