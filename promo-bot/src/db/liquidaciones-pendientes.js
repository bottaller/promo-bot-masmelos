// Acceso a las LIQUIDACIONES DE PLATAFORMA en espera (bot.liquidaciones_pendientes, migración 022).
// El admin las sube de noche con /carga; el barrido de las 08:00 (entrega-arqueo.js) las cruza
// contra el libro y las borra. Son efímeras: lo que queda archivado es el RESULTADO del arqueo
// (bot.mp_conciliacion), no el archivo. Mismo patrón que db/libro.js.
//
// OJO con el bytea (~50-150 KB): las consultas de metadata NO lo traen; solo liquidacionesDeDia()
// baja el archivo, y únicamente cuando el barrido lo va a conciliar.
const { pool } = require('./pool');
const { fechaISO } = require('../lib/fechas');

// Columnas de metadata (todo menos el archivo).
const META = 'fecha, empresa, plataforma, nombre_archivo, bytes, n_operaciones, cargado_por, cargado_en';

// Guarda (upsert) la liquidación de una plataforma para un día. Re-subirla la PISA.
async function guardarLiquidacion({ fecha, empresa = 'HONRE', plataforma, archivo, nombreArchivo, nOperaciones, usuarioId }) {
  const { rows } = await pool.query(
    `insert into bot.liquidaciones_pendientes
       (fecha, empresa, plataforma, archivo, nombre_archivo, bytes, n_operaciones, cargado_por)
     values ($1::date, $2, $3, $4, $5, $6, $7, $8)
     on conflict (fecha, empresa, plataforma) do update set
       archivo = excluded.archivo, nombre_archivo = excluded.nombre_archivo,
       bytes = excluded.bytes, n_operaciones = excluded.n_operaciones,
       cargado_por = excluded.cargado_por, cargado_en = now()
     returning ${META}`,
    [fechaISO(fecha), empresa, plataforma, archivo, nombreArchivo || '',
     archivo ? archivo.length : 0, nOperaciones || 0, usuarioId ?? null]
  );
  return rows[0];
}

// Qué plataformas hay en espera para un día (metadata, sin bytea). Para el recordatorio y el
// mensaje de /carga ("ya tengo MP, falta Talo"). Devuelve ['mp', 'talo', ...].
async function plataformasPendientesDe({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    'select plataforma from bot.liquidaciones_pendientes where fecha = $1::date and empresa = $2 order by plataforma',
    [fechaISO(fecha), empresa]
  );
  return rows.map((r) => r.plataforma);
}

// Días con liquidaciones en espera (distinct), para que el barrido de las 08:00 sepa qué procesar.
// Devuelve [{ fecha (Date), plataformas: ['mp','talo'] }] ordenado por fecha.
async function diasPendientes({ empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select fecha, array_agg(plataforma order by plataforma) as plataformas
       from bot.liquidaciones_pendientes where empresa = $1
      group by fecha order by fecha`,
    [empresa]
  );
  return rows.map((r) => ({ fecha: r.fecha, plataformas: r.plataformas }));
}

// Las liquidaciones (CON el archivo crudo) de un día, para que el barrido las concilie.
// Devuelve [{ plataforma, archivo (Buffer), nombre_archivo }].
async function liquidacionesDeDia({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select plataforma, archivo, nombre_archivo
       from bot.liquidaciones_pendientes where fecha = $1::date and empresa = $2 order by plataforma`,
    [fechaISO(fecha), empresa]
  );
  return rows;
}

// Borra las liquidaciones de un día (después de conciliarlo). El resultado ya quedó en
// bot.mp_conciliacion, así que el crudo no hace falta más.
async function borrarLiquidacionesDe({ fecha, empresa = 'HONRE' }) {
  await pool.query(
    'delete from bot.liquidaciones_pendientes where fecha = $1::date and empresa = $2',
    [fechaISO(fecha), empresa]
  );
}

module.exports = {
  guardarLiquidacion, plataformasPendientesDe, diasPendientes,
  liquidacionesDeDia, borrarLiquidacionesDe,
};
