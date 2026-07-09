// Área Tesorería. Por ahora es un esqueleto: el comando /arqueo real (procesar el
// Excel de Sigma y devolver los informes) se implementa en la Fase 3.
const { requiereArea } = require('../../middleware/authz');

const CODIGO = 'tesoreria';

const comandos = [
  { comando: 'arqueo', descripcion: 'Procesar el arqueo (próximamente)' },
];

function registrar(bot) {
  bot.command('arqueo', requiereArea(CODIGO), (ctx) =>
    ctx.reply(
      'El comando /arqueo va a estar disponible pronto.\n' +
      'Va a recibir el Excel exportado de Sigma y devolver el arqueo procesado (Fase 3).'
    )
  );
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Tesorería',
  scenes: [],
  comandos,
  registrar,
};
