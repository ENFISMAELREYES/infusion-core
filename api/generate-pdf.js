import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, "assets");

// Logos institucionales por centro (se agregan conforme estén disponibles)
const CENTER_LOGOS = {
  CITIO: {
    header: path.join(ASSETS_DIR, "logo-citio-header.png"),
    watermark: path.join(ASSETS_DIR, "logo-citio-watermark.png"),
  },
  // CIPI: { header: path.join(ASSETS_DIR, "logo-cipi-header.png"), watermark: path.join(ASSETS_DIR, "logo-cipi-watermark.png") },
};

export const config = { api: { responseLimit: '10mb' } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { patientName, sessionIds, center, token } = req.body;

  try {
    const PROJECT_ID = "infusion-core";

    // Obtener access token
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/datastore"],
    });
    const accessToken = await auth.getAccessToken();

    // Fetch sesiones del paciente
    const queryRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`,
      { method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: "sessions" }],
          where: { compositeFilter: { op: "AND", filters: [
            { fieldFilter: { field: { fieldPath: "patientName" }, op: "EQUAL", value: { stringValue: patientName } } },
            { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "completado" } } },
          ]}},
          orderBy: [{ field: { fieldPath: "date" }, direction: "ASCENDING" }],
          limit: 200,
        }})
      }
    );
    const queryData = await queryRes.json();

    const parse = (v) => {
      if (!v) return null;
      if (v.stringValue !== undefined) return v.stringValue;
      if (v.booleanValue !== undefined) return v.booleanValue;
      if (v.integerValue !== undefined) return parseInt(v.integerValue);
      if (v.arrayValue) return (v.arrayValue.values || []).map(parse);
      if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, parse(val)]));
      return null;
    };

    let sessions = queryData.filter(d => d.document).map(d => {
      const id = d.document.name.split("/").pop();
      return { id, ...Object.fromEntries(Object.entries(d.document.fields || {}).map(([k, v]) => [k, parse(v)])) };
    });

    // Filtrar por sessionIds si se proporcionaron
    if (sessionIds && sessionIds.length > 0) {
      sessions = sessions.filter(s => sessionIds.includes(s.id));
    }

    if (sessions.length === 0) return res.status(404).json({ error: "No hay sesiones" });

    // Generar PDF
    const PDFDocument = (await import("pdfkit")).default;
    const chunks = [];
    const doc = new PDFDocument({ size: "LETTER", margin: 45, bufferPages: true });
    doc.on("data", chunk => chunks.push(chunk));

    const sample = sessions[0];
    const NAVY = "#00339F";
    const TEAL = "#16C2D5";
    const W = 612 - 90; // ancho útil
    const centerKey = (center || "CITIO").toUpperCase();
    const logos = CENTER_LOGOS[centerKey] || {};
    const hasHeaderLogo = logos.header && fs.existsSync(logos.header);
    const hasWatermarkLogo = logos.watermark && fs.existsSync(logos.watermark);

    const drawHeader = () => {
      // Línea superior
      doc.rect(45, 40, W, 3).fill(NAVY);

      // Logo institucional del centro (fallback a texto si aún no está disponible, ej. CIPI)
      if (hasHeaderLogo) {
        doc.image(logos.header, 45, 44, { width: 90 });
      } else {
        doc.fontSize(14).fillColor(NAVY).font("Helvetica-Bold")
          .text("InfusionCore", 45, 60);
      }

      // Título + centro (alineados a la misma altura que el logo)
      doc.fontSize(15).fillColor(NAVY).font("Helvetica-Bold")
        .text("BITACORA DE TRATAMIENTO", 45, 60, { align: "center", width: W });
      doc.fontSize(8).fillColor(TEAL).font("Helvetica")
        .text(centerKey, 45, 80, { align: "center", width: W });

      // Datos del paciente
      doc.rect(45, 100, W, 1).fill("#cccccc");
      doc.fontSize(9).fillColor("#333").font("Helvetica");
      const col1 = 45, col2 = 320;
      const dob = sample.dob || "";
      let age = "";
      if (dob) {
        const [y,m,d] = dob.split("-").map(Number);
        const today = new Date();
        age = today.getFullYear() - y - (today.getMonth()+1 < m || (today.getMonth()+1===m && today.getDate()<d) ? 1 : 0);
      }
      doc.font("Helvetica-Bold").text("Paciente:", col1, 107, { continued: true }).font("Helvetica").text(`  ${sample.patientName || ""}`, { width: 250 });
      doc.font("Helvetica-Bold").text("F. Nac:", col2, 107, { continued: true }).font("Helvetica").text(`  ${dob}  (${age} años)`);
      doc.font("Helvetica-Bold").text("Diagnóstico:", col1, 121, { continued: true }).font("Helvetica").text(`  ${sample.diagnosis || ""}`, { width: 250 });
      doc.font("Helvetica-Bold").text("Médico:", col2, 121, { continued: true }).font("Helvetica").text(`  ${sample.physician || ""}`);
      doc.font("Helvetica-Bold").text("Alergias:", col1, 135, { continued: true }).font("Helvetica").text(`  ${sample.allergies || "Negadas"}`, { width: 250 });
      doc.font("Helvetica-Bold").text("Régimen:", col2, 135, { continued: true }).font("Helvetica").text(`  ${sample.insurance || "Particular"}`);
      doc.rect(45, 148, W, 1).fill("#cccccc");
      doc.y = 155;
    };

    const drawWatermark = () => {
      doc.save();
      if (hasWatermarkLogo) {
        const size = 300;
        doc.image(logos.watermark,
          (doc.page.width - size) / 2, (doc.page.height - size) / 2,
          { width: size });
      } else {
        doc.opacity(0.06);
        doc.fontSize(80).fillColor(NAVY).font("Helvetica-Bold")
          .text("InfusionCore", 80, 320, { width: W, align: "center" });
      }
      doc.restore();
    };

    const CAT_LABEL = { premedicacion:"Premedicación", inmunoterapia:"Inmunoterapia", quimioterapia:"Quimioterapia", adicional:"Adicional", especialidad:"Especialidad", hidratacion:"Hidratación", domicilio:"Domicilio" };
    const catOrder = ["premedicacion", "inmunoterapia", "quimioterapia", "adicional", "especialidad", "hidratacion", "domicilio"];
    const COLS = 3, GAP = 10;
    const colW = (W - GAP * (COLS - 1)) / COLS;

    // Estima el alto que ocupará una sesión antes de dibujarla, para forzar
    // salto de página (con encabezado) en vez de dejar que pdfkit corte a la mitad.
    const estimateSessionHeight = (s) => {
      let h = 24; // barra de fecha/esquema + margen
      const meds = s.meds || [];
      const groups = {};
      meds.forEach(m => {
        const cat = m.category || "adicional";
        (groups[cat] = groups[cat] || []).push(m);
      });
      const activeCats = catOrder.filter(cat => groups[cat]);
      const rows = Math.max(1, Math.ceil(activeCats.length / COLS));
      const maxItems = activeCats.reduce((mx, c) => Math.max(mx, groups[c].length), 0);
      h += rows * (12 + maxItems * 11 + 6);
      if (s.globalNote) h += 14;
      h += 6 + 34 + 4; // firmas + línea separadora
      return h;
    };

    drawHeader();
    drawWatermark();

    sessions.forEach((s, idx) => {
      // Calcular si la sesión completa cabe en el espacio restante de la página
      const estH = estimateSessionHeight(s);
      if (doc.y + estH > 745) {
        doc.addPage();
        drawHeader();
        drawWatermark();
      }

      const blockY = doc.y + 6;
      doc.rect(45, blockY, W, 14).fill(NAVY);
      doc.fontSize(8).fillColor("white").font("Helvetica-Bold")
        .text(`Fecha: ${s.date || ""}    Ciclo: ${s.cycle || ""}    Esquema: ${s.schemeName || ""}    Ingreso: ${s.events?.ingreso || "__:__"}    Retiro: ${s.events?.retiro || "__:__"}`,
          47, blockY + 3, { width: W - 4 });

      doc.y = blockY + 18;
      doc.fillColor("#333").font("Helvetica").fontSize(8);

      // Agrupar medicamentos por categoría
      const meds = s.meds || [];
      const groups = {};
      meds.forEach(m => {
        const cat = m.category || "adicional";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(m);
      });

      const activeCats = catOrder.filter(cat => groups[cat]);

      let rowY = doc.y, col = 0, rowMaxH = 0;
      activeCats.forEach(cat => {
        const x = 47 + col * (colW + GAP);
        doc.y = rowY;
        doc.font("Helvetica-Bold").fontSize(8).fillColor(TEAL)
          .text(CAT_LABEL[cat] || cat, x, doc.y, { width: colW });
        groups[cat].forEach(m => {
          doc.font("Helvetica").fontSize(8).fillColor("#333")
            .text(`• ${m.name || ""} ${m.dose || ""}`, x, doc.y, { width: colW });
        });
        rowMaxH = Math.max(rowMaxH, doc.y - rowY);
        col++;
        if (col >= COLS) { col = 0; rowY += rowMaxH + 6; rowMaxH = 0; }
      });
     doc.y = col === 0 ? rowY : rowY + rowMaxH + 6;

      // Nota
      if (s.globalNote) {
        doc.font("Helvetica-BoldOblique").fontSize(8).fillColor("#555")
          .text(`Nota: ${s.globalNote}`, 47, doc.y, { width: W });
      }

      // Firmas
      doc.y += 6;
      const firmaY = doc.y;
      const fw = W / 3 - 5;
      ["Enfermería", "Paciente / Familiar", "Médico"].forEach((label, i) => {
        const fx = 45 + i * (fw + 7);
        doc.rect(fx, firmaY, fw, 28).stroke("#cccccc");
        doc.fontSize(7).fillColor("#999").font("Helvetica")
          .text(label, fx, firmaY + 20, { width: fw, align: "center" });
      });
      doc.y = firmaY + 34;

      // Línea separadora
      doc.rect(45, doc.y, W, 0.5).fill("#e0e0e0");
      doc.y += 4;
    });

   // Numeración de páginas
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // evita que pdfkit cree una página extra solo por el pie
      doc.fontSize(7).fillColor("#aaa").font("Helvetica")
        .text(`Página ${i + 1} de ${pages.count}  ·  InfusionCore  ·  ${center || "CITIO"}`,
          45, 760, { width: W, align: "center", lineBreak: false });
      doc.page.margins.bottom = bottomMargin;
    }
    
    doc.end();

    await new Promise((resolve, reject) => {
      doc.on("end", resolve);
      doc.on("error", reject);
    });

    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="tratamiento-${patientName.replace(/\s+/g, "_")}.pdf"`);
    res.send(pdfBuffer);

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
