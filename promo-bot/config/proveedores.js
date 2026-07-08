// Lista predeterminada de proveedores.
// Agregá, editá o borrá proveedores acá — esta es la lista que aparece
// como botones en /alta y en /reporte, y la que se usa para filtrar reportes.
//
// "compradores" es opcional: si lo completás, ese proveedor va a notificar
// a esas personas cuando se hace una alta o una baja de promoción.
// Dejar el array vacío ([]) si todavía no corresponde notificar a nadie.

module.exports = {
  'Don Satur': {
    compradores: [
      { nombre: 'Jazmín', chat_id: 'PENDIENTE' },
    ],
  },
  'Proveedor 2': {
    compradores: [
      { nombre: 'Ricardo', chat_id: 'PENDIENTE' },
    ],
  },
};
