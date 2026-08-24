// Tests de aviso-planilla.js — el que vigila la pantalla de recepción.
// Correr: node test/aviso-planilla.test.js
//
// Lo que se cuida es que el aviso sea CREÍBLE, que es lo único que hace que
// alguien le preste atención:
//   - distingue "el script murió" de "nadie tocó la planilla" (son problemas
//     distintos, con culpables y arreglos distintos),
//   - avisa una vez por episodio, no cada media hora,
//   - pero RECUERDA una vez por día mientras siga sin resolverse,
//   - avisa cuando se resuelve, así el silencio significa "está bien",
//   - no molesta de noche ni los domingos.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const assert = require('assert');
const Module = require('module');

let ultimaFalsa = null;
function stub(ruta, exports) {
  const p = require.resolve(ruta);
  const m = new Module(p, null);
  m.filename = p; m.loaded = true; m.exports = exports;
  require.cache[p] = m;
}
const avisos = [];
stub('../src/db/retiros', { async ultimaPlanillaImportada() { return ultimaFalsa; } });
stub('../src/notificar', { async avisarProblema(o) { avisos.push(o); return 1; } });

const canal = require('../src/lib/canal-planilla');
const av = require('../src/aviso-planilla');

const H = 3600 * 1000;
const M = 60 * 1000;
// Miércoles 14:00 de Argentina (17:00 UTC): en horario de trabajo.
const EN_HORARIO = new Date('2026-08-19T17:00:00Z');
// Mismo día 06:00 de Argentina: fuera.
const DE_MADRUGADA = new Date('2026-08-19T09:00:00Z');

const latidoDe = (fecha, extra = {}) => ({
  en: fecha, equipo: 'DESKTOP-GO5TPVR', estado: 'ok',
  archivo: 'PLANILLA RETIRA MORENO 2026.xlsx', fecha: '2026-08-19 13:40', tam: 104791,
  motivo: null, ...extra,
});
// Estado limpio de episodios para las pruebas de decidir().
const sinEpisodios = () => ({ canal: null, datos: null });

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }
async function ta(nombre, fn) {
  avisos.length = 0; av._reset(); canal._reset(); ultimaFalsa = null;
  await fn(); pass++; console.log('  ok:', nombre);
}

(async () => {
  console.log('\naviso-planilla');

  // ── Fechas y horas argentinas ──────────────────────────────────────────────

  t('horaArg y diaArg trabajan en hora argentina, no UTC', () => {
    assert.equal(av.horaArg(new Date('2026-08-19T12:00:00Z')), 9);
    assert.equal(av.horaArg(new Date('2026-08-19T17:00:00Z')), 14);
    assert.equal(av.horaArg(new Date('2026-08-20T01:00:00Z')), 22);
    // Sábado 22:00 en Argentina ya es domingo en UTC: con getUTCDay() a secas se
    // perderían las últimas dos horas del sábado.
    assert.equal(av.diaArg(new Date('2026-08-23T01:00:00Z')), 6, 'todavía es sábado acá');
    assert.equal(av.diaArg(new Date('2026-08-23T17:00:00Z')), 0, 'domingo');
    assert.equal(av.fechaArg(new Date('2026-08-20T01:00:00Z')), '2026-08-19');
  });

  // ── Todo bien ──────────────────────────────────────────────────────────────

  t('con latidos frescos y planilla reciente no pasa nada', () => {
    const acc = av.decidir({
      ahora: EN_HORARIO,
      ultima: new Date(EN_HORARIO - 0.5 * H),
      latido: latidoDe(new Date(EN_HORARIO - 2 * M)),
      minutosDespierto: 600,
      estado: sinEpisodios(),
    });
    assert.deepEqual(acc, []);
  });

  // ── El canal (¿el script está vivo?) ───────────────────────────────────────

  t('sin latidos hace rato: se reclama el CANAL, no los datos', () => {
    // Este es el caso que antes no se podía distinguir: la planilla no llega
    // porque el script se murió, no porque nadie la edite.
    const acc = av.decidir({
      ahora: EN_HORARIO,
      ultima: new Date(EN_HORARIO - 40 * H),
      latido: latidoDe(new Date(EN_HORARIO - 3 * H)),
      minutosDespierto: 600,
      estado: sinEpisodios(),
    });
    assert.equal(acc.length, 1, 'un problema, un aviso');
    assert.equal(acc[0].tipo, 'canal');
    assert.equal(acc[0].accion, 'reclamar');
  });

  t('sin NINGUN latido no se acusa al script: puede ser una version vieja', () => {
    // El bug que salio a produccion: el primer deploy mando "el sync no reporta,
    // nunca reporto" con la planilla habiendo entrado 44 minutos antes. El script
    // estaba perfecto; lo que pasaba es que todavia no hablaba el protocolo.
    const acc = av.decidir({
      ahora: EN_HORARIO,
      ultima: new Date(EN_HORARIO - 0.7 * H), // planilla reciente: nada esta mal
      latido: null, minutosDespierto: 600, estado: sinEpisodios(),
    });
    assert.deepEqual(acc, [], 'ausencia de latidos no es prueba de nada');
  });

  t('sin latidos Y con la planilla vieja se avisa, pero sin culpar al script', () => {
    const acc = av.decidir({
      ahora: EN_HORARIO, ultima: new Date(EN_HORARIO - 40 * H),
      latido: null, minutosDespierto: 600, estado: sinEpisodios(),
    });
    assert.deepEqual(acc.map((x) => x.tipo), ['datos'], 'no "canal": no hay con que acusarlo');
  });

  t('solo se acusa al canal si LATIO y despues se callo', () => {
    const acc = av.decidir({
      ahora: EN_HORARIO, ultima: new Date(EN_HORARIO - 40 * H),
      latido: latidoDe(new Date(EN_HORARIO - 3 * H)), // hablo el protocolo, y se fue
      minutosDespierto: 600, estado: sinEpisodios(),
    });
    assert.deepEqual(acc.map((x) => x.tipo), ['canal']);
  });

  t('recién reiniciado el bot NO se acusa al script', () => {
    // Sin esto, cada redeploy dispara un "el sync no reporta" que es mentira: el
    // script está bien, lo que pasa es que su próxima vuelta no llegó todavía.
    // Que la planilla esté vieja SÍ se puede afirmar —sale de la base, no depende
    // de hace cuánto arrancó el bot—, así que ese aviso sale igual.
    const acc = av.decidir({
      ahora: EN_HORARIO, ultima: new Date(EN_HORARIO - 40 * H),
      latido: null, minutosDespierto: 3, estado: sinEpisodios(),
    });
    assert.ok(!acc.some((a) => a.tipo === 'canal'), 'al script no se lo puede acusar todavía');
    assert.deepEqual(acc.map((a) => a.tipo), ['datos']);
  });

  t('con un latido viejo y el bot recién reiniciado tampoco se afirma nada', () => {
    // Ventana de tolerancia: el latido quedó de antes del reinicio y todavía no
    // llegó el siguiente. Ni canal ni datos: se espera.
    const acc = av.decidir({
      ahora: EN_HORARIO, ultima: new Date(EN_HORARIO - 40 * H),
      latido: latidoDe(new Date(EN_HORARIO - 3 * H)), minutosDespierto: 3, estado: sinEpisodios(),
    });
    assert.deepEqual(acc, []);
  });

  // ── Los datos (¿alguien actualiza la planilla?) ────────────────────────────

  t('con el script vivo pero sin planilla nueva: se reclaman los DATOS', () => {
    const acc = av.decidir({
      ahora: EN_HORARIO,
      ultima: new Date(EN_HORARIO - 5 * H),
      latido: latidoDe(new Date(EN_HORARIO - 2 * M)),
      minutosDespierto: 600, estado: sinEpisodios(),
    });
    assert.equal(acc.length, 1);
    assert.equal(acc[0].tipo, 'datos');
    assert.equal(Math.round(acc[0].horasSin), 5);
  });

  t('con el canal caído NO se reclama además por los datos', () => {
    // Dos avisos para un solo problema es ruido, y encima despista: la causa es
    // el canal, no que nadie edite la planilla.
    const acc = av.decidir({
      ahora: EN_HORARIO, ultima: new Date(EN_HORARIO - 40 * H),
      latido: latidoDe(new Date(EN_HORARIO - 5 * H)),
      minutosDespierto: 600, estado: sinEpisodios(),
    });
    assert.deepEqual(acc.map((a) => a.tipo), ['canal']);
  });

  t('un episodio de datos abierto no se cierra si despues cae el canal', () => {
    // Con el canal caído no sabemos nada de los datos: no es que se arreglaron.
    const estado = { canal: null, datos: { desde: EN_HORARIO, ultimoAvisoDia: '2026-08-19' } };
    const acc = av.decidir({
      ahora: EN_HORARIO, ultima: new Date(EN_HORARIO - 0.1 * H),
      latido: latidoDe(new Date(EN_HORARIO - 5 * H)),
      minutosDespierto: 600, estado,
    });
    assert.ok(!acc.some((a) => a.tipo === 'datos' && a.accion === 'resuelto'));
  });

  // ── Cuándo se molesta y cuándo no ──────────────────────────────────────────

  t('de madrugada no se molesta a nadie', () => {
    const acc = av.decidir({
      ahora: DE_MADRUGADA, ultima: new Date(DE_MADRUGADA - 12 * H),
      latido: latidoDe(new Date(DE_MADRUGADA - 2 * M)),
      minutosDespierto: 600, estado: sinEpisodios(),
    });
    assert.deepEqual(acc, []);
  });

  t('el domingo no se reclama: no se trabaja', () => {
    // La planilla del 21/08 traía viernes, sábado y lunes. El domingo ni figura.
    const domingo = new Date('2026-08-23T17:00:00Z');
    const acc = av.decidir({
      ahora: domingo, ultima: new Date(domingo - 20 * H),
      latido: latidoDe(new Date(domingo - 2 * M)),
      minutosDespierto: 600, estado: sinEpisodios(),
    });
    assert.deepEqual(acc, []);
  });

  t('el sábado SÍ se reclama: se trabaja', () => {
    const sabado = new Date('2026-08-22T17:00:00Z');
    const acc = av.decidir({
      ahora: sabado, ultima: new Date(sabado - 5 * H),
      latido: latidoDe(new Date(sabado - 2 * M)),
      minutosDespierto: 600, estado: sinEpisodios(),
    });
    assert.equal(acc[0].tipo, 'datos');
  });

  t('el "ya se resolvió" sale a cualquier hora y cualquier día', () => {
    // Si se destrabó un domingo a la noche, hay que cerrar el episodio igual: si
    // no, queda un reclamo abierto que nadie sabe si sigue vigente.
    const domingoTarde = new Date('2026-08-23T23:00:00Z');
    const estado = { canal: null, datos: { desde: EN_HORARIO, ultimoAvisoDia: '2026-08-19' } };
    const acc = av.decidir({
      ahora: domingoTarde, ultima: new Date(domingoTarde - 0.2 * H),
      latido: latidoDe(new Date(domingoTarde - 2 * M)),
      minutosDespierto: 600, estado,
    });
    assert.deepEqual(acc.map((a) => [a.tipo, a.accion]), [['datos', 'resuelto']]);
  });

  // ── Repetición: ni cada media hora, ni nunca más ───────────────────────────

  t('el mismo día no se repite el reclamo', () => {
    const estado = { canal: null, datos: { desde: EN_HORARIO, ultimoAvisoDia: '2026-08-19' } };
    const luego = new Date(EN_HORARIO.getTime() + 0.5 * H);
    const acc = av.decidir({
      ahora: luego,
      ultima: new Date(EN_HORARIO - 5 * H),
      latido: latidoDe(new Date(luego.getTime() - 2 * M)), // el script sigue latiendo
      minutosDespierto: 600, estado,
    });
    assert.deepEqual(acc, [], 'avisar cada media hora hace que dejen de leerse los avisos');
  });

  t('al día siguiente SÍ se recuerda', () => {
    // El caso real: el problema empieza un sábado a la tarde, se avisa cuando la
    // sucursal está cerrando, y el lunes —cuando importa— nadie se entera.
    const estado = { canal: null, datos: { desde: EN_HORARIO, ultimoAvisoDia: '2026-08-22' } };
    const lunes = new Date('2026-08-24T13:30:00Z'); // 10:30 ART
    const acc = av.decidir({
      ahora: lunes, ultima: new Date(lunes - 42 * H),
      latido: latidoDe(new Date(lunes - 2 * M)),
      minutosDespierto: 600, estado,
    });
    assert.deepEqual(acc.map((a) => [a.tipo, a.accion]), [['datos', 'recordar']]);
  });

  // ── El episodio completo, con envío ────────────────────────────────────────

  await ta('canal: avisa, se calla, recuerda al otro día y cierra cuando vuelve', async () => {
    canal._fijarArranque(new Date(EN_HORARIO - 10 * H)); // despierto hace rato
    ultimaFalsa = new Date(EN_HORARIO - 40 * H);
    // El script LATIÓ y después se calló: eso sí prueba que se murió. (Sin ningún
    // latido no se lo puede acusar: podría ser una versión vieja.)
    canal.registrarLatido({ equipo: 'DESKTOP-GO5TPVR', estado: 'ok' });
    canal.ultimoLatido().en = new Date(EN_HORARIO - 3 * H);
    const a = await av.revisarPlanilla({ ahora: EN_HORARIO });
    assert.deepEqual(a.map((x) => x.tipo), ['canal']);
    assert.equal(avisos.length, 1);
    assert.ok(/dejó de reportar/.test(avisos[0].que), avisos[0].que);
    assert.ok(/prendida y con la sesión iniciada/.test(avisos[0].sugerencia), 'tiene que decir qué mirar');

    // Media hora después: nada.
    await av.revisarPlanilla({ ahora: new Date(EN_HORARIO.getTime() + 0.5 * H) });
    assert.equal(avisos.length, 1);

    // Al otro día, mismo problema: recuerda.
    await av.revisarPlanilla({ ahora: new Date(EN_HORARIO.getTime() + 24 * H) });
    assert.equal(avisos.length, 2);
    assert.ok(/SIGUE sin resolverse/.test(avisos[1].que));

    // Llega un latido: se cierra el episodio del canal…
    canal.registrarLatido({ equipo: 'DESKTOP-GO5TPVR', estado: 'ok' });
    const c = await av.revisarPlanilla({ ahora: new Date(EN_HORARIO.getTime() + 24.5 * H) });
    assert.ok(c.some((x) => x.tipo === 'canal' && x.accion === 'resuelto'));
    assert.ok(avisos.some((m) => m.nivel === '✅'), 'tiene que salir el "ya volvió"');
    assert.equal(av._episodios().canal, null);

    // …y en la MISMA pasada aparece el problema que el canal caído tapaba: la
    // planilla sigue siendo vieja. Es el diagnóstico en dos etapas funcionando,
    // no un aviso de más.
    assert.ok(c.some((x) => x.tipo === 'datos' && x.accion === 'reclamar'));
    assert.ok(av._episodios().datos, 'y queda abierto para poder recordarlo mañana');
  });

  await ta('datos: el aviso dice qué archivo está viendo el script', async () => {
    canal._fijarArranque(new Date(EN_HORARIO - 10 * H));
    canal.registrarLatido({
      equipo: 'DESKTOP-GO5TPVR', estado: 'ok',
      archivo: 'PLANILLA RETIRA MORENO 2026.xlsx', fecha: '2026-08-19 09:10', tam: 104791,
    });
    ultimaFalsa = new Date(EN_HORARIO - 6 * H);
    await av.revisarPlanilla({ ahora: EN_HORARIO });
    assert.equal(avisos.length, 1);
    assert.ok(/sync SÍ está funcionando/.test(avisos[0].que), avisos[0].que);
    assert.ok(/PLANILLA RETIRA MORENO 2026\.xlsx/.test(avisos[0].detalle), avisos[0].detalle);
    assert.ok(/2026-08-19 09:10/.test(avisos[0].detalle), 'y desde cuándo no lo tocan');
  });

  await ta('sin latidos, el aviso NO afirma que el sync este funcionando', async () => {
    canal._fijarArranque(new Date(EN_HORARIO - 10 * H));
    ultimaFalsa = new Date(EN_HORARIO - 6 * H);   // planilla vieja, y ningun latido
    await av.revisarPlanilla({ ahora: EN_HORARIO });
    assert.equal(avisos.length, 1);
    assert.ok(!/sync SÍ está funcionando/.test(avisos[0].que), avisos[0].que);
    assert.ok(/tampoco recibo latidos/.test(avisos[0].detalle), avisos[0].detalle);
    assert.ok(/sync\.log/.test(avisos[0].sugerencia));
  });

  await ta('el aviso del canal no dice "no reporta nunca reporto"', async () => {
    // Salio asi a produccion: dos frases pegadas que se contradicen y hacen dudar
    // del aviso entero.
    canal._fijarArranque(new Date(EN_HORARIO - 10 * H));
    canal.registrarLatido({ equipo: 'DESKTOP-GO5TPVR', estado: 'ok' });
    canal.ultimoLatido().en = new Date(EN_HORARIO - 3 * H); // latio, y se callo
    ultimaFalsa = new Date(EN_HORARIO - 40 * H);
    await av.revisarPlanilla({ ahora: EN_HORARIO });
    assert.equal(avisos.length, 1);
    assert.ok(/dejó de reportar hace 3 horas/.test(avisos[0].que), avisos[0].que);
    assert.ok(!/nunca reportó/.test(avisos[0].que));
  });

  await ta('todo bien: no avisa nada', async () => {
    canal._fijarArranque(new Date(EN_HORARIO - 10 * H));
    canal.registrarLatido({ equipo: 'X', estado: 'ok' });
    ultimaFalsa = new Date(EN_HORARIO - 0.2 * H);
    const a = await av.revisarPlanilla({ ahora: EN_HORARIO });
    assert.deepEqual(a, []);
    assert.equal(avisos.length, 0);
  });

  // ── Textos ─────────────────────────────────────────────────────────────────

  t('los textos de tiempo se leen bien', () => {
    assert.equal(av.textoHoras(Infinity), 'nunca entró ninguna');
    assert.equal(av.textoHoras(0.5), 'hace 30 minutos');
    assert.equal(av.textoHoras(4.2), 'hace 4 horas');
    assert.equal(av.textoMinutos(Infinity), 'nunca reportó');
    assert.equal(av.textoMinutos(25), 'hace 25 minutos');
    assert.equal(av.textoMinutos(180), 'hace 3 horas');
  });

  console.log(`\n${pass} tests ok\n`);
})().catch((e) => { console.error('\nFALLO:', e); process.exit(1); });
