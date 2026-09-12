import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, "assets");

// Mismo criterio de logo/nombre por centro que ya usa generate-material-order.js
const CENTER_LOGOS = {
  CITIO: {
    header: path.join(ASSETS_DIR, "logo-citio-header.png"),
    watermark: path.join(ASSETS_DIR, "logo-citio-watermark.png"),
    name: "CENTRO DE INFUSIÓN, TRATAMIENTO E INVESTIGACIÓN ONCOLÓGICA",
    city: "Santiago de Querétaro",
  },
  CIPI_PRO: {
    header: path.join(ASSETS_DIR, "logo-cipi-header-left.png"),
    watermark: path.join(ASSETS_DIR, "logo-cipi-watermark.png"),
    name: "CENTRO DE INFUSIÓN PROFESIONAL INTEGRAL",
    city: "Ciudad de México",
  },
  CIPI_PED: {
    header: path.join(ASSETS_DIR, "logo-cipi-header-right.png"),
    watermark: path.join(ASSETS_DIR, "logo-cipi-watermark.png"),
    name: "CENTRO DE INFUSIÓN PEDIÁTRICA INTEGRAL",
    city: "Ciudad de México",
  },
};

const NAVY = "#00339F", GRAY = "#666666", LINE = "#999999";

// Categorías que sí cuentan como "el tratamiento" para nombrar los fármacos
// en el consentimiento -- premedicación/hidratación/domicilio son soporte,
// no lo que el documento necesita nombrar explícitamente. Cada una con su
// etiqueta para el encabezado del documento ("especialidad" es donde caen
// los biológicos/dirigidos que no son ni quimio ni inmunoterapia propiamente,
// ej. bevacizumab) -- así el título deja de ser siempre "QUIMIOTERAPIA/
// AGENTE BIOLÓGICO" fijo y se arma según lo que de verdad trae la sesión:
// solo quimio -> "QUIMIOTERAPIA"; solo bevacizumab -> "AGENTE BIOLÓGICO";
// combinación -> "QUIMIOTERAPIA / INMUNOTERAPIA", etc.
const TREATMENT_CAT_LABEL = { quimioterapia: "QUIMIOTERAPIA", inmunoterapia: "INMUNOTERAPIA", especialidad: "AGENTE BIOLÓGICO" };
const TREATMENT_CAT_ORDER = ["quimioterapia", "inmunoterapia", "especialidad"];

// "Negadas", "Ninguna", "No", etc. cuentan como sin alergia -- cualquier otra
// cosa capturada se toma como una alergia real que hay que mostrar.
function hasAllergy(text) {
  const t = (text || "").trim();
  if (!t) return false;
  return !/^(negad|ningun|no\b)/i.test(t);
}

export const config = { api: { responseLimit: "10mb" } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { center, cipiVariant, patientName, dob, diagnosis, physician, allergies, meds, requestedByName, treatmentInfo, token } = req.body;

  // Es un documento legal con datos clínicos del paciente -- a diferencia de
  // generate-material-order.js (solo insumos/cantidades), aquí sí se exige
  // sesión autenticada antes de generar nada, mismo criterio que generate-pdf.js.
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : token;
  if (!bearerToken) return res.status(401).json({ error: "No autenticado: falta el token de sesión." });
  try {
    const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";
    const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: bearerToken }),
    });
    if (!verifyRes.ok) return res.status(401).json({ error: "Token inválido o expirado." });
    const verifyData = await verifyRes.json();
    if (!verifyData.users || verifyData.users.length === 0) return res.status(401).json({ error: "Token inválido." });
  } catch (e) {
    return res.status(401).json({ error: "No se pudo verificar la sesión." });
  }

  try {
    if (!patientName) return res.status(400).json({ error: "Falta el nombre del paciente." });

    const centerKey = (center || "CITIO").toUpperCase();
    const logoKey = centerKey === "CIPI" ? `CIPI_${(cipiVariant || "PRO").toUpperCase()}` : centerKey;
    const logos = CENTER_LOGOS[logoKey] || CENTER_LOGOS.CITIO;
    const hasHeaderLogo = logos.header && fs.existsSync(logos.header);
    const hasWatermarkLogo = logos.watermark && fs.existsSync(logos.watermark);

    // Edad calculada a partir de la fecha de nacimiento (mismo cálculo que
    // ya usa generate-pdf.js para el encabezado de la bitácora).
    let age = "";
    if (dob) {
      const [y, m, d] = dob.split("-").map(Number);
      const today = new Date();
      age = today.getFullYear() - y - (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d) ? 1 : 0);
    }

    // Nombres de los fármacos "del tratamiento" (no premedicación/hidratación)
    // para nombrarlos explícitamente en el documento -- a diferencia de dejar
    // solo "QUIMIOTERAPIA/AGENTE BIOLÓGICO" genérico.
    const treatmentMeds = (meds || []).filter(m => TREATMENT_CAT_LABEL[m.category]);
    const treatmentDrugs = [...new Set(treatmentMeds.map(m => (m.name || "").trim().toUpperCase()).filter(Boolean))];
    const drugList = treatmentDrugs.join(", ");

    // Datos de ficha técnica por medicamento (los manda el cliente, que ya
    // tiene fichasByName cargado -- ver NurseView.jsx). Uno por nombre, sin
    // duplicados aunque el cliente mande el mismo fármaco más de una vez.
    const infoByDrug = {};
    (treatmentInfo || []).forEach(i => { if (i?.name) infoByDrug[i.name.trim().toUpperCase()] = i; });
    const infoList = Object.values(infoByDrug);
    const withMechanism = infoList.filter(i => i.mecanismo_accion_paciente);
    const withRisks = infoList.filter(i => {
      const r = i.riesgos_por_frecuencia;
      return r && ((r.frecuentes || []).length || (r.menos_frecuentes || []).length || (r.raros_pero_importantes || []).length);
    });
    // Sin datos de ficha para ningún medicamento (aún no cargadas, o
    // sesión antigua) -- se asume oncológico, que es el caso de siempre
    // hasta ahora. Con datos, basta que UNO de los fármacos del tratamiento
    // sea oncológico para tratar todo el documento como tal.
    const isOncologic = infoList.length === 0 ? true : infoList.some(i => i.es_oncologico === true);
    const dedupList = (arrs) => {
      const seen = new Set(), out = [];
      arrs.forEach(arr => (arr || []).forEach(s => { const t = (s || "").trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } }));
      return out;
    };
    const beneficios = dedupList(infoList.map(i => i.beneficios_esperados));
    const alternativas = dedupList(infoList.map(i => i.alternativas_tratamiento));

    // Título/frase del tratamiento dinámicos según qué categorías realmente
    // trae la sesión -- si ninguna calza (sesión sin meds, o todo
    // premedicación) se deja el genérico de siempre como respaldo. Para
    // tratamiento NO oncológico (ej. hierro IV, antiemético solo) la
    // etiqueta de categoría (QUIMIOTERAPIA/AGENTE BIOLÓGICO) no aplica --
    // se nombra directo el fármaco en su lugar.
    const presentCats = TREATMENT_CAT_ORDER.filter(c => treatmentMeds.some(m => m.category === c));
    const treatmentLabel = presentCats.length > 0 ? presentCats.map(c => TREATMENT_CAT_LABEL[c]).join(" / ") : "QUIMIOTERAPIA/AGENTE BIOLÓGICO";
    const treatmentPhrase = !isOncologic ? (drugList || "el tratamiento indicado") : `${treatmentLabel}${drugList ? ` (${drugList})` : ""}`;

    const allergic = hasAllergy(allergies);

    const todayD = new Date();
    const todayStr = `${todayD.getDate()} de ${["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"][todayD.getMonth()]} de ${todayD.getFullYear()}`;

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
      }
      doc.restore();
    };

    // El texto largo (párrafos/lista de efectos) deja que pdfkit pagine solo
    // cuando no cabe -- eso dispara "pageAdded" sin pasar por newPage(), así
    // que la marca de agua se engancha aquí para no perderla en esas páginas
    // automáticas. La primera página no dispara el evento (ya existe al
    // crear el documento), por eso el drawWatermark() suelto de abajo.
    doc.on("pageAdded", () => drawWatermark());
    const newPage = () => { doc.addPage(); doc.y = 45; };

    drawWatermark();

    // Encabezado: logo apilado sobre el nombre completo del centro, igual
    // que generate-material-order.js -- y el título del documento centrado.
    let y = 45;
    if (hasHeaderLogo) {
      doc.image(logos.header, 45, y, { fit: [150, 40], align: "left" });
    }
    doc.fontSize(14).fillColor(NAVY).font("Helvetica-Bold")
      .text("CONSENTIMIENTO INFORMADO PARA RECIBIR", 45, y, { width: W, align: "center" });
    doc.fontSize(14).fillColor(NAVY).font("Helvetica-Bold")
      .text(isOncologic ? "QUIMIOTERAPIA / AGENTE BIOLÓGICO" : (drugList || "TRATAMIENTO"), 45, doc.y, { width: W, align: "center" });
    y = Math.max(doc.y + 8, y + 44);
    doc.fontSize(8).fillColor(GRAY).font("Helvetica").text(logos.name, 45, y, { width: W, align: "center" });
    y = doc.y + 10;

    const line = (yy) => { doc.moveTo(45, yy).lineTo(45 + W, yy).lineWidth(0.75).strokeColor(LINE).stroke(); };
    const field = (label, value, x, yy, labelW, valueW) => {
      doc.fontSize(9.5).fillColor("#000").font("Helvetica-Bold").text(label, x, yy, { continued: true, width: labelW });
      doc.font("Helvetica").text(`  ${value || ""}`, { width: valueW, underline: !value });
    };

    doc.fontSize(10).fillColor(NAVY).font("Helvetica-Bold").text("Datos Paciente", 45, y);
    y = doc.y + 6;
    field("Nombre del Paciente:", patientName, 45, y, 130, W - 130);
    y = doc.y + 6;
    field("Fecha de Nacimiento:", dob ? dob.split("-").reverse().join("/") : "", 45, y, 130, 150);
    field("Edad:", age ? `${age} años` : "", 300, y, 40, 80);
    field("Sexo:", "", 420, y, 40, W - 420 + 45 - 40);
    y = doc.y + 6;
    doc.fontSize(9.5).font("Helvetica-Bold").text("Antecedentes de Alergia:", 45, y, { continued: true })
      .font("Helvetica").text(`  SI: ${allergic ? "X" : "___"}   NO: ${allergic ? "___" : "X"}   Cuál: ${allergic ? allergies : ""}`);
    y = doc.y + 10;
    line(y); y += 8;

    doc.fontSize(9.5).font("Helvetica").text("Datos: Tutor ( )   Representante Legal ( )   Familiar más cercano por vínculo ( )   Parentesco: ______________________", 45, y, { width: W });
    y = doc.y + 6;
    field("Nombre:", "", 45, y, 60, 300);
    field("Edad:", "", 400, y, 40, 80);
    y = doc.y + 10;
    line(y); y += 12;
    doc.y = y;

    const P = (text, opts = {}) => { doc.fontSize(9.5).fillColor("#000").font("Helvetica").text(text, 45, doc.y, { width: W, align: "justify", ...opts }); doc.moveDown(0.6); };
    // OJO: dos anchos distintos dentro de un mismo continued:true rompe el
    // ajuste de línea en pdfkit (cada palabra termina en su propio renglón)
    // -- el mismo ancho (W) en ambos tramos es lo que ya funciona bien en
    // la lista de efectos secundarios, de ahí se copia el criterio.
    const numbered = (n, text) => { doc.fontSize(9.5).fillColor("#000").font("Helvetica-Bold").text(`${n}. `, 45, doc.y, { continued: true, width: W }).font("Helvetica").text(text); doc.moveDown(0.3); };

    P("Este documento sirve para que usted, o quien lo represente, dé su consentimiento para este tratamiento. Eso significa que nos autoriza a realizarlo. Puede usted retirar este consentimiento cuando lo desee. Firmarlo no le obliga a recibir dicho tratamiento. En caso de rechazo, no se derivará ninguna consecuencia adversa respecto a la calidad del resto de la atención recibida.");

    doc.fontSize(9.5).fillColor("#000").font("Helvetica").text("Usted, o la persona que representa, ha sido diagnosticado/a de ", 45, doc.y, { continued: true, width: W })
      .font("Helvetica-Bold").text(diagnosis || "____________________________", { continued: true })
      .font("Helvetica").text(` por tal motivo se le ha sugerido recibir tratamiento con ${treatmentPhrase}.`);
    doc.moveDown(0.6);

    // Explicación de qué es el tratamiento: si hay mecanismo_accion_paciente
    // capturado para alguno de los fármacos (ficha técnica), se explica cada
    // uno específicamente; si no, se cae al párrafo genérico de siempre --
    // pero ese genérico solo aplica bien a tratamiento oncológico (habla de
    // "cáncer" explícito), así que para no oncológico sin datos de ficha
    // simplemente no se agrega nada aquí (quedan igual las secciones de
    // beneficios/alternativas/riesgos de más abajo).
    if (withMechanism.length > 0) {
      withMechanism.forEach(i => {
        doc.fontSize(9.5).fillColor("#000").font("Helvetica-Bold").text(`${(i.name || "").toUpperCase()}: `, 45, doc.y, { continued: true, width: W })
          .font("Helvetica").text(i.mecanismo_accion_paciente);
        doc.moveDown(0.5);
      });
    } else if (isOncologic) {
      P("La quimioterapia es uno de los tratamientos más utilizados para combatir el cáncer y otras enfermedades proliferativas. Su objetivo es atacar las células del cuerpo humano que tienen un crecimiento anormal, ya sea destruyéndolas o controlando su crecimiento. En general, los tratamientos de quimioterapia consisten en la combinación de diferentes medicamentos (agentes químicos antineoplásicos y agentes biológicos) que, habitualmente, se administran de forma intermitente o en ciclos (semanal, cada 2, 3 ó 4 semanas). La finalidad del tratamiento es destruir las células anómalas que están ocasionando su enfermedad. La indicación de tratamiento oncológico forma parte de las recomendaciones científicas admitidas para su enfermedad.");
      P("El objetivo de la quimioterapia es eliminar la enfermedad micrometastásica para evitar recidivas futuras (tratamiento adyuvante), disminuir el tamaño del tumor previo a la cirugía (tratamiento neoadyuvante), control de los síntomas con la intención de mejorar la calidad de vida y la supervivencia en algunos casos (tratamiento quimioterápico paliativo) o con intención curativa. En forma simplificada; con el tratamiento se espera reducir la probabilidad de recaída de la enfermedad o disminuir la progresión de ésta en caso de presentarla de forma activa en este momento. Su consecuencia es una mayor probabilidad de supervivencia y/o mejorar los síntomas de la enfermedad y/o su calidad de vida.");
    }

    // Beneficios esperados / alternativas de tratamiento -- listos para los
    // 44 fármacos de la ficha (a diferencia del mecanismo/riesgos, que hoy
    // solo están completos para los de soporte), así que se muestran
    // siempre que haya datos, oncológico o no.
    // "•  texto" -- ancho único (W) para todo el renglón, mismo criterio
    // que ya evita el bug de continued:true con anchos distintos (ver
    // numbered() más arriba).
    const bulletList = (title, items) => {
      if (!items || items.length === 0) return;
      doc.fontSize(10).fillColor(NAVY).font("Helvetica-Bold").text(title, 45, doc.y, { width: W });
      doc.moveDown(0.3);
      items.forEach(txt => {
        doc.fontSize(9.5).fillColor("#000").font("Helvetica").text(`•  ${txt}`, 45, doc.y, { width: W });
        doc.moveDown(0.15);
      });
      doc.moveDown(0.4);
    };
    bulletList("Beneficios esperados de este tratamiento", beneficios);
    bulletList("Alternativas de tratamiento", alternativas);

    if (isOncologic) {
      P("Estos fármacos van dirigidos a combatir las células que están ocasionando su enfermedad, pero con frecuencia también dañan algunas células sanas de su organismo ocasionando efectos no deseados. Hay algunos efectos secundarios comunes a todos los medicamentos y otros característicos de cada agente. Será su médico el que le informará de las precauciones que deberá tener y las molestias que puede presentar tras el inicio de su tratamiento.");
      doc.fontSize(9.5).font("Helvetica-Bold").text("Los efectos adversos o secundarios más frecuentes de estos tratamientos incluyen:", 45, doc.y, { width: W });
      doc.moveDown(0.3);

      const EFFECTS = [
        ["Generales", "cansancio, malestar, decaimiento, pérdida o ganancia de peso. Dolores difusos. Fiebre. Infecciones (con o sin bajada de defensas). Caída del cabello y/o vello corporal."],
        ["Cutáneos", "dermatitis, descamación, enrojecimiento, aparición de manchas, agrietamiento de las palmas y plantas, alteraciones de las uñas."],
        ["Alérgicos", "broncoespasmo (“silbido” en el pecho, con o sin dificultad para respirar), manchas cutáneas, caída de tensión."],
        ["Óticos", "ruidos en los oídos, disminución de la audición."],
        ["Oculares", "conjuntivitis, lagrimeo, sensación de arenilla en el ojo, pérdida de agudeza visual."],
        ["Neurológicos", "confusión, letargo, adormecimiento, disminución del nivel de consciencia, pérdida de sensibilidad o de fuerza, disminución o desaparición de los reflejos osteotendinosos (reflejos musculares). Disestesias (sensación de hormigueos)."],
        ["Tracto digestivo", "alteraciones del gusto y del olfato, náuseas, vómitos, mucositis (“llagas” en la cavidad oral y/o esófago), gastritis, úlceras, diarrea, estreñimiento, dolor abdominal."],
        ["Hepáticos", "alteraciones de los enzimas (análisis) hepáticos."],
        ["Respiratorios", "tos, disnea (dificultad para respirar), dolor torácico."],
        ["Cardíacos", "arritmias (alteraciones del ritmo cardiaco), dolor por afectación del pericardio (membrana que recubre el corazón)."],
        ["Vasculares", "estenosis (estrechez) y debilidad de las venas donde se administra la quimioterapia. Extravasaciones o salida de la quimioterapia fuera de las venas, con paso a los tejidos de alrededor, que pueden inflamarse o incluso degradarse."],
        ["Genitourinarios", "disminución de la función renal, cistitis (inflamación de la vejiga) con o sin eliminación de sangre por la orina. Sequedad de la mucosa vaginal."],
        ["Osteoarticulares", "dolores osteoarticulares, dolores musculares, inflamación de las articulaciones."],
        ["Hematológicos", "anemia. Leucopenia y neutropenia (bajada de las “defensas” de la sangre), con o sin infección acompañante. Trombopenia (bajada de las plaquetas) con o sin hemorragias. Según el grado de anemia o trombopenia puede ser necesario administrar transfusiones."],
      ];
      EFFECTS.forEach(([label, text], i) => {
        doc.fontSize(9.5).font("Helvetica-Bold").text(`${i + 1}. ${label}: `, 45, doc.y, { continued: true, width: W, indent: 12 })
          .font("Helvetica").text(text);
      });
      doc.moveDown(0.6);
    }

    // Riesgos específicos por fármaco (de la ficha técnica) -- en
    // tratamiento oncológico se suma como complemento a la lista genérica
    // de arriba; si no es oncológico, es la única lista de riesgos (no hay
    // lista genérica de "efectos de quimioterapia" que mostrar).
    if (withRisks.length > 0) {
      doc.fontSize(10).fillColor(NAVY).font("Helvetica-Bold")
        .text(isOncologic ? "Riesgos específicos por medicamento" : "Riesgos de este tratamiento", 45, doc.y, { width: W });
      doc.moveDown(0.3);
      withRisks.forEach(i => {
        doc.fontSize(9.5).fillColor("#000").font("Helvetica-Bold").text((i.name || "").toUpperCase(), 45, doc.y, { width: W });
        doc.moveDown(0.1);
        const r = i.riesgos_por_frecuencia || {};
        [["frecuentes", "Frecuentes"], ["menos_frecuentes", "Menos frecuentes"], ["raros_pero_importantes", "Raros pero importantes"]].forEach(([k, label]) => {
          if ((r[k] || []).length === 0) return;
          doc.fontSize(9).font("Helvetica-Bold").text(`${label}: `, 45, doc.y, { continued: true, width: W })
            .font("Helvetica").text(r[k].join(", "));
          doc.moveDown(0.1);
        });
        doc.moveDown(0.3);
      });
    }

    if (isOncologic) {
      P("La frecuencia y la intensidad de los efectos secundarios varían mucho de unos tratamientos a otros, de unas personas a otras y de la fase de tratamiento en que se encuentre. En general, la toxicidad estimada del tratamiento es inferior al riesgo de la enfermedad que es objeto de tratamiento. Para prevenir y tratar estos efectos secundarios se adoptarán una serie de medidas como la administración de antieméticos (prevención de los vómitos) y antidiarreicos, antibióticos, factores de crecimiento medular, transfusión de sangre y sus derivados (plaquetas o plasma), nutrición artificial (enteral o parenteral), etc. Generalmente las complicaciones suelen ser leves y transitorias pero, en algunas ocasiones, a pesar del tratamiento pueden ser graves e incluso mortales. Si la toxicidad es grave, puede requerir del ingreso en el hospital. La mayoría de los efectos adversos desaparecen después de finalizar el tratamiento pero, en algunas ocasiones, son irreversibles. En cualquier caso, cuando proceda, se llevarán a cabo las pruebas y terapias de soporte necesarias para que los riesgos del tratamiento se reduzcan al mínimo. Con el fin de minimizar riesgos, usted deberá informar de toda la medicación que tome y de cualquier prueba diagnóstica o maniobra terapéutica que le vayan a realizar por indicación de otros médicos. Otros riesgos o complicaciones que pueden aparecer teniendo en cuenta sus circunstancias personales (estado previo de salud, edad, profesión, creencias, etc.)");
    } else {
      P("La frecuencia y la intensidad de los efectos varían de una persona a otra. En cualquier caso, cuando proceda, se llevarán a cabo las pruebas y terapias de soporte necesarias para que los riesgos del tratamiento se reduzcan al mínimo. Con el fin de minimizar riesgos, usted deberá informar de toda la medicación que tome y de cualquier prueba diagnóstica o maniobra terapéutica que le vayan a realizar por indicación de otros médicos.");
    }

    // Sin salto de página forzado aquí -- pdfkit ya pagina solo cuando el
    // texto no cabe, forzarlo dejaba media página en blanco innecesariamente.
    doc.fontSize(10).fillColor(NAVY).font("Helvetica-Bold").text("Al dar mi consentimiento", 45, doc.y, { width: W });
    doc.moveDown(0.4);
    numbered(1, `Acepto que se me ha explicado que es conveniente proceder, en mi situación, a la administración de ${treatmentPhrase}.`);
    numbered(2, "He sido informado(a) de forma comprensible de la naturaleza y los riesgos del tratamiento mencionado, así como de sus alternativas, que he tenido oportunidad de comentar con el médico.");
    numbered(3, "He sido informado(a) de las posibles consecuencias de no realizar la terapia que se me propone.");
    numbered(4, "Estoy satisfecho(a) con la información recibida.");
    numbered(5, "He podido formular todas las preguntas que he creído convenientes y me han sido aclaradas todas mis dudas.");
    numbered(6, "He sido informado(a) de la posibilidad de revocar este consentimiento en cualquier momento, aceptando firmar la denegación si esto llegara a suceder.");
    numbered(7, "Sé que debo realizarme una serie de exámenes de sangre, radiografías, ecografías o tomografías, entre otros, para el diagnóstico, tratamiento y seguimiento de esta enfermedad. Los exámenes específicos dependerán del diagnóstico, la etapa del tratamiento y la evaluación médica.");
    numbered(8, "Entiendo mi estado de salud y que por indicación médica, dicho procedimiento supone beneficios esperados para mejorar la situación que me afecta.");
    numbered(9, "Tengo conocimiento que no es posible garantizar el buen resultado de las prácticas que se me realicen, de los riesgos y eventuales complicaciones que puedan surgir en el curso de los mismos y de las condiciones imprevistas que, tal vez, requieran procedimientos adicionales para mi mejoría.");

    doc.moveDown(1.5);
    doc.fontSize(9.5).font("Helvetica").text(`${logos.city} a ${todayStr}`, 45, doc.y, { width: W, align: "center" });
    doc.moveDown(2);

    const sigBlock = (name, label) => {
      // Un bloque de firma completo (nombre + línea + etiqueta) ocupa ~70pt --
      // el umbral anterior (90) no dejaba margen suficiente y a veces
      // partía el bloque entre dos páginas (nombre en una, línea en otra).
      if (doc.y > doc.page.height - 130) newPage();
      if (name) doc.fontSize(9).font("Helvetica-Bold").text(name, 45, doc.y, { width: W, align: "center" });
      doc.moveDown(name ? 0.2 : 1.2);
      line(doc.y); doc.moveDown(0.15);
      doc.fontSize(8).fillColor(GRAY).font("Helvetica").text(label, 45, doc.y, { width: W, align: "center" });
      doc.fillColor("#000");
      doc.moveDown(1.4);
    };
    sigBlock(patientName, "Nombre Completo y firma del paciente");
    sigBlock("", "Nombre completo y firma del Tutor, representante legal o familiar más cercano por vínculo");
    sigBlock(requestedByName || "", "Nombre completo y firma de quien proporciona la información y recaba el consentimiento");
    sigBlock(physician || "", "Nombre completo del Médico Tratante");
    sigBlock("", "Nombre completo y firma del Testigo 1");

    newPage();
    doc.fontSize(12).fillColor(NAVY).font("Helvetica-Bold").text("NEGACIÓN DEL CONSENTIMIENTO", 45, doc.y, { width: W, align: "center" });
    doc.moveDown(0.6);
    P("Por la presente y después de ser informado (a) de la naturaleza y riesgos del procedimiento, manifiesto libre y consciente mi negación para su aplicación a mí o mi representado, responsabilizándome de las consecuencias que puedan derivar de esta decisión.", { align: "left" });
    doc.moveDown(0.6);
    doc.fontSize(9.5).font("Helvetica").text(`${logos.city} a ______ de _________ de ________`, 45, doc.y, { width: W, align: "center" });
    doc.moveDown(2);
    sigBlock("", "Nombre Completo y firma de quien suscribe.");

    doc.moveDown(1.5);
    doc.fontSize(12).fillColor(NAVY).font("Helvetica-Bold").text("REVOCACIÓN DEL CONSENTIMIENTO", 45, doc.y, { width: W, align: "center" });
    doc.moveDown(0.6);
    P("Por la presente REVOCO el consentimiento anteriormente firmado en la fecha _________________ manifestando libre y consciente mi decisión de no continuar con el tratamiento de mí o mi representado a partir de esta fecha, asumiendo los riesgos que de esto deriva.", { align: "left" });
    doc.moveDown(0.6);
    doc.fontSize(9.5).font("Helvetica").text(`${logos.city} a ______ de __________ de ________`, 45, doc.y, { width: W, align: "center" });
    doc.moveDown(2);
    sigBlock("", "Nombre Completo y firma de quien suscribe.");

    // Numeración de página
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor("#aaa").font("Helvetica")
        .text(`Página ${i + 1} de ${pages.count}  ·  ${logos.name}`, 45, doc.page.height - 30, { width: W, align: "center", lineBreak: false });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
    await new Promise((resolve, reject) => { doc.on("end", resolve); doc.on("error", reject); });

    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="CONSENTIMIENTO_${patientName.replace(/\s+/g, "_")}.pdf"`);
    res.send(pdfBuffer);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
