// Área Caja Central — el rol operativo que controla que lo que cobraron las plataformas
// (Mercado Pago, Talo) sea exactamente lo que quedó asentado en el sistema.
//
// Ya NO tiene comando propio: el arqueo de cobros dejó de ser manual (/mp) y ahora es
// AUTOMÁTICO. El admin sube las liquidaciones de noche con /carga (área Tesorería) y a las 08:00
// el barrido (src/entrega-arqueo.js) las cruza contra el libro y manda los reportes a este grupo
// + Tesorería. Los lunes llega además el resumen semanal (src/aviso-mp-semanal.js).
//
// El área sigue existiendo como ROL (bot.areas.codigo='cajacentral', migración 014): es el canal
// al que se entregan esos avisos, vía telegramIdsPorRol('cajacentral'). El rol se asigna con:
// /usuarios agregar <telegram_id> cajacentral.
const CODIGO = 'cajacentral';

module.exports = {
  codigo: CODIGO,
  nombre: 'Caja Central',
  scenes: [],
  comandos: [],
  registrar() {},
};
