// Acceso a datos del LIBRO DIARIO centralizado (bot.libro_diario, migración 016).
// El admin lo carga una vez por día (/libro) y todos los comandos lo consumen, en vez de
// pedirle el mismo Excel al usuario una y otra vez.
//
// OJO con el bytea: el archivo pesa ~280 KB. Las consultas de metadata NO lo traen (columnas
// explícitas); solo `archivoLibro()` lo baja, y únicamente cuando alguien necesita el .xlsx
// en sí (/flujos, /mp). Traerlo de más en cada chequeo sería tirar ancho de banda a la basura.
const { pool } = require('./pool');
const { fechaISO } = require('../lib/fechas');

// Columnas de metadata (todo menos el archivo).
const META = 'fecha, empresa, nombre_archivo, bytes, desde, hasta, filas, cargado_por, cargado_en';

// Guarda (upsert) el libro de una jornada. Re-subirlo la PISA: así se corrige un export
// incompleto sin duplicar. `archivo` es el Buffer del .xlsx tal cual lo mandó Sigma.
async function guardarLibro({ fecha, empresa = 'HONRE', archivo, nombreArchivo, desde, hasta, filas, usuarioId }) {
  const fISO = fechaISO(fecha);
  const { rows } = await pool.query(
    `insert into bot.libro_diario
       (fecha, empresa, archivo, nombre_archivo, bytes, desde, hasta, filas, cargado_por)
     values ($1::date, $2, $3, $4, $5, $6::date, $7::date, $8, $9)
     on conflict (fecha, empresa) do update set
       archivo = excluded.archivo, nombre_archivo = excluded.nombre_archivo,
       bytes = excluded.bytes, desde = excluded.desde, hasta = excluded.hasta,
       filas = excluded.filas, cargado_por = excluded.cargado_por, cargado_en = now()
     returning ${META}`,
    [fISO, empresa, archivo, nombreArchivo || '', archivo ? archivo.length : 0,
     fechaISO(desde), fechaISO(hasta), filas || 0, usuarioId ?? null]
  );
  return rows[0];
}

// Metadata del libro de una jornada exacta (sin el archivo). null si no está cargado.
async function metaLibro({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select ${META} from bot.libro_diario where fecha = $1::date and empresa = $2`,
    [fechaISO(fecha), empresa]
  );
  return rows[0] || null;
}

// ¿Está cargado el libro de esa jornada? (barato: no toca el bytea)
async function hayLibro({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    'select 1 from bot.libro_diario where fecha = $1::date and empresa = $2',
    [fechaISO(fecha), empresa]
  );
  return rows.length > 0;
}

// El .xlsx crudo de una jornada, para quien necesita el archivo y no los datos
// (/flujos se lo pasa al motor Python; /mp lo parsea con su propio parser).
// Devuelve { archivo (Buffer), nombre_archivo, fecha } o null.
async function archivoLibro({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    'select archivo, nombre_archivo, fecha from bot.libro_diario where fecha = $1::date and empresa = $2',
    [fechaISO(fecha), empresa]
  );
  return rows[0] || null;
}

// El libro cuyo RANGO cubre esa fecha. El export de Sigma suele abarcar varios días
// (13→17), así que el libro cargado como jornada del 17 igual sirve para consultar el 15.
// Desempate cuando varios la cubren:
//   1º una coincidencia EXACTA de jornada (fecha = el día pedido), y
//   2º entre las que quedan, la CARGADA más recientemente (el dato más fresco).
// El orden viejo (fecha desc = la jornada más alta) rompía el camino de corrección: si el 21 se
// re-exporta y re-sube SOLO el 15 con un asiento que faltaba, ese libro (jornada 15) perdía
// contra el export ancho viejo (jornada 17 que también cubre el 15), y se conciliaba contra el
// dato desactualizado. cargado_en desc es lo que "gana el más fresco" quería decir de verdad.
async function libroQueCubre({ fecha, empresa = 'HONRE' }) {
  const fISO = fechaISO(fecha);
  const { rows } = await pool.query(
    `select ${META} from bot.libro_diario
      where empresa = $1 and desde <= $2::date and hasta >= $2::date
      order by (fecha = $2::date) desc, cargado_en desc limit 1`,
    [empresa, fISO]
  );
  return rows[0] || null;
}

// ¿Algún libro CUBRE esa fecha? Distinto de hayLibro(), que exige que sea la jornada exacta:
// si el martes se sube un export que abarca lunes+martes, el lunes está cubierto aunque su
// jornada registrada sea el martes. Para "¿tengo los datos de ese día?" se usa ESTA.
async function cubreFecha({ fecha, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    'select 1 from bot.libro_diario where empresa = $1 and $2::date between desde and hasta limit 1',
    [empresa, fechaISO(fecha)]
  );
  return rows.length > 0;
}

// Días de un rango que NO quedaron cubiertos por ningún libro. Sirve para avisar los huecos
// ("cargaste el martes, pero no tengo el lunes"). Devuelve ['AAAA-MM-DD', ...] ordenado.
// Incluye findes y feriados: quien lo llama decide si son huecos reales o días sin operación.
async function diasSinLibro({ desde, hasta, empresa = 'HONRE' }) {
  const { rows } = await pool.query(
    `select to_char(d, 'YYYY-MM-DD') as dia
       from generate_series($2::date, $3::date, interval '1 day') d
      where not exists (
        select 1 from bot.libro_diario l
         where l.empresa = $1 and d::date between l.desde and l.hasta)
      order by d`,
    [empresa, fechaISO(desde), fechaISO(hasta)]
  );
  return rows.map((r) => r.dia);
}

// El último libro cargado (para avisar "tengo el del 17" cuando falta el de hoy).
async function ultimoLibro({ empresa = 'HONRE' } = {}) {
  const { rows } = await pool.query(
    `select ${META} from bot.libro_diario where empresa = $1 order by fecha desc limit 1`,
    [empresa]
  );
  return rows[0] || null;
}

module.exports = {
  guardarLibro, metaLibro, hayLibro, archivoLibro, libroQueCubre,
  cubreFecha, diasSinLibro, ultimoLibro,
};
