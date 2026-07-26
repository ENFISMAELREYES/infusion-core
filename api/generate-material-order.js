import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, "assets");

const CENTER_LOGOS = {
  CITIO: {
    header: path.join(ASSETS_DIR, "logo-citio-header.png"),
    watermark: path.join(ASSETS_DIR, "logo-citio-watermark.png"),
    name: "CENTRO DE INFUSIÓN, TRATAMIENTO E INVESTIGACIÓN ONCOLÓGICA",
  },
  CIPI_PRO: {
    header: path.join(ASSETS_DIR, "logo-cipi-header-left.png"),
    watermark: path.join(ASSETS_DIR, "logo-cipi-watermark.png"),
    name: "CENTRO DE INFUSIÓN PROFESIONAL INTEGRAL",
  },
  CIPI_PED: {
    header: path.join(ASSETS_DIR, "logo-cipi-header-right.png"),
    watermark: path.join(ASSETS_DIR, "logo-cipi-watermark.png"),
    name: "CENTRO DE INFUSIÓN PEDIÁTRICA INTEGRAL",
  },
};

const NAVY = "#00339F", GRAY = "#666666", LINE = "#cccccc";

export const config = { api: { responseLimit: "10mb" } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { center, cipiVariant, patientName, cycle, date, groups, note, anexoNumber, scope } = req.body;

  try {
    const centerKey = (center || "CITIO").toUpperCase();
    const logoKey = centerKey === "CIPI" ? `CIPI_${(cipiVariant || "PRO").toUpperCase()}` : centerKey;
    const logos = CENTER_LOGOS[logoKey] || CENTER_LOGOS.CITIO;
    const hasHeaderLogo = logos.header && fs.existsSync(logos.header);
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

    drawWatermark();

    // Encabezado: logo institucional (según centro/variante), apilado sobre el
    // nombre completo de la empresa (evita que se encimen sin importar la
    // proporción de cada logo).
    let y = 45;
    if (hasHeaderLogo) {
      doc.image(logos.header, 45, y, { fit: [160, 42], align: "left" });
      y += 48;
      doc.fontSize(9).fillColor(NAVY).font("Helvetica-Bold").text(logos.name, 45, y, { width: W });
      y += 18;
    } else {
      doc.fontSize(11).fillColor(NAVY).font("Helvetica-Bold").text(logos.name, 45, y, { width: W });
      y += 24;
    }

    const title = anexoNumber ? `ANEXO ${anexoNumber} A SOLICITUD DE MATERIAL`
      : scope === "medicamentos" ? "SOLICITUD DE MEDICAMENTOS"
      : scope === "material" ? "SOLICITUD DE MATERIAL"
      : "SOLICITUD DE MATERIAL";
    doc.fontSize(15).fillColor(NAVY).font("Helvetica-Bold").text(title, 45, y, { width: W, align: "center" });
    y += 28;

    const fmtDate = (iso) => {
      if (!iso) return "";
      const [yy, mm, dd] = iso.split("-");
      return `${dd}/${mm}/${yy}`;
    };
    const today = new Date();
    const todayStr = `${String(today.getDate()).padStart(2,"0")}/${String(today.getMonth()+1).padStart(2,"0")}/${today.getFullYear()}`;

    doc.fontSize(10).fillColor("#000");
    doc.font("Helvetica-Bold").text("EMPRESA:", 45, y, { continued: true, width: 200 }).font("Helvetica").text(`  ${centerKey}${centerKey === "CIPI" ? ` (${(cipiVariant||"PRO").toUpperCase()})` : ""}`);
    doc.font("Helvetica-Bold").text("FECHA DE SOLICITUD:", 300, y, { continued: true }).font("Helvetica").text(`  ${todayStr}`);
    y += 16;
    doc.font("Helvetica-Bold").text("CONCEPTO:", 45, y, { continued: true }).font("Helvetica").text(`  ${(patientName || "").toUpperCase()} ${cycle || ""}`.trim());
    y += 16;
    doc.font("Helvetica-Bold").text("FECHA DE ENTREGA:", 45, y, { continued: true }).font("Helvetica").text(`  ${fmtDate(date)}`);
    y += 20;
    doc.moveTo(45, y).lineTo(45 + W, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 14;

    const sectionTitle = (label) => {
      doc.fontSize(11).fillColor(NAVY).font("Helvetica-Bold").text(label, 45, y);
      y += 16;
    };
    const itemRow = (item, qty) => {
      doc.fontSize(9.5).fillColor("#000").font("Helvetica-Bold").text(item, 45, y, { width: W - 50 });
      doc.font("Helvetica-Bold").text(String(qty), 45 + W - 40, y, { width: 40, align: "right" });
      y += 14;
      if (y > doc.page.height - 90) { doc.addPage(); drawWatermark(); y = 45; }
    };

    ["MEDICAMENTOS", "SOLUCIONES", "INSUMOS"].forEach((cat) => {
      const items = (groups && groups[cat]) || [];
      if (items.length === 0) return;
      sectionTitle(cat);
      items.forEach(t => itemRow(t.item, t.qty));
      y += 10;
    });

    if (note) {
      sectionTitle("NOTA");
      doc.fontSize(9.5).fillColor("#000").font("Helvetica").text(note, 45, y, { width: W });
    }

    doc.end();
    await new Promise((resolve, reject) => { doc.on("end", resolve); doc.on("error", reject); });

    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    const fnamePrefix = anexoNumber ? `ANEXO${anexoNumber}` : "SOLICITUD";
    res.setHeader("Content-Disposition", `inline; filename="${fnamePrefix}_${centerKey}_${(patientName || "paciente").replace(/\s+/g, "_")}.pdf"`);
    res.send(pdfBuffer);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
