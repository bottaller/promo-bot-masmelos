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
const CODIGO = 'retiros';

const comandos = [
  { comando: 'carga', descripcion: 'Subir la planilla de retiros (actualiza la pantalla de recepción)' },
];

function registrar() {
  // Sin handlers propios: /carga lo registra Tesorería (ver el comentario de arriba).
}

module.exports = {
  codigo: CODIGO,
  nombre: 'Retiros',
  scenes: [],
  comandos,
  registrar,
};
