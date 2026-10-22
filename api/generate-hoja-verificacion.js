import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, "assets");

// Mismo criterio de logos que generate-pdf.js (bitácora) -- CITIO lleva un
// solo logo, CIPI dos (izquierda/derecha), ambos con su propia marca de agua.
const CENTER_LOGOS = {
  CITIO: { header: path.join(ASSETS_DIR, "logo-citio-header.png"), watermark: path.join(ASSETS_DIR, "logo-citio-watermark.png") },
  CIPI:  { headerLeft: path.join(ASSETS_DIR, "logo-cipi-header-left.png"), headerRight: path.join(ASSETS_DIR, "logo-cipi-header-right.png"), watermark: path.join(ASSETS_DIR, "logo-cipi-watermark.png") },
};

const NAVY = "#00339F", TEAL = "#16C2D5", GRAY = "#666666", LINE = "#000000", LINE_SOFT = "#cccccc", HEAD_BG = "#D9D9D9";

export const config = { api: { responseLimit: "10mb" } };

function num(v, dec = 2) { const n = parseFloat(v); return isNaN(n) || v === null || v === undefined ? "" : n.toFixed(dec); }

function fmtFechaCorta(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { center, patientName, dob, date, medName, dose, diluent, hv, calculo } = req.body;

  try {
    const fetchSigBuffer = async (url) => {
      if (!url) return null;
      try { const r = await fetch(url); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()); }
      catch (e) { return null; }
    };
    const [prepBuf, revBuf] = await Promise.all([fetchSigBuffer(hv.preparadoSignatureUrl), fetchSigBuffer(hv.revisadoSignatureUrl)]);

    const centerKey = (center || "CITIO").toUpperCase();
    const logos = CENTER_LOGOS[centerKey] || CENTER_LOGOS.CITIO;
    const hasHeaderLogo = logos.header && fs.existsSync(logos.header);
    const hasHeaderLeft = logos.headerLeft && fs.existsSync(logos.headerLeft);
    const hasHeaderRight = logos.headerRight && fs.existsSync(logos.headerRight);
    const hasWatermarkLogo = logos.watermark && fs.existsSync(logos.watermark);

    const PDFDocument = (await import("pdfkit")).default;
    const chunks = [];
    const doc = new PDFDocument({ size: "LETTER", margin: 45, bufferPages: true });
    doc.on("data", chunk => chunks.push(chunk));

    const W = doc.page.width - 90;

    const drawWatermark = () => {
      doc.save();
      if (hasWatermarkLogo) {
        const size = 300;
        doc.image(logos.watermark, (doc.page.width - size) / 2, (doc.page.height - size) / 2, { width: size });
      } else {
        doc.opacity(0.06);
        doc.fontSize(80).fillColor(NAVY).font("Helvetica-Bold").text("InfusionCore", 80, 320, { width: W, align: "center" });
      }
      doc.restore();
    };

    // ---- Helpers de dibujo, estilo CEMI (lib/pdf/CalculoVerificacionPdf.jsx):
    // tablas con encabezado gris, cajas con barra de título gris, y valores
    // de fórmula en pequeñas cajas subrayadas en vez de texto corrido. ----

    const sectionTitle = (label, y, size = 11) => {
      doc.fontSize(size).fillColor(NAVY).font("Helvetica-Bold").text(label, 45, y, { width: W, align: size > 9 ? "left" : "center" });
      return y + (size > 9 ? 16 : 14);
    };

    // Tabla simple: un encabezado gris + N filas, columnas de ancho fijo.
    function tabla(y, cols, filas) {
      doc.rect(45, y, W, 15).fillAndStroke(HEAD_BG, LINE);
      let x = 45;
      doc.fontSize(8).fillColor("#000").font("Helvetica-Bold");
      cols.forEach(c => { doc.text(c.label, x + 4, y + 4, { width: c.w - 6, lineBreak: false }); x += c.w; });
      y += 15;
      filas.forEach(fila => {
        doc.rect(45, y, W, 15).stroke(LINE);
        x = 45;
        doc.fontSize(8.5).fillColor("#222").font("Helvetica");
        cols.forEach((c, i) => { doc.text(fila[i] || "", x + 4, y + 4, { width: c.w - 6, lineBreak: false }); x += c.w; });
        y += 15;
      });
      return y;
    }

    // Renglón de fórmula con valores en cajita subrayada (como los "Valor"
    // de CEMI) en vez de texto corrido -- deja clarísimo cuál es cada dato
    // capturado/calculado dentro de la fórmula.
    function formulaRow(segs, y) {
      let x = 50;
      segs.forEach(seg => {
        if (seg.v !== undefined) {
          doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#000");
          const txt = seg.v === "" || seg.v === null ? " " : String(seg.v);
          const w = Math.max(30, doc.widthOfString(txt) + 10);
          doc.text(txt, x, y, { width: w, align: "center", lineBreak: false });
          doc.moveTo(x, y + 12).lineTo(x + w, y + 12).lineWidth(0.75).strokeColor(LINE).stroke();
          x += w + 3;
          if (seg.u) {
            doc.font("Helvetica").fontSize(7.5).fillColor("#555");
            doc.text(seg.u, x, y + 2, { lineBreak: false });
            x += doc.widthOfString(seg.u) + 8;
          }
        } else {
          doc.font(seg.b ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor("#333");
          doc.text(seg.t, x, y, { lineBreak: false });
          x += doc.widthOfString(seg.t);
        }
      });
      return y + 17;
    }

    const bodyLine = (txt, y, opts = {}) => {
      doc.fontSize(opts.size || 8.2).fillColor(opts.color || "#333").font(opts.bold ? "Helvetica-Bold" : "Helvetica");
      doc.text(txt, 45, y, { width: W });
      return doc.y + 3;
    };

    const drawHeader = (title) => {
      drawWatermark();
      let logoBottom = 45;
      if (hasHeaderLeft || hasHeaderRight) {
        const logoH = 40;
        if (hasHeaderLeft) doc.image(logos.headerLeft, 45, 45, { height: logoH });
        if (hasHeaderRight) {
          const img = doc.openImage(logos.headerRight);
          const wR = logoH * (img.width / img.height);
          doc.image(logos.headerRight, 45 + W - wR, 45, { height: logoH });
        }
        logoBottom = 45 + logoH + 8;
      } else if (hasHeaderLogo) {
        doc.image(logos.header, 45, 45, { width: 90 });
        logoBottom = 95;
      } else {
        doc.fontSize(13).fillColor(NAVY).font("Helvetica-Bold").text("InfusionCore", 45, 45);
        logoBottom = 67;
      }
      doc.fontSize(14).fillColor(NAVY).font("Helvetica-Bold").text(title, 45, 50, { width: W, align: "center" });
      doc.fontSize(8).fillColor(TEAL).font("Helvetica").text(centerKey, 45, 68, { width: W, align: "center" });
      let y = Math.max(logoBottom, 86);
      const infoStartY = y;

      // Sello de alto riesgo -- junto al bloque de datos (como en la
      // referencia), con ancho angosto para no encimarse con "Diluyente:"
      // (ese renglón usa width:460 de los W≈522 disponibles).
      if (hv.altoRiesgo) {
        const bx = 45 + W - 26, by = infoStartY + 16;
        doc.circle(bx, by, 22).fillAndStroke("#D11A2A", "#D11A2A");
        doc.fontSize(7.5).fillColor("#fff").font("Helvetica-Bold").text("ALTO", bx - 22, by - 8, { width: 44, align: "center" });
        doc.text("RIESGO", bx - 22, by + 2, { width: 44, align: "center" });
      }

      doc.fontSize(9.5).fillColor("#000").font("Helvetica-Bold").text("Paciente:", 45, y, { continued: true }).font("Helvetica").text(`  ${patientName || ""}`, { width: 250 });
      doc.font("Helvetica-Bold").text("F. Nac:", 320, y, { continued: true }).font("Helvetica").text(`  ${fmtFechaCorta(dob)}`);
      y += 15;
      doc.font("Helvetica-Bold").text("Médico:", 45, y, { continued: true }).font("Helvetica").text(`  ${hv.medico || ""}`, { width: 250 });
      doc.font("Helvetica-Bold").text("Fecha:", 320, y, { continued: true }).font("Helvetica").text(`  ${fmtFechaCorta(date)}`);
      y += 15;
      doc.font("Helvetica-Bold").text("Medicamento:", 45, y, { continued: true }).font("Helvetica").text(`  ${medName || ""} ${dose || ""}`, { width: 460 });
      y += 15;
      doc.font("Helvetica-Bold").text("Diluyente:", 45, y, { continued: true }).font("Helvetica").text(`  ${diluent || ""}`, { width: 460 });
      y += 18;
      doc.moveTo(45, y).lineTo(45 + W, y).lineWidth(1).strokeColor(LINE_SOFT).stroke();
      y += 10;
      return y;
    };

    const activo = (medName || "").toUpperCase();
    const diluyenteUp = (diluent || "").toUpperCase();

    // ---------- Página 1: Orden para preparación de mezcla ----------
    let y = drawHeader("ORDEN PARA PREPARACIÓN DE MEZCLA");
    y = sectionTitle("SOLICITUD DE MEZCLA", y + 8, 11);
    y = tabla(y, [{ label: "Medicamento", w: W * 0.32 }, { label: "Dosis", w: W * 0.14 }, { label: "Diluyente", w: W * 0.39 }, { label: "Volumen Total", w: W * 0.15 }],
      [[activo, dose || "", diluyenteUp, hv.vd ? `${hv.vd} ML` : ""]]);
    y += 10;

    y = sectionTitle("CÁLCULO DE MEZCLA", y, 11);
    y += 2;
    y = tabla(y, [{ label: "Medicamento", w: W * 0.7 }, { label: "Dosis", w: W * 0.3 }], [[activo, dose || ""]]);
    y += 6;
    y = bodyLine("1.1 Presentación y volumen medicamento:", y, { bold: true });
    y = formulaRow([
      { t: "1.- " },
      { v: num(hv.mgFrasco, 0), u: "mg" }, { t: " / " }, { v: num(hv.mlFrasco, 0), u: "ml" },
      { t: "   Piezas " }, { v: hv.piezas || "1" },
      { t: "   P" }, { v: num(hv.mgFrasco, 0), u: "mg" }, { t: " % V" }, { v: num(hv.mlFrasco, 0), u: "ml" },
      { t: " = C" }, { v: num(calculo.c), u: "mg/ml" },
    ], y);
    y = bodyLine("1.2 Concentración medicamento: P presentación (mg) % V volumen (ml) = C concentración (mg/ml)", y + 2);
    y += 4;
    y = bodyLine(`1.3 Calculo de volumen de ${activo} a retirar: D dosis medicamento (mg) % C concentración (mg/ml) = Vm volumen de medicamento`, y, { bold: true });
    y = formulaRow([
      { t: "D" }, { v: num(calculo.doseMg, 1), u: "mg" }, { t: " % C" }, { v: num(calculo.c), u: "mg/ml" },
      { t: " = Vm" }, { v: num(calculo.vm), u: "ml" },
    ], y);
    y += 6;

    y = tabla(y, [{ label: "Diluyente", w: W * 0.7 }, { label: "Vol. Total", w: W * 0.3 }], [[diluyenteUp, hv.vd ? `${hv.vd} ML` : ""]]);
    y += 6;
    y = bodyLine("2.1 Volumen a retirar en el envase diluyente: Ve volumen envase – Vd volumen diluyente + Vm volumen de medicamento (ml) = Vr volumen a retirar", y, { bold: true });
    y = formulaRow([
      { t: "Ve" }, { v: num(hv.ve, 0), u: "ml" }, { t: " -  Vd" }, { v: num(hv.vd, 0), u: "ml" },
      { t: " +  Vm" }, { v: num(calculo.vm), u: "ml" }, { t: " =  Vr" }, { v: num(calculo.vr), u: "ml" },
    ], y);
    y = bodyLine("2.2 Calculo del volumen total en el envase mezclado medicamento/diluyente: Ve volumen envase – Vr volumen retirado + Vm Volumen medicamento = Vt volumen total", y + 2, { bold: true });
    y = formulaRow([
      { t: "Ve" }, { v: num(hv.ve, 0), u: "ml" }, { t: " -  Vr" }, { v: num(calculo.vr), u: "ml" },
      { t: " +  Vm" }, { v: num(calculo.vm), u: "ml" }, { t: " =  Vt" }, { v: num(calculo.vt), u: "ml" },
    ], y);
    y += 6;

    y = sectionTitle("3. Calculo de la concentración del producto mezclado", y, 9.5);
    y = bodyLine("D dosis del paciente (mg) % Vt volumen total = Ct Concentración Total", y);
    y = formulaRow([
      { t: "D" }, { v: num(calculo.doseMg, 1), u: "mg" }, { t: " % Vt" }, { v: num(calculo.vt), u: "ml" },
      { t: " = Ct" }, { v: num(calculo.ct), u: "mg/ml" },
    ], y);

    // ---------- Página 2: Hoja de verificación ----------
    doc.addPage();
    y = drawHeader("HOJA DE VERIFICACIÓN");
    y += 8;
    doc.fontSize(9.5).fillColor("#000").font("Helvetica-Bold").text("Fecha de preparación:", 45, y, { continued: true })
      .font("Helvetica").text(`  ${fmtFechaCorta(hv.fechaPreparacion)}  (dd/mm/aaaa)   Hora: ${hv.horaPreparacion || ""} HRS`);
    y = doc.y + 10;

    const colLote = [
      { label: "Nombre Comercial (activo)", w: W * 0.31 }, { label: "Presentación", w: W * 0.13 },
      { label: "Fabricante", w: W * 0.15 }, { label: "Lote", w: W * 0.13 },
      { label: "Caducidad", w: W * 0.11 }, { label: "Piezas", w: W * 0.07 }, { label: "Rev. por", w: W * 0.09 },
    ];
    y = tabla(y, colLote, [
      [activo, `${num(hv.mgFrasco,0)}/${num(hv.mlFrasco,0)}ML`, hv.marcaMed || "", hv.loteMed || "", fmtFechaCorta(hv.cadMed), String(hv.piezas || "1"), hv.revisadoPorName ? hv.revisadoPorName.split(" ")[0] : ""],
      [diluyenteUp, hv.ve ? `${hv.ve} ML` : "", hv.marcaDil || "", hv.loteDil || "", fmtFechaCorta(hv.cadDil), "1", hv.revisadoPorName ? hv.revisadoPorName.split(" ")[0] : ""],
    ]);
    y += 12;

    y = sectionTitle("VERIFICACIÓN DE LA MEZCLA", y, 11);
    y += 2;
    y = bodyLine("Antes de la mezcla:", y, { bold: true, color: "#000" });
    y = bodyLine("1. Realizar técnica de lavado de manos antes de ingresar al área de mezclado.", y);
    y = bodyLine("2. Preparar material necesario para la mezcla.", y);
    y = bodyLine("3. Verificar el adecuado funcionamiento del gabinete de bioseguridad.", y);
    y = bodyLine("4. Colocarse equipo de protección para resguardar la seguridad personal y procedimiento aséptico.", y);
    y += 6;

    y = bodyLine("Durante la mezcla:", y, { bold: true, color: "#000" });
    y = bodyLine(`1. Retirar ${num(calculo.vr)} ml del envase diluyente.`, y);
    y = bodyLine(`2. Extraer ${num(calculo.vm)} ml del (de los) vial(es) de medicamento.`, y);
    // "¿Se homogeniza?" y "¿Libre de partículas?" se imprimen en blanco a
    // propósito -- esa verificación se hace presencial, al momento de
    // mezclar, no se captura digitalmente (mismo criterio que CEMI).
    y = bodyLine("3. Inyectar el volumen de medicamento en el diluyente y homogenizar.  ¿Se homogeniza?  Sí: ___  No: ___", y);
    y += 6;

    y = bodyLine("Posterior a la mezcla:", y, { bold: true, color: "#000" });
    y = bodyLine("1. La mezcla está libre de partículas, homogeneizada:  Sí: ___  No: ___", y);
    y = bodyLine(`2. Fecha y hora de expiración:  ${fmtFechaCorta(hv.fechaExpiracion)}  ${hv.horaExpiracion || ""} HRS`, y);
    y = bodyLine(`3. Condición de almacenamiento:  ${hv.condicionAlmacenamiento === "ambiente" ? "Ambiente" : "Refrigeración"}`, y);

    // Firmas: preparado por / revisado por -- mismo patrón que
    // generate-material-order.js (imagen de firma + nombre debajo).
    const sigLines = [
      { label: "PREPARADO POR", name: hv.preparadoPorName, buffer: prepBuf, date: hv.preparadoAt },
      { label: "REVISADO POR", name: hv.revisadoPorName, buffer: revBuf, date: hv.revisadoAt },
    ];
    // 100pt reservados desde sigBoxY hasta el renglón de "SELLO DE
    // VERIFICADO" (ver más abajo) -- si no caben completos antes del
    // margen inferior, todo el bloque de firmas se pasa a una página nueva.
    const SIG_BLOCK_H = 100;
    const sigBoxY = Math.max(y + 24, doc.page.height - 45 - SIG_BLOCK_H);
    const finalSigY = (sigBoxY + SIG_BLOCK_H > doc.page.height - 45) ? (doc.addPage(), drawWatermark(), 60) : sigBoxY;
    const sigW = (W - 20) / 2;
    sigLines.forEach((line, i) => {
      const x = 45 + i * (sigW + 20);
      if (line.buffer) { try { doc.image(line.buffer, x + sigW / 2 - 30, finalSigY, { fit: [60, 34], align: "center" }); } catch (e) {} }
      doc.moveTo(x, finalSigY + 40).lineTo(x + sigW, finalSigY + 40).lineWidth(0.75).strokeColor(LINE_SOFT).stroke();
      doc.fontSize(9).fillColor(GRAY).font("Helvetica-Bold").text(line.label, x, finalSigY + 44, { width: sigW, align: "center" });
      doc.fontSize(7.5).fillColor(GRAY).font("Helvetica").text(line.name || "Pendiente", x, finalSigY + 58, { width: sigW, align: "center" });
      if (line.date) doc.fontSize(7).fillColor("#999").text(new Date(line.date).toLocaleString("es-MX"), x, finalSigY + 70, { width: sigW, align: "center" });
    });
    doc.fontSize(9).fillColor(NAVY).font("Helvetica-Bold").text("SELLO DE VERIFICADO", 45, finalSigY + 84, { width: W, align: "center" });

    doc.end();
    await new Promise((resolve, reject) => { doc.on("end", resolve); doc.on("error", reject); });

    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="HOJA_VERIFICACION_${(patientName || "paciente").replace(/\s+/g, "_")}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
