// Tests de aviso-planilla.js — el que avisa cuando la pantalla de recepción quedó
// mostrando datos viejos. Correr: node test/aviso-planilla.test.js
//
// Lo que se cuida es que el aviso sea CREÍBLE, que es lo único que hace que
// alguien le preste atención:
//   - avisa UNA vez por episodio y no cada media hora,
//   - avisa cuando se resuelve, así el silencio significa "está bien",
//   - no molesta de noche ni el fin de semana a la madrugada, cuando que no llegue
//     una planilla es lo normal.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const assert = require('assert');
const Module = require('module');

// ── Dobles ───────────────────────────────────────────────────────────────────
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

const av = require('../src/aviso-planilla');

const H = 3600 * 1000;
// Un miércoles a las 14:00 de Argentina (17:00 UTC): dentro del horario de trabajo.
const EN_HORARIO = new Date('2026-08-19T17:00:00Z');
// El mismo día a las 06:00 de Argentina: fuera.
const DE_MADRUGADA = new Date('2026-08-19T09:00:00Z');

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }
async function ta(nombre, fn) { avisos.length = 0; av._reset(); await fn(); pass++; console.log('  ok:', nombre); }

(async () => {
  console.log('\naviso-planilla');

  // ── La hora argentina ──────────────────────────────────────────────────────

  t('horaArg convierte de UTC a hora argentina', () => {
    assert.equal(av.horaArg(new Date('2026-08-19T12:00:00Z')), 9);
    assert.equal(av.horaArg(new Date('2026-08-19T17:00:00Z')), 14);
    // El caso que rompe si alguien usa getHours(): pasada la medianoche UTC
    // todavía es el día anterior en Argentina.
    assert.equal(av.horaArg(new Date('2026-08-20T01:00:00Z')), 22);
  });

  // ── La decisión ────────────────────────────────────────────────────────────

  t('planilla reciente: no pasa nada', () => {
    const r = av.decidir({ ultima: new Date(EN_HORARIO - 0.5 * H), ahora: EN_HORARIO, hayReclamo: false });
    assert.equal(r.accion, 'nada');
  });

  t('planilla vieja en horario de trabajo: se reclama', () => {
    const r = av.decidir({ ultima: new Date(EN_HORARIO - 5 * H), ahora: EN_HORARIO, hayReclamo: false });
    assert.equal(r.accion, 'reclamar');
    assert.equal(Math.round(r.horasSin), 5);
  });

  t('justo en el límite todavía no se reclama', () => {
    const casi = av.decidir({ ultima: new Date(EN_HORARIO - (av.LIMITE_HORAS * H - 60000)), ahora: EN_HORARIO, hayReclamo: false });
    assert.equal(casi.accion, 'nada');
    const pasado = av.decidir({ ultima: new Date(EN_HORARIO - (av.LIMITE_HORAS * H + 60000)), ahora: EN_HORARIO, hayReclamo: false });
    assert.equal(pasado.accion, 'reclamar');
  });

  t('de madrugada no se molesta a nadie aunque haga horas que no llega', () => {
    const r = av.decidir({ ultima: new Date(DE_MADRUGADA - 12 * H), ahora: DE_MADRUGADA, hayReclamo: false });
    assert.equal(r.accion, 'nada', 'a las 6 de la mañana que no haya planilla es lo normal');
  });

  t('el domingo no se reclama: no se trabaja', () => {
    // La planilla del 21/08 traía viernes, sábado y lunes. El domingo ni figura.
    // Sin esto, el primer domingo llegaba un "hace 3 horas que no entra" que es
    // mentira — y un aviso que grita en falso una vez ya no se lee la segunda.
    const domingo = new Date('2026-08-23T17:00:00Z'); // 14:00 ART, domingo
    assert.equal(av.diaArg(domingo), 0);
    const r = av.decidir({ ultima: new Date(domingo - 20 * H), ahora: domingo, hayReclamo: false });
    assert.equal(r.accion, 'nada');
  });

  t('el sábado SÍ se reclama: se trabaja', () => {
    const sabado = new Date('2026-08-22T17:00:00Z'); // 14:00 ART, sábado
    assert.equal(av.diaArg(sabado), 6);
    const r = av.decidir({ ultima: new Date(sabado - 5 * H), ahora: sabado, hayReclamo: false });
    assert.equal(r.accion, 'reclamar');
  });

  t('diaArg usa la fecha ARGENTINA, no la UTC', () => {
    // Sábado 22 a las 22:00 de Argentina ya es domingo 23 en UTC. Con getUTCDay()
    // a secas, las últimas dos horas del sábado se tomarían como domingo.
    const sabadoTarde = new Date('2026-08-23T01:00:00Z'); // 22:00 ART del sábado
    assert.equal(av.diaArg(sabadoTarde), 6, 'todavía es sábado en Argentina');
  });

  t('si nunca entró ninguna planilla, también se reclama', () => {
    const r = av.decidir({ ultima: null, ahora: EN_HORARIO, hayReclamo: false });
    assert.equal(r.accion, 'reclamar');
    assert.equal(r.horasSin, Infinity);
  });

  t('con un reclamo abierto y el problema sin resolver, NO se repite', () => {
    const r = av.decidir({ ultima: new Date(EN_HORARIO - 9 * H), ahora: EN_HORARIO, hayReclamo: true });
    assert.equal(r.accion, 'nada', 'avisar cada media hora hace que dejen de leer los avisos');
  });

  t('el "ya volvió" sale aunque sea fuera de horario', () => {
    // Si la planilla se destraba a las 19:30, el aviso de resuelto tiene que salir
    // esa misma noche: si no, queda un reclamo abierto que nadie sabe si sigue.
    const tarde = new Date('2026-08-19T23:00:00Z'); // 20:00 ART
    const r = av.decidir({ ultima: new Date(tarde - 0.2 * H), ahora: tarde, hayReclamo: true });
    assert.equal(r.accion, 'resuelto');
  });

  // ── El texto ───────────────────────────────────────────────────────────────

  t('el texto de la demora se lee bien', () => {
    assert.equal(av.textoHoras(Infinity), 'nunca entró ninguna');
    assert.equal(av.textoHoras(0.5), 'hace 30 minutos');
    assert.equal(av.textoHoras(4.2), 'hace 4 horas');
  });

  // ── El episodio completo ───────────────────────────────────────────────────

  await ta('un episodio: avisa una vez, se calla, y avisa cuando vuelve', async () => {
    ultimaFalsa = new Date(EN_HORARIO - 6 * H);

    const a = await av.revisarPlanilla({ ahora: EN_HORARIO });
    assert.equal(a.accion, 'reclamar');
    assert.equal(avisos.length, 1);
    assert.ok(/datos viejos/.test(avisos[0].que));
    // El aviso tiene que decir dónde mirar: si no, no es accionable.
    assert.ok(/sync\.log/.test(avisos[0].sugerencia));
    assert.ok(av._hayReclamo());

    // Media hora después sigue igual: no puede volver a avisar.
    const b = await av.revisarPlanilla({ ahora: new Date(EN_HORARIO.getTime() + 0.5 * H) });
    assert.equal(b.accion, 'nada');
    assert.equal(avisos.length, 1, 'no se repite el mismo reclamo');

    // Entra una planilla.
    ultimaFalsa = new Date(EN_HORARIO.getTime() + 0.9 * H);
    const c = await av.revisarPlanilla({ ahora: new Date(EN_HORARIO.getTime() + H) });
    assert.equal(c.accion, 'resuelto');
    assert.equal(avisos.length, 2);
    assert.equal(avisos[1].nivel, '✅');
    assert.ok(!av._hayReclamo(), 'cerrado el episodio, un problema nuevo tiene que poder avisar');

    // Y si vuelve a cortarse, avisa de nuevo.
    ultimaFalsa = new Date(EN_HORARIO - 8 * H);
    const d = await av.revisarPlanilla({ ahora: EN_HORARIO });
    assert.equal(d.accion, 'reclamar');
    assert.equal(avisos.length, 3);
  });

  await ta('todo bien de entrada: no avisa nada', async () => {
    ultimaFalsa = new Date(EN_HORARIO - 0.1 * H);
    const r = await av.revisarPlanilla({ ahora: EN_HORARIO });
    assert.equal(r.accion, 'nada');
    assert.equal(avisos.length, 0);
  });

  console.log(`\n${pass} tests ok\n`);
})().catch((e) => { console.error('\nFALLO:', e); process.exit(1); });
