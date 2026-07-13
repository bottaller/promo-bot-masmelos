// Área Carrito Web. Por ahora es solo la sección + el control de acceso: la ven los admins y
// quien tenga el rol "carritoweb" (asignable con /usuarios agregar <telegram_id> carritoweb).
// Todavía no tiene comandos — se suman cuando se defina cómo se linkean los pedidos del carrito.
const CODIGO = 'carritoweb';

const comandos = [];

function registrar(bot) {
  // Sin comandos por ahora.
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Carrito Web',
  scenes: [],
  comandos,
  registrar,
};
