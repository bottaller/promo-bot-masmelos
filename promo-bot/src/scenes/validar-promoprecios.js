// Wizard: se entra al tocar "✅ Validar" en el archivo de /promoprecios (ver
// src/acciones-calidad.js). Intenta leer el archivo y detectar los productos marcados con "x"
// en la columna "Imagen" (lib/promoprecios-excel.js) — si los reconoce:
//   1. Genera y le manda al DUEÑO el .txt de "precio al piso" para Sigma (lib/promoprecios-sigma.js).
//   2. Genera el cartel automático de cada producto (misma lógica que /carteleria, plantilla
//      a4_color + corto_vencimiento, ver lib/carteleria-generar.js) y se lo manda AL DUEÑO
//      directo para que lo valide (ver carteleria-mensajes.js) — ya no pasa por Marketing ni
//      por Compras; Marketing solo entra al final, para imprimir todo ya validado (ver
//      acciones-deposito.js / lib/promoprecios-mensajes.js).
// Si el archivo no tiene ese formato (versión vieja de la planilla, u otra cosa), cae al flujo
// manual de siempre: preguntar cuántas imágenes tiene que hacer Marketing a mano (ese camino
// SÍ sigue avisándole a Compras el archivo crudo, sin cambios).
const { Scenes } = require('telegraf');
const {
  promoPreciosPorId, validarPromoPrecios, marcarMarketingCompletado,
} = require('../db/promoprecios');
const { crearCarteleria } = require('../db/carteleria');
const { telegramIdsPorRol } = require('../db/usuarios');
const { mapaImpuestosInternos } = require('../db/impuestos-internos');
const { generarYNotificarMarketing } = require('../lib/carteleria-generar');
const { parsearProductosConImagen } = require('../lib/promoprecios-excel');
const { generarTxtSigma } = require('../lib/promoprecios-sigma');
const { fechaHoyArgISO } = require('../lib/fechas');
const { respuesta, esCancelar, parseUnidades } = require('../lib/wizard');

// Genera el .txt de Sigma y se lo manda al dueño (quien está validando el archivo en este
// wizard). No es fatal si falla o si no hay nada para generar (archivo viejo sin la columna
// "ACCION A TOMAR", o ningún producto con ese dato completo) — las imágenes se generan igual.
async function mandarTxtSigma(ctx, productos, esPrueba) {
  try {
    const mapaImpuestos = await mapaImpuestosInternos();
    const txt = generarTxtSigma(productos, mapaImpuestos);
    if (!txt) return;
    const prefijo = esPrueba ? '🧪 PRUEBA — ' : '';
    await ctx.replyWithDocument(
      { source: Buffer.from(txt, 'utf8'), filename: `precio_al_piso_${fechaHoyArgISO()}.txt` },
      { caption: `${prefijo}💲 .txt listo para cargar en Sigma.` }
    );
  } catch (e) {
    console.error('No pude generar el .txt de Sigma:', e.message);
    await ctx.reply('⚠️ No pude generar el .txt de Sigma (revisá que /actimpint esté cargado). Sigo con las imágenes igual.');
  }
}

const TIPO_GRAFICA = 'a4_color';
const TIPO_PRECIO = 'corto_vencimiento';

async function bajarArchivo(telegram, fileId) {
  const link = await telegram.getFileLink(fileId);
  const resp = await fetch(link.href);
  return Buffer.from(await resp.arrayBuffer());
}

// Compras recibe el archivo crudo con los precios (igual en el flujo automático y en el manual).
// En un ciclo de /promoprecios_prueba (promo.es_prueba) esto NUNCA sale para Compras real —
// vuelve solo a quien lo probó (mismo criterio que /carteleria_prueba).
async function avisarComprasArchivo(ctx, promo) {
  const prefijo = promo.es_prueba ? '🧪 PRUEBA — ' : '';
  const destinatarios = promo.es_prueba ? [promo.usuario_telegram_id] : await telegramIdsPorRol('compras_promo');
  let avisados = 0;
  for (const tid of destinatarios) {
    try {
      await ctx.telegram.sendDocument(tid, promo.archivo_file_id, {
        caption: `${prefijo}💲 Promociones y precios, ya validado.`,
        reply_markup: { inline_keyboard: [[{ text: '✅ LISTO', callback_data: `promo_compras_ok:${promo.id}` }]] },
      });
      avisados++;
    } catch (e) { console.error('No pude avisarle a compras_promo:', e.message); }
  }
  return avisados;
}

// Flujo viejo: Marketing arma las imágenes a mano y las entrega con /imagenes.
async function repartirManual(ctx, promo) {
  const avisadosCompras = await avisarComprasArchivo(ctx, promo);

  const prefijo = promo.es_prueba ? '🧪 PRUEBA — ' : '';
  const destinatariosMarketing = promo.es_prueba ? [promo.usuario_telegram_id] : await telegramIdsPorRol('marketing');
  let avisadosMarketing = 0;
  for (const tid of destinatariosMarketing) {
    try {
      await ctx.telegram.sendDocument(tid, promo.archivo_file_id, {
        caption: `${prefijo}💲 Promociones y precios.\n\nTenés que mandar ${promo.imagenes_requeridas} imagen(es). Usá /imagenes para entregarlas.`,
      });
      avisadosMarketing++;
    } catch (e) { console.error('No pude avisarle a marketing:', e.message); }
  }

  return { avisadosCompras, avisadosMarketing };
}

// Flujo nuevo: por cada producto marcado con "x" en Imagen, generar el cartel automático y
// mandárselo AL DUEÑO directo para que lo valide (Compras ya no entra en este circuito).
async function repartirConDisenos(ctx, promo, productos) {
  let generados = 0;
  for (const p of productos) {
    try {
      const id = await crearCarteleria({
        tipo: TIPO_GRAFICA, tipoPrecio: TIPO_PRECIO,
        producto: p.detalle, precio: p.precio, vencimiento: p.vencimiento,
        usuarioTelegramId: promo.usuario_telegram_id, usuarioNombre: promo.usuario_nombre,
        esPrueba: promo.es_prueba, promoprecioId: promo.id,
      });
      await generarYNotificarMarketing(ctx.telegram, {
        id, tipo: TIPO_GRAFICA, tipoPrecio: TIPO_PRECIO,
        producto: p.detalle, precio: p.precio, vencimiento: p.vencimiento, articuloCodigo: p.codigo,
      });
      generados++;
    } catch (e) { console.error(`No pude generar el diseño para "${p.detalle}":`, e.message); }
  }

  // Ya se generaron (y mandaron a validar) todas las imágenes de este ciclo — así, si más
  // adelante hace falta corregir alguna, /imagenes entra directo en modo corrección.
  await marcarMarketingCompletado(promo.id);

  return { generados };
}

const validarPromoPreciosWizard = new Scenes.WizardScene(
  'validar-promoprecios-wizard',
  // 0: intentar detectar los productos marcados con "x" en Imagen -> flujo automático;
  // si no se reconoce el archivo, preguntar la cantidad a mano (flujo de siempre).
  async (ctx) => {
    const promoId = ctx.session.promoIdParaValidar;
    ctx.wizard.state.promoId = promoId;

    const promoPrevia = await promoPreciosPorId(promoId);
    if (!promoPrevia) { await ctx.reply('No encontré ese archivo de promoprecios.'); return ctx.scene.leave(); }

    let productos = null;
    try {
      const buffer = await bajarArchivo(ctx.telegram, promoPrevia.archivo_file_id);
      productos = parsearProductosConImagen(buffer);
    } catch (e) {
      console.error('No pude autodetectar los productos con imagen del archivo de promoprecios:', e.message);
    }

    if (productos !== null) {
      const promo = await validarPromoPrecios(promoId, { imagenesRequeridas: productos.length });
      if (!promo) { await ctx.reply('Ese archivo ya estaba validado.'); return ctx.scene.leave(); }

      if (productos.length === 0) {
        await marcarMarketingCompletado(promo.id);
        await ctx.reply('Listo. Este archivo no marcó ningún producto con imagen — no hace falta generar nada.');
        return ctx.scene.leave();
      }

      await mandarTxtSigma(ctx, productos, promo.es_prueba);

      const { generados } = await repartirConDisenos(ctx, promo, productos);
      await ctx.reply(
        `Listo. Encontré ${productos.length} producto(s) marcados con imagen — generé ${generados} diseño(s) para que los valides vos.`
      );
      return ctx.scene.leave();
    }

    await ctx.reply('¿Cuántas imágenes tiene que hacer Marketing?');
    return ctx.wizard.next();
  },
  // 1: (flujo manual, solo si no se reconoció el archivo) procesar la cantidad -> validar y repartir
  async (ctx) => {
    const r = await respuesta(ctx);
    if (esCancelar(r)) { await ctx.reply('Cancelado. El archivo sigue sin validar.'); return ctx.scene.leave(); }
    const n = parseUnidades(r);
    if (n === null || n <= 0) { await ctx.reply('Ingresá un número entero mayor a 0.'); return; }

    const promoId = ctx.wizard.state.promoId;
    const promo = await validarPromoPrecios(promoId, { imagenesRequeridas: n });
    if (!promo) {
      await ctx.reply('Ese archivo ya estaba validado.');
      return ctx.scene.leave();
    }

    const { avisadosCompras, avisadosMarketing } = await repartirManual(ctx, promo);
    await ctx.reply(
      `Listo. Le pedí ${n} imagen(es) a Marketing (${avisadosMarketing} persona(s)) y avisé a Compras (${avisadosCompras} persona(s)).`
    );
    return ctx.scene.leave();
  }
);

module.exports = validarPromoPreciosWizard;
