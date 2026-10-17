import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { FIRESTORE_BASE_URL } from "../config";
import { MASTER_CATALOG } from "../data/materialCatalog";

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
  if (val === null || val === undefined) return { nullValue: null };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
  if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFV(v)])) } };
  return { stringValue: String(val) };
}

async function fetchCollection(token, collectionId, limit = 1000) {
  const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

// Mismo criterio que Inventario.jsx: el almacén "PROTOCOLO" es donde vive el
// material/medicamento de los protocolos de investigación clínica, al
// margen de CITIO/CIPI.
const WAREHOUSE = "PROTOCOLO";
const MED_CATEGORIES = ["Medicamentos", "Oncológicos", "Inmunoterapia"];
// Único protocolo por ahora (toma de muestras + aplicación IM). El campo
// queda guardado en cada visita para poder distinguir el de infusión
// cuando se defina, sin tener que migrar nada de lo ya capturado.
const PROTOCOLO_ACTUAL = "muestras_im";

function inventoryDocId(warehouse, item) {
  return `${warehouse}_${item}`.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 200);
}

const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

const fmtMaterial = (arr) => (arr || []).map(m => `${m.item} ×${m.qty}`).join(", ") || "—";
const fmtMuestras = (arr) => (arr || []).map(m => `${m.tipo}${m.cantidad ? ` ×${m.cantidad}` : ""}${m.hora ? ` (${m.hora})` : ""}`).join(", ") || "—";
const fmtMedicamento = (arr) => (arr || []).map(m => `${m.item}${m.dosis ? ` ${m.dosis}` : ""}${m.qty ? ` ×${m.qty}` : ""}`).join(", ") || "—";

function openPrintWindow(title, bodyHtml) {
  const win = window.open("", "_blank", "width=850,height=900");
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#111;}
    h1{font-size:18px;margin-bottom:2px;} h2{font-size:14px;margin:20px 0 6px;}
    p{font-size:12px;color:#555;margin-top:0;margin-bottom:16px;}
    table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:18px;}
    th{text-align:left;padding:6px 8px;border-bottom:2px solid #333;}
    td{padding:5px 8px;border-bottom:1px solid #ddd;vertical-align:top;}
  </style></head><body>${bodyHtml}
    <script>window.onload = () => window.print();<\/script>
  </body></html>`);
  win.document.close();
}

const inputStyle = { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 8, padding: "7px 10px", color: "#f0f0f0", fontSize: 12 };
const btnStyle = { padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.3)", color: "#00d4aa" };
const removeBtnStyle = { padding: "3px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)", color: "#ff6b6b" };

export default function Protocolos() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const isEnfermera = profile?.role === "enfermera";
  const canCapture = isJefe || isEnfermera;
  // El coordinador de protocolos y cualquier otra cuenta visualizador
  // marcada con puedeVerProtocolos solo consultan reportes -- igual que ya
  // hace ManualesGuias.jsx con el visualizador no-médico.
  const blocked = profile?.role === "visualizador" && !profile?.isCoordinadorProtocolos && !profile?.puedeVerProtocolos;

  const [token, setToken] = useState("");
  useEffect(() => { user?.getIdToken().then(setToken); }, [user]);

  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [extraCatalog, setExtraCatalog] = useState([]);

  const loadVisits = async (t) => {
    const data = await fetchCollection(t, "protocol_visits");
    setVisits(data.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "")));
    setLoading(false);
  };
  useEffect(() => { if (token) loadVisits(token); }, [token]);

  useEffect(() => {
    if (!token) return;
    fetch(`${FIRESTORE_BASE_URL}/settings/materialCatalog`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.status === 404 ? null : res.json())
      .then(doc => setExtraCatalog(doc ? (parseDoc(doc).extraCatalog || []) : []))
      .catch(() => setExtraCatalog([]));
  }, [token]);

  const fullCatalog = [...MASTER_CATALOG, ...extraCatalog];
  const insumoOptions = fullCatalog.filter(c => !MED_CATEGORIES.includes(c.category)).map(c => c.item);
  const medOptions = fullCatalog.filter(c => MED_CATEGORIES.includes(c.category)).map(c => c.item);
  const patientOptions = [...new Set(visits.map(v => v.patientName).filter(Boolean))].sort();

  const [tab, setTab] = useState(canCapture ? "captura" : "paciente");

  if (blocked) return <div style={{ padding: 40, color: "#666", textAlign: "center" }}>No tienes acceso a esta sección.</div>;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#fff", marginBottom: 4 }}>Protocolos</h1>
        <p style={{ fontSize: 13, color: "#555" }}>Material, muestras y medicamento de los pacientes en protocolo de investigación clínica</p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {[...(canCapture ? [["captura", "＋ Nueva visita"]] : []), ["paciente", "👤 Por paciente"], ["dia", "📅 Por día"], ["mes", "🗓️ Por mes"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: tab === id ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${tab === id ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.08)"}`,
            color: tab === id ? "#00d4aa" : "#666",
          }}>{label}</button>
        ))}
      </div>

      {loading ? <div style={{ color: "#555", padding: 40, textAlign: "center" }}>Cargando…</div> : (
        <>
          {tab === "captura" && canCapture && (
            <CapturaForm token={token} profile={profile} visits={visits} insumoOptions={insumoOptions} medOptions={medOptions}
              patientOptions={patientOptions} onSaved={() => loadVisits(token)} />
          )}
          {tab === "paciente" && <ReportePorPaciente visits={visits} patientOptions={patientOptions} />}
          {tab === "dia" && <ReportePorDia visits={visits} />}
          {tab === "mes" && <ReportePorMes visits={visits} />}
        </>
      )}
    </div>
  );
}

function CapturaForm({ token, profile, visits, insumoOptions, medOptions, patientOptions, onSaved }) {
  const [patientName, setPatientName] = useState("");
  const [date, setDate] = useState(todayStr());
  const [visitNumber, setVisitNumber] = useState("");
  const [material, setMaterial] = useState([]);
  const [muestras, setMuestras] = useState([]);
  const [medicamento, setMedicamento] = useState([]);
  const [draftMaterial, setDraftMaterial] = useState("");
  const [draftMed, setDraftMed] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  // Sugiere el siguiente número de visita según cuántas ya tiene ese
  // paciente -- no bloquea, se puede corregir a mano antes de guardar.
  useEffect(() => {
    if (!patientName.trim()) return;
    const count = visits.filter(v => (v.patientName || "").toUpperCase() === patientName.trim().toUpperCase()).length;
    setVisitNumber(String(count + 1));
  }, [patientName, visits]);

  const addMaterial = () => {
    if (!draftMaterial.trim()) return;
    setMaterial(prev => [...prev, { item: draftMaterial.trim().toUpperCase(), qty: 1 }]);
    setDraftMaterial("");
  };
  const addMedicamento = () => {
    if (!draftMed.trim()) return;
    setMedicamento(prev => [...prev, { item: draftMed.trim().toUpperCase(), dosis: "", qty: 1 }]);
    setDraftMed("");
  };
  const addMuestra = () => setMuestras(prev => [...prev, { tipo: "", cantidad: 1, hora: "" }]);

  const save = async () => {
    if (!patientName.trim()) { setNotice("Falta el nombre del paciente."); return; }
    if (material.length === 0 && muestras.length === 0 && medicamento.length === 0) {
      setNotice("Agrega al menos material, una muestra o medicamento.");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      const visit = {
        protocolo: PROTOCOLO_ACTUAL,
        patientName: patientName.trim(),
        date, visitNumber: visitNumber ? Number(visitNumber) : null,
        material, muestras, medicamento,
        capturedBy: profile?.name || "",
        createdAt: new Date().toISOString(),
      };
      const res = await fetch(`${FIRESTORE_BASE_URL}/protocol_visits`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries(visit).map(([k, v]) => [k, toFV(v)])) }),
      });
      if (!res.ok) throw new Error(`Error ${res.status} al guardar la visita`);

      // Descontar del almacén "Protocolos" de Inventario -- best-effort: si
      // el artículo todavía no tiene una entrada registrada ahí, se avisa
      // pero la visita ya quedó guardada (el control clínico no depende de
      // que el inventario esté al día).
      const missing = [];
      for (const it of [...material, ...medicamento]) {
        const docId = inventoryDocId(WAREHOUSE, it.item);
        const getRes = await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!getRes.ok) { missing.push(it.item); continue; }
        const doc = parseDoc(await getRes.json());
        await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}?updateMask.fieldPaths=currentStock&updateMask.fieldPaths=lastUpdated`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: { currentStock: toFV((doc.currentStock || 0) - (it.qty || 0)), lastUpdated: toFV(new Date().toISOString()) } }),
        });
      }

      setPatientName(""); setVisitNumber(""); setMaterial([]); setMuestras([]); setMedicamento([]);
      setNotice(missing.length > 0
        ? `Visita guardada. Sin descontar (no están registrados en el almacén "Protocolos" de Inventario): ${missing.join(", ")}.`
        : "Visita guardada.");
      onSaved();
    } catch (e) {
      setNotice("Error al guardar: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#666", marginBottom: 4 }}>Paciente</label>
          <input list="protocolos-pacientes" value={patientName} onChange={e => setPatientName(e.target.value)}
            placeholder="Nombre del paciente" style={{ ...inputStyle, width: 240 }} />
          <datalist id="protocolos-pacientes">{patientOptions.map(p => <option key={p} value={p} />)}</datalist>
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#666", marginBottom: 4 }}>Fecha</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#666", marginBottom: 4 }}>Visita #</label>
          <input type="number" min="1" value={visitNumber} onChange={e => setVisitNumber(e.target.value)} style={{ ...inputStyle, width: 70 }} />
        </div>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#f0f0f0", marginBottom: 8 }}>🧰 Material usado</div>
        {material.map((m, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ flex: 1, fontSize: 12, color: "#ccc" }}>{m.item}</span>
            <input type="number" min="1" value={m.qty} onChange={e => setMaterial(prev => prev.map((x, xi) => xi === i ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x))}
              style={{ ...inputStyle, width: 60 }} />
            <button onClick={() => setMaterial(prev => prev.filter((_, xi) => xi !== i))} style={removeBtnStyle}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <input list="protocolos-insumos" value={draftMaterial} onChange={e => setDraftMaterial(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addMaterial()} placeholder="Agregar material…" style={{ ...inputStyle, flex: 1 }} />
          <datalist id="protocolos-insumos">{insumoOptions.map(o => <option key={o} value={o} />)}</datalist>
          <button onClick={addMaterial} style={btnStyle}>＋ Agregar</button>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#f0f0f0", marginBottom: 8 }}>🧪 Muestras tomadas</div>
        {muestras.map((m, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <input list="protocolos-tipos-muestra" value={m.tipo} onChange={e => setMuestras(prev => prev.map((x, xi) => xi === i ? { ...x, tipo: e.target.value } : x))}
              placeholder="Tipo (ej. sangre)" style={{ ...inputStyle, flex: 1 }} />
            <input type="number" min="1" value={m.cantidad} onChange={e => setMuestras(prev => prev.map((x, xi) => xi === i ? { ...x, cantidad: Math.max(1, Number(e.target.value)) } : x))}
              style={{ ...inputStyle, width: 60 }} />
            <input type="time" value={m.hora} onChange={e => setMuestras(prev => prev.map((x, xi) => xi === i ? { ...x, hora: e.target.value } : x))} style={inputStyle} />
            <button onClick={() => setMuestras(prev => prev.filter((_, xi) => xi !== i))} style={removeBtnStyle}>✕</button>
          </div>
        ))}
        <datalist id="protocolos-tipos-muestra">
          {["Sangre", "Orina", "Saliva", "Hisopado", "Biopsia"].map(o => <option key={o} value={o} />)}
        </datalist>
        <button onClick={addMuestra} style={btnStyle}>＋ Agregar muestra</button>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#f0f0f0", marginBottom: 8 }}>💉 Medicamento aplicado (IM)</div>
        {medicamento.map((m, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ flex: 1, fontSize: 12, color: "#ccc" }}>{m.item}</span>
            <input placeholder="Dosis" value={m.dosis} onChange={e => setMedicamento(prev => prev.map((x, xi) => xi === i ? { ...x, dosis: e.target.value } : x))}
              style={{ ...inputStyle, width: 90 }} />
            <input type="number" min="1" value={m.qty} onChange={e => setMedicamento(prev => prev.map((x, xi) => xi === i ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x))}
              style={{ ...inputStyle, width: 60 }} />
            <button onClick={() => setMedicamento(prev => prev.filter((_, xi) => xi !== i))} style={removeBtnStyle}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <input list="protocolos-medicamentos" value={draftMed} onChange={e => setDraftMed(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addMedicamento()} placeholder="Agregar medicamento…" style={{ ...inputStyle, flex: 1 }} />
          <datalist id="protocolos-medicamentos">{medOptions.map(o => <option key={o} value={o} />)}</datalist>
          <button onClick={addMedicamento} style={btnStyle}>＋ Agregar</button>
        </div>
      </div>

      {notice && <div style={{ fontSize: 12, color: notice.startsWith("Error") ? "#ff6b6b" : "#00d4aa", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "8px 12px" }}>{notice}</div>}

      <button onClick={save} disabled={saving} style={{ ...btnStyle, alignSelf: "flex-start", padding: "10px 20px", fontSize: 13, cursor: saving ? "wait" : "pointer" }}>
        {saving ? "Guardando…" : "Guardar visita"}
      </button>
    </div>
  );
}

function VisitTable({ rows, showPatient }) {
  if (rows.length === 0) return <div style={{ color: "#444", padding: 30, textAlign: "center", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 14 }}>Sin visitas para este filtro.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#666" }}>
            <th style={{ padding: "6px 8px" }}>Fecha</th>
            {showPatient && <th style={{ padding: "6px 8px" }}>Paciente</th>}
            <th style={{ padding: "6px 8px" }}>Visita</th>
            <th style={{ padding: "6px 8px" }}>Material</th>
            <th style={{ padding: "6px 8px" }}>Muestras</th>
            <th style={{ padding: "6px 8px" }}>Medicamento</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(v => (
            <tr key={v.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <td style={{ padding: "6px 8px", color: "#ccc" }}>{v.date}</td>
              {showPatient && <td style={{ padding: "6px 8px", color: "#f0f0f0", fontWeight: 600 }}>{v.patientName}</td>}
              <td style={{ padding: "6px 8px", color: "#888" }}>{v.visitNumber ?? "—"}</td>
              <td style={{ padding: "6px 8px", color: "#AFA9EC" }}>{fmtMaterial(v.material)}</td>
              <td style={{ padding: "6px 8px", color: "#00d4aa" }}>{fmtMuestras(v.muestras)}</td>
              <td style={{ padding: "6px 8px", color: "#ffb347" }}>{fmtMedicamento(v.medicamento)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportePorPaciente({ visits, patientOptions }) {
  const [patient, setPatient] = useState(patientOptions[0] || "");
  useEffect(() => { if (!patient && patientOptions.length > 0) setPatient(patientOptions[0]); }, [patientOptions]);

  if (patientOptions.length === 0) return <div style={{ color: "#444", padding: 40, textAlign: "center" }}>Aún no hay visitas registradas.</div>;

  const rows = visits.filter(v => v.patientName === patient).sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const print = () => {
    const body = `
      <h1>Protocolos — ${patient}</h1>
      <p>${rows.length} visita${rows.length !== 1 ? "s" : ""} · Generado ${new Date().toLocaleString("es-MX")}</p>
      <table><thead><tr><th>Fecha</th><th>Visita</th><th>Material</th><th>Muestras</th><th>Medicamento</th></tr></thead><tbody>
      ${rows.map(v => `<tr><td>${v.date}</td><td>${v.visitNumber ?? "—"}</td><td>${fmtMaterial(v.material)}</td><td>${fmtMuestras(v.muestras)}</td><td>${fmtMedicamento(v.medicamento)}</td></tr>`).join("")}
      </tbody></table>`;
    openPrintWindow(`Protocolos — ${patient}`, body);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
        <select value={patient} onChange={e => setPatient(e.target.value)} style={inputStyle}>
          {patientOptions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={print} style={btnStyle}>🖨️ Imprimir</button>
      </div>
      <VisitTable rows={rows} showPatient={false} />
    </div>
  );
}

function ReportePorDia({ visits }) {
  const [day, setDay] = useState(todayStr());
  const rows = visits.filter(v => v.date === day).sort((a, b) => (a.patientName || "").localeCompare(b.patientName || ""));

  const print = () => {
    const body = `
      <h1>Protocolos — ${day}</h1>
      <p>${rows.length} visita${rows.length !== 1 ? "s" : ""} · Generado ${new Date().toLocaleString("es-MX")}</p>
      <table><thead><tr><th>Paciente</th><th>Visita</th><th>Material</th><th>Muestras</th><th>Medicamento</th></tr></thead><tbody>
      ${rows.map(v => `<tr><td>${v.patientName}</td><td>${v.visitNumber ?? "—"}</td><td>${fmtMaterial(v.material)}</td><td>${fmtMuestras(v.muestras)}</td><td>${fmtMedicamento(v.medicamento)}</td></tr>`).join("")}
      </tbody></table>`;
    openPrintWindow(`Protocolos — ${day}`, body);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <button onClick={() => { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() - 1); setDay(d.toLocaleDateString("en-CA")); }} style={{ ...inputStyle, cursor: "pointer" }}>◀</button>
        <input type="date" value={day} onChange={e => setDay(e.target.value)} style={inputStyle} />
        <button onClick={() => { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() + 1); setDay(d.toLocaleDateString("en-CA")); }} style={{ ...inputStyle, cursor: "pointer" }}>▶</button>
        <button onClick={print} style={btnStyle}>🖨️ Imprimir</button>
      </div>
      <VisitTable rows={rows} showPatient={true} />
    </div>
  );
}

function ReportePorMes({ visits }) {
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const rows = visits.filter(v => (v.date || "").startsWith(month)).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const patients = new Set(rows.map(v => v.patientName));

  const matTotals = {}, medTotals = {}, muestraTotals = {};
  rows.forEach(v => {
    (v.material || []).forEach(m => { matTotals[m.item] = (matTotals[m.item] || 0) + (m.qty || 0); });
    (v.medicamento || []).forEach(m => { medTotals[m.item] = (medTotals[m.item] || 0) + (m.qty || 0); });
    (v.muestras || []).forEach(m => { muestraTotals[m.tipo] = (muestraTotals[m.tipo] || 0) + (m.cantidad || 0); });
  });
  const totalsRows = (totals) => Object.entries(totals).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([item, qty]) => `<tr><td>${item}</td><td style="text-align:right;">${qty}</td></tr>`).join("") || `<tr><td colspan="2">—</td></tr>`;

  const print = () => {
    const body = `
      <h1>Protocolos — ${month}</h1>
      <p>${rows.length} visita${rows.length !== 1 ? "s" : ""} · ${patients.size} paciente${patients.size !== 1 ? "s" : ""} · Generado ${new Date().toLocaleString("es-MX")}</p>
      <h2>Material consumido</h2>
      <table><thead><tr><th>Artículo</th><th style="text-align:right;">Cantidad</th></tr></thead><tbody>${totalsRows(matTotals)}</tbody></table>
      <h2>Medicamento aplicado</h2>
      <table><thead><tr><th>Medicamento</th><th style="text-align:right;">Cantidad</th></tr></thead><tbody>${totalsRows(medTotals)}</tbody></table>
      <h2>Muestras tomadas</h2>
      <table><thead><tr><th>Tipo</th><th style="text-align:right;">Cantidad</th></tr></thead><tbody>${totalsRows(muestraTotals)}</tbody></table>
      <h2>Detalle por visita</h2>
      <table><thead><tr><th>Fecha</th><th>Paciente</th><th>Visita</th><th>Material</th><th>Muestras</th><th>Medicamento</th></tr></thead><tbody>
      ${rows.map(v => `<tr><td>${v.date}</td><td>${v.patientName}</td><td>${v.visitNumber ?? "—"}</td><td>${fmtMaterial(v.material)}</td><td>${fmtMuestras(v.muestras)}</td><td>${fmtMedicamento(v.medicamento)}</td></tr>`).join("")}
      </tbody></table>`;
    openPrintWindow(`Protocolos — ${month}`, body);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={inputStyle} />
        <button onClick={print} style={btnStyle}>🖨️ Imprimir</button>
      </div>
      <div style={{ marginBottom: 16, fontSize: 13, color: "#888" }}>
        {rows.length} visita{rows.length !== 1 ? "s" : ""} · {patients.size} paciente{patients.size !== 1 ? "s" : ""}
      </div>
      <VisitTable rows={rows} showPatient={true} />
    </div>
  );
}
