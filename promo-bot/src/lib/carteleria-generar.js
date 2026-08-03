// Genera el diseño de un pedido de bot.carteleria YA CREADO (matcheo de foto del catálogo
// incluido, con manejo de candidatas ambiguas) y avisa a Marketing para que lo verifique.
// Extraído de scenes/carteleria.js para que /carteleria y los diseños automáticos que arma
// /promoprecios (ver scenes/validar-promoprecios.js) compartan EXACTAMENTE el mismo manejo de
// fotos ambiguas, sin duplicar esa lógica.
const { carteleriaPorId, guardarDiseno, guardarDisenosCandidatos } = require('../db/carteleria');
const { buscarImagenProducto, archivosCandidatos, buscarImagenesCandidatas } = require('./carteleria-catalogo');
const { generarCartel } = require('./carteleria-render');
const { avisarVerificacionMarketing, avisarEleccionFoto } = require('./carteleria-mensajes');

// Devuelve { ambiguo, avisados }: `ambiguo` true si el matcheo de fotos quedó entre 2-4
// candidatas igual de buenas (Marketing elige, ver avisarEleccionFoto) — en ese caso el diseño
// final todavía no salió a verificar, sale recién cuando Marketing elige la foto
// (carteleria_elegir_foto, en acciones-deposito.js). `avisados` es cuánta gente de Marketing
// recibió el mensaje (0 si no hay nadie con el rol cargado).
async function generarYNotificarMarketing(telegram, { id, tipo, tipoPrecio, producto, precio, vencimiento, politica, articuloCodigo }) {
  const candidatos = archivosCandidatos(producto, articuloCodigo);
  if (candidatos.length > 1) {
    const imagenesCandidatas = await buscarImagenesCandidatas(producto, articuloCodigo);
    const disenosBuffers = [];
    for (const imagenProductoBuffer of imagenesCandidatas) {
      disenosBuffers.push(await generarCartel({
        tipoGrafica: tipo, tipoPrecio, producto, precio: precio ?? null, vencimiento, politica: politica ?? null, imagenProductoBuffer,
      }));
    }

    const carteleria = await carteleriaPorId(id);
    const { avisados, disenosFileIds } = await avisarEleccionFoto(telegram, { carteleria, disenosBuffers });
    if (avisados > 0) await guardarDisenosCandidatos(id, disenosFileIds);
    return { ambiguo: true, avisados };
  }

  const imagenProductoBuffer = await buscarImagenProducto(producto, articuloCodigo);
  const disenoBuffer = await generarCartel({
    tipoGrafica: tipo, tipoPrecio, producto, precio: precio ?? null, vencimiento, politica: politica ?? null, imagenProductoBuffer,
  });

  const carteleria = await carteleriaPorId(id);
  const { avisados, disenoFileId } = await avisarVerificacionMarketing(telegram, { carteleria, disenoBuffer });
  if (disenoFileId) await guardarDiseno(id, { producto, precio, disenoFileId });
  return { ambiguo: false, avisados };
}

module.exports = { generarYNotificarMarketing };
