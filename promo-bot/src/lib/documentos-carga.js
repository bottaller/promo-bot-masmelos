// Los tipos de documento que entiende /carga, con su detección, su procesamiento
// y QUIÉN puede subir cada uno.
//
// Mismo espíritu que plataformas.js: sumar un documento nuevo es agregar una
// entrada acá más su parser, sin tocar el wizard.
//
// EL ORDEN IMPORTA. Se prueban de arriba hacia abajo y el LIBRO va último porque
// es el catch-all: no se reconoce por encabezados sino intentando parsearlo. Si
// un documento nuevo se pusiera después del libro, nunca llegaría a su turno.
//
// EL PERMISO VIAJA CON EL DOCUMENTO, no con el comando. /carga lo abre cualquiera
// que pueda subir al menos un tipo, y recién al reconocer el archivo se decide si
// esa persona puede. Así el de Retiros sube su planilla sin que se le abran el
// libro diario ni las liquidaciones, que son data financiera. Y como el área está
// declarada al lado del parser, agregar un documento sin protegerlo no se olvida.
const { detectarPlataforma, plataformasManuales } = require('./plataformas');
const { diaDeLiquidacion } = require('./arqueo');
const { registrarLibro, LibroError } = require('./registrar-libro');
const { guardarLiquidacion } = require('../db/liquidaciones-pendientes');
const { parsearRetiros, esPlanillaRetiros, RetirosError } = require('./retiros-excel');
const { registrarRetiros } = require('../db/retiros');
const { formatoVencimiento } = require('./fechas');
const { AREAS_SIN_BYPASS_SISTEMAS } = require('../middleware/authz');

function isoADate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function isoALinda(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
function kb(bytes) {
  return `${Math.round((bytes || 0) / 1024)} KB`;
}

// Error de negocio de un documento reconocido pero que no se puede procesar
// (ej. una liquidación que abarca varios días). Se le muestra al usuario tal cual.
class DocumentoInvalido extends Error {}

const DOCUMENTOS = [
  // ── Liquidaciones de las plataformas de cobro (Tesorería) ─────────────────
  {
    codigo: 'liquidacion',
    nombre: 'Liquidación de plataforma',
    // Se listan una por una en el mensaje de bienvenida, con el archivo que espera cada
    // plataforma. Es una sola entrada del registro pero varias líneas en el menú: Mercado Pago,
    // Santander y Supervielle llegan por acá.
    etiquetas: () => plataformasManuales().map((p) => `<b>${p.nombre}</b> (${p.archivoEsperado})`),
    soloAdmin: true,
    nocturno: true,
    detectar: (buffer) => !!detectarPlataforma(buffer),
    async procesar({ buffer, nombreArchivo, usuarioId }) {
      const plataforma = detectarPlataforma(buffer);
      let liq;
      try {
        liq = plataforma.parsear(buffer);
      } catch (e) {
        if (e instanceof plataforma.Error) throw new DocumentoInvalido(`${plataforma.nombre}: ${e.message}`);
        throw e;
      }
      const dia = diaDeLiquidacion(liq);
      if (!dia) {
        throw new DocumentoInvalido(
          `Esa liquidación de ${plataforma.nombre} abarca varios días. Mandame una por día para poder arquearla contra su libro.`
        );
      }
      await guardarLiquidacion({
        fecha: isoADate(dia), plataforma: plataforma.codigo, archivo: buffer,
        nombreArchivo, nOperaciones: liq.operaciones.length, usuarioId,
      });
      return {
        dias: [dia],
        mensaje:
          `✅ <b>${plataforma.nombre}</b>: ${liq.operaciones.length} operación(es) del <b>${isoALinda(dia)}</b>, ` +
          'en espera para el arqueo de las 08:00.',
      };
    },
  },

  // ── Planilla de retiros (área Retiros) → pantalla /tv_recepcion ───────────
  {
    codigo: 'retiros',
    nombre: 'Planilla de retiros',
    etiquetas: () => ['<b>Planilla de retiros</b> (la que alimenta la pantalla de recepción)'],
    area: 'retiros',
    nocturno: false, // se sube durante el día, no entra en el reclamo del arqueo
    detectar: (buffer) => esPlanillaRetiros(buffer),
    async procesar({ buffer }) {
      let leido;
      try {
        leido = parsearRetiros(buffer);
      } catch (e) {
        if (e instanceof RetirosError) throw new DocumentoInvalido(e.message);
        throw e;
      }
      // Una planilla que no aporta NINGUN turno de hoy en adelante casi siempre es
      // un archivo viejo mandado por error (hay dos .xlsx con el mismo nombre base
      // dando vueltas). Se corta acá, antes de tocar la base: así no se pisa nada y
      // la persona se entera de por qué en vez de ver un éxito engañoso.
      if (!leido.filas.length) {
        const dias = leido.diasVistos.length
          ? ` Tiene armados los días ${leido.diasVistos.slice(0, 3).map(isoALinda).join(', ')}, pero sin ningún pedido cargado.`
          : '';
        throw new DocumentoInvalido(
          '⚠️ Esa planilla no trae ningún turno de hoy en adelante, así que <b>no toqué nada</b>.' + dias +
          '\n\n¿No será una versión vieja del archivo? Fijate la fecha de modificación y mandame la última.'
        );
      }

      const { porDia, borrados, conservados } = await registrarRetiros({
        filas: leido.filas,
        diasVistos: leido.diasVistos,
      });

      const lineas = ['✅ <b>Planilla de retiros</b> actualizada.'];
      if (!porDia.length) {
        lineas.push('', 'No hay ningún turno cargado de hoy en adelante.');
      } else {
        for (const d of porDia) {
          const detalle = [];
          if (d.listos) detalle.push(`${d.listos} listo(s)`);
          if (d.preparando) detalle.push(`${d.preparando} en preparación`);
          if (d.sin_estado) detalle.push(`${d.sin_estado} sin estado`);
          if (d.retirados) detalle.push(`${d.retirados} ya retirado(s)`);
          lineas.push(`📅 <b>${isoALinda(d.fecha)}</b>: ${d.total} pedido(s)${detalle.length ? ' — ' + detalle.join(', ') : ''}`);
        }
      }
      if (borrados) lineas.push('', `🗑 Saqué ${borrados} pedido(s) que ya no están en la planilla.`);
      // Los que desaparecieron del Excel pero YA estaban marcados no se borran solos:
      // que un pedido marcado listo se esfume del archivo es raro y lo tiene que
      // mirar una persona. Se listan con nombre para que se pueda ir a buscarlos.
      if (conservados && conservados.length) {
        lineas.push('', `❗ ${conservados.length} pedido(s) ya no están en la planilla pero <b>ya estaban marcados</b>, así que los dejé:`);
        for (const c of conservados.slice(0, 6)) {
          const marca = c.prep === 'listo' ? 'listo' : (c.estado_final === 'retirado' ? 'retirado' : (c.prep || 'marcado'));
          lineas.push(`   • ${isoALinda(c.fecha)} ${c.turno} — ${c.cliente || c.codigo_cliente} (${marca})`);
        }
        if (conservados.length > 6) lineas.push(`   …y ${conservados.length - 6} más.`);
        lineas.push('<i>Si de verdad se dieron de baja, sacalos desde el panel.</i>');
      }
      const fuera = leido.descartados;
      const omitidos = [];
      if (fuera.reparto) omitidos.push(`${fuera.reparto} de reparto en camión`);
      if (fuera.cancelados) omitidos.push(`${fuera.cancelados} cancelado(s) o reprogramado(s)`);
      if (omitidos.length) lineas.push(`ℹ️ No van a la pantalla: ${omitidos.join(', ')}.`);
      // Las anomalías son cosas raras de la planilla que conviene que alguien mire.
      for (const a of leido.anomalias.slice(0, 5)) lineas.push(`⚠️ ${a}`);
      if (leido.anomalias.length > 5) lineas.push(`⚠️ …y ${leido.anomalias.length - 5} aviso(s) más.`);

      return { dias: leido.dias, mensaje: lineas.join('\n') };
    },
  },

  // ── Libro diario de Sigma (Tesorería) — CATCH-ALL, va último ──────────────
  {
    codigo: 'libro',
    nombre: 'Libro diario',
    etiquetas: () => ['<b>Libro diario</b> (Diario de movimientos de Sigma)'],
    soloAdmin: true,
    nocturno: true,
    // Es el ULTIMO y dice que si a cualquier cosa (ver `detectar` abajo). Por eso se
    // marca: un archivo que llega hasta acá no fue "reconocido como libro", sino
    // "no reconocido como nada". Sin esta marca, a alguien de Retiros que manda un
    // archivo equivocado el bot le contestaba que habia mandado el libro diario y
    // que no tenia permiso para subirlo, que es doblemente confuso.
    catchAll: true,
    // No se reconoce por encabezados: si no fue ninguno de los anteriores, se
    // intenta parsear como libro y registrarLibro decide.
    detectar: () => true,
    async procesar({ buffer, nombreArchivo, usuarioId }) {
      let res;
      try {
        res = await registrarLibro({ buffer, nombreArchivo, usuarioId });
      } catch (e) {
        if (e instanceof LibroError) throw new LibroError(e.message); // el wizard lo trata como "no reconocido"
        throw e;
      }
      const rango = formatoVencimiento(res.desde) === formatoVencimiento(res.hasta)
        ? formatoVencimiento(res.desde)
        : `${formatoVencimiento(res.desde)} al ${formatoVencimiento(res.hasta)}`;
      const partes = [
        `✅ <b>Libro</b> cargado — jornada <b>${formatoVencimiento(res.jornada)}</b> (${res.filas} mov. · ${kb(buffer.length)}).`,
        `📅 Trae del: ${rango}`,
      ];
      if (res.yaHabia) partes.push(`⚠️ Reemplacé el libro que ya estaba de esa jornada (tenía ${res.previo.filas} mov.).`);
      if (res.huecos && res.huecos.length) {
        partes.push(`📭 Días sin libro en la semana: <b>${res.huecos.map((iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`).join(', ')}</b> <i>(ignorá los feriados)</i>`);
      }
      const jornada = res.jornada instanceof Date
        ? `${res.jornada.getFullYear()}-${String(res.jornada.getMonth() + 1).padStart(2, '0')}-${String(res.jornada.getDate()).padStart(2, '0')}`
        : String(res.jornada).slice(0, 10);
      return { dias: [jornada], mensaje: partes.join('\n'), huboLibro: true };
    },
  },
];

/**
 * ¿Este usuario puede subir este tipo de documento?
 * Mismo criterio que middleware/authz: admin real pasa siempre; "sistemas" pasa
 * salvo en las áreas excluidas; el resto necesita el área declarada.
 */
function puedeSubir(usuario, doc) {
  if (!usuario) return false;
  if (usuario.es_admin) return true;
  if (doc.soloAdmin) return false; // "sistemas" no alcanza para el libro ni las liquidaciones
  if (!doc.area) return false;
  const areas = usuario.areas || [];
  if (areas.includes(doc.area)) return true;
  return !AREAS_SIN_BYPASS_SISTEMAS.includes(doc.area) && areas.includes('sistemas');
}

/** Documentos que este usuario puede subir (para armar el mensaje de bienvenida). */
function documentosDe(usuario) {
  return DOCUMENTOS.filter((d) => puedeSubir(usuario, d));
}

/** ¿Tiene sentido que este usuario entre a /carga? */
function puedeUsarCarga(usuario) {
  return documentosDe(usuario).length > 0;
}

/**
 * Middleware de entrada a /carga. No es un permiso fino: solo corta a quien no puede subir
 * NINGÚN tipo de documento. Lo que decide de verdad es puedeSubir(), ya con el archivo
 * reconocido — así el mismo comando sirve a Tesorería y a Retiros sin mezclar accesos.
 */
function puertaDeCarga() {
  return async (ctx, next) => {
    if (puedeUsarCarga(ctx.state.usuario)) return next();
    await ctx.reply('No tenés ningún documento para cargar.');
  };
}

/** El primer tipo de documento cuya detección da positivo. Nunca es null: el libro es el catch-all. */
function detectarDocumento(buffer) {
  return DOCUMENTOS.find((d) => {
    try {
      return d.detectar(buffer);
    } catch {
      return false; // un detector que revienta no debe tumbar la carga entera
    }
  });
}

module.exports = {
  DOCUMENTOS, DocumentoInvalido,
  puedeSubir, documentosDe, puedeUsarCarga, puertaDeCarga, detectarDocumento,
  isoALinda,
};
