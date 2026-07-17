// Informe PDF de la conciliación de Mercado Pago (/mp): una hoja que dice si el control
// salió BIEN o MAL, con la fecha del día conciliado y la fecha+hora en que se corrió.
// Es el comprobante para archivar/imprimir; el detalle fino queda en el mensaje de Telegram.
//
// pdfkit usa fuentes estándar (Helvetica), que NO tienen glifos de emoji → el veredicto se
// muestra con COLOR + texto (verde/rojo), nunca con 🟢/🔴. Los acentos del castellano sí
// entran (WinAnsi).
const PDFDocument = require('pdfkit');
const { fechaHoraArg } = require('./fechas');

const VERDE = '#1a7f37';
const ROJO = '#c92a2a';
const TINTA = '#1f2933';
const GRIS = '#6b7280';
const LINEA = '#d7dbe0';

const _NF0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const _NF2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmt(n) {
  if (n == null) return '—';
  return `${n < 0 ? '-' : ''}$${_NF0.format(Math.abs(Math.round(n)))}`;
}
function fmtC(n) {
  if (n == null) return '—';
  return `${n < 0 ? '-' : ''}$${_NF2.format(Math.abs(n))}`;
}
function hora(ts) {
  return ts ? ts.slice(11, 16) : '—';
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
      ? 'Todas las cobranzas por QR / transferencia tienen su cobro en Mercado Pago.'
      : `${sinAparear} operacion(es) sin aparear: hay que revisarlas.`,
  };
}

// Fila etiqueta/valor alineada (etiqueta a la izquierda, valor a la derecha).
function filaLV(doc, etiqueta, valor, { x, ancho, negrita = false, color = TINTA } = {}) {
  const y = doc.y;
  doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(11).fillColor(TINTA);
  doc.text(etiqueta, x, y, { width: ancho * 0.62, continued: false });
  doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fillColor(color);
  doc.text(valor, x + ancho * 0.62, y, { width: ancho * 0.38, align: 'right' });
  doc.fillColor(TINTA);
  doc.moveDown(0.35);
}

// construirInformePDF({fecha, cuenta, resultado, generadoEn}) -> Promise<Buffer>
//   fecha:      texto del día (o rango) conciliado, 'DD/MM/AAAA'
//   cuenta:     nombre de la cuenta (MERCADO PAGO MORENO)
//   resultado:  lo que devuelve conciliarMP()
//   generadoEn: 'DD/MM/AAAA HH:MM' del momento del control (default: ahora, hora Argentina)
function construirInformePDF({ fecha, cuenta, resultado, generadoEn }) {
  const sello = generadoEn || fechaHoraArg();
  const v = veredictoMP(resultado);
  const r = resultado.resumen;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const x = doc.page.margins.left;
    const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Encabezado
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS)
      .text('MÁS MELOS · CONTROL MERCADO PAGO', x, doc.page.margins.top, { characterSpacing: 1 });
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(TINTA).text('Conciliación Mercado Pago');
    doc.font('Helvetica').fontSize(11).fillColor(GRIS)
      .text(`${cuenta} · operación por operación`);
    doc.moveDown(1);

    // Banner del veredicto (rectángulo de color, texto blanco)
    const bannerY = doc.y;
    const bannerAlto = 62;
    doc.save().roundedRect(x, bannerY, ancho, bannerAlto, 6).fill(v.ok ? VERDE : ROJO).restore();
    doc.fillColor('white').font('Helvetica-Bold').fontSize(18)
      .text(v.titulo, x + 16, bannerY + 12, { width: ancho - 32 });
    doc.font('Helvetica').fontSize(10.5)
      .text(v.detalle, x + 16, bannerY + 37, { width: ancho - 32 });
    doc.fillColor(TINTA);
    doc.y = bannerY + bannerAlto + 18;

    // Fechas (el requisito: fecha del control y fecha+hora en que se corrió)
    filaLV(doc, 'Día conciliado', fecha, { x, ancho, negrita: true });
    filaLV(doc, 'Control corrido', sello, { x, ancho });
    doc.moveDown(0.4);
    doc.moveTo(x, doc.y).lineTo(x + ancho, doc.y).strokeColor(LINEA).stroke();
    doc.moveDown(0.6);

    // Resumen
    doc.font('Helvetica-Bold').fontSize(12).fillColor(TINTA).text('Resumen'); doc.moveDown(0.4);
    filaLV(doc, 'Cobranzas apareadas 1 a 1', String(r.nPares), { x, ancho });
    if (r.nAviso) filaLV(doc, '  · de esas, con aviso menor (redondeo/hora)', String(r.nAviso), { x, ancho, color: GRIS });
    filaLV(doc, 'Sin aparear', String(v.sinAparear), { x, ancho, negrita: v.sinAparear > 0, color: v.sinAparear ? ROJO : TINTA });
    if (r.nSoloMp) filaLV(doc, '  · cobró MP y no está asentado', `${r.nSoloMp} · ${fmt(r.totalSoloMp)}`, { x, ancho, color: ROJO });
    if (r.nSoloSistema) filaLV(doc, '  · asentado y MP no lo tiene', `${r.nSoloSistema} · ${fmt(r.totalSoloSistema)}`, { x, ancho, color: ROJO });
    doc.moveDown(0.3);
    filaLV(doc, 'Total sistema (QR / transferencia)', fmt(r.totalSistema), { x, ancho });
    filaLV(doc, 'Total Mercado Pago', fmt(r.totalMp), { x, ancho });
    filaLV(doc, 'Diferencia', fmtC(r.diferencia), { x, ancho, negrita: true, color: Math.abs(r.diferencia) > 0.05 ? ROJO : TINTA });

    // Detalle de lo que no cierra (solo si hay diferencias)
    if (!v.ok) {
      const MAX = 22;
      doc.moveDown(0.6);
      doc.moveTo(x, doc.y).lineTo(x + ancho, doc.y).strokeColor(LINEA).stroke();
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(TINTA).text('Qué no cierra'); doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10).fillColor(TINTA);
      let n = 0;
      for (const o of resultado.soloMp) {
        if (n++ >= MAX) break;
        doc.text(`Cobró MP y no está asentado — ${hora(o.hora)} · ${fmt(o.bruto)} · id ${o.source_id}`, x, doc.y);
        doc.moveDown(0.2);
      }
      for (const m of resultado.soloSistema) {
        if (n++ >= MAX) break;
        doc.text(`Asentado y MP no lo tiene — ${hora(m.ingreso)} · ${fmt(m.debe)} · ${m.comprobante || 'asiento ' + m.asiento} · ${m.cliente}`, x, doc.y);
        doc.moveDown(0.2);
      }
      const restan = v.sinAparear - Math.min(v.sinAparear, MAX);
      if (restan > 0) doc.fillColor(GRIS).text(`…y ${restan} más.`, x, doc.y);
    }

    // Pie
    const pieY = doc.page.height - doc.page.margins.bottom - 26;
    doc.font('Helvetica').fontSize(8).fillColor(GRIS);
    doc.text(
      'Alcance: ventas cobradas por QR / transferencia (cuenta MERCADO PAGO MORENO). ' +
      'Point, Mercado Libre y salidas de dinero quedan fuera. Generado automáticamente por el bot.',
      x, pieY, { width: ancho, align: 'center' }
    );

    doc.end();
  });
}

module.exports = { construirInformePDF, veredictoMP };
