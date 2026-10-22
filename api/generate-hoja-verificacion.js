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

const NAVY = "#00339F", TEAL = "#16C2D5", GRAY = "#666666", LINE = "#cccccc";

export const config = { api: { responseLimit: "10mb" } };

function num(v, dec = 2) { const n = parseFloat(v); return isNaN(n) || n === null ? "—" : n.toFixed(dec); }

function fmtFechaCorta(iso) {
  if (!iso) return "—";
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

    const drawHeader = (title) => {
      drawWatermark();
      let y = 45;
      if (hasHeaderLeft || hasHeaderRight) {
        const logoH = 40;
        if (hasHeaderLeft) doc.image(logos.headerLeft, 45, y, { height: logoH });
        if (hasHeaderRight) {
          const img = doc.openImage(logos.headerRight);
          const wR = logoH * (img.width / img.height);
          doc.image(logos.headerRight, 45 + W - wR, y, { height: logoH });
        }
        y += logoH + 8;
      } else if (hasHeaderLogo) {
        doc.image(logos.header, 45, y, { width: 90 });
        y += 50;
      } else {
        doc.fontSize(13).fillColor(NAVY).font("Helvetica-Bold").text("InfusionCore", 45, y);
        y += 22;
      }
      doc.fontSize(14).fillColor(NAVY).font("Helvetica-Bold").text(title, 45, 50, { width: W, align: "center" });
      doc.fontSize(8).fillColor(TEAL).font("Helvetica").text(centerKey, 45, 68, { width: W, align: "center" });
      y = Math.max(y, 86);

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
      doc.moveTo(45, y).lineTo(45 + W, y).lineWidth(1).strokeColor(LINE).stroke();
      y += 12;
      if (hv.altoRiesgo) {
        doc.circle(45 + W - 30, y + 20, 26).fillAndStroke("#D11A2A", "#D11A2A");
        doc.fontSize(8).fillColor("#fff").font("Helvetica-Bold").text("ALTO", 45 + W - 56, y + 14, { width: 52, align: "center" });
        doc.text("RIESGO", 45 + W - 56, y + 24, { width: 52, align: "center" });
      }
      doc.y = y;
      return y;
    };

    const sectionTitle = (label, y) => {
      doc.fontSize(11).fillColor(NAVY).font("Helvetica-Bold").text(label, 45, y);
      return y + 16;
    };

    // ---------- Página 1: Orden para preparación de mezcla ----------
    let y = drawHeader("ORDEN PARA PREPARACIÓN DE MEZCLA");
    y = sectionTitle("1. Cálculo de volumen de medicamento", y + 4);
    doc.fontSize(9).fillColor("#333").font("Helvetica");
    const line = (txt) => { doc.text(txt, 45, y, { width: W }); y = doc.y + 4; };
    line(`Piezas: ${hv.piezas || "1"} frasco(s) de ${num(hv.mgFrasco, 0)} mg / ${num(hv.mlFrasco, 0)} ml`);
    line(`1.1 Concentración del medicamento:  P (${num(hv.mgFrasco, 0)} mg)  ÷  V (${num(hv.mlFrasco, 0)} ml)  =  C (${num(calculo.c)} mg/ml)`);
    line(`1.2 Volumen de medicamento a retirar:  D (${num(calculo.doseMg, 1)} mg)  ÷  C (${num(calculo.c)} mg/ml)  =  Vm (${num(calculo.vm)} ml)`);
    y += 6;
    y = sectionTitle("2. Cálculo del volumen de la mezcla", y);
    doc.fontSize(9).fillColor("#333").font("Helvetica");
    line(`2.1 Volumen a retirar del envase diluyente:  Ve (${num(hv.ve, 0)} ml)  −  Vd (${num(hv.vd, 0)} ml)  +  Vm (${num(calculo.vm)} ml)  =  Vr (${num(calculo.vr)} ml)`);
    line(`2.2 Volumen total de la mezcla:  Ve (${num(hv.ve, 0)} ml)  −  Vr (${num(calculo.vr)} ml)  +  Vm (${num(calculo.vm)} ml)  =  Vt (${num(calculo.vt)} ml)`);
    y += 6;
    y = sectionTitle("3. Concentración final de la mezcla", y);
    doc.fontSize(9).fillColor("#333").font("Helvetica");
    line(`D (${num(calculo.doseMg, 1)} mg)  ÷  Vt (${num(calculo.vt)} ml)  =  Ct (${num(calculo.ct)} mg/ml)`);

    // ---------- Página 2: Hoja de verificación ----------
    doc.addPage();
    y = drawHeader("HOJA DE VERIFICACIÓN");
    doc.fontSize(9.5).fillColor("#000").font("Helvetica-Bold").text("Fecha de preparación:", 45, y + 4, { continued: true })
      .font("Helvetica").text(`  ${fmtFechaCorta(hv.fechaPreparacion)}  ${hv.horaPreparacion || ""} HRS`);
    y = doc.y + 10;

    y = sectionTitle("Lote y caducidad", y);
    const tableW = W, col = [tableW * 0.22, tableW * 0.2, tableW * 0.2, tableW * 0.2, tableW * 0.18];
    const headRow = (labels) => {
      doc.rect(45, y, tableW, 16).fill("#D9D9D9");
      let x = 45;
      doc.fontSize(8).fillColor("#000").font("Helvetica-Bold");
      labels.forEach((l, i) => { doc.text(l, x + 3, y + 4, { width: col[i] - 6 }); x += col[i]; });
      y += 16;
    };
    const dataRow = (vals) => {
      doc.rect(45, y, tableW, 16).stroke(LINE);
      let x = 45;
      doc.fontSize(8.5).fillColor("#333").font("Helvetica");
      vals.forEach((v, i) => { doc.text(v || "", x + 3, y + 4, { width: col[i] - 6 }); x += col[i]; });
      y += 16;
    };
    headRow(["Artículo", "Presentación", "Piezas", "Lote", "Caducidad"]);
    dataRow([(medName || "").toUpperCase(), `${num(hv.mgFrasco,0)}/${num(hv.mlFrasco,0)}ML`, String(hv.piezas || "1"), hv.loteMed || "", fmtFechaCorta(hv.cadMed)]);
    dataRow([(diluent || "").toUpperCase(), hv.ve ? `${hv.ve} ML` : "", "1", hv.loteDil || "", fmtFechaCorta(hv.cadDil)]);
    y += 14;

    y = sectionTitle("Verificación de la mezcla", y);
    doc.fontSize(8.5).fillColor("#333").font("Helvetica");
    const checklistLine = (txt) => { doc.text(txt, 45, y, { width: W }); y = doc.y + 3; };
    doc.font("Helvetica-Bold").fontSize(8.5).text("Antes de la mezcla:", 45, y); y = doc.y + 2;
    doc.font("Helvetica").fontSize(8.5);
    checklistLine("1. Realizar técnica de lavado de manos antes de ingresar al área de mezclado.");
    checklistLine("2. Preparar material necesario para la mezcla.");
    checklistLine("3. Verificar el adecuado funcionamiento del gabinete de bioseguridad.");
    checklistLine("4. Colocarse equipo de protección para resguardar la seguridad personal y procedimiento aséptico.");
    y += 6;
    doc.font("Helvetica-Bold").fontSize(8.5).text("Durante la mezcla:", 45, y); y = doc.y + 2;
    doc.font("Helvetica").fontSize(8.5);
    checklistLine(`1. Retirar ${num(calculo.vr)} ml del envase diluyente.`);
    checklistLine(`2. Extraer ${num(calculo.vm)} ml del (de los) vial(es) de medicamento.`);
    checklistLine(`3. Inyectar el volumen de medicamento en el diluyente y homogenizar.  ¿Se homogeniza?  ${hv.homogeniza === true ? "SÍ" : hv.homogeniza === false ? "NO" : "—"}`);
    y += 6;
    doc.font("Helvetica-Bold").fontSize(8.5).text("Posterior a la mezcla:", 45, y); y = doc.y + 2;
    doc.font("Helvetica").fontSize(8.5);
    checklistLine(`1. La mezcla está libre de partículas, homogeneizada:  ${hv.libreParticulas === true ? "SÍ" : hv.libreParticulas === false ? "NO" : "—"}`);
    checklistLine(`2. Fecha y hora de expiración:  ${fmtFechaCorta(hv.fechaExpiracion)}  ${hv.horaExpiracion || ""} HRS`);
    checklistLine(`3. Condición de almacenamiento:  ${hv.condicionAlmacenamiento === "ambiente" ? "Ambiente" : "Refrigeración"}`);

    // Firmas: preparado por / revisado por -- mismo patrón que
    // generate-material-order.js (imagen de firma + nombre debajo).
    const sigLines = [
      { label: "PREPARADO POR", name: hv.preparadoPorName, buffer: prepBuf, date: hv.preparadoAt },
      { label: "REVISADO POR", name: hv.revisadoPorName, buffer: revBuf, date: hv.revisadoAt },
    ];
    const sigBoxY = Math.max(y + 24, doc.page.height - 130);
    const finalSigY = (sigBoxY + 60 > doc.page.height - 45) ? (doc.addPage(), drawWatermark(), 60) : sigBoxY;
    const sigW = (W - 20) / 2;
    sigLines.forEach((line, i) => {
      const x = 45 + i * (sigW + 20);
      if (line.buffer) { try { doc.image(line.buffer, x + sigW / 2 - 30, finalSigY, { fit: [60, 34], align: "center" }); } catch (e) {} }
      doc.moveTo(x, finalSigY + 40).lineTo(x + sigW, finalSigY + 40).lineWidth(0.75).strokeColor(LINE).stroke();
      doc.fontSize(9).fillColor(GRAY).font("Helvetica-Bold").text(line.label, x, finalSigY + 44, { width: sigW, align: "center" });
      doc.fontSize(7.5).fillColor(GRAY).font("Helvetica").text(line.name || "Pendiente", x, finalSigY + 58, { width: sigW, align: "center" });
      if (line.date) doc.fontSize(7).fillColor("#999").text(new Date(line.date).toLocaleString("es-MX"), x, finalSigY + 70, { width: sigW, align: "center" });
    });

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
