// CLI de la bajada automática del extracto de Talo (ver talo-api.js).
//
//   node src/lib/talo-api.js --desde 2026-07-23
//   node src/lib/talo-api.js --desde 2026-07-01 --hasta 2026-07-23 --salida "C:\ruta\mov.xlsx"
//   node src/lib/talo-api.js --desde 2026-07-23 --verificar "C:\...\Movimientos_23-07-2026_23-07-2026.xlsx"
//
// El archivo que escribe usa los MISMOS encabezados que el export del panel, así que lo
// reconocen detectarPlataforma() y parsearTalo() sin tocar nada: es un reemplazo directo del
// archivo que hoy se baja a mano.
//
// --verificar es el paso de confianza ANTES de apagar el circuito manual: baja el mismo rango
// por API y lo compara contra el Excel que bajaste del panel. Mientras no cierren los totales
// al centavo, la automatización no se usa para arquear.
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { bajarExtracto, TaloApiError } = require('./talo-api');
const { parsearTalo } = require('./talo-excel');

// Encabezados del export del panel (el subconjunto que la API sabe llenar). El orden imita al
// del panel; parsearTalo busca por NOMBRE, así que no depende de la posición.
const COLUMNAS_SALIDA = [
  'Número de Orden', 'Enviado', 'Recibido', 'Comisión', 'Impuestos Total', 'Acreditado',
  'Moneda', 'Estado', 'Fecha Movimiento', 'Hora Movimiento', 'Titular', 'ID de pago',
];

function parsearArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const clave = a.slice(2);
    const valor = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[clave] = valor;
  }
  return o;
}

// ts canónico 'AAAA-MM-DD HH:MM:SS' -> ['DD/MM/AA', 'hh:mm:ss AM/PM'], como los escribe el panel.
// parsearTalo acepta los segundos opcionales, así que no se pierde la precisión que da la API.
function aColumnasFechaHora(ts) {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  const [, y, mo, d, hh, mm, ss] = m;
  let h12 = Number(hh) % 12;
  if (h12 === 0) h12 = 12;
  const meridiano = Number(hh) < 12 ? 'AM' : 'PM';
  return [`${d}/${mo}/${y.slice(2)}`, `${String(h12).padStart(2, '0')}:${mm}:${ss} ${meridiano}`];
}

// Los importes se escriben como NÚMEROS, no como texto argentino: parseMonto() acepta number
// tal cual y así no hay una segunda oportunidad de romper el formato al ida y vuelta.
function escribirXlsx(operaciones, destino) {
  const filas = [COLUMNAS_SALIDA];
  for (const o of operaciones) {
    const [fecha, hora] = aColumnasFechaHora(o.hora);
    filas.push([
      '-', o.enviado || 0, o.bruto || 0,
      Math.abs(o.comision || 0), Math.abs(o.impuestos || 0), o.neto || 0,
      o.moneda || 'ARS', o.estado, fecha, hora, o.titular || '', o.source_id || '',
    ]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), 'Movimientos');
  fs.mkdirSync(path.dirname(path.resolve(destino)), { recursive: true });
  XLSX.writeFile(wb, destino);
}

const money = (n) => (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function totales(ops) {
  return ops.reduce((a, o) => ({
    n: a.n + 1,
    bruto: a.bruto + (o.bruto || 0),
    comision: a.comision + (o.comision || 0),
    impuestos: a.impuestos + (o.impuestos || 0),
    neto: a.neto + (o.neto || 0),
  }), { n: 0, bruto: 0, comision: 0, impuestos: 0, neto: 0 });
}

// Clave de apareo API<->panel: el Excel tiene precisión de MINUTOS y la API de segundos, así
// que la hora se compara truncada al minuto. El importe se redondea al centavo.
const claveOp = (o) => [o.estado, (o.bruto || 0).toFixed(2), (o.neto || 0).toFixed(2), o.hora.slice(0, 16)].join('|');

// Compara lo que bajó la API contra el Excel del panel del mismo rango. Devuelve true si cierra.
function verificar(opsApi, opsPanel) {
  const tApi = totales(opsApi);
  const tPanel = totales(opsPanel);

  console.log('\n  Comparación API vs. panel');
  console.log('  ' + '-'.repeat(58));
  console.log(`  ${'concepto'.padEnd(14)}${'API'.padStart(16)}${'panel'.padStart(16)}${'dif'.padStart(12)}`);
  const filas = [
    ['movimientos', tApi.n, tPanel.n, false],
    ['bruto', tApi.bruto, tPanel.bruto, true],
    ['comisión', tApi.comision, tPanel.comision, true],
    ['impuestos', tApi.impuestos, tPanel.impuestos, true],
    ['acreditado', tApi.neto, tPanel.neto, true],
  ];
  let cierraTotales = true;
  for (const [nombre, a, b, esPlata] of filas) {
    const dif = a - b;
    if (Math.abs(dif) > 0.005) cierraTotales = false;
    const f = esPlata ? money : String;
    console.log(`  ${nombre.padEnd(14)}${f(a).padStart(16)}${f(b).padStart(16)}${(Math.abs(dif) < 0.005 ? 'ok' : f(dif)).padStart(12)}`);
  }

  // Diferencias operación por operación (multiconjunto: puede haber importes repetidos).
  const bolsa = new Map();
  for (const o of opsPanel) bolsa.set(claveOp(o), (bolsa.get(claveOp(o)) || 0) + 1);
  const soloApi = [];
  for (const o of opsApi) {
    const k = claveOp(o);
    if (bolsa.get(k)) bolsa.set(k, bolsa.get(k) - 1); else soloApi.push(o);
  }
  const soloPanel = [...bolsa.entries()].filter(([, n]) => n > 0).flatMap(([k, n]) => Array(n).fill(k));

  if (soloApi.length) {
    console.log(`\n  ⚠ ${soloApi.length} movimiento(s) que trajo la API y NO están en el panel:`);
    soloApi.slice(0, 10).forEach((o) => console.log(`      ${o.hora}  ${o.estado.padEnd(9)} ${money(o.bruto)}`));
  }
  if (soloPanel.length) {
    console.log(`\n  ⚠ ${soloPanel.length} movimiento(s) del panel que NO trajo la API:`);
    soloPanel.slice(0, 10).forEach((k) => console.log(`      ${k.split('|')[3]}  ${k.split('|')[0].padEnd(9)} ${k.split('|')[1]}`));
  }

  // El titular no está documentado en la API: se avisa explícitamente si vino vacío, porque el
  // informe de conciliación lo usa como referencia de cada cobro (plataformas.js: referencia).
  const sinTitular = opsApi.filter((o) => o.estado === 'RECIBIDO' && !o.titular).length;
  const panelConTitular = opsPanel.filter((o) => o.estado === 'RECIBIDO' && o.titular).length;
  if (sinTitular && panelConTitular) {
    console.log(`\n  ⚠ La API no trajo Titular en ${sinTitular} cobro(s) y el panel sí lo tiene en ${panelConTitular}.`);
    console.log('    El informe pierde el nombre del pagador. Preguntarle a Talo si hay un campo/param para traerlo.');
  }

  const ok = cierraTotales && !soloApi.length && !soloPanel.length;
  console.log(ok
    ? '\n  ✅ Cierra: la bajada por API reproduce el export del panel.'
    : '\n  ❌ NO cierra. No reemplaces el circuito manual hasta entender la diferencia.');
  return ok;
}

async function main(argv) {
  const a = parsearArgs(argv);
  if (!a.desde || a.desde === true) {
    console.log([
      'Bajada automática del extracto de Talo.',
      '',
      '  --desde AAAA-MM-DD      día inicial (calendario argentino). Obligatorio.',
      '  --hasta AAAA-MM-DD      día final. Por defecto, igual a --desde.',
      '  --salida <archivo.xlsx> escribe el extracto con el formato del panel.',
      '  --verificar <panel.xlsx> compara contra el Excel bajado a mano del panel.',
      '  --json                  imprime las operaciones normalizadas en JSON.',
      '',
      'Credenciales en .env: TALO_USER_ID, TALO_CLIENT_ID, TALO_CLIENT_SECRET',
      '(Dashboard de Talo > Usuario > Credenciales). TALO_BASE_URL para sandbox.',
    ].join('\n'));
    return;
  }

  const hasta = a.hasta && a.hasta !== true ? a.hasta : a.desde;
  console.log(`Bajando extracto de Talo: ${a.desde} → ${hasta} (hora argentina)…`);

  const { operaciones, rango } = await bajarExtracto({ desde: a.desde, hasta });
  console.log(`  rango UTC pedido: ${rango.start_date} → ${rango.end_date}`);

  const t = totales(operaciones);
  const cobros = operaciones.filter((o) => o.estado === 'RECIBIDO');
  const tc = totales(cobros);
  console.log(`\n  ${t.n} movimiento(s); ${tc.n} cobro(s) recibido(s)`);
  console.log(`  bruto ${money(tc.bruto)} | comisión ${money(tc.comision)} | impuestos ${money(tc.impuestos)} | acreditado ${money(tc.neto)}`);

  if (a.json) console.log(JSON.stringify(operaciones, null, 2));

  if (a.salida && a.salida !== true) {
    escribirXlsx(operaciones, a.salida);
    console.log(`\n  📄 Escrito: ${path.resolve(a.salida)}`);
  }

  if (a.verificar && a.verificar !== true) {
    const buf = fs.readFileSync(a.verificar);
    const { operaciones: opsPanel } = parsearTalo(buf);
    if (!verificar(operaciones, opsPanel)) process.exitCode = 2;
  }
}

module.exports = { main, escribirXlsx, verificar, totales, aColumnasFechaHora, COLUMNAS_SALIDA, TaloApiError };
