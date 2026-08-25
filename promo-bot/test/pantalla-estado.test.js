// Tests del texto de /pantalla — la respuesta a "¿cómo sé que está mandando?".
// Correr: node test/pantalla-estado.test.js
//
// Lo que se cuida acá es que el veredicto de la primera línea sea VERDADERO en
// los cinco estados posibles. Si /pantalla dijera "todo bien" con un criterio
// distinto al que dispara los avisos, uno de los dos estaría mintiendo — y el
// que consulta desde el teléfono no tiene cómo darse cuenta.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const assert = require('assert');
const { armarMensaje, haceCuanto, MINUTOS_SIN_LATIDO, LIMITE_HORAS } = require('../src/lib/pantalla-estado');

const M = 60 * 1000;
const H = 3600 * 1000;
const AHORA = new Date('2026-08-25T15:00:00Z');

const latidoDe = (haceMin, extra = {}) => ({
  en: new Date(AHORA.getTime() - haceMin * M),
  equipo: 'DESKTOP-GO5TPVR', estado: 'ok',
  archivo: 'PLANILLA RETIRA MORENO 2026.xlsx', fecha: '2026-08-25 11:58',
  tam: 105574, motivo: null, ...extra,
});
const DIAS = [
  { fecha: '2026-08-25', total: 15, listos: 6, retirados: 2 },
  { fecha: '2026-08-26', total: 7, listos: 0, retirados: 0 },
];
const armar = (o) => armarMensaje({
  latido: null, ultima: null, dias: DIAS, ahora: AHORA, minutosDespierto: 600, ...o,
});

let pass = 0;
function t(nombre, fn) { fn(); pass++; console.log('  ok:', nombre); }

console.log('\npantalla-estado');

// ── Los cinco veredictos ─────────────────────────────────────────────────────

t('todo bien: latido fresco y planilla reciente', () => {
  const m = armar({ latido: latidoDe(3), ultima: new Date(AHORA - 0.5 * H) });
  assert.ok(m.startsWith('✅'), m.split('\n')[0]);
  assert.ok(/al día/.test(m));
});

t('el sync anda pero nadie edita la planilla', () => {
  const m = armar({ latido: latidoDe(3), ultima: new Date(AHORA - 6 * H) });
  assert.ok(m.startsWith('🟡'), m.split('\n')[0]);
  assert.ok(/nadie edita/.test(m));
});

t('el sync dejo de reportar', () => {
  const m = armar({ latido: latidoDe(90), ultima: new Date(AHORA - 6 * H) });
  assert.ok(m.startsWith('❌'), m.split('\n')[0]);
  assert.ok(/dejó de reportar/.test(m));
  // Y tiene que decir qué hacer, que es lo único accionable desde el teléfono.
  assert.ok(/prendida y con la sesión iniciada/.test(m));
});

t('entran planillas pero el sync no reporta (script viejo, sin latido)', () => {
  // Es el estado real que tuvo el sistema durante horas. El mensaje NO puede
  // afirmar que todo está bien ni que el sync está muerto: ninguna es cierta.
  const m = armar({ latido: null, ultima: new Date(AHORA - 0.5 * H) });
  assert.ok(m.startsWith('🟡'), m.split('\n')[0]);
  assert.ok(/no está reportando/.test(m));
});

t('lo peor: ni planilla ni latido', () => {
  const m = armar({ latido: null, ultima: new Date(AHORA - 30 * H) });
  assert.ok(m.startsWith('❌'), m.split('\n')[0]);
});

// ── Casos que hacen mentir al mensaje si no se contemplan ───────────────────

t('bot recien reiniciado: no acusa al sync por no haber latidos todavia', () => {
  const m = armar({ latido: null, ultima: new Date(AHORA - 0.2 * H), minutosDespierto: 2 });
  assert.ok(/se reinició recién/.test(m), m);
  assert.ok(!/no está reportando/.test(m), 'sin latidos recién arrancado no se afirma nada');
});

t('si el sync avisa que NO llega al archivo, se dice eso y no otra cosa', () => {
  const m = armar({
    latido: latidoDe(2, { estado: 'sin-archivo', motivo: 'no se llego a la carpeta compartida' }),
    ultima: new Date(AHORA - 6 * H),
  });
  assert.ok(/avisa un problema/.test(m));
  assert.ok(/carpeta compartida/.test(m));
});

t('el umbral es el MISMO que dispara los avisos', () => {
  // Si /pantalla dijera "al día" en un momento en que el vigilante ya está
  // reclamando, no habria forma de saber a cual creerle.
  const justoAntes = armar({ latido: latidoDe(MINUTOS_SIN_LATIDO - 1), ultima: new Date(AHORA - 0.1 * H) });
  const justoDespues = armar({ latido: latidoDe(MINUTOS_SIN_LATIDO + 1), ultima: new Date(AHORA - 0.1 * H) });
  assert.ok(justoAntes.startsWith('✅'));
  assert.ok(justoDespues.startsWith('❌'));

  const datosJustos = armar({ latido: latidoDe(2), ultima: new Date(AHORA - (LIMITE_HORAS * H - M)) });
  assert.ok(datosJustos.startsWith('✅'));
});

// ── El contenido ─────────────────────────────────────────────────────────────

t('muestra lo que la tele tiene, por dia', () => {
  const m = armar({ latido: latidoDe(2), ultima: new Date(AHORA - 0.1 * H) });
  assert.ok(/25\/08 — 15 pedido\(s\) · 6 listo\(s\) · 2 retirado\(s\)/.test(m), m);
  assert.ok(/26\/08 — 7 pedido\(s\)$/m.test(m), 'sin listos ni retirados no se inventan ceros');
});

t('sin pedidos lo dice, en vez de mostrar una lista vacia', () => {
  const m = armar({ latido: latidoDe(2), ultima: new Date(AHORA - 0.1 * H), dias: [] });
  assert.ok(/no tiene ningún pedido/.test(m));
});

t('escapa el HTML: un nombre raro no puede romper el mensaje', () => {
  // Telegram rechaza el mensaje ENTERO si el HTML esta mal, asi que un equipo
  // llamado "<test>" dejaria a /pantalla sin contestar nunca.
  const m = armar({ latido: latidoDe(2, { equipo: 'PC<de>Juan & Cia' }), ultima: new Date(AHORA - 0.1 * H) });
  assert.ok(/PC&lt;de&gt;Juan &amp; Cia/.test(m), m);
});

t('los tiempos se leen como los diria una persona', () => {
  assert.equal(haceCuanto(30 * 1000), 'recién');
  assert.equal(haceCuanto(25 * M), 'hace 25 min');
  assert.equal(haceCuanto(3 * H), 'hace 3 h');
  assert.equal(haceCuanto(50 * H), 'hace 2 día(s)');
  assert.equal(haceCuanto(Infinity), 'nunca');
});

t('sin ninguna planilla nunca importada no explota', () => {
  const m = armar({ latido: latidoDe(2), ultima: null });
  assert.ok(/Última planilla: <b>nunca<\/b>/.test(m), m);
});

console.log(`\n${pass} tests ok\n`);
