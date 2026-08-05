// Wizard /falta (áreas Ventas y Depósito): avisar que un producto falta o queda poco. El que
// reporta escribe código interno, código de barras o nombre -> se resuelve contra el maestro
// (bot.articulos, el mismo buscarArticulos que usa /alta). Se guarda en bot.faltantes; Compras
// lo baja consolidado con /faltantes. Molde: scenes/informe.js.
const { Scenes } = require('telegraf');
const { buscarArticulos } = require('../db/articulos');
const { registrarFaltante } = require('../db/faltantes');
const { respuesta, esCancelar, opciones, preguntar, SI_NO } = require('../lib/wizard');

const SITUACIONES = { falta: 'No hay (falta)', poco: 'Queda poco', vende_mucho: 'Se vende mucho' };
const MAX_CANDIDATOS = 6;

function esSi(v) {
  const s = String(v).toLowerCase();
  return s === 'si' || s === 'sí';
}

async function cancelar(ctx) {
  await ctx.reply('Reporte cancelado.');
  return ctx.scene.leave();
}

// Producto ya decidido (del maestro o texto libre) -> pasar a preguntar la situación.
async function pedirSituacion(ctx) {
  await preguntar(
    ctx,
    `¿Qué pasa con ${ctx.wizard.state.data.productoTexto}?`,
    opciones([
      ['No hay (falta)', 'falta'],
      ['Queda poco', 'poco'],
      ['Se vende mucho', 'vende_mucho'],
    ])
  );
  return ctx.wizard.next();
}

async function elegirDelMaestro(ctx, art) {
  ctx.wizard.state.data.articuloCodigo = art.codigo;
  ctx.wizard.state.data.productoTexto = art.nombre || art.codigo;
  return pedirSituacion(ctx);
}

async function elegirTextoLibre(ctx, texto) {
  ctx.wizard.state.data.articuloCodigo = null;
  ctx.wizard.state.data.productoTexto = texto;
  return pedirSituacion(ctx);
}

function resumen(d) {
  const cod = d.articuloCodigo ? ` (${d.articuloCodigo})` : '';
  return (
    'Confirmá el reporte:\n\n' +
    `Producto: ${d.productoTexto}${cod}\n` +
    `Situación: ${SITUACIONES[d.situacion]}\n` +
    `Nota: ${d.nota || '—'}\n\n` +
    '¿Lo mando a Compras?'
  );
}

const faltaWizard = new Scenes.WizardScene(
  'falta-wizard',
  // 0: pedir el producto
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      'Reportar faltante.\n\n' +
      '¿Qué producto falta o queda poco? Escribí el código interno, el código de barras o el nombre. (o "cancelar")'
    );
    return ctx.wizard.next();
  },
  // 1: resolver el producto contra el maestro (busca / confirma / elige / texto libre)
  async (ctx) => {
    const r = await respuesta(ctx);
    if (r === null) return; // botón viejo / no-texto: seguir esperando
    if (esCancelar(r)) return cancelar(ctx);
    const st = ctx.wizard.state;

    // Preguntamos "¿es este?" y contestó Sí/No.
    if (st.fase === 'confirmar') {
      if (esSi(r)) return elegirDelMaestro(ctx, st.candidato);
      st.fase = 'buscar';
      await ctx.reply('Dale, escribilo de nuevo (código, código de barras o nombre):');
      return;
    }

    // Le mostramos una lista y tocó un candidato (o "ninguno").
    if (st.fase === 'elegir') {
      if (r === '__ninguno__') {
        st.fase = 'buscar';
        await ctx.reply('Escribilo de otra forma (o el código):');
        return;
      }
      const art = (st.candidatos || []).find((a) => a.codigo === r);
      if (art) return elegirDelMaestro(ctx, art);
      // Si escribió texto en vez de tocar, cae abajo y re-busca.
    }

    // No lo encontramos y le preguntamos si lo anota igual.
    if (st.fase === 'textolibre') {
      if (esSi(r)) return elegirTextoLibre(ctx, st.textoPendiente);
      st.fase = 'buscar';
      await ctx.reply('Ok, escribí el producto de nuevo:');
      return;
    }

    // fase "buscar" (o primera vez): buscar en el maestro.
    const texto = String(r).trim();
    if (!texto) { await ctx.reply('Escribí algo: código, código de barras o nombre.'); return; }

    let arts = [];
    try {
      arts = await buscarArticulos(texto, MAX_CANDIDATOS);
    } catch (e) {
      console.error('Error buscando artículo para /falta:', e.message);
    }

    if (arts.length === 1) {
      const a = arts[0];
      st.candidato = a;
      st.fase = 'confirmar';
      await preguntar(ctx, `¿Es este?\n\n${a.nombre}\ncód. ${a.codigo}${a.proveedor ? ` · ${a.proveedor}` : ''}`, SI_NO);
      return;
    }
    if (arts.length > 1) {
      st.candidatos = arts;
      st.fase = 'elegir';
      await preguntar(ctx, '¿Cuál es?', opciones([
        ...arts.map((a) => [`${a.nombre} (${a.codigo})`, a.codigo]),
        ['Ninguno / lo escribo distinto', '__ninguno__'],
      ]));
      return;
    }
    // 0 resultados -> ofrecer guardarlo como texto libre.
    st.textoPendiente = texto;
    st.fase = 'textolibre';
    await preguntar(ctx, `No lo encontré en el maestro. ¿Lo anoto igual como "${texto}"?`, SI_NO);
  },
  // 2: situación
  async (ctx) => {
    const r = await respuesta(ctx);
    if (r === null) return;
    if (esCancelar(r)) return cancelar(ctx);
    if (!SITUACIONES[r]) { await ctx.reply('Tocá una de las opciones.'); return; }
    ctx.wizard.state.data.situacion = r;
    await preguntar(ctx, '¿Querés agregar una nota? Escribila, o tocá saltar.', opciones([['Saltar', '__saltar__']]));
    return ctx.wizard.next();
  },
  // 3: nota (opcional) -> confirmar
  async (ctx) => {
    const r = await respuesta(ctx);
    if (r === null) return;
    if (esCancelar(r)) return cancelar(ctx);
    ctx.wizard.state.data.nota = r === '__saltar__' ? null : String(r).trim();
    await preguntar(ctx, resumen(ctx.wizard.state.data), SI_NO);
    return ctx.wizard.next();
  },
  // 4: confirmar -> guardar
  async (ctx) => {
    const raw = await respuesta(ctx);
    if (raw === null) return;
    if (esCancelar(raw)) return cancelar(ctx);
    if (!esSi(raw)) { await ctx.reply('Reporte cancelado.'); return ctx.scene.leave(); }
    if (ctx.wizard.state.guardando) return; // anti doble-tap
    ctx.wizard.state.guardando = true;

    const d = ctx.wizard.state.data;
    const u = ctx.state.usuario;
    const nombre = u ? u.nombre : (ctx.from.username || ctx.from.first_name || null);
    // Origen: si es de Ventas lo marcamos ventas; si no, deposito (los únicos que llegan acá).
    const origen = u && u.areas && u.areas.includes('ventas') ? 'ventas' : 'deposito';

    try {
      await registrarFaltante({
        articuloCodigo: d.articuloCodigo,
        productoTexto: d.productoTexto,
        origenArea: origen,
        situacion: d.situacion,
        nota: d.nota,
        usuarioId: u ? u.id : null,
        usuarioNombre: nombre,
      });
      await ctx.reply('✅ Anotado. Compras lo va a ver en el próximo /faltantes (últimas 2 semanas). ¡Gracias!');
    } catch (err) {
      console.error('Error guardando faltante:', err);
      await ctx.reply('❌ No pude guardar el reporte. Probá de nuevo o avisá al admin.');
    }
    return ctx.scene.leave();
  }
);

module.exports = faltaWizard;
