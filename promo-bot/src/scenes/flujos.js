// Wizard /flujos (área Tesorería): recibe el Excel del "Diario de movimientos" de Sigma,
// corre el motor en Python (arqueo/runner.py) y devuelve el HTML del flujo del dinero.
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

const RUNNER = path.resolve(__dirname, '..', '..', 'arqueo', 'runner.py');
const PYTHON = process.env.PYTHON_BIN || 'python';
const TIMEOUT_MS = 180000; // puede tardar; cortamos a los 3 min

// El motor escribe el HTML en un directorio FIJO con un nombre derivado del rango
// (flujo_<desde>_<hasta>.html). Mientras cada uno subía SU export el choque era improbable
// porque los rangos diferían; con el libro compartido todos generan el MISMO nombre, y como la
// corrida tarda hasta 3 minutos la ventana para pisarse es enorme (se podría leer un HTML a
// medio escribir). Se serializan las corridas.
// OJO: es un lock EN MEMORIA. Si algún día Railway levanta más de una réplica deja de proteger,
// y la falla no sería un error sino un archivo truncado entregado como bueno.
let corriendo = null; // { desde: number, quien: string }

function hace(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

// El acceso ya lo garantiza requiereArea('tesoreria') al entrar, pero lo re-chequeamos
// en el paso del documento por si le quitan el rol a mitad de camino (es data financiera).
function tieneAccesoTesoreria(u) {
  return !!(u && (u.es_admin || (u.areas && u.areas.includes('tesoreria'))));
}

// Corre el runner de Python y resuelve con la última línea JSON de stdout ({ok, html, xlsx} o {ok:false, error}).
function correrFlujos(excelPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [RUNNER, excelPath], { windowsHide: true });
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
  // 0: ofrecer el libro cargado (si hay) o pedir el Excel
  async (ctx) => {
    await ctx.reply(
      'Flujo del dinero.\n\n' +
      'Mandame el Excel del "Diario de movimientos contables" exportado de Sigma, como archivo .xlsx.\n' +
      '(o escribí "cancelar")'
    );
    // conseguirLibro NUNCA tira: si la base está caída devuelve ok:false y esto sigue igual que
    // siempre. Que este paso no pueda fallar es crítico: si tirara, el wizard quedaría trabado
    // sin que "cancelar" ni /flujos puedan rescatarlo.
    const lib = await conseguirLibro({ modo: 'ultimo' });
    if (lib.ok) {
      ctx.wizard.state.libroMeta = lib.meta;
      await preguntar(
        ctx,
        LM.describirLibro(lib.meta, lib.antiguedadDias,
          `📊 El reporte va a cubrir <b>${LM.describirRango(lib.meta)}</b> si uso el libro cargado.`),
        opciones(lib.antiguedadDias > 1
          ? [['📎 Mandar otro Excel', 'otro'], [LM.etiquetaUsarLibro(lib.meta), 'usar_libro']]
          : [[LM.etiquetaUsarLibro(lib.meta), 'usar_libro'], ['📎 Mandar otro Excel', 'otro']])
      );
    } else if (lib.motivo !== 'sin_libro') {
      await ctx.reply(LM.textoFallback(lib.motivo));
    }
    return ctx.wizard.next();
  },
  // 1: recibir el Excel (o el botón) y procesar
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

    let excelPath = null;
    let limpiar = () => {};
    const meta = usarLibro ? ctx.wizard.state.libroMeta : null;
    try {
      if (usarLibro) {
        const mat = await materializarLibro(meta);
        if (!mat.ok) {
          await ctx.reply(`${LM.textoFallback(mat.motivo)}`);
          ctx.wizard.state.procesando = false;
          return; // sigue esperando el archivo
        }
        excelPath = mat.ruta;
        limpiar = mat.limpiar;
        await ctx.reply(`Usando el libro del ${LM.diaLibro(meta)}. Procesando el flujo del dinero, esto puede tardar un momento…`);
      } else {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flujos-'));
        // Nombre sintético: no se usa doc.file_name para no meter texto del usuario en un path.
        excelPath = path.join(tmpDir, 'diario.xlsx');
        limpiar = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignorar */ } };
        await ctx.reply('Recibido. Procesando el flujo del dinero, esto puede tardar un momento…');
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(link.href);
        fs.writeFileSync(excelPath, Buffer.from(await resp.arrayBuffer()));
      }

      corriendo = { desde: Date.now(), quien: (ctx.from && ctx.from.id) || '?' };
      const res = await correrFlujos(excelPath);
      if (!res.ok) {
        await ctx.reply(res.error || 'No pude procesar el archivo.');
        return ctx.scene.leave();
      }
      // El motor ya nombra el archivo con el período (flujo_<desde>_<hasta>.html),
      // así el que lo recibe sabe de qué fechas es sin abrirlo (convenciones.md).
      // El caption lleva el origen: el HTML se reenvía y se mira después, y sale idéntico
      // venga del libro o de un Excel subido a mano.
      await ctx.replyWithDocument(
        { source: fs.readFileSync(res.html), filename: path.basename(res.html) },
        { caption: `Flujo del dinero — abrilo en el navegador.\n${LM.lineaOrigen(meta)}` }
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
