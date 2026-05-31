import { useState } from "react";
import { useAuth } from "../hooks/useAuth";

const CATEGORIES = ["premedicacion", "inmunoterapia", "quimioterapia", "adicional"];
const CAT_LABEL = { premedicacion:"Premedicación", inmunoterapia:"Inmunoterapia", quimioterapia:"Quimioterapia", adicional:"Adicional" };
const emptyMed = (order) => ({ id: Date.now() + order, order, name: "", dose: "", diluent: "", time: "", category: "premedicacion" });

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

export default function NuevaSession() {
  const { user, profile } = useAuth();
  const today = new Date().toISOString().split("T")[0];
  const [form, setForm] = useState({ patientName:"", dob:"", diagnosis:"", physician:"", insurance:"", cycle:"" });
  const [meds, setMeds] = useState([emptyMed(1)]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const addMed = () => setMeds(m => [...m, emptyMed(m.length + 1)]);
  const removeMed = (id) => setMeds(m => m.filter(x => x.id !== id).map((x, i) => ({ ...x, order: i + 1 })));
  const setMedField = (id, k, v) => setMeds(m => m.map(x => x.id === id ? { ...x, [k]: v } : x));

  const toFirestoreValue = (val) => {
    if (typeof val === "string") return { stringValue: val };
    if (typeof val === "boolean") return { booleanValue: val };
    if (typeof val === "number") return { integerValue: String(val) };
    if (val === null) return { nullValue: null };
    if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
    if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFirestoreValue(v)])) } };
    return { stringValue: String(val) };
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const token = await user.getIdToken();
      const data = {
        ...form,
        center: profile?.center || "",
        nurseId: user?.uid || "",
        nurseName: profile?.name || "",
        date: today,
        status: "pendiente",
        authorized: false,
        createdAt: new Date().toISOString(),
        meds: meds.map(m => ({ ...m, time: m.time ? parseInt(m.time) : null })),
        events: {},
        medEvents: {},
      };

      const fields = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, toFirestoreValue(v)])
      );

      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions?key=${API_KEY}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify({ fields }),
        }
      );

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || "Error al guardar");
      }

      const result = await res.json();
      console.log("Guardado:", result.name);
      setSaved(true);
    } catch (err) {
      console.error("Error:", err);
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => { setForm({ patientName:"", dob:"", diagnosis:"", physician:"", insurance:"", cycle:"" }); setMeds([emptyMed(1)]); setSaved(false); setError(""); };

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

      <form onSubmit={submit} style={{ display:"flex", flexDirection:"column", gap:24 }}>
        <section style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px" }}>
          <div style={{ fontSize:11, color:"#555", letterSpacing:2, textTransform:"uppercase", marginBottom:16 }}>Datos del paciente</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
            {[["Nombre completo","patientName","text"],["Fecha de nacimiento","dob","date"],["Diagnóstico","diagnosis","text"],["Médico tratante","physician","text"],["Tipo de atención","insurance","text"],["Ciclo / Día","cycle","text"]].map(([label, key, type]) => (
              <div key={key} style={{ gridColumn: key === "diagnosis" ? "1/-1" : "auto" }}>
                <label style={labelStyle}>{label}</label>
                <input type={type} required value={form[key]} onChange={e => setField(key, e.target.value)} style={inputStyle} />
              </div>
            ))}
          </div>
        </section>

        <section style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <div style={{ fontSize:11, color:"#555", letterSpacing:2, textTransform:"uppercase" }}>Medicamentos</div>
            <button type="button" onClick={addMed} style={{ padding:"6px 14px", borderRadius:8, fontSize:12, fontWeight:600, background:"rgba(0,212,170,0.1)", border:"1px solid rgba(0,212,170,0.25)", color:"#00d4aa" }}>+ Agregar</button>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {meds.map((med) => (
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
                  <div><label style={labelStyle}>Medicamento</label><input required value={med.name} onChange={e => setMedField(med.id, "name", e.target.value)} placeholder="ej: Bevacizumab" style={inputStyle} /></div>
                  <div><label style={labelStyle}>Dosis</label><input required value={med.dose} onChange={e => setMedField(med.id, "dose", e.target.value)} placeholder="ej: 780 mg" style={inputStyle} /></div>
                  <div><label style={labelStyle}>Dilución</label><input required value={med.diluent} onChange={e => setMedField(med.id, "diluent", e.target.value)} placeholder="ej: 100 ml SF" style={inputStyle} /></div>
                  <div><label style={labelStyle}>Tiempo (minutos)</label><input type="number" min="1" value={med.time} onChange={e => setMedField(med.id, "time", e.target.value)} placeholder="ej: 30" style={inputStyle} /></div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <button type="submit" disabled={saving} style={{ padding:"14px", borderRadius:12, fontSize:15, fontWeight:700, background: saving ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#00d4aa,#0099ff)", border:"none", color: saving ? "#555" : "#000", transition:"all 0.2s" }}>
          {saving ? "Guardando..." : "Enviar para autorización →"}
        </button>
      </form>
    </div>
  );
}
