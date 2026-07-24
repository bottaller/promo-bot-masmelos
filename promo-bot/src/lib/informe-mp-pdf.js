// Informe PDF de la conciliación de Mercado Pago (/mp): el comprobante del control.
// Dice si salió BIEN o MAL, con el día conciliado y la fecha+hora en que se corrió.
//
// FORMATO: sigue la convención de los reportes de Sigma (los que ya se imprimen en la
// empresa), para que el informe se lea como uno más del sistema:
//   Masmelos
//   <Reporte> - <alcance>                        Página N
//   Desde el DD/MM/AAAA Hasta el DD/MM/AAAA      D/M/AAAA HH:MM:SS
//                                                USUARIO
// La única licencia respecto de Sigma es el recuadro de color con el veredicto: es el punto
// del documento (que se vea de un vistazo si el control cerró) y Sigma no tiene nada igual.
//
// pdfkit usa fuentes estándar (Helvetica), que NO tienen glifos de emoji → el veredicto va
// con COLOR + texto, nunca con 🟢/🔴. Los acentos del castellano sí entran (WinAnsi).
const PDFDocument = require('pdfkit');
const { fechaHoraArg } = require('./fechas');

const VERDE = '#1a7f37';
const ROJO = '#c92a2a';
const TINTA = '#1f2933';
const GRIS = '#6b7280';
const LINEA = '#9aa3ad';

const _NF0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const _NF2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmt(n) {
  if (n == null) return '-';
  return `${n < 0 ? '-' : ''}$${_NF0.format(Math.abs(Math.round(n)))}`;
}
function fmtC(n) {
  if (n == null) return '-';
  return `${n < 0 ? '-' : ''}$${_NF2.format(Math.abs(n))}`;
}
function hora(ts) {
  return ts ? ts.slice(11, 16) : '-';
}

// ¿El control salió bien? Bien = todas las cobranzas por QR/transferencia aparearon con su
// cobro en MP (0 sin aparear). Las diferencias de centavos por redondeo NO lo tumban: son
// avisos, no un descuadre. Función pura → testeable sin generar el PDF.
function veredictoMP(resultado) {
  const sinAparear = resultado.soloSistema.length + resultado.soloMp.length;
  const ok = sinAparear === 0;
  return {
    ok,
    sinAparear,
    titulo: ok ? 'CONTROL OK' : 'CONTROL CON DIFERENCIAS',
    detalle: ok
      ? 'Todas las cobranzas tienen su cobro en la plataforma.'
      : `${sinAparear} operacion(es) sin aparear: hay que revisarlas.`,
  };
}

// Veredicto de TODO el arqueo: cierra solo si cierran todas las plataformas.
function veredictoArqueo(resultados) {
  const sinAparear = resultados.reduce((a, x) => a + veredictoMP(x.resultado).sinAparear, 0);
  const conProblema = resultados.filter((x) => !veredictoMP(x.resultado).ok);
  const ok = sinAparear === 0;
  const plats = resultados.map((x) => x.plataforma.nombre).join(' + ');
  return {
    ok,
    sinAparear,
    titulo: ok ? 'CONTROL OK' : 'CONTROL CON DIFERENCIAS',
    detalle: ok
      ? `${plats}: todas las cobranzas tienen su cobro en la plataforma.`
      : `${sinAparear} operacion(es) sin aparear en ${conProblema.length} de ${resultados.length} plataforma(s).`,
  };
}

// Encabezado al estilo Sigma. Se dibuja en cada página (por eso recibe el nro).
function encabezado(doc, { cuenta, fecha, sello, usuario, pagina, titulo = 'Control de cobros' }) {
  const x = doc.page.margins.left;
  const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y0 = doc.page.margins.top;
  const izq = ancho * 0.62;

  doc.font('Helvetica-Bold').fontSize(12).fillColor(TINTA).text('Masmelos', x, y0, { width: izq });
  doc.font('Helvetica').fontSize(9).fillColor(TINTA)
    .text(`${titulo} - Cuenta ${cuenta}`, x, y0 + 16, { width: izq });
  doc.text(`Desde el ${fecha.desde} Hasta el ${fecha.hasta}`, x, y0 + 28, { width: izq });

  // Bloque derecho: página / cuándo se corrió / quién lo corrió (como Sigma).
  const xr = x + izq;
  const anchoR = ancho - izq;
  doc.fontSize(9).fillColor(TINTA);
  doc.text(`Página ${pagina}`, xr, y0, { width: anchoR, align: 'right' });
  doc.text(sello, xr, y0 + 12, { width: anchoR, align: 'right' });
  doc.text(usuario || '-', xr, y0 + 24, { width: anchoR, align: 'right' });

  doc.moveTo(x, y0 + 44).lineTo(x + ancho, y0 + 44).strokeColor(LINEA).lineWidth(0.8).stroke();
  doc.y = y0 + 54;
}

// Fila de tabla etiqueta/valor con la etiqueta a la izquierda y el valor a la derecha.
function filaLV(doc, etiqueta, valor, { x, ancho, negrita = false, color = TINTA, sangria = 0 } = {}) {
  const y = doc.y;
  doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(TINTA);
  doc.text(etiqueta, x + sangria, y, { width: ancho * 0.68 - sangria });
  doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fillColor(color);
  doc.text(valor, x + ancho * 0.68, y, { width: ancho * 0.32, align: 'right' });
  doc.fillColor(TINTA);
  doc.moveDown(0.4);
}

// Título de sección con regla, como los cortes de los reportes de Sigma.
function seccion(doc, titulo, x, ancho) {
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(TINTA).text(titulo, x, doc.y);
  doc.moveDown(0.15);
  doc.moveTo(x, doc.y).lineTo(x + ancho, doc.y).strokeColor(LINEA).lineWidth(0.5).stroke();
  doc.moveDown(0.4);
}

// El rastreo de una huérfana: en qué otra cuenta apareció ese importe. Va indentado y en
// gris, como pista (no como veredicto). Orden Haber -> Debe: de dónde salió y adónde fue.
function dibujarContrapartidas(doc, huerfana, x, ancho) {
  for (const c of (huerfana.contrapartidas || [])) {
    const cuentas = [...c.renglones]
      .sort((a, b) => (b.haber - b.debe) - (a.haber - a.debe))
      .map((g) => g.cuenta)
      .join(' -> ');
    const partes = [cuentas];
    if (c.concepto) partes.push(`"${c.concepto}"`);
    partes.push(hora(c.ingreso));
    if (c.usuario) partes.push(c.usuario);
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(GRIS)
      .text('aparece en: ' + partes.join(' · '), x + 14, doc.y, { width: ancho - 14 });
    doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
  }
}

// construirInformePDF({fecha, resultados, generadoEn, usuario}) -> Promise<Buffer>
//   fecha:      texto del día (o rango) conciliado, 'DD/MM/AAAA' o 'DD/MM/AAAA al DD/MM/AAAA'
//   resultados: [{ plataforma, cuenta, resultado }] — una entrada por plataforma arqueada
//   generadoEn: 'DD/MM/AAAA HH:MM' del momento del control (default: ahora, hora Argentina)
//   usuario:    quién corrió el control (va en el encabezado, como en Sigma)
// Acepta también la forma vieja ({cuenta, resultado}) para no romper llamadores de una sola
// plataforma.
function construirInformePDF({ fecha, resultados, cuenta, resultado, generadoEn, usuario }) {
  const lista = resultados && resultados.length
    ? resultados
    : [{ plataforma: { nombre: 'Mercado Pago', codigo: 'mp' }, cuenta, resultado }];
  const sello = generadoEn || fechaHoraArg();
  const v = veredictoArqueo(lista);
  const cuentasTxt = lista.map((x) => x.cuenta).join(' · ');
  // Título: si el PDF es de UNA plataforma (el caso del arqueo automático, un PDF por plataforma),
  // lleva su nombre; si mezcla varias (el /mp viejo), un rótulo genérico.
  const titulo = lista.length === 1 && lista[0].plataforma && lista[0].plataforma.nombre
    ? `Control ${lista[0].plataforma.nombre}`
    : 'Control de cobros';
  // 'DD/MM/AAAA al DD/MM/AAAA' -> {desde, hasta}; un solo día -> los dos iguales.
  const partes = String(fecha).split(' al ');
  const rango = { desde: partes[0], hasta: partes[1] || partes[0] };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, autoFirstPage: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let pagina = 0;
    const cab = () => {
      pagina += 1;
      encabezado(doc, { cuenta: cuentasTxt, fecha: rango, sello, usuario, pagina, titulo });
    };
    doc.on('pageAdded', cab);
    doc.addPage(); // dispara el encabezado de la página 1

    const x = doc.page.margins.left;
    const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Veredicto: recuadro de color. Es lo único que no imita a Sigma, a propósito.
    const bannerY = doc.y;
    const alto = 54;
    doc.save().rect(x, bannerY, ancho, alto).fill(v.ok ? VERDE : ROJO).restore();
    doc.fillColor('white').font('Helvetica-Bold').fontSize(16)
      .text(v.titulo, x + 14, bannerY + 10, { width: ancho - 28 });
    doc.font('Helvetica').fontSize(9.5)
      .text(v.detalle, x + 14, bannerY + 31, { width: ancho - 28 });
    doc.fillColor(TINTA);
    doc.y = bannerY + alto + 14;

    // Una sección por plataforma: resumen + lo que no cierra.
    for (const item of lista) {
      const r = item.resultado.resumen;
      const vp = veredictoMP(item.resultado);
      const nombre = (item.plataforma && item.plataforma.nombre) || 'Mercado Pago';
      const corto = (item.plataforma && item.plataforma.corto) || 'MP';
      const alcance = (item.plataforma && item.plataforma.alcanceTxt) || 'QR / transferencia';

      seccion(doc, `${nombre} — ${item.cuenta}   [${vp.ok ? 'OK' : 'CON DIFERENCIAS'}]`, x, ancho);
      filaLV(doc, 'Cobranzas apareadas 1 a 1', String(r.nPares), { x, ancho });
      if (r.nAviso) filaLV(doc, 'de esas, con aviso menor (centavos / hora)', String(r.nAviso), { x, ancho, color: GRIS, sangria: 14 });
      filaLV(doc, 'Sin aparear', String(vp.sinAparear), { x, ancho, negrita: vp.sinAparear > 0, color: vp.sinAparear ? ROJO : TINTA });
      if (r.nSoloMp) filaLV(doc, `cobró ${corto} y no está asentado`, `${r.nSoloMp} · ${fmt(r.totalSoloMp)}`, { x, ancho, color: ROJO, sangria: 14 });
      if (r.nSoloSistema) filaLV(doc, `asentado y ${corto} no lo tiene`, `${r.nSoloSistema} · ${fmt(r.totalSoloSistema)}`, { x, ancho, color: ROJO, sangria: 14 });
      doc.moveDown(0.2);
      filaLV(doc, `Total sistema (${alcance})`, fmt(r.totalSistema), { x, ancho });
      filaLV(doc, `Total ${nombre}`, fmt(r.totalMp), { x, ancho });
      filaLV(doc, 'Diferencia', fmtC(r.diferencia), { x, ancho, negrita: true, color: Math.abs(r.diferencia) > 0.05 ? ROJO : TINTA });

      if (!vp.ok) {
        const MAX = 22;
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TINTA).text('Qué no cierra', x, doc.y);
        doc.moveDown(0.2);
        let n = 0;
        for (const o of item.resultado.soloMp) {
          if (n++ >= MAX) break;
          const ref = item.plataforma && item.plataforma.referencia ? item.plataforma.referencia(o) : `id ${o.source_id || ''}`;
          doc.font('Helvetica').fontSize(9.5).fillColor(TINTA)
            .text(`Cobró ${corto} y no está asentado · ${hora(o.hora)} · ${fmt(o.bruto)}${ref ? ' · ' + ref : ''}`, x, doc.y, { width: ancho });
          dibujarContrapartidas(doc, o, x, ancho);
          doc.moveDown(0.25);
        }
        for (const m of item.resultado.soloSistema) {
          if (n++ >= MAX) break;
          doc.font('Helvetica').fontSize(9.5).fillColor(TINTA)
            .text(`Asentado y ${corto} no lo tiene · ${hora(m.ingreso)} · ${fmt(m.debe)} · ${m.comprobante || 'asiento ' + m.asiento} · ${m.cliente}`, x, doc.y, { width: ancho });
          dibujarContrapartidas(doc, m, x, ancho);
          doc.moveDown(0.25);
        }
        const restan = vp.sinAparear - Math.min(vp.sinAparear, MAX);
        if (restan > 0) doc.fillColor(GRIS).text(`...y ${restan} más.`, x, doc.y);
        if (!r.rastreo) {
          doc.moveDown(0.3);
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(GRIS)
            .text('Se concilió contra el "Mayor de cuenta" (una sola cuenta): no se pudo rastrear en qué otra '
              + 'cuenta quedó imputado el importe. Con el "Diario de movimientos" el informe lo indica.',
            x, doc.y, { width: ancho });
        }
      }
      doc.moveDown(0.5);
    }

    // Pie
    const pieY = doc.page.height - doc.page.margins.bottom - 22;
    doc.font('Helvetica').fontSize(7.5).fillColor(GRIS).text(
      'Alcance: los cobros que cada plataforma liquida en su cuenta. Point, Mercado Libre y salidas de '
      + 'dinero quedan fuera. Generado automáticamente por el bot de Más Melos.',
      x, pieY, { width: ancho, align: 'center' }
    );

    doc.end();
  });
}

module.exports = { construirInformePDF, veredictoMP };
