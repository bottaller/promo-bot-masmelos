// Wizard /flujos (área Tesorería): recibe el Excel del "Diario de movimientos" de Sigma,
// corre el motor en Python (arqueo/runner.py) y devuelve el HTML del flujo del dinero.
// (El motor se llama "arqueo" por su origen en masmelos-analytics, pero para el usuario
//  esto es el flujo del dinero, no un arqueo.)
const { Scenes } = require('telegraf');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { esCancelar } = require('../lib/wizard');

const RUNNER = path.resolve(__dirname, '..', '..', 'arqueo', 'runner.py');
const PYTHON = process.env.PYTHON_BIN || 'python';
const TIMEOUT_MS = 180000; // puede tardar; cortamos a los 3 min

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
  // 0: pedir el Excel
  async (ctx) => {
    await ctx.reply(
      'Flujo del dinero.\n\n' +
      'Mandame el Excel del "Diario de movimientos contables" exportado de Sigma, como archivo .xlsx.\n' +
      '(o escribí "cancelar")'
    );
    return ctx.wizard.next();
  },
  // 1: recibir el Excel y procesar
  async (ctx) => {
    if (ctx.message && esCancelar(ctx.message.text)) {
      await ctx.reply('Cancelado.');
      return ctx.scene.leave();
    }
    const doc = ctx.message && ctx.message.document;
    if (!doc) {
      await ctx.reply('Mandame el archivo .xlsx como documento (no como foto ni texto). O escribí "cancelar".');
      return;
    }
    if (!tieneAccesoTesoreria(ctx.state.usuario)) {
      await ctx.reply('Ya no tenés acceso al área Tesorería.');
      return ctx.scene.leave();
    }
    if (ctx.wizard.state.procesando) return; // evita doble envío de archivo
    ctx.wizard.state.procesando = true;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flujos-'));
    const excelPath = path.join(tmpDir, doc.file_name || 'diario.xlsx');
    try {
      await ctx.reply('Recibido. Procesando el flujo del dinero, esto puede tardar un momento…');
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const resp = await fetch(link.href);
      fs.writeFileSync(excelPath, Buffer.from(await resp.arrayBuffer()));

      const res = await correrFlujos(excelPath);
      if (!res.ok) {
        await ctx.reply(res.error || 'No pude procesar el archivo.');
        return ctx.scene.leave();
      }
      // El motor ya nombra el archivo con el período (flujo_<desde>_<hasta>.html),
      // así el que lo recibe sabe de qué fechas es sin abrirlo (convenciones.md).
      await ctx.replyWithDocument(
        { source: fs.readFileSync(res.html), filename: path.basename(res.html) },
        { caption: 'Flujo del dinero — abrilo en el navegador.' }
      );
      return ctx.scene.leave();
    } catch (e) {
      console.error('Error en /flujos:', e.message);
      await ctx.reply('Hubo un problema procesando el flujo del dinero. Probá de nuevo o avisá al admin.');
      return ctx.scene.leave();
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignorar */ }
    }
  }
);

module.exports = flujosWizard;
