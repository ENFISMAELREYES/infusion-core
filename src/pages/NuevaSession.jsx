import { useState, useEffect, useRef } from "react";
import { useAuth } from "../hooks/useAuth";

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

const CATEGORIES = ["premedicacion","inmunoterapia","quimioterapia","adicional","especialidad","hidratacion","domicilio"];
const CAT_LABEL = { premedicacion:"Premedicación", inmunoterapia:"Inmunoterapia", quimioterapia:"Quimioterapia", adicional:"Adicional", especialidad:"Especialidad", hidratacion:"Hidratación", domicilio:"Domicilio" };
const emptyMed = (order) => ({ id: Date.now() + order, order, name: "", dose: "", diluent: "", time: "", category: "premedicacion", parallelType: "secuencial", startOffset: null });

function getToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function normalize(str) {
  return str?.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim() || "";
}

function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const words = nb.split(" ");
  const matches = words.filter(w => na.includes(w)).length;
  return matches / words.length;
}

async function fetchCatalog(token, center) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "sessions" }],
        select: { fields: [
          { fieldPath: "patientName" }, { fieldPath: "dob" },
          { fieldPath: "diagnosis" }, { fieldPath: "physician" },
          { fieldPath: "insurance" }, { fieldPath: "center" },
          { fieldPath: "meds" }, { fieldPath: "allergies" },
        ]},
        limit: 200,
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return { patients: [], physicians: [], diagnoses: [] };

const sessions = data.filter(d => d.document).map(d => {
    const f = d.document.fields || {};
    const g = (k) => f[k]?.stringValue || "";
    const medNames = (f.meds?.arrayValue?.values || []).map(m => m.mapValue?.fields?.name?.stringValue).filter(Boolean);
   return { patientName: g("patientName"), dob: g("dob"), diagnosis: g("diagnosis"), physician: g("physician"), insurance: g("insurance"), center: g("center"), medNames, allergies: g("allergies") };
  });
  
  // Deduplicar por similitud
  const dedupe = (items, key) => {
    const unique = [];
    items.forEach(item => {
      const val = item[key];
      if (!val) return;
      const exists = unique.find(u => similarity(u[key], val) > 0.85);
      if (!exists) unique.push(item);
    });
    return unique;
  };

const filtered   = center ? sessions.filter(s => s.center === center) : sessions;
const patients   = dedupe(filtered, "patientName");
const physicians = [...new Set(filtered.map(s => s.physician).filter(Boolean))].map(p => ({ physician: p }));
const diagnoses  = [...new Set(filtered.map(s => s.diagnosis).filter(Boolean))].map(d => ({ diagnosis: d }));
const medications = [...new Set(filtered.flatMap(s => s.medNames || []))].map(m => ({ medication: m }));
console.log("Catalog loaded:", { total: sessions.length, filtered: filtered.length, center });
  console.log("Sample centers:", sessions.slice(0,5).map(s => s.center));
// Cargar esquemas
      const schemesRes = await fetch(
        `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`,
        { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ structuredQuery: { from:[{ collectionId:"schemes" }], limit:100 } }) }
      );
      const schemesData = await schemesRes.json();
      const schemes = schemesData.filter(d=>d.document).map(d => {
        const f = d.document.fields || {};
        return { id: d.document.name.split("/").pop(), name: f.name?.stringValue || "" };
      });

      return { patients: dedupe(patients, "patientName"), physicians: dedupe(physicians, "physician"), diagnoses: dedupe(diagnoses, "diagnosis"), medications: dedupe(medications, "medication"), schemes };
}

function Autocomplete({ value, onChange, suggestions, onSelect, placeholder, field }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  console.log("Suggestions:", suggestions.length, "Value:", value, "Field:", field);
const filtered = suggestions
    .map(s => ({ ...s, score: similarity(s[field], value) }))
    .filter(s => s.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"10px 13px", color:"#f0f0f0", fontSize:13, outline:"none" }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position:"absolute", top:"100%", left:0, right:0, zIndex:100,
          background:"#1a1d24", border:"1px solid rgba(255,255,255,0.12)", borderRadius:10,
          marginTop:4, maxHeight:220, overflowY:"auto", boxShadow:"0 8px 24px rgba(0,0,0,0.4)"
        }}>
          {filtered.map((s, i) => (
            <div key={i} onClick={() => { onSelect(s); setOpen(false); }}
              style={{ padding:"10px 14px", cursor:"pointer", borderBottom:"1px solid rgba(255,255,255,0.05)", fontSize:13, color:"#f0f0f0" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.07)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div style={{ fontWeight:600 }}>{s[field]}</div>
              {field === "patientName" && s.dob && <div style={{ fontSize:11, color:"#666", marginTop:2 }}>Nac: {s.dob} · {s.diagnosis}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NuevaSession() {
 const { user, profile } = useAuth();
const canCopyPrevious = user?.uid === "IhiRm5Fc5IT8BzzmQLQaq1dFXGs1";
  const today = getToday();

  const [sessionType, setSessionType] = useState(null);
const [form, setForm] = useState({
    patientName: "", dob: "", diagnosis: "", physician: "",
    insurance: "", cycle: "", applicationDate: today, allergies: "", schemeId: "",
  });
  const [meds, setMeds]       = useState([emptyMed(1)]);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState("");
  const [catalog, setCatalog] = useState({ patients: [], physicians: [], diagnoses: [], medications: [], schemes: [] });
  const [patientSchemeOptions, setPatientSchemeOptions] = useState([]);

  useEffect(() => {
    if (!user || !profile?.center) return;
    user.getIdToken(true).then(token => fetchCatalog(token, profile.center)).then(setCatalog).catch(console.error);
  }, [user, profile?.center]);

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const addMed    = () => setMeds(m => [...m, emptyMed(m.length + 1)]);
  const removeMed = (id) => setMeds(m => m.filter(x => x.id !== id).map((x, i) => ({ ...x, order: i + 1 })));
  const setMedField = (id, k, v) => setMeds(m => m.map(x => x.id === id ? { ...x, [k]: v } : x));

  const selectPatient = async (s) => {
    setForm(f => ({
      ...f,
      patientName: s.patientName || f.patientName,
      dob:         s.dob         || f.dob,
      diagnosis:   s.diagnosis   || f.diagnosis,
      physician:   s.physician   || f.physician,
      insurance:   s.insurance   || f.insurance,
      allergies:   s.allergies   || f.allergies,
    }));
    // Buscar esquemas activos del paciente
    try {
      const token = await user.getIdToken(true);
      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`,
        { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ structuredQuery: {
            from:[{ collectionId:"patientSchemes" }],
            where:{ compositeFilter:{ op:"AND", filters:[
              { fieldFilter:{ field:{ fieldPath:"patientName" }, op:"EQUAL", value:{ stringValue: s.patientName } } },
            ]}},
            limit: 10,
          }})
        }
      );
      const data = await res.json();
      const ps = data.filter(d => d.document).map(d => {
        const f = d.document.fields || {};
        return {
          id: d.document.name.split("/").pop(),
          schemeId: f.schemeId?.stringValue || "",
          schemeStatus: f.schemeStatus?.stringValue || "activo",
        };
      });
      // Solo activos y suspendidos
      setPatientSchemeOptions(ps.filter(p => p.schemeStatus === "activo" || p.schemeStatus === "suspendido"));
    } catch(e) { console.log("Error cargando esquemas:", e); }
  };

  const copyPreviousTreatment = async () => {
    if (!form.patientName) return;
    try {
      const token = await user.getIdToken(true);
      const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "sessions" }],
            where: { fieldFilter: { field: { fieldPath: "patientName" }, op: "EQUAL", value: { stringValue: form.patientName } } },
            orderBy: [{ field: { fieldPath: "date" }, direction: "DESCENDING" }],
            limit: 1,
          }
        })
      });
      const data = await res.json();
      const doc = data.find(d => d.document);
      if (!doc) { alert("No se encontró sesión anterior para este paciente."); return; }
      const f = doc.document.fields || {};
      const parse = (v) => {
        if (!v) return null;
        if (v.stringValue !== undefined) return v.stringValue;
        if (v.integerValue !== undefined) return parseInt(v.integerValue);
        if (v.nullValue !== undefined) return null;
        if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, parse(val)]));
        if (v.arrayValue) return (v.arrayValue.values || []).map(parse);
        return null;
      };
      const prevMeds = parse(f.meds) || [];
      const copiedMeds = prevMeds.map((m, i) => ({
        id: Date.now() + i, order: i + 1,
        name: m.name || "", dose: m.dose || "", diluent: m.diluent || "",
        time: m.time ? String(m.time) : "", category: m.category || "premedicacion",
        parallelType: "secuencial", startOffset: null,
      }));
      if (copiedMeds.length === 0) { alert("La sesión anterior no tiene medicamentos."); return; }
      setMeds(copiedMeds);
    } catch(e) { alert("Error: " + e.message); }
  };
  
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      const token = await user.getIdToken(true);
      const toFV = (val) => {
        if (typeof val === "string")  return { stringValue: val };
        if (typeof val === "boolean") return { booleanValue: val };
        if (typeof val === "number")  return { integerValue: String(val) };
        if (val === null)             return { nullValue: null };
        if (Array.isArray(val))       return { arrayValue: { values: val.map(toFV) } };
        if (typeof val === "object")  return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFV(v)])) } };
        return { stringValue: String(val) };
      };

      const data = {
        ...form,
        sessionType: sessionType || "iv",
        center:    profile?.center || "",
        nurseId:   user?.uid || "",
        nurseName: profile?.name || "",
        date:      form.applicationDate || today,
        status:    "pendiente",
        authorized: false,
        createdAt: new Date().toISOString(),
        meds: meds.map(m => ({ ...m, time: m.time ? parseInt(m.time) : null })),
        events: {}, medEvents: {}, washEvents: {},
      };

      const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions?key=${API_KEY}`,
        { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body: JSON.stringify({ fields }) }
      );
      if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || "Error al guardar"); }
      console.log("Guardado:", (await res.json()).name);
      setSaved(true);
    } catch(err) {
      setError(err.message);
    } finally { setSaving(false); }
  };

  const reset = () => {
    setForm({ patientName:"", dob:"", diagnosis:"", physician:"", insurance:"", cycle:"", applicationDate:today });
    setMeds([emptyMed(1)]); setSaved(false); setError("");
    setSessionType(null);
  };

  const inputStyle = { width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"10px 13px", color:"#f0f0f0", fontSize:13, outline:"none" };
  const labelStyle = { fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 };

  if (saved) return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"80vh", gap:20 }}>
      <div style={{ fontSize:40 }}>✓</div>
      <div style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff" }}>Orden registrada</div>
      <div style={{ fontSize:13, color:"#666" }}>Enviada al Jefe de Enfermería para autorización.</div>
      <button onClick={reset} style={{ padding:"11px 28px", borderRadius:10, fontSize:13, fontWeight:600, background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.12)", color:"#ddd" }}>
        + Registrar otro paciente
      </button>
    </div>
  );

  return (
    <div style={{ padding:"28px 32px", maxWidth:720, margin:"0 auto" }}>
      <div style={{ marginBottom:28 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Nueva sesión</h1>
        <p style={{ fontSize:13, color:"#555" }}>Transcribe la orden de tratamiento del médico</p>
      </div>

      {error && (
        <div style={{ marginBottom:16, padding:"12px 16px", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.3)", borderRadius:10, color:"#ff6b6b", fontSize:13 }}>
          ⚠ {error}
        </div>
      )}
{!sessionType && (
  <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
    <div style={{ fontSize:13, color:"#555", marginBottom:8 }}>Selecciona el tipo de atención:</div>
    {[
     { id:"iv",           icon:"💉", label:"Infusión IV",          desc:"Medicamentos intravenosos" },
      { id:"im",           icon:"💊", label:"Intramuscular",         desc:"Aplicación intramuscular" },
      { id:"sc",           icon:"🩺", label:"Subcutánea",            desc:"Aplicación subcutánea" },
      { id:"entrega",      icon:"📦", label:"Entrega de medicamento", desc:"Medicamento para domicilio" },
      { id:"procedimiento",icon:"🔧", label:"Procedimiento",          desc:"Heparinización, retiro de infusor" },
    ].map(t => (
      <div key={t.id} onClick={() => setSessionType(t.id)}
        style={{ padding:"18px 20px", borderRadius:13, cursor:"pointer", background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", display:"flex", alignItems:"center", gap:14, transition:"all 0.15s" }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.07)"}
        onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}>
        <span style={{ fontSize:28 }}>{t.icon}</span>
        <div>
          <div style={{ fontSize:15, color:"#f0f0f0", fontWeight:600 }}>{t.label}</div>
          <div style={{ fontSize:12, color:"#555", marginTop:2 }}>{t.desc}</div>
        </div>
        <span style={{ marginLeft:"auto", color:"#555" }}>›</span>
      </div>
    ))}
  </div>
)}
      {sessionType && (
  <>
    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
      <button onClick={() => setSessionType(null)} style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"6px 12px", color:"#666", fontSize:12, cursor:"pointer" }}>← Volver</button>
      <span style={{ fontSize:13, color:"#00d4aa", fontWeight:600 }}>
       {sessionType === "iv" ? "💉 Infusión IV" : sessionType === "im" ? "💊 Intramuscular" : sessionType === "sc" ? "🩺 Subcutánea" : sessionType === "entrega" ? "📦 Entrega" : "🔧 Procedimiento"}
      </span>
    </div>
    {/* aquí va todo el formulario existente */}
  </>
)}
{sessionType && (
      <form onSubmit={submit} style={{ display:"flex", flexDirection:"column", gap:24 }}>
        <section style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px" }}>
          <div style={{ fontSize:11, color:"#555", letterSpacing:2, textTransform:"uppercase", marginBottom:16 }}>Datos del paciente</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>

            <div style={{ gridColumn:"1/-1" }}>
              <label style={labelStyle}>Nombre completo</label>
              <Autocomplete
                value={form.patientName}
                onChange={v => setField("patientName", v)}
                suggestions={catalog.patients}
                onSelect={selectPatient}
                placeholder="ej: Juan Pérez García"
                field="patientName"
              />
            </div>

            <div>
              <label style={labelStyle}>Fecha de nacimiento</label>
              <input type="date" required value={form.dob} onChange={e => setField("dob", e.target.value)} style={inputStyle} />
            </div>

           <div>
              <label style={labelStyle}>Alergias</label>
              <input value={form.allergies} onChange={e => setField("allergies", e.target.value)} placeholder="ej: Negadas / Penicilina" style={inputStyle} />
            </div>

            <div style={{ gridColumn:"1/-1" }}>
              <label style={labelStyle}>Diagnóstico</label>
              <Autocomplete
                value={form.diagnosis}
                onChange={v => setField("diagnosis", v)}
                suggestions={catalog.diagnoses}
                onSelect={s => setField("diagnosis", s.diagnosis)}
                placeholder="ej: Cáncer de ovario"
                field="diagnosis"
              />
            </div>

            <div>
              <label style={labelStyle}>Médico tratante</label>
              <Autocomplete
                value={form.physician}
                onChange={v => setField("physician", v)}
                suggestions={catalog.physicians}
                onSelect={s => setField("physician", s.physician)}
                placeholder="ej: Dr. López"
                field="physician"
              />
            </div>

            <div>
              <label style={labelStyle}>Ciclo / Día</label>
              <input required value={form.cycle} onChange={e => setField("cycle", e.target.value)} placeholder="ej: Ciclo 5 Día 1" style={inputStyle} />
            </div>

            <div>
              <label style={labelStyle}>Fecha de aplicación</label>
              <input type="date" value={form.applicationDate} onChange={e => setField("applicationDate", e.target.value)} style={inputStyle} />
            </div>

            <div style={{ gridColumn:"1/-1" }}>
              <label style={labelStyle}>Esquema</label>
              {patientSchemeOptions.length > 0 ? (
                <select value={form.schemeId} onChange={e => setField("schemeId", e.target.value)} style={{ ...inputStyle, cursor:"pointer" }}>
                  <option value="">Sin esquema / definir después</option>
                  {patientSchemeOptions.map(ps => {
                    const scheme = catalog.schemes?.find(s => s.id === ps.schemeId);
                    return <option key={ps.id} value={ps.schemeId}>{scheme?.name || ps.schemeId}{ps.schemeStatus === "suspendido" ? " (suspendido)" : ""}</option>;
                  })}
                </select>
              ) : (
                <div style={{ fontSize:12, color:"#555", padding:"10px 13px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:9 }}>Sin esquema asignado — se puede definir después en Catálogo</div>
              )}
            </div>

          </div>
        </section>

        <section style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase" }}>Medicamentos</div>
            <div style={{ display:"flex", gap:8 }}>
              {canCopyPrevious && (
                <button type="button" onClick={copyPreviousTreatment} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(175,169,236,0.1)", border: "1px solid rgba(175,169,236,0.25)", color: "#AFA9EC", cursor: "pointer" }}>📋 Copiar anterior</button>
              )}
              <button type="button" onClick={addMed} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.25)", color: "#00d4aa", cursor: "pointer" }}>+ Agregar</button>
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {meds.map(med => (
              <div key={med.id} style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:11, padding:"14px 16px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                  <span style={{ fontSize:12, color:"#888", fontFamily:"'IBM Plex Mono', monospace" }}>#{med.order}</span>
                  {meds.length > 1 && <button type="button" onClick={() => removeMed(med.id)} style={{ background:"none", border:"none", color:"#555", fontSize:16, cursor:"pointer" }}>✕</button>}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <div style={{ gridColumn:"1/-1" }}>
                    <label style={labelStyle}>Tipo</label>
                    <select value={med.category} onChange={e => setMedField(med.id, "category", e.target.value)} style={{ ...inputStyle, cursor:"pointer" }}>
                      {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Medicamento</label>
                    <Autocomplete
                      value={med.name}
                      onChange={v => setMedField(med.id, "name", v)}
                      suggestions={catalog.medications}
                      onSelect={s => setMedField(med.id, "name", s.medication)}
                      placeholder="ej: Bevacizumab"
                      field="medication"
                    />
                  </div>
                  <div><label style={labelStyle}>Dosis</label><input required value={med.dose} onChange={e => setMedField(med.id, "dose", e.target.value)} placeholder="ej: 780 mg" style={inputStyle} /></div>
                  {med.category !== "domicilio" && <div><label style={labelStyle}>Dilución</label><input required value={med.diluent} onChange={e => setMedField(med.id, "diluent", e.target.value)} placeholder="ej: 100 ml SF" style={inputStyle} /></div>}
{med.category !== "domicilio" && <div><label style={labelStyle}>Tiempo (minutos)</label><input type="number" min="1" value={med.time} onChange={e => setMedField(med.id, "time", e.target.value)} placeholder="ej: 30" style={inputStyle} /></div>}
                 {meds.indexOf(meds.find(m => m.id === med.id)) > 0 && (
  <div style={{ gridColumn:"1/-1" }}>
    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
      <input type="checkbox" id={`parallel_${med.id}`}
        checked={med.parallelType !== "secuencial"}
        onChange={e => setMedField(med.id, "parallelType", e.target.checked ? "junto" : "secuencial")}
        style={{ width:16, height:16, cursor:"pointer" }} />
      <label htmlFor={`parallel_${med.id}`} style={{ fontSize:12, color:"#aaa", cursor:"pointer" }}>
        ⚡ Infusión simultánea con medicamento anterior
      </label>
    </div>
    {med.parallelType !== "secuencial" && (
      <div style={{ marginTop:10, display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <div>
          <label style={labelStyle}>Tipo de inicio</label>
          <select value={med.parallelType} onChange={e => setMedField(med.id, "parallelType", e.target.value)}
            style={{ ...inputStyle, cursor:"pointer" }}>
            <option value="junto">Simultáneo — inicia al mismo tiempo</option>
            <option value="offset">Con retraso — X minutos después</option>
          </select>
        </div>
        {med.parallelType === "offset" && (
          <div>
            <label style={labelStyle}>Minutos de retraso</label>
            <input type="number" min="1" value={med.startOffset || ""}
              onChange={e => setMedField(med.id, "startOffset", parseInt(e.target.value))}
              placeholder="ej: 30" style={inputStyle} />
          </div>
        )}
      </div>
    )}
  </div>
)}
                </div>
              </div>
            ))}
          </div>
        </section>

        <button type="submit" disabled={saving} style={{
          padding:"14px", borderRadius:12, fontSize:15, fontWeight:700,
          background: saving ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#00d4aa,#0099ff)",
          border:"none", color: saving ? "#555" : "#000", cursor: saving ? "not-allowed" : "pointer",
        }}>
          {saving ? "Guardando..." : "Enviar para autorización →"}
        </button>
      </form>
)}
    </div>
  );
}

