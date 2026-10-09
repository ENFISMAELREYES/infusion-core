// Diagnóstico de solo lectura: busca pacientes con más de un número de
// expediente distinto entre sus sesiones, y números consecutivos
// (infusionNumber/imNumber/scNumber/deliveryNumber/procedureNumber)
// repetidos entre dos pacientes distintos dentro del mismo centro/tipo.
//
// No modifica nada en Firestore -- solo imprime un reporte en consola y,
// opcionalmente, lo guarda como JSON para revisarlo con calma.
//
// Uso: mismo patrón que backfill-past-cycles.mjs
//   export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
//   export VITE_FIREBASE_PROJECT_ID="infusion-core"      (opcional, es el default)
//   export VITE_FIRESTORE_DATABASE_ID="default"           (opcional, es el default)
//   node scripts/diagnose-expediente-duplicates.mjs                 # todos los centros
//   node scripts/diagnose-expediente-duplicates.mjs --center=CITIO  # solo un centro
//   node scripts/diagnose-expediente-duplicates.mjs --json=reporte.json

import { GoogleAuth } from "google-auth-library";
import fs from "fs";

const PROJECT_ID  = process.env.VITE_FIREBASE_PROJECT_ID   || "infusion-core";
const DATABASE_ID = process.env.VITE_FIRESTORE_DATABASE_ID || "default";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

const args = process.argv.slice(2);
const centerArg = args.find(a => a.startsWith("--center="))?.split("=")[1];
const jsonArg = args.find(a => a.startsWith("--json="))?.split("=")[1];

// Mismo criterio que normalize()/normalizePatientName() ya corregidos en la
// app -- colapsa acentos y espacios repetidos, para agrupar como la misma
// persona aunque haya una diferencia invisible de captura entre sesiones.
function normalizeName(str) {
  return str?.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim() || "";
}

function parseDoc(doc) {
  const parse = (v) => {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return parseInt(v.integerValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.nullValue !== undefined) return null;
    if (v.arrayValue) return (v.arrayValue.values || []).map(parse);
    if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, parse(val)]));
    return null;
  };
  const id = doc.name.split("/").pop();
  return { id, ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, parse(v)])) };
}

async function fetchAllSessions(accessToken) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "sessions" }],
      orderBy: [{ field: { fieldPath: "date" }, direction: "ASCENDING" }],
      limit: 5000,
    }}),
  });
  const data = await res.json();
  if (!Array.isArray(data)) { console.error("Error al leer sessions:", data); return []; }
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

function groupByPatient(sessions) {
  const groups = new Map(); // normalizedName -> { names:Set, sessions:[] }
  for (const s of sessions) {
    if (!s.patientName) continue;
    const key = normalizeName(s.patientName);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { names: new Set(), sessions: [] });
    const g = groups.get(key);
    g.names.add(s.patientName);
    g.sessions.push(s);
  }
  return groups;
}

function reportExpedienteDuplicates(groups) {
  const findings = [];
  for (const [key, g] of groups) {
    const withExp = g.sessions.filter(s => (s.expedienteNumber || 0) > 0);
    const distinctNumbers = [...new Set(withExp.map(s => s.expedienteNumber))];
    if (distinctNumbers.length > 1) {
      findings.push({
        patient: [...g.names].join(" / "),
        variantesDeNombre: g.names.size > 1 ? [...g.names] : null,
        expedientes: distinctNumbers.sort((a,b) => a-b).map(num => ({
          numero: num,
          sesiones: withExp.filter(s => s.expedienteNumber === num)
            .map(s => ({ id: s.id, fecha: s.date, centro: s.center, status: s.status }))
            .sort((a,b) => (a.fecha||"").localeCompare(b.fecha||"")),
        })),
      });
    }
  }
  return findings;
}

function reportCounterCollisions(sessions, centerFilter) {
  // Para cada (centro, campo de número consecutivo) junta qué sesiones
  // comparten el mismo número -- si el contador se reinició o se usó una
  // llave de centro distinta por error, aparecerán dos pacientes distintos
  // con el mismo número.
  const fieldsByType = [
    ["infusionNumber", null],
    ["imNumber", ["intramuscular", "im"]],
    ["scNumber", ["subcutaneo", "sc"]],
    ["deliveryNumber", ["entrega"]],
    ["procedureNumber", ["procedimiento"]],
  ];
  const buckets = new Map(); // "CENTRO|campo|numero" -> sesiones
  for (const s of sessions) {
    if (centerFilter && s.center !== centerFilter) continue;
    for (const [field] of fieldsByType) {
      const num = s[field];
      if (!num || num <= 0) continue;
      const bucketKey = `${s.center || ""}|${field}|${num}`;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
      buckets.get(bucketKey).push(s);
    }
  }
  const findings = [];
  for (const [bucketKey, list] of buckets) {
    const distinctPatients = new Set(list.map(s => normalizeName(s.patientName)));
    if (distinctPatients.size > 1) {
      const [centro, campo, numero] = bucketKey.split("|");
      findings.push({
        centro, campo, numero,
        sesiones: list.map(s => ({ id: s.id, paciente: s.patientName, fecha: s.date, status: s.status })),
      });
    }
  }
  return findings;
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).");
    process.exit(1);
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const auth = new GoogleAuth({ credentials: serviceAccount, scopes: ["https://www.googleapis.com/auth/datastore"] });
  const accessToken = await auth.getAccessToken();

  console.log(`Leyendo sesiones de ${PROJECT_ID} (db: ${DATABASE_ID})${centerArg ? ` -- filtrando a centro ${centerArg}` : ""}...`);
  const allSessions = await fetchAllSessions(accessToken);
  console.log(`Total de sesiones leídas: ${allSessions.length}`);

  const sessions = centerArg ? allSessions.filter(s => s.center === centerArg) : allSessions;
  console.log(`Sesiones consideradas tras el filtro de centro: ${sessions.length}\n`);

  const groups = groupByPatient(sessions);
  const expedienteFindings = reportExpedienteDuplicates(groups);
  const counterFindings = reportCounterCollisions(sessions, centerArg);

  console.log(`=== Pacientes con más de un número de expediente (${expedienteFindings.length}) ===`);
  for (const f of expedienteFindings) {
    console.log(`\n• ${f.patient}`);
    if (f.variantesDeNombre) console.log(`  ⚠ nombre capturado de forma distinta entre sesiones: ${f.variantesDeNombre.map(v => `"${v}"`).join(", ")}`);
    for (const exp of f.expedientes) {
      console.log(`  Expediente ${String(exp.numero).padStart(3,"0")}:`);
      for (const s of exp.sesiones) console.log(`    - ${s.fecha}  [${s.centro}]  status=${s.status}  id=${s.id}`);
    }
  }

  console.log(`\n=== Números consecutivos usados por más de un paciente (${counterFindings.length}) ===`);
  for (const f of counterFindings) {
    console.log(`\n• Centro ${f.centro} · ${f.campo} = ${f.numero}`);
    for (const s of f.sesiones) console.log(`    - ${s.fecha}  ${s.paciente}  status=${s.status}  id=${s.id}`);
  }

  if (expedienteFindings.length === 0 && counterFindings.length === 0) {
    console.log("\nNo se encontraron duplicados. ✓");
  }

  if (jsonArg) {
    fs.writeFileSync(jsonArg, JSON.stringify({ expedienteFindings, counterFindings }, null, 2));
    console.log(`\nReporte completo guardado en ${jsonArg}`);
  }
}

main();
