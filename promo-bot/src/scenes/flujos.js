// Wizard /flujos (área Tesorería): recibe el rango de fechas + el "Diario de movimientos" de
// Sigma (o usa el libro que ya cargó el admin), corre el motor en Python (arqueo/runner.py) y
// devuelve el HTML del flujo del dinero.
// (El motor se llama "arqueo" por su origen en masmelos-analytics, pero para el usuario
//  esto es el flujo del dinero, no un arqueo.)
const { Scenes } = require('telegraf');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { esCancelar, respuesta, preguntar, opciones } = require('../lib/wizard');
const { conseguirLibro, materializarLibro } = require('../lib/libro-fuente');
const LM = require('../lib/libro-mensajes');
const { parseVencimiento, formatoVencimiento, fechaISO, fechaHoyArgISO } = require('../lib/fechas');

const RUNNER = path.resolve(__dirname, '..', '..', 'arqueo', 'runner.py');
const PYTHON = process.env.PYTHON_BIN || 'python';
const TIMEOUT_MS = 180000; // puede tardar; cortamos a los 3 min

// El motor escribe el HTML en un directorio FIJO con un nombre derivado del rango
// (flujo_<desde>_<hasta>.html). Mientras cada uno subía SU export con SU rango el choque era
// improbable; con el libro compartido y rangos elegidos a mano dos corridas pueden generar el
// MISMO nombre, y como tarda hasta 3 minutos la ventana para pisarse es enorme (se podría
// entregar un HTML a medio escribir). Se serializan las corridas.
// OJO: es un lock EN MEMORIA. Si algún día Railway levanta más de una réplica deja de proteger,
// y la falla no sería un error visible sino un archivo truncado entregado como bueno.
let corriendo = null; // { desde: number }

function hace(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

// El acceso ya lo garantiza requiereArea('tesoreria') al entrar, pero lo re-chequeamos
// en el paso del documento por si le quitan el rol a mitad de camino (es data financiera).
function tieneAccesoTesoreria(u) {
  return !!(u && (u.es_admin || (u.areas && u.areas.includes('tesoreria'))));
}

// Interpreta el rango que escribió el usuario. Acepta "01/07/2026 15/07/2026",
// "01/07/2026 al 15/07/2026", "01/07/2026-15/07/2026" y una sola fecha (= ese día).
// Devuelve { ok:true, desde, hasta } | { ok:false, error }
function parsearRango(txt) {
  const fechas = String(txt || '').match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || [];
  if (fechas.length === 0) {
    return { ok: false, error: 'No encontré ninguna fecha. Escribila como DD/MM/AAAA, por ejemplo: 01/07/2026 15/07/2026' };
  }
  if (fechas.length > 2) {
    return { ok: false, error: 'Me diste más de dos fechas. Mandame solo el desde y el hasta.' };
  }
  const desde = parseVencimiento(fechas[0]);
  const hasta = fechas.length === 2 ? parseVencimiento(fechas[1]) : desde;
  if (!desde || !hasta) return { ok: false, error: 'Alguna de esas fechas no existe. Revisala y mandámela de nuevo.' };
  if (fechaISO(desde) > fechaISO(hasta)) {
    return { ok: false, error: `El desde (${formatoVencimiento(desde)}) es posterior al hasta (${formatoVencimiento(hasta)}). Invertilos.` };
  }
  if (fechaISO(desde) > fechaHoyArgISO()) {
    return { ok: false, error: `${formatoVencimiento(desde)} todavía no pasó. Elegí un rango que ya haya ocurrido.` };
  }
  return { ok: true, desde, hasta };
}

// Corre el runner de Python y resuelve con la última línea JSON de stdout
// ({ok, html, xlsx} o {ok:false, error}). `desde`/`hasta` acotan la ventana del reporte:
// el runner los reenvía al motor, que de ahí saca también el nombre del HTML.
function correrFlujos(excelPath, { desde = null, hasta = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = [RUNNER, excelPath];
    if (desde) args.push('--desde', desde);
    if (hasta) args.push('--hasta', hasta);
    const proc = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout del flujo')); }, TIMEOUT_MS);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // La última línea no vacía de stdout es el JSON del contrato (el motor loguea por stderr).
      const lineas = stdout.trim().split('\n').filter((l) => l.trim());
      let json = null;
      try { json = JSON.parse(lineas[lineas.length - 1]); } catch (e) { /* no hubo JSON */ }
      if (code !== 0 || !json) {
        return reject(new Error(`el motor salió con code ${code}: ${stderr.slice(-500)}`));
      }
      resolve(json);
    });
  });
}

const flujosWizard = new Scenes.WizardScene(
  'flujos-wizard',
  // 0: pedir el RANGO de fechas. Va primero porque define qué se va a mirar; el archivo es
  // apenas de dónde salen los datos.
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      '💵 <b>Flujo del dinero</b>.\n\n' +
      '<b>1) ¿Qué período querés ver?</b> Mandame la fecha de inicio y la de fin:\n' +
      '<code>01/07/2026 15/07/2026</code>\n\n' +
      'Si querés un solo día, mandá una sola fecha.\n' +
      '(o escribí "cancelar")',
      { parse_mode: 'HTML' }
    );
    return ctx.wizard.next();
  },
  // 1: recibir el rango -> ofrecer el libro cargado o pedir el Excel
  async (ctx) => {
    const txt = (ctx.message && typeof ctx.message.text === 'string') ? ctx.message.text.trim() : '';
    if (esCancelar(txt)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
    if (!txt) { await ctx.reply('Escribime el período, por ejemplo: 01/07/2026 15/07/2026 (o "cancelar").'); return; }

    const r = parsearRango(txt);
    if (!r.ok) { await ctx.reply(r.error); return; } // se queda en este paso

    ctx.wizard.state.data.desde = fechaISO(r.desde);
    ctx.wizard.state.data.hasta = fechaISO(r.hasta);
    const rangoTxt = fechaISO(r.desde) === fechaISO(r.hasta)
      ? formatoVencimiento(r.desde)
      : `${formatoVencimiento(r.desde)} al ${formatoVencimiento(r.hasta)}`;
    ctx.wizard.state.data.rangoTxt = rangoTxt;

    await ctx.reply(
      `📅 Período: <b>${rangoTxt}</b>.\n\n` +
      '<b>2) Ahora el Excel:</b> mandame el "Diario de movimientos contables" de Sigma que ' +
      'cubra ese período, como .xlsx.',
      { parse_mode: 'HTML' }
    );

    // conseguirLibro NUNCA tira: si la base está caída devuelve ok:false y esto sigue igual.
    // Que este paso no pueda fallar es crítico: si tirara, el wizard quedaría trabado sin que
    // "cancelar" ni /flujos puedan rescatarlo.
    const lib = await conseguirLibro({ modo: 'ultimo' });
    if (lib.ok) {
      ctx.wizard.state.data.libroMeta = lib.meta;
      await preguntar(
        ctx,
        LM.describirLibro(lib.meta, lib.antiguedadDias,
          `♻️ O uso el libro que ya está cargado y lo recorto a <b>${rangoTxt}</b>.`),
        // Si el libro tiene más de un día de antigüedad, "mandar otro" va PRIMERO: romper el
        // automatismo del primer botón es lo único que frena el "dale, dale" con datos viejos.
        opciones(lib.antiguedadDias > 1
          ? [['📎 Mandar otro Excel', 'otro'], [LM.etiquetaUsarLibro(lib.meta), 'usar_libro']]
          : [[LM.etiquetaUsarLibro(lib.meta), 'usar_libro'], ['📎 Mandar otro Excel', 'otro']])
      );
    } else if (lib.motivo !== 'sin_libro') {
      await ctx.reply(LM.textoFallback(lib.motivo));
    }
    return ctx.wizard.next();
  },
  // 2: recibir el Excel (o el botón) y procesar
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Cancelado.');
      return ctx.scene.leave();
    }
    const doc = ctx.message && ctx.message.document;

    // --- Sin archivo: ver si tocó un botón ---
    let usarLibro = false;
    if (!doc) {
      const r = await respuesta(ctx);
      if (r === null) return; // botón viejo / doble-tap / no era texto
      if (esCancelar(r)) { await ctx.reply('Cancelado.'); return ctx.scene.leave(); }
      if (r === 'otro') {
        await ctx.reply('Dale. Mandame el Excel de Sigma como archivo .xlsx.');
        return;
      }
      if (r !== 'usar_libro') {
        await ctx.reply('Mandame el archivo .xlsx como documento (no como foto ni texto). O escribí "cancelar".');
        return;
      }
      usarLibro = true;
    }

    if (!tieneAccesoTesoreria(ctx.state.usuario)) {
      await ctx.reply('Ya no tenés acceso al área Tesorería.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.procesando) return; // evita doble envío de archivo
    ctx.wizard.state.procesando = true;

    // El motor escribe en una ruta compartida: dos corridas a la vez se pisan (ver el lock).
    if (corriendo) {
      await ctx.reply(
        `⏳ Ya hay un flujo corriendo (arrancó hace ${hace(Date.now() - corriendo.desde)}; suele tardar ~2 min).\n` +
        'Esperá a que termine y volvé a correr /flujos.'
      );
      ctx.wizard.state.procesando = false;
      return ctx.scene.leave();
    }

    const { desde, hasta, rangoTxt, libroMeta } = ctx.wizard.state.data;
    const meta = usarLibro ? libroMeta : null;
    let excelPath = null;
    let limpiar = () => {};
    try {
      if (usarLibro) {
        const mat = await materializarLibro(meta);
        if (!mat.ok) {
          await ctx.reply(LM.textoFallback(mat.motivo));
          ctx.wizard.state.procesando = false;
          return; // sigue esperando el archivo
        }
        excelPath = mat.ruta;
        limpiar = mat.limpiar;
        await ctx.reply(`Usando el libro del ${LM.diaLibro(meta)}, recortado a ${rangoTxt}. Esto puede tardar un momento…`);
      } else {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flujos-'));
        // Nombre sintético: no se usa doc.file_name para no meter texto del usuario en un path.
        excelPath = path.join(tmpDir, 'diario.xlsx');
        limpiar = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignorar */ } };
        await ctx.reply(`Recibido. Procesando ${rangoTxt}, esto puede tardar un momento…`);
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(link.href);
        fs.writeFileSync(excelPath, Buffer.from(await resp.arrayBuffer()));
      }

      corriendo = { desde: Date.now() };
      const res = await correrFlujos(excelPath, { desde, hasta });
      if (!res.ok) {
        // Caso típico: el export no tiene movimientos en el período pedido.
        await ctx.reply(res.error || `No pude procesar el archivo para ${rangoTxt}.`);
        return ctx.scene.leave();
      }
      // El motor nombra el archivo con el período (flujo_<desde>_<hasta>.html), así el que lo
      // recibe sabe de qué fechas es sin abrirlo (convenciones.md). El caption lleva el origen:
      // el HTML se reenvía y se mira después, y salía idéntico viniera del libro o de un Excel.
      await ctx.replyWithDocument(
        { source: fs.readFileSync(res.html), filename: path.basename(res.html) },
        { caption: `Flujo del dinero — ${rangoTxt}. Abrilo en el navegador.\n${LM.lineaOrigen(meta)}` }
      );
      return ctx.scene.leave();
    } catch (e) {
      console.error('Error en /flujos:', e.message);
      await ctx.reply('Hubo un problema procesando el flujo del dinero. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    } finally {
      // Liberar el lock SIEMPRE: si una excepción lo dejara tomado, /flujos quedaría muerto
      // para todos hasta el próximo deploy.
      corriendo = null;
      limpiar();
    }
  }
);

module.exports = flujosWizard;
// Se expone solo para los tests: es la única lógica pura del módulo y define QUÉ período se
// mira, así que conviene tenerla cubierta sin tener que simular un wizard entero.
module.exports._parsearRango = parsearRango;
