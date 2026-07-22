// Carga el LIBRO DIARIO desde un archivo, sin pasar por Telegram. Es la puerta para
// automatizar la exportación de Sigma: el robot exporta el .xlsx y después corre
//
//     node src/db/cargar-libro.js "C:\ruta\Diario de movimientos.xlsx"
//     node src/db/cargar-libro.js "<ruta>" 20/07/2026      <- forzar la jornada
//
// Sin el segundo argumento, la jornada es el último día que trae el export (lo normal).
// Sale con código != 0 si algo falla, para que el proceso que lo invoca se entere.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { registrarLibro, LibroError } = require('../lib/registrar-libro');
const { parseVencimiento, formatoVencimiento } = require('../lib/fechas');
const { pool } = require('./pool');

(async () => {
  const file = process.argv[2];
  const fechaTxt = process.argv[3];
  if (!file) {
    console.error('Uso: node src/db/cargar-libro.js <ruta-al-.xlsx> [DD/MM/AAAA]');
    process.exitCode = 1;
    return;
  }

  let fecha = null;
  if (fechaTxt) {
    fecha = parseVencimiento(fechaTxt);
    if (!fecha) {
      console.error(`Fecha inválida: "${fechaTxt}". Usá DD/MM/AAAA.`);
      process.exitCode = 1;
      return;
    }
  }

  let buffer;
  try {
    buffer = fs.readFileSync(path.resolve(file));
  } catch (err) {
    console.error(`No pude leer ${file}:`, err.message);
    process.exitCode = 1;
    return;
  }

  try {
    const res = await registrarLibro({
      buffer,
      nombreArchivo: path.basename(file),
      fecha,
      usuarioId: null, // lo cargó un proceso, no una persona
    });
    console.log(
      `Libro cargado — jornada ${formatoVencimiento(res.jornada)} | ` +
      `export ${formatoVencimiento(res.desde)}→${formatoVencimiento(res.hasta)} | ` +
      `${res.filas} movimientos en ${res.dias} día(s)` +
      (res.yaHabia ? ' | REEMPLAZÓ al que ya estaba' : '')
    );
  } catch (err) {
    // LibroError = el Excel no tiene la forma esperada (mensaje claro). Otro error = bug.
    console.error(err instanceof LibroError ? `Excel inválido: ${err.message}` : err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
