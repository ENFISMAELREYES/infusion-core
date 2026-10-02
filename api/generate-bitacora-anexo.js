import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, "assets");

// Mismo mapeo de logos que generate-pdf.js (hoja de tratamiento) -- este
// endpoint genera el mismo documento "BITACORA DE TRATAMIENTO", solo que la
// lista de sesiones no se consulta de Firestore: la arma Historial anexo en
// el cliente, mezclando sesiones reales con sus correcciones/ciclos nuevos
// de la colección historial_anexo (que nunca toca `sessions`).
const CENTER_LOGOS = {
  CITIO: {
    header: path.join(ASSETS_DIR, "logo-citio-header.png"),
    watermark: path.join(ASSETS_DIR, "logo-citio-watermark.png"),
  },
  CIPI: {
    headerLeft: path.join(ASSETS_DIR, "logo-cipi-header-left.png"),
    headerRight: path.join(ASSETS_DIR, "logo-cipi-header-right.png"),
    watermark: path.join(ASSETS_DIR, "logo-cipi-watermark.png"),
  },
};

export const config = { api: { responseLimit: "10mb" } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { patientName, center, sample, entries, token } = req.body;

  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : token;
  if (!bearerToken) {
    return res.status(401).json({ error: "No autenticado: falta el token de sesión." });
  }
  try {
    const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";
    const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: bearerToken }),
    });
    if (!verifyRes.ok) return res.status(401).json({ error: "Token inválido o expirado." });
    const verifyData = await verifyRes.json();
    if (!verifyData.users || verifyData.users.length === 0) {
      return res.status(401).json({ error: "Token inválido." });
    }
  } catch (e) {
    return res.status(401).json({ error: "No se pudo verificar la sesión." });
  }

  // El permiso real (jefe o puedeEditarTratamientos) ya lo hace cumplir
  // Firestore -- este endpoint no consulta sessions/historial_anexo por su
  // cuenta, solo convierte en PDF la lista que el cliente ya armó leyendo
  // esas colecciones con su propio token. Mismo criterio que
  // generate-consent.js y generate-material-order.js: autenticación sí,
  // sin credencial de servidor aparte.
  try {
    if (!patientName || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "Faltan datos del paciente o no hay entradas para la bitácora." });
    }

    const sessions = [...entries].sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    // Pre-descargar firmas (solo las entradas que vienen de una sesión real
    // sin corregir traen signatures con URLs válidas; las corregidas/nuevas
    // simplemente dejan el recuadro vacío).
    const sigBuffers = {};
    const fetchSigBuffer = async (url) => {
      if (!url) return null;
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
      } catch (e) { return null; }
    };
    await Promise.all(sessions.map(async (s) => {
      if (!s.signatures) return;
      const [paciente, enfermeria] = await Promise.all([
        fetchSigBuffer(s.signatures.paciente),
        fetchSigBuffer(s.signatures.enfermeria),
      ]);
      sigBuffers[s.id] = { paciente, enfermeria };
    }));

    const PDFDocument = (await import("pdfkit")).default;
    const chunks = [];
    const doc = new PDFDocument({ size: "LETTER", margin: 45, bufferPages: true });
    doc.on("data", chunk => chunks.push(chunk));

    const NAVY = "#00339F";
    const TEAL = "#16C2D5";
    const W = 612 - 90;
    const centerKey = (center || "CITIO").toUpperCase();
    const logos = CENTER_LOGOS[centerKey] || {};
    const hasHeaderLogo = logos.header && fs.existsSync(logos.header);
    const hasHeaderLeft = logos.headerLeft && fs.existsSync(logos.headerLeft);
    const hasHeaderRight = logos.headerRight && fs.existsSync(logos.headerRight);
    const hasWatermarkLogo = logos.watermark && fs.existsSync(logos.watermark);

    const drawHeader = () => {
      doc.rect(45, 40, W, 3).fill(NAVY);
      if (hasHeaderLeft || hasHeaderRight) {
        const logoH = 48;
        if (hasHeaderLeft) doc.image(logos.headerLeft, 45, 44, { height: logoH });
        if (hasHeaderRight) {
          const img = doc.openImage(logos.headerRight);
          const wR = logoH * (img.width / img.height);
          doc.image(logos.headerRight, 45 + W - wR, 44, { height: logoH });
        }
      } else if (hasHeaderLogo) {
        doc.image(logos.header, 45, 44, { width: 90 });
      } else {
        doc.fontSize(14).fillColor(NAVY).font("Helvetica-Bold").text("InfusionCore", 45, 60);
      }

      doc.fontSize(15).fillColor(NAVY).font("Helvetica-Bold")
        .text("BITACORA DE TRATAMIENTO", 45, 60, { align: "center", width: W });
      doc.fontSize(8).fillColor(TEAL).font("Helvetica")
        .text(centerKey, 45, 80, { align: "center", width: W });

      doc.rect(45, 100, W, 1).fill("#cccccc");
      doc.fontSize(9).fillColor("#333").font("Helvetica");
      const col1 = 45, col2 = 320;
      const dob = sample?.dob || "";
      let age = "";
      if (dob) {
        const [y, m, d] = dob.split("-").map(Number);
        const today = new Date();
        age = today.getFullYear() - y - (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d) ? 1 : 0);
      }
      doc.font("Helvetica-Bold").text("Paciente:", col1, 107, { continued: true }).font("Helvetica").text(`  ${patientName || ""}`, { width: 250 });
      doc.font("Helvetica-Bold").text("F. Nac:", col2, 107, { continued: true }).font("Helvetica").text(`  ${dob}  (${age} años)`);
      doc.font("Helvetica-Bold").text("Diagnóstico:", col1, 121, { continued: true }).font("Helvetica").text(`  ${sample?.diagnosis || ""}`, { width: 250 });
      doc.font("Helvetica-Bold").text("Médico:", col2, 121, { continued: true }).font("Helvetica").text(`  ${sample?.physician || ""}`);
      doc.font("Helvetica-Bold").text("Alergias:", col1, 135, { continued: true }).font("Helvetica").text(`  ${sample?.allergies || "Negadas"}`, { width: 250 });
      doc.font("Helvetica-Bold").text("Régimen:", col2, 135, { continued: true }).font("Helvetica").text(`  ${sample?.insurance || "Particular"}`);
      doc.rect(45, 148, W, 1).fill("#cccccc");
      doc.y = 155;
    };

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

    const CAT_LABEL = { premedicacion: "Premedicación", inmunoterapia: "Inmunoterapia", quimioterapia: "Quimioterapia", adicional: "Adicional", especialidad: "Especialidad", hidratacion: "Hidratación", domicilio: "Domicilio" };
    const catOrder = ["premedicacion", "inmunoterapia", "quimioterapia", "adicional", "especialidad", "hidratacion", "domicilio"];
    const COLS = 3, GAP = 10;
    const colW = (W - GAP * (COLS - 1)) / COLS;

    const estimateSessionHeight = (s) => {
      let h = 24;
      const meds = s.meds || [];
      const groups = {};
      meds.forEach(m => { const cat = m.category || "adicional"; (groups[cat] = groups[cat] || []).push(m); });
      const activeCats = catOrder.filter(cat => groups[cat]);
      const rows = Math.max(1, Math.ceil(activeCats.length / COLS));
      const maxItems = activeCats.reduce((mx, c) => Math.max(mx, groups[c].length), 0);
      h += rows * (12 + maxItems * 11 + 6);
      if (s.globalNote) h += 14;
      h += 6 + 34 + 4;
      return h;
    };

    drawHeader();
    drawWatermark();

    sessions.forEach((s) => {
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

      const meds = s.meds || [];
      const groups = {};
      meds.forEach(m => { const cat = m.category || "adicional"; if (!groups[cat]) groups[cat] = []; groups[cat].push(m); });
      const activeCats = catOrder.filter(cat => groups[cat]);

      let rowY = doc.y, col = 0, rowMaxH = 0;
      activeCats.forEach(cat => {
        const x = 47 + col * (colW + GAP);
        doc.y = rowY;
        doc.font("Helvetica-Bold").fontSize(8).fillColor(TEAL).text(CAT_LABEL[cat] || cat, x, doc.y, { width: colW });
        groups[cat].forEach(m => {
          doc.font("Helvetica").fontSize(8).fillColor("#333").text(`• ${m.name || ""} ${m.dose || ""}`, x, doc.y, { width: colW });
        });
        rowMaxH = Math.max(rowMaxH, doc.y - rowY);
        col++;
        if (col >= COLS) { col = 0; rowY += rowMaxH + 6; rowMaxH = 0; }
      });
      doc.y = col === 0 ? rowY : rowY + rowMaxH + 6;

      if (s.globalNote) {
        doc.font("Helvetica-BoldOblique").fontSize(8).fillColor("#555").text(`Nota: ${s.globalNote}`, 47, doc.y, { width: W });
      }

      doc.y += 6;
      const firmaY = doc.y;
      const fw = W / 3 - 5;
      const sig = sigBuffers[s.id] || {};
      const FIRMA_KEY = { "Enfermería": "enfermeria", "Paciente / Familiar": "paciente", "Médico": null };
      ["Enfermería", "Paciente / Familiar", "Médico"].forEach((label, i) => {
        const fx = 45 + i * (fw + 7);
        doc.rect(fx, firmaY, fw, 28).stroke("#cccccc");
        const key = FIRMA_KEY[label];
        const buf = key && sig[key];
        if (buf) {
          try { doc.image(buf, fx + 4, firmaY + 2, { fit: [fw - 8, 19], align: "center", valign: "center" }); } catch (e) { /* imagen inválida: caja vacía */ }
        }
        doc.fontSize(7).fillColor("#999").font("Helvetica").text(label, fx, firmaY + 20, { width: fw, align: "center" });
      });
      doc.y = firmaY + 34;

      doc.rect(45, doc.y, W, 0.5).fill("#e0e0e0");
      doc.y += 4;
    });

    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor("#aaa").font("Helvetica")
        .text(`Página ${i + 1} de ${pages.count}  ·  InfusionCore  ·  ${center || "CITIO"}`, 45, 760, { width: W, align: "center", lineBreak: false });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
    await new Promise((resolve, reject) => { doc.on("end", resolve); doc.on("error", reject); });

    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="bitacora-${patientName.replace(/\s+/g, "_")}.pdf"`);
    res.send(pdfBuffer);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
