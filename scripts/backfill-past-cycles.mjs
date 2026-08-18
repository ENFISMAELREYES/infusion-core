// Migración única: genera las citas ESTIMADAS de los ciclos anteriores (1 a
// currentCycle-1) para los esquemas de paciente que ya existían ANTES de que
// Agenda.jsx empezara a generarlas automáticamente al crear el esquema
// (commit "Generate estimated past cycles for schemes assigned mid-treatment").
//
// Es idempotente -- si un patientScheme ya tiene citas para algún ciclo
// anterior a currentCycle, se salta (para no duplicar si se corre dos veces).
//
// Uso: mismo patrón que migrate-users-to-firestore.mjs
//   export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
//   export VITE_FIREBASE_PROJECT_ID="infusion-core"      (opcional, es el default)
//   export VITE_FIRESTORE_DATABASE_ID="pruebas"           (opcional, default "default")
//   node scripts/backfill-past-cycles.mjs

import { GoogleAuth } from "google-auth-library";

const PROJECT_ID  = process.env.VITE_FIREBASE_PROJECT_ID   || "infusion-core";
const DATABASE_ID = process.env.VITE_FIRESTORE_DATABASE_ID || "default";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

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

function toFV(val) {
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  return { stringValue: String(val) };
}

// Copia exacta de calcPastDates() en src/pages/Agenda.jsx.
function calcPastDates(startDate, scheme, currentCycle) {
  const dates = [];
  const start = new Date(startDate + "T12:00:00");
  for (let cycle = 1; cycle < currentCycle; cycle++) {
    const cycleStart = new Date(start);
    cycleStart.setDate(start.getDate() + (cycle - currentCycle) * scheme.cycleDurationDays);
    for (const day of scheme.administrationDays) {
      const d = new Date(cycleStart);
      d.setDate(cycleStart.getDate() + (day - 1));
      dates.push({ date: d.toISOString().split("T")[0], cycle, day, label: `C${cycle}D${day}`, estimated: true });
    }
  }
  return dates.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchCollection(accessToken, collectionId) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit: 2000 } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) { console.error(`Error al leer "${collectionId}":`, data); return []; }
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).");
    process.exit(1);
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const auth = new GoogleAuth({ credentials: serviceAccount, scopes: ["https://www.googleapis.com/auth/datastore"] });
  const accessToken = await auth.getAccessToken();

  console.log(`Backfill de ciclos pasados en ${PROJECT_ID} (db: ${DATABASE_ID})...`);

  const [patientSchemes, schemes, appointments] = await Promise.all([
    fetchCollection(accessToken, "patientSchemes"),
    fetchCollection(accessToken, "schemes"),
    fetchCollection(accessToken, "appointments"),
  ]);

  const today = new Date().toISOString().split("T")[0];
  let created = 0, skipped = 0, warned = 0;

  for (const ps of patientSchemes) {
    const currentCycle = ps.currentCycle || 1;
    if (currentCycle <= 1) continue; // nada que rellenar -- ya arrancó en el ciclo 1

    const scheme = schemes.find(s => s.id === ps.schemeId);
    if (!scheme || !ps.startDate) {
      console.warn(`  ⚠ ${ps.patientName}: sin esquema o sin fecha de ancla, se salta.`);
      warned++;
      continue;
    }

    const alreadyHasPast = appointments.some(a => a.patientSchemeId === ps.id && a.cycle < currentCycle);
    if (alreadyHasPast) { skipped++; continue; }

    const pastDates = calcPastDates(ps.startDate, scheme, currentCycle);
    if (pastDates.length === 0) continue;

    for (const d of pastDates) {
      const apptFields = {
        patientSchemeId: toFV(ps.id),
        patientName:     toFV(ps.patientName),
        schemeId:        toFV(ps.schemeId),
        date:            toFV(d.date),
        cycle:           toFV(d.cycle),
        day:             toFV(d.day),
        label:           toFV(d.label),
        status:          toFV(d.date < today ? "past" : "scheduled"),
        center:          toFV(ps.center || ""),
        estimated:       toFV(true),
        createdAt:       toFV(new Date().toISOString()),
      };
      const res = await fetch(`${BASE}/appointments`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
        body: JSON.stringify({ fields: apptFields }),
      });
      if (res.ok) created++;
      else console.error(`  ✗ ${ps.patientName} ${d.label}: ${res.status} ${await res.text()}`);
    }
    console.log(`  ✓ ${ps.patientName}: ${pastDates.length} ciclos estimados generados (C1-C${currentCycle - 1})`);
  }

  console.log(`Listo: ${created} citas creadas, ${skipped} esquema(s) ya tenían ciclos previos (se saltaron), ${warned} con advertencia.`);
}

main();
