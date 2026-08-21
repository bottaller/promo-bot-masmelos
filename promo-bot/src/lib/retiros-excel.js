// Parser de la PLANILLA RETIRA (turnos de retiro de pedidos en Moreno). Alimenta
// la pantalla /tv_recepcion del sitio.
//
// FORMA DE LA PLANILLA (verificada contra el archivo real de julio/agosto 2026):
//  - Una hoja por mes ("JULIO", "AGOSTO"), más hojas sueltas que se ignoran solas.
//  - Dentro de cada hoja, BLOQUES DE 17 FILAS: 1 encabezado + 16 turnos fijos de
//    09:00 a 16:30 cada media hora. Un bloque = un día.
//  - La fecha del día vive en una CELDA COMBINADA de la columna "FECHA Retiro"
//    (I19:I34, etc.), así que solo la trae la primera fila del bloque: hay que
//    buscarla hacia abajo.
//  - La fecha es TEXTO en castellano y sin tildes: "MIERCOLES 12 DE AGOSTO DE 2026".
//
// LO QUE HAY QUE TOLERAR (todo esto está en el archivo real):
//  - Mayúsculas inconsistentes: "Preparado" y "PREPARADO", "si" y "SI".
//  - ESTADO vacío significa "todavía no se retiró", no "no está listo".
//  - El N° de orden a veces trae dos juntos, con tres separadores distintos:
//    "2653776-2653773", "2653898 / 2653942", "2653996/*2654280".
//  - "N° de PEDIDO" va del 1 al 16 DENTRO del día: no identifica nada entre días.
//    La clave real del renglón es (fecha, turno).
//  - Filas que no son pedidos: el depósito escribe marcas propias en la columna
//    CLIENTE (aparece "CORTE" sin código). Sin código de cliente no es un pedido.
//
// QUÉ NO VA A LA PANTALLA:
//  - Cancelado y Reprogramado.
//  - FORMA DE ENTREGA que diga "reparto" (van en camión, no los retira nadie).
//    Ojo que "RETIRA FACU CACERES" SÍ es un retiro y se queda.
const XLSX = require('xlsx');
const { fechaHoyArgISO } = require('./fechas');

class RetirosError extends Error {}

const MESES = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6, JULIO: 7,
  AGOSTO: 8, SEPTIEMBRE: 9, SETIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
};

function sinAcentos(s) {
  return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}
// Para comparar encabezados y valores: sin acentos, sin ° ni espacios de más, en minúscula.
function norm(v) {
  return sinAcentos(v).replace(/[°º]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function txt(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// Encabezados que hacen inconfundible a esta planilla. Con 3 de 4 alcanza: así el
// reconocimiento en /carga no se rompe si mañana renombran una columna.
const FIRMA = ['fecha de registro de pedido', 'n de pedido', 'codigo del cliente', 'horario de retiro del pedido'];

function esFilaEncabezado(fila) {
  return norm(fila && fila[0]).startsWith('fecha de registro');
}

/** ¿Este .xlsx es la planilla de retiros? Solo mira encabezados: no escribe nada. */
function esPlanillaRetiros(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', sheetRows: 6 });
  } catch {
    return false;
  }
  for (const nombre of wb.SheetNames) {
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, raw: true, blankrows: false });
    for (const fila of filas.slice(0, 6)) {
      const junta = (fila || []).map(norm).join(' | ');
      if (FIRMA.filter((f) => junta.includes(f)).length >= 3) return true;
    }
  }
  return false;
}

// Índices de columna leídos del encabezado del bloque, no fijos por posición: la
// hoja de julio tiene 19 columnas y la de agosto 17, y las dos últimas (FORMA DE
// ENTREGA, OBSERVACION) no existen en todos los meses.
function mapearColumnas(fila) {
  const col = {};
  (fila || []).forEach((celda, i) => {
    const h = norm(celda);
    if (!h) return;
    if (/^n de pedido$/.test(h)) col.nPedido = i;
    else if (/orden de pedido/.test(h)) col.ordenes = i;
    else if (/codigo del cliente/.test(h)) col.codigo = i;
    else if (/^cliente$/.test(h)) col.cliente = i;
    else if (/^vendedor$/.test(h)) col.vendedor = i;
    else if (/fecha retiro/.test(h)) col.fechaRetiro = i;
    else if (/horario de retiro/.test(h)) col.turno = i;
    else if (/bultos/.test(h)) col.bultos = i;
    else if (/status de preparacion/.test(h)) col.prep = i;
    else if (/^estado$/.test(h)) col.estado = i;
    else if (/forma de entrega/.test(h)) col.entrega = i;
  });
  return col;
}

/** "MIERCOLES 12 DE AGOSTO DE 2026" → "2026-08-12" (o null si no se entiende). */
function parsearFechaEs(valor) {
  const m = sinAcentos(valor).toUpperCase().match(/(\d{1,2})\s+DE\s+([A-Z]+)\s+DE\s+(\d{4})/);
  if (!m) return null;
  const mes = MESES[m[2]];
  if (!mes) return null;
  const dia = Number(m[1]);
  if (dia < 1 || dia > 31) return null;
  return `${m[3]}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** El turno puede venir como fracción de día (0.375), como Date o como texto. */
function parsearTurno(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number' && isFinite(valor)) {
    const minutos = Math.round((valor % 1) * 24 * 60);
    return `${String(Math.floor(minutos / 60) % 24).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
  }
  if (valor instanceof Date && !isNaN(valor)) {
    return `${String(valor.getHours()).padStart(2, '0')}:${String(valor.getMinutes()).padStart(2, '0')}`;
  }
  const m = String(valor).trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : null;
}

/** "2653996/*2654280" → ["2653996", "2654280"]. Separadores: - / * , y espacios. */
function parsearOrdenes(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .split(/[\-/*,\s]+/)
    .map((t) => t.trim())
    .filter((t) => /^\d{4,}$/.test(t));
}

/** "battaglia (moron)" → "Battaglia (Moron)". Los nombres vienen de cualquier forma. */
function tituloNombre(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(^|[\s.\-/(])([a-záéíóúñü])/g, (_, p, c) => p + c.toUpperCase());
}

const PREP = {
  'preparado': 'listo',
  'en preparacion': 'preparando',
  'pendiente': 'agendado',
  'con faltante': 'faltante',
};
// Cancelado y Reprogramado no se importan: 'excluir' los saca de la pantalla.
const FINAL = {
  'retirado': 'retirado',
  'demorado': 'demorado',
  'pendiente de retiro': null,
  'cancelado': 'excluir',
  'reprogramado': 'excluir',
};

/**
 * Lee la planilla completa y devuelve los turnos de `desde` en adelante.
 *
 * `dias` son los días que traen pedidos. `diasVistos` son TODOS los días que la
 * planilla tiene armados de `desde` en adelante, incluso los que quedaron vacíos:
 * los necesita quien guarda para poder borrar un pedido que se dio de baja. Sin
 * eso, un día que se vacía dejaría el pedido viejo colgado en la pantalla.
 *
 * @param {Buffer} buffer      el .xlsx
 * @param {string} [opts.desde] ISO 'AAAA-MM-DD'; por defecto hoy en Argentina.
 * @returns {{filas: Array, dias: string[], diasVistos: string[], anomalias: string[], descartados: object}}
 */
function parsearRetiros(buffer, opts = {}) {
  const desde = opts.desde || fechaHoyArgISO();

  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  } catch (e) {
    throw new RetirosError(`No pude abrir el archivo (${e.message}).`);
  }

  const filas = [];
  const anomalias = [];
  const vistos = new Set();
  const descartados = { pasados: 0, cancelados: 0, reparto: 0, sinCodigo: 0 };
  let bloques = 0;

  for (const nombreHoja of wb.SheetNames) {
    const hoja = XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], { header: 1, raw: true, blankrows: true });

    for (let i = 0; i < hoja.length; i++) {
      if (!esFilaEncabezado(hoja[i])) continue;
      bloques++;

      const col = mapearColumnas(hoja[i]);
      if (col.codigo === undefined || col.turno === undefined) {
        anomalias.push(`${nombreHoja}: un bloque no tiene las columnas de código y horario.`);
        continue;
      }

      // El cuerpo del día llega hasta el encabezado del día siguiente, NO hasta una
      // ventana fija de 16. La planilla tiene 16 turnos armados, pero el depósito
      // inserta filas cuando entra un pedido de más — y con el corte fijo esas
      // filas se perdían EN SILENCIO. Estaba pasando: en la planilla de agosto hay
      // un bloque de 17 y el cliente 41163 de las 16:30 nunca llegaba a la pantalla.
      //
      // Sin tope: el último día de la hoja llega hasta el final. Un tope acá volvía
      // a perder filas justo en ese bloque, que es donde el depósito agrega los
      // pedidos del día en curso. Lo que sobre no molesta: más abajo cada fila
      // necesita código de cliente Y horario para entrar, así que los renglones
      // vacíos del final de la hoja se descartan solos.
      let fin = hoja.length;
      for (let j = i + 1; j < hoja.length; j++) {
        if (esFilaEncabezado(hoja[j])) { fin = j; break; }
      }
      const cuerpo = hoja.slice(i + 1, fin);

      // La fecha vive en una celda combinada: solo la trae la primera fila.
      let fecha = null;
      for (const fila of cuerpo) {
        const crudo = txt(fila && fila[col.fechaRetiro]);
        if (crudo) { fecha = parsearFechaEs(crudo); break; }
      }
      if (!fecha) {
        const tieneDatos = cuerpo.some((f) => txt(f && f[col.codigo]));
        if (tieneDatos) anomalias.push(`${nombreHoja}: hay un día con pedidos cuya fecha no pude leer.`);
        continue;
      }
      // El día existe en la planilla aunque hoy esté vacío: se registra igual para
      // que quien guarda pueda borrar un pedido dado de baja.
      if (fecha >= desde) vistos.add(fecha);

      for (const fila of cuerpo) {
        if (!fila) continue;
        const codigo = txt(fila[col.codigo]);
        // Sin código no es un pedido: son las marcas que escribe el depósito ("CORTE").
        if (!codigo) {
          if (txt(fila[col.cliente])) descartados.sinCodigo++;
          continue;
        }
        if (fecha < desde) { descartados.pasados++; continue; }

        const prepCrudo = txt(fila[col.prep]);
        const estadoCrudo = txt(fila[col.estado]);
        const entrega = norm(fila[col.entrega]);

        const prep = prepCrudo ? PREP[norm(prepCrudo)] : null;
        if (prepCrudo && prep === undefined) {
          anomalias.push(`${nombreHoja} · ${fecha}: no conozco el estado de preparación "${prepCrudo}".`);
        }
        const final = estadoCrudo ? FINAL[norm(estadoCrudo)] : null;
        if (estadoCrudo && final === undefined) {
          anomalias.push(`${nombreHoja} · ${fecha}: no conozco el estado "${estadoCrudo}".`);
        }

        if (final === 'excluir') { descartados.cancelados++; continue; }
        if (entrega.includes('reparto')) { descartados.reparto++; continue; }

        const turno = parsearTurno(fila[col.turno]);
        if (!turno) {
          anomalias.push(`${nombreHoja} · ${fecha}: el cliente ${codigo} no tiene horario de retiro.`);
          continue;
        }

        const bultos = Number(txt(fila[col.bultos]));
        const nPedido = Number(txt(fila[col.nPedido]));

        filas.push({
          fecha,
          turno,
          codigo_cliente: codigo,
          cliente: tituloNombre(fila[col.cliente]) || null,
          n_pedido: Number.isInteger(nPedido) && nPedido > 0 ? nPedido : null,
          ordenes: parsearOrdenes(fila[col.ordenes]),
          canal: norm(fila[col.vendedor]) === 'web' ? 'web' : 'programado',
          bultos: Number.isFinite(bultos) && bultos > 0 ? Math.round(bultos) : null,
          prep: prep || null,
          estado_final: final || null,
        });
      }
    }
  }

  if (!bloques) {
    throw new RetirosError('No encontré ningún día cargado. ¿Es la planilla de retiros?');
  }

  // (fecha, turno) es la clave del renglón. Si la planilla trae dos pedidos en el
  // mismo turno gana el último, pero hay que avisarlo: significa que alguien pisó
  // un renglón y uno de los dos pedidos no va a aparecer en la pantalla.
  const porTurno = new Map();
  for (const f of filas) {
    const clave = `${f.fecha} ${f.turno}`;
    if (porTurno.has(clave)) {
      anomalias.push(`${f.fecha} ${f.turno}: hay dos pedidos en el mismo turno (${porTurno.get(clave).codigo_cliente} y ${f.codigo_cliente}). Dejo el segundo.`);
    }
    porTurno.set(clave, f);
  }

  const unicas = [...porTurno.values()].sort((a, b) => (a.fecha + a.turno).localeCompare(b.fecha + b.turno));
  const dias = [...new Set(unicas.map((f) => f.fecha))].sort();

  return { filas: unicas, dias, diasVistos: [...vistos].sort(), anomalias, descartados };
}

module.exports = {
  parsearRetiros,
  esPlanillaRetiros,
  RetirosError,
  // exportados para los tests
  parsearFechaEs,
  parsearTurno,
  parsearOrdenes,
  tituloNombre,
};
