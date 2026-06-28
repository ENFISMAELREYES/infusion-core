import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

const CAT_COLOR = {
  premedicacion: "#FAC775", inmunoterapia: "#5DCAA5",
  quimioterapia: "#F09595", adicional: "#AFA9EC", 
  especialidad: "#F7A8D0", hidratacion: "#FFFFFF", domicilio: "#82C4F8",
};
const CATEGORIES = ["premedicacion","inmunoterapia","quimioterapia","adicional","especialidad","domicilio"];
const CAT_LABEL = { premedicacion:"Premedicación", inmunoterapia:"Inmunoterapia", quimioterapia:"Quimioterapia", adicional:"Adicional", especialidad:"Especialidad", domicilio:"Domicilio" };

function nowStr() {
  return new Date().toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit", hour12:false });
}

function getToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone:"America/Mexico_City" });
}

function parseFirestoreDoc(doc) {
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

async function fetchSessionsByNurse(token, nurseId) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from:[{ collectionId:"sessions" }],
        where:{ fieldFilter:{ field:{ fieldPath:"center" }, op:"EQUAL", value:{ stringValue:nurseId } } },
        orderBy:[{ field:{ fieldPath:"date" }, direction:"DESCENDING" }],
        limit: 100,
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseFirestoreDoc(d.document));
}

async function fetchTodaySessions(token, center, date) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from:[{ collectionId:"sessions" }],
        where:{ compositeFilter:{ op:"AND", filters:[
          { fieldFilter:{ field:{ fieldPath:"date" }, op:"EQUAL", value:{ stringValue:date } } },
          { fieldFilter:{ field:{ fieldPath:"center" }, op:"EQUAL", value:{ stringValue:center } } },
        ]}}
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseFirestoreDoc(d.document));
}

async function patchSession(token, sessionId, updates) {
  const toFV = (val) => {
    if (typeof val === "string") return { stringValue:val };
    if (typeof val === "boolean") return { booleanValue:val };
    if (typeof val === "number") return { integerValue:String(val) };
    if (val === null) return { nullValue:null };
    if (Array.isArray(val)) return { arrayValue:{ values:val.map(toFV) } };
    if (typeof val === "object") return { mapValue:{ fields:Object.fromEntries(Object.entries(val).map(([k,v]) => [k,toFV(v)])) } };
    return { stringValue:String(val) };
  };
  const simpleUpdates = {}, nestedUpdates = {};
  Object.entries(updates).forEach(([k,v]) => {
    if (k.includes(".")) nestedUpdates[k] = v;
    else simpleUpdates[k] = v;
  });
  if (Object.keys(simpleUpdates).length > 0) {
    const fields = Object.fromEntries(Object.entries(simpleUpdates).map(([k,v]) => [k,toFV(v)]));
    const mask   = Object.keys(simpleUpdates).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
    await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions/${sessionId}?${mask}`,
      { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields }) });
  }
  for (const [path, value] of Object.entries(nestedUpdates)) {
    const parts = path.split(".");
    const mask  = `updateMask.fieldPaths=${encodeURIComponent(path)}`;
    let fields  = {};
    if (parts.length === 2) fields[parts[0]] = { mapValue:{ fields:{ [parts[1]]:toFV(value) } } };
    else if (parts.length === 3) fields[parts[0]] = { mapValue:{ fields:{ [parts[1]]:{ mapValue:{ fields:{ [parts[2]]:toFV(value) } } } } } };
    await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions/${sessionId}?${mask}`,
      { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields }) });
  }
}

async function updateSessionMeds(token, sessionId, meds, reAuth) {
  const toFV = (val) => {
    if (typeof val === "string") return { stringValue:val };
    if (typeof val === "boolean") return { booleanValue:val };
    if (typeof val === "number") return { integerValue:String(val) };
    if (val === null) return { nullValue:null };
    if (Array.isArray(val)) return { arrayValue:{ values:val.map(toFV) } };
    if (typeof val === "object") return { mapValue:{ fields:Object.fromEntries(Object.entries(val).map(([k,v]) => [k,toFV(v)])) } };
    return { stringValue:String(val) };
  };
  const fields = { meds:toFV(meds) };
  if (reAuth) fields.authorized = { booleanValue:false };
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions/${sessionId}?${mask}`,
    { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields }) });
}

async function deleteSessionAPI(token, sessionId) {
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions/${sessionId}`,
    { method:"DELETE", headers:{ "Authorization":`Bearer ${token}` } }
  );
}

function ElapsedTimer({ startTime }) {
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    const calc = () => {
      if (!startTime) return;
      const pt = (t) => {
        if (t.includes("a.m.")||t.includes("p.m.")) {
          const [time,period] = t.split(" ");
          const [h,m] = time.split(":").map(Number);
          let hours = h;
          if (period==="p.m."&&h!==12) hours+=12;
          if (period==="a.m."&&h===12) hours=0;
          return hours*60+m;
        }
        const [h,m] = t.split(":").map(Number);
        return h*60+m;
      };
      const now    = new Date();
      const nowMin = now.getHours()*60+now.getMinutes();
      const diff   = nowMin-pt(startTime);
      if (diff<0) return;
      setElapsed(`${Math.floor(diff/60)}h ${diff%60}m`);
    };
    calc();
    const id = setInterval(calc, 60000);
    return () => clearInterval(id);
  }, [startTime]);
  return <div style={{ fontSize:10, color:"#00d4aa", marginTop:2, fontFamily:"'IBM Plex Mono', monospace" }}>⏱ {elapsed}</div>;
}

function WashCard({ wash, washEvents, medId, onStart, onEnd, canStart }) {
  if (!wash) return null;
  const ev      = washEvents?.[`wash_${medId}`] || {};
  const started = !!ev.inicio;
  const ended   = !!ev.fin;
  return (
    <div style={{ margin:"4px 0", borderRadius:10, overflow:"hidden", border:`1px solid ${ended?"rgba(79,195,247,0.25)":started?"rgba(0,212,170,0.25)":"rgba(79,195,247,0.2)"}`, background:ended?"rgba(79,195,247,0.05)":"rgba(79,195,247,0.03)" }}>
      <div style={{ padding:"10px 14px", display:"flex", alignItems:"center", gap:10 }}>
        <span style={{ fontSize:16 }}>💧</span>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:12, color:"#4fc3f7", fontWeight:600 }}>Lavado — {wash.solution} · {wash.time} min · {wash.speed ? `${wash.speed} ml/hr` : "—"}</div>
          <div style={{ fontSize:11, color:"#555", marginTop:1 }}>{ended?"Lavado completado":started?"Lavado en curso":"Iniciar lavado antes del siguiente medicamento"}</div>
        </div>
        <span style={{ fontSize:14 }}>{ended?"✓":started?"⏳":"○"}</span>
      </div>
      <div style={{ padding:"0 14px 10px", display:"flex", gap:8 }}>
        {!started && <button onClick={onStart} disabled={!canStart} style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:canStart?"pointer":"not-allowed", background:canStart?"rgba(79,195,247,0.12)":"rgba(255,255,255,0.03)", border:`1px solid ${canStart?"rgba(79,195,247,0.3)":"rgba(255,255,255,0.06)"}`, color:canStart?"#4fc3f7":"#444" }}>▶ Iniciar lavado</button>}
        {started && !ended && (
          <>
            <div style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, textAlign:"center", background:"rgba(79,195,247,0.07)", border:"1px solid rgba(79,195,247,0.18)", color:"#4fc3f7" }}>▶ {ev.inicio}</div>
            <button onClick={onEnd} style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(29,158,117,0.12)", border:"1px solid rgba(29,158,117,0.3)", color:"#1D9E75" }}>■ Terminar lavado</button>
          </>
        )}
        {ended && (
          <div style={{ flex:1, display:"flex", gap:8 }}>
            <div style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, textAlign:"center", background:"rgba(79,195,247,0.05)", border:"1px solid rgba(79,195,247,0.15)", color:"#4fc3f7" }}>▶ {ev.inicio}</div>
            <div style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, textAlign:"center", background:"rgba(29,158,117,0.05)", border:"1px solid rgba(29,158,117,0.15)", color:"#1D9E75" }}>■ {ev.fin}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function TimeBtn({ label, time, onRecord, disabled }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 14px", borderRadius:10, background:time?"rgba(29,158,117,0.08)":"rgba(255,255,255,0.03)", border:`1px solid ${time?"rgba(29,158,117,0.25)":"rgba(255,255,255,0.07)"}` }}>
      <div>
        <div style={{ fontSize:11, color:"#666", letterSpacing:1, textTransform:"uppercase" }}>{label}</div>
        {time && <div style={{ fontSize:14, color:"#1D9E75", fontFamily:"'IBM Plex Mono', monospace", marginTop:2, fontWeight:600 }}>{time}</div>}
      </div>
      {!time && !disabled && <button onClick={onRecord} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.12)", color:"#ddd", borderRadius:8, padding:"7px 14px", fontSize:12, fontWeight:600, cursor:"pointer" }}>Registrar</button>}
      {disabled && !time && <span style={{ fontSize:11, color:"#444" }}>—</span>}
    </div>
  );
}

function AddMedForm({ onAdd, onCancel }) {
  const inputStyle = { width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"9px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };
  const labelStyle = { fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 };
  const [med, setMed] = useState({ name:"", dose:"", diluent:"", time:"", category:"premedicacion" });
  const set = (k,v) => setMed(m => ({ ...m, [k]:v }));
  return (
    <div style={{ background:"rgba(0,212,170,0.05)", border:"1px dashed rgba(0,212,170,0.3)", borderRadius:12, padding:"16px" }}>
      <div style={{ fontSize:12, color:"#00d4aa", fontWeight:600, marginBottom:12 }}>➕ Nuevo medicamento</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <div style={{ gridColumn:"1/-1" }}>
          <label style={labelStyle}>Tipo</label>
          <select value={med.category} onChange={e => set("category",e.target.value)} style={{ ...inputStyle, cursor:"pointer" }}>
            {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
          </select>
        </div>
        <div><label style={labelStyle}>Medicamento</label><input value={med.name} onChange={e => set("name",e.target.value)} placeholder="ej: Bevacizumab" style={inputStyle} /></div>
        <div><label style={labelStyle}>Dosis</label><input value={med.dose} onChange={e => set("dose",e.target.value)} placeholder="ej: 780 mg" style={inputStyle} /></div>
        {med.category !== "domicilio" && <div><label style={labelStyle}>Dilución</label><input value={med.diluent} onChange={e => set("diluent",e.target.value)} placeholder="ej: 100 ml SF" style={inputStyle} /></div>}
{med.category !== "domicilio" && <div><label style={labelStyle}>Tiempo (min)</label><input type="number" min="1" value={med.time} onChange={e => set("time",e.target.value)} placeholder="ej: 30" style={inputStyle} /></div>}
      </div>
      <div style={{ display:"flex", gap:8, marginTop:12 }}>
        <button onClick={() => { if (!med.name) return; onAdd({ ...med, time:parseInt(med.time)||0, id:Date.now() }); }} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"linear-gradient(135deg,#1D9E75,#0F6E56)", border:"none", color:"#fff" }}>✓ Agregar</button>
        <button onClick={onCancel} style={{ padding:"9px 16px", borderRadius:9, fontSize:13, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#666" }}>Cancelar</button>
      </div>
    </div>
  );
}

function EditMedForm({ med, onSave, onCancel }) {
  const inputStyle = { width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"9px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };
  const labelStyle = { fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 };
  const [draft, setDraft] = useState({ ...med, time:String(med.time||"") });
  const set = (k,v) => setDraft(d => ({ ...d, [k]:v }));
  return (
    <div style={{ background:"rgba(255,179,71,0.05)", border:"1px dashed rgba(255,179,71,0.3)", borderRadius:12, padding:"16px", marginTop:6 }}>
      <div style={{ fontSize:12, color:"#ffb347", fontWeight:600, marginBottom:12 }}>✏️ Editar medicamento</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <div style={{ gridColumn:"1/-1" }}>
          <label style={labelStyle}>Tipo</label>
          <select value={draft.category} onChange={e => set("category",e.target.value)} style={{ ...inputStyle, cursor:"pointer" }}>
            {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
          </select>
        </div>
        <div><label style={labelStyle}>Medicamento</label><input value={draft.name} onChange={e => set("name",e.target.value)} style={inputStyle} /></div>
        <div><label style={labelStyle}>Dosis</label><input value={draft.dose} onChange={e => set("dose",e.target.value)} style={inputStyle} /></div>
       {med.category !== "domicilio" && <div><label style={labelStyle}>Dilución</label><input required value={med.diluent} onChange={e => setMedField(med.id, "diluent", e.target.value)} placeholder="ej: 100 ml SF" style={inputStyle} /></div>}
{med.category !== "domicilio" && <div><label style={labelStyle}>Tiempo (minutos)</label><input type="number" min="1" value={med.time} onChange={e => setMedField(med.id, "time", e.target.value)} placeholder="ej: 30" style={inputStyle} /></div>}
      </div>
      <div style={{ display:"flex", gap:8, marginTop:12 }}>
        <button onClick={() => onSave({ ...draft, time:parseInt(draft.time)||0 })} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"linear-gradient(135deg,#EF9F27,#BA7517)", border:"none", color:"#000" }}>✓ Guardar cambios</button>
        <button onClick={onCancel} style={{ padding:"9px 16px", borderRadius:9, fontSize:13, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#666" }}>Cancelar</button>
      </div>
    </div>
  );
}

// Tarjeta para sesiones pendientes y programadas (no del día)
function PendingSessionCard({ session, user, onRefresh }) {
  const [open, setOpen]     = useState(false);
  const [editDate, setEditDate] = useState(session.date || "");
  const [saving, setSaving] = useState(false);

  const handleReschedule = async () => {
    if (!editDate || editDate === session.date) return;
    setSaving(true);
    try {
      const token = await user.getIdToken(true);
      await patchSession(token, session.id, { date: editDate, applicationDate: editDate });
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm(`¿Eliminar sesión de ${session.patientName}?`)) return;
    try {
      const token = await user.getIdToken(true);
      await deleteSessionAPI(token, session.id);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  const handleReauth = async () => {
    if (!confirm(`¿Enviar a reautorización la sesión de ${session.patientName}?`)) return;
    try {
      const token = await user.getIdToken(true);
      await patchSession(token, session.id, { authorized: false });
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  const statusColor = !session.authorized ? "#ffb347" : "#1D9E75";
  const statusLabel = !session.authorized ? "Sin autorizar" : "Autorizado";

  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:`1px solid ${statusColor}33`, borderLeft:`3px solid ${statusColor}`, borderRadius:14, overflow:"hidden", marginBottom:10 }}>
      <div onClick={() => setOpen(o=>!o)} style={{ padding:"14px 18px", cursor:"pointer", display:"flex", alignItems:"center", gap:12 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, color:"#f0f0f0", fontWeight:600 }}>{session.patientName}</div>
          <div style={{ fontSize:12, color:"#666", marginTop:2 }}>{session.diagnosis} · {session.cycle}</div>
          <div style={{ fontSize:11, color:"#555", marginTop:2 }}>{session.physician}</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:12, color:"#777", marginBottom:4 }}>{session.date}</div>
          <span style={{ fontSize:11, padding:"2px 10px", borderRadius:99, background:`${statusColor}18`, color:statusColor, border:`1px solid ${statusColor}44` }}>{statusLabel}</span>
        </div>
        <span style={{ color:"#555", marginLeft:8 }}>{open?"▲":"▼"}</span>
      </div>

      {open && (
        <div style={{ padding:"14px 18px", borderTop:"1px solid rgba(255,255,255,0.05)", display:"flex", flexDirection:"column", gap:12 }}>
          {/* Medicamentos */}
          <div style={{ fontSize:11, color:"#555", letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>Medicamentos</div>
          {(session.meds||[]).map(m => (
            <div key={m.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", background:"rgba(255,255,255,0.02)", borderRadius:8, borderLeft:`3px solid ${CAT_COLOR[m.category]||"#888"}` }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:12, color:"#ddd", fontWeight:600 }}>{m.name} {m.dose}</div>
                <div style={{ fontSize:11, color:"#555" }}>{m.diluent} · {m.time} min</div>
              </div>
            </div>
          ))}

          {/* Reagendar */}
          <div>
            <div style={{ fontSize:11, color:"#555", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Reagendar</div>
            <div style={{ display:"flex", gap:8 }}>
              <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                style={{ flex:1, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"8px 12px", color:"#f0f0f0", fontSize:13, outline:"none" }} />
              <button onClick={handleReschedule} disabled={saving || editDate === session.date}
                style={{ padding:"8px 16px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
                {saving ? "..." : "Guardar fecha"}
              </button>
            </div>
          </div>

          {/* Acciones */}
          <div style={{ display:"flex", gap:8 }}>
            {session.authorized && (
              <button onClick={handleReauth} style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>
                ↩ Enviar a reautorización
              </button>
            )}
            <button onClick={handleDelete} style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
              🗑 Eliminar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionCard({ session, token, onRefresh, user }) {
  const [open, setOpen]       = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const events     = session.events    || {};
  const medEvents  = session.medEvents || {};
  const washEvents = session.washEvents || {};

 const recordEvent = async (key) => {
    try {
      const freshToken = await user.getIdToken(true);
      const t = nowStr();
      const updates = { [`events.${key}`]: t };
      if (key === "ingreso") {
        updates.status = "en_curso";
        // Confirmar cita en agenda si existe
try {
  const today = getToday();
  const apptUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const apptRes = await fetch(apptUrl, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${freshToken}` },
    body: JSON.stringify({ structuredQuery: {
      from:[{ collectionId:"appointments" }],
      where:{ compositeFilter:{ op:"AND", filters:[
        { fieldFilter:{ field:{ fieldPath:"patientName" }, op:"EQUAL", value:{ stringValue:session.patientName } } },
        { fieldFilter:{ field:{ fieldPath:"date" }, op:"EQUAL", value:{ stringValue:today } } },
      ]}},
      limit:1,
    }})
  });
  const apptData = await apptRes.json();
  const appt = apptData.find(d => d.document);
  if (appt) {
    const apptId = appt.document.name.split("/").pop();
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/appointments/${apptId}?updateMask.fieldPaths=status&updateMask.fieldPaths=confirmedAt`,
      { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${freshToken}` },
        body: JSON.stringify({ fields: {
          status:      { stringValue:"confirmed" },
          confirmedAt: { stringValue:new Date().toISOString() },
        }})
      }
    );
  }
} catch(err) { console.log("No se pudo confirmar cita:", err); }
       // Asignar número consecutivo del centro
       const counterId = session.sessionType === "entrega" 
          ? `counter_${session.center}_entrega`
          : (session.sessionType === "intramuscular" || session.sessionType === "im")
          ? `counter_${session.center}_im`
          : (session.sessionType === "subcutaneo" || session.sessionType === "sc")
          ? `counter_${session.center}_sc`
          : session.sessionType === "procedimiento"
          ? `counter_${session.center}_procedimiento`
          : `counter_${session.center}`;
        const counterRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/config/${counterId}`,
          { headers: { "Authorization": `Bearer ${freshToken}` } }
        );
        const counterDoc = await counterRes.json();
        const lastNumber = counterDoc.fields?.lastNumber?.integerValue ? parseInt(counterDoc.fields.lastNumber.integerValue) : 0;
        const newNumber  = lastNumber + 1;
        await fetch(
          `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/config/${counterId}?updateMask.fieldPaths=lastNumber`,
          { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${freshToken}` },
            body: JSON.stringify({ fields: { lastNumber: { integerValue: String(newNumber) } } }) }
        );
      if (session.sessionType === "entrega") {
          updates.deliveryNumber = newNumber;
        } else if (session.sessionType === "intramuscular" || session.sessionType === "im") {
          updates.imNumber = newNumber;
        } else if (session.sessionType === "subcutaneo" || session.sessionType === "sc") {
          updates.scNumber = newNumber;
        } else if (session.sessionType === "procedimiento") {
          updates.procedureNumber = newNumber;
        } else {
          updates.infusionNumber = newNumber;
        }
        // Actualizar contador
        await fetch(
          `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/config/${counterId}?updateMask.fieldPaths=lastNumber`,
          { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${freshToken}` },
            body: JSON.stringify({ fields: { lastNumber: { integerValue: String(newNumber) } } }) }
        );
        updates.infusionNumber = newNumber;
      }
      if (key === "retiro") updates.status = "completado";
      await patchSession(freshToken, session.id, updates);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  const recordMedEvent = async (medId, key) => {
    try {
      const freshToken = await user.getIdToken(true);
      await patchSession(freshToken, session.id, { [`medEvents.med_${medId}.${key}`]: nowStr() });
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  const recordWashEvent = async (medId, key) => {
    try {
      const freshToken = await user.getIdToken(true);
      await patchSession(freshToken, session.id, { [`washEvents.wash_${medId}.${key}`]: nowStr() });
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  const saveMeds = async (updatedMeds, reAuth) => {
    try {
      const freshToken = await user.getIdToken(true);
      await updateSessionMeds(freshToken, session.id, updatedMeds, reAuth);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  const handleDeleteSession = async () => {
    if (!confirm(`¿Eliminar sesión de ${session.patientName}?`)) return;
    try {
      const freshToken = await user.getIdToken(true);
      await deleteSessionAPI(freshToken, session.id);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  const handleAdd = (newMed) => {
    const medWithDefaults = { ...newMed, order:(session.meds||[]).length+1, parallelType:"secuencial", startOffset:null };
    saveMeds([...(session.meds||[]), medWithDefaults], true);
    setShowAdd(false);
  };

  const handleEdit = (updatedMed) => {
    const others = (session.meds||[]).filter(m => m.id !== updatedMed.id);
    const newOrder = updatedMed.order || 1;
    const reordered = [...others];
    reordered.splice(newOrder-1, 0, updatedMed);
    const updatedMeds = reordered.map((m,i) => ({ ...m, order:i+1 }));
    saveMeds(updatedMeds, session.authorized);
    setEditingId(null);
  };

  const handleDelete = (medId) => {
    if (!confirm("¿Eliminar este medicamento?")) return;
    const updatedMeds = (session.meds||[]).filter(m => m.id !== medId).map((m,i) => ({ ...m, order:i+1 }));
    saveMeds(updatedMeds, session.authorized);
  };

  const completedMeds = (session.meds||[]).filter(m => 
    m.category === "domicilio" || session.sessionType === "entrega" || session.sessionType === "im" || session.sessionType === "sc"
      ? !!medEvents[`med_${m.id}`]?.inicio 
      : !!medEvents[`med_${m.id}`]?.fin
  ).length;
const totalTimed = (session.meds||[]).filter(m => m.time || m.category === "domicilio").length;
  const pct           = totalTimed ? Math.round((completedMeds/totalTimed)*100) : 0;
  const allWashDone = (session.meds||[]).every(m => 
    m.category === "domicilio" || session.sessionType === "entrega" || session.sessionType === "im" || session.sessionType === "sc"
    || !m.wash?.time || !medEvents[`med_${m.id}`]?.fin || washEvents[`wash_${m.id}`]?.fin
  );

  const canStartMed = (med) => {
    if (!session.authorized || !events.ingreso) return false;
    const prev = (session.meds||[]).find(m => m.order === med.order-1);
    if (!prev) return true;
    if (!prev.time) return true;
    const prevEv = medEvents[`med_${prev.id}`] || {};
    if (!med.parallelType || med.parallelType === "secuencial") {
      if (!prevEv.fin) return false;
      if (prev.wash?.time && !washEvents[`wash_${prev.id}`]?.fin) return false;
      return true;
    }
    if (med.parallelType === "junto") return !!prevEv.inicio;
    if (med.parallelType === "offset") {
      if (!prevEv.inicio) return false;
      const offset = med.startOffset || 0;
      if (offset === 0) return true;
      const pt = (t) => {
        if (!t) return null;
        if (t.includes("a.m.")||t.includes("p.m.")) {
          const [time,period] = t.split(" ");
          const [h,mm] = time.split(":").map(Number);
          let hours = h;
          if (period==="p.m."&&h!==12) hours+=12;
          if (period==="a.m."&&h===12) hours=0;
          return hours*60+mm;
        }
        const [h,mm] = t.split(":").map(Number);
        return h*60+mm;
      };
      const now = new Date();
      const nowMin = now.getHours()*60+now.getMinutes();
      const startMin = pt(prevEv.inicio);
      if (startMin===null) return false;
      return (nowMin-startMin)>=offset;
    }
    return false;
  };

  const canStartWash = (med) => !!medEvents[`med_${med.id}`]?.fin;
  const statusColor  = !session.authorized?"#ffb347":!events.ingreso?"#888":events.retiro?"#4fc3f7":"#1D9E75";

  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderLeft:`3px solid ${statusColor}`, borderRadius:16, overflow:"hidden", marginBottom:12 }}>
      <div onClick={() => setOpen(o=>!o)} style={{ padding:"16px 20px", cursor:"pointer", display:"flex", alignItems:"center", gap:14 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:15, color:"#f0f0f0", fontWeight:600 }}>{session.patientName}</div>
          <div style={{ fontSize:12, color:"#666", marginTop:3 }}>{session.diagnosis} · {session.cycle} · {session.physician}</div>
        </div>
        {events.ingreso && <div style={{ fontSize:13, color:"#aaa", fontFamily:"'IBM Plex Mono', monospace" }}>{pct}%</div>}
        {!session.authorized && <span style={{ fontSize:11, color:"#ffb347", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", padding:"3px 10px", borderRadius:99 }}>⏳ Sin autorizar</span>}
        <span style={{ color:"#555" }}>{open?"▲":"▼"}</span>
      </div>

      {events.ingreso && (
        <div style={{ padding:"0 20px 2px" }}>
          <div style={{ background:"rgba(255,255,255,0.05)", borderRadius:99, height:3, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${pct}%`, background:"#1D9E75", borderRadius:99 }} />
          </div>
        </div>
      )}

      {open && (
        <div style={{ padding:"16px 20px", borderTop:"1px solid rgba(255,255,255,0.05)" }}>
          {!session.authorized && (
            <div style={{ padding:"12px 16px", borderRadius:10, marginBottom:14, background:"rgba(255,179,71,0.07)", border:"1px solid rgba(255,179,71,0.2)", fontSize:13, color:"#ffb347", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span>⏳ Esperando autorización del Jefe de Enfermería.</span>
              <button onClick={handleDeleteSession} style={{ background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b", borderRadius:8, padding:"5px 10px", fontSize:11, cursor:"pointer", flexShrink:0 }}>🗑 Eliminar</button>
            </div>
          )}

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
            <TimeBtn label="Ingreso del paciente" time={events.ingreso} onRecord={() => recordEvent("ingreso")} disabled={!session.authorized} />
            <TimeBtn label="Retiro del paciente" time={events.retiro} onRecord={() => recordEvent("retiro")} disabled={!events.ingreso || completedMeds < totalTimed || !allWashDone} />
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {(session.meds||[]).map(med => {
              const ev       = medEvents[`med_${med.id}`] || {};
              const color    = CAT_COLOR[med.category] || "#888";
              const started  = !!ev.inicio;
              const ended    = !!ev.fin;
              const canStart = canStartMed(med);
              const isEditing = editingId === med.id;

              return (
                <div key={med.id}>
                  <div style={{ borderRadius:11, overflow:"hidden", border:`1px solid ${ended?"rgba(79,195,247,0.2)":started?"rgba(29,158,117,0.2)":"rgba(255,255,255,0.07)"}`, borderLeft:`3px solid ${color}`, background:"rgba(255,255,255,0.02)" }}>
                    <div style={{ padding:"11px 14px", display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ width:22, height:22, borderRadius:"50%", background:"rgba(255,255,255,0.06)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:"#888", fontFamily:"'IBM Plex Mono', monospace", flexShrink:0 }}>{med.order}</span>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:13, color:"#f0f0f0", fontWeight:600 }}>{med.name} {med.dose}</div>
                        <div style={{ fontSize:11, color:"#666", marginTop:1 }}>{med.diluent}{med.time?` · ${med.time} min`:""}</div>
                        {med.parallelType && med.parallelType !== "secuencial" && (
                          <div style={{ fontSize:10, color:"#AFA9EC", marginTop:2 }}>
                            ⚡ {med.parallelType==="junto"?"Simultáneo con anterior":`Inicia ${med.startOffset} min después del anterior`}
                          </div>
                        )}
                      </div>
                      <span style={{ fontSize:14 }}>{ended?"✓":started?"⏳":"○"}</span>
                    </div>

                    {med.correction && (
                      <div style={{ margin:"0 14px 8px", padding:"7px 11px", borderRadius:8, background:"rgba(186,117,23,0.09)", border:"1px solid rgba(186,117,23,0.22)" }}>
                        <div style={{ fontSize:11, color:"#EF9F27", fontWeight:600, marginBottom:3 }}>⚠ Corrección del Jefe</div>
                        {med.correction.diluent && <div style={{ fontSize:11, color:"#aaa" }}>Dilución: {med.correction.diluent}</div>}
                        {med.correction.time    && <div style={{ fontSize:11, color:"#aaa" }}>Tiempo: {med.correction.time}</div>}
                        {med.correction.general && <div style={{ fontSize:11, color:"#aaa" }}>Nota: {med.correction.general}</div>}
                      </div>
                    )}
                    
{(med.category === "domicilio" || session.sessionType === "entrega" || session.sessionType === "im" || session.sessionType === "sc") && (
  <div style={{ padding:"0 14px 10px" }}>
    {!medEvents[`med_${med.id}`]?.inicio ? (
      <button onClick={() => recordMedEvent(med.id, "inicio")} style={{ width:"100%", padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.15)", border:"1px solid rgba(175,169,236,0.4)", color:"#AFA9EC" }}>
        {session.sessionType === "entrega" || med.category === "domicilio" ? "📦 Marcar como entregado" : "✅ Marcar como aplicado"}
      </button>
    ) : (
      <div style={{ padding:"8px", borderRadius:8, fontSize:12, textAlign:"center", background:"rgba(175,169,236,0.08)", border:"1px solid rgba(175,169,236,0.25)", color:"#AFA9EC" }}>
        {session.sessionType === "entrega" || med.category === "domicilio" ? "✓ Entregado" : "✓ Aplicado"} a las {medEvents[`med_${med.id}`]?.inicio}
      </div>
    )}
  </div>
)}
                    {med.time && (
                      <div style={{ padding:"0 14px 10px", display:"flex", gap:8 }}>
                        {!started && <button onClick={() => recordMedEvent(med.id,"inicio")} disabled={!canStart} style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:canStart?"pointer":"not-allowed", background:canStart?"rgba(29,158,117,0.12)":"rgba(255,255,255,0.03)", border:`1px solid ${canStart?"rgba(29,158,117,0.3)":"rgba(255,255,255,0.06)"}`, color:canStart?"#1D9E75":"#444" }}>▶ Iniciar</button>}
                        {started && !ended && (
                          <>
                            <div style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, textAlign:"center", background:"rgba(29,158,117,0.07)", border:"1px solid rgba(29,158,117,0.18)", color:"#1D9E75" }}>
                              ▶ {ev.inicio}<ElapsedTimer startTime={ev.inicio} />
                            </div>
                            <button onClick={() => recordMedEvent(med.id,"fin")} style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(79,195,247,0.12)", border:"1px solid rgba(79,195,247,0.3)", color:"#4fc3f7" }}>■ Terminar</button>
                          </>
                        )}
                        {ended && (
                          <div style={{ flex:1, display:"flex", gap:8 }}>
                            <div style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, textAlign:"center", background:"rgba(29,158,117,0.06)", border:"1px solid rgba(29,158,117,0.15)", color:"#1D9E75" }}>▶ {ev.inicio}</div>
                            <div style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, textAlign:"center", background:"rgba(79,195,247,0.06)", border:"1px solid rgba(79,195,247,0.15)", color:"#4fc3f7" }}>■ {ev.fin}</div>
                          </div>
                        )}
                      </div>
                    )}

                    {!started && (
                      <div style={{ padding:"0 14px 10px", display:"flex", gap:6 }}>
                        <button onClick={() => setEditingId(isEditing ? null : med.id)} style={{ flex:1, padding:"6px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>✏️ Editar</button>
                        <button onClick={() => handleDelete(med.id)} style={{ flex:1, padding:"6px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>🗑 Eliminar</button>
                      </div>
                    )}
                  </div>

                  {isEditing && !started && (
                    <EditMedForm med={med} onSave={handleEdit} onCancel={() => setEditingId(null)} />
                  )}

                  {med.wash && med.category !== "domicilio" && (
                    <div style={{ paddingLeft:16 }}>
                      <WashCard wash={med.wash} washEvents={washEvents} medId={med.id}
                        onStart={() => recordWashEvent(med.id,"inicio")}
                        onEnd={()   => recordWashEvent(med.id,"fin")}
                        canStart={canStartWash(med)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!showAdd ? (
            <button onClick={() => setShowAdd(true)} style={{ width:"100%", padding:"9px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.08)", border:"1px dashed rgba(0,212,170,0.3)", color:"#00d4aa", marginTop:10 }}>
              + Agregar medicamento
            </button>
          ) : (
            <div style={{ marginTop:10 }}>
              <AddMedForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />
            </div>
          )}

          {session.globalNote && (
            <div style={{ marginTop:14, padding:"10px 14px", borderRadius:10, background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", fontSize:12, color:"#888" }}>
              📋 Nota del Jefe: {session.globalNote}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function NurseView() {
  const { user, profile } = useAuth();
  const [todaySessions, setTodaySessions]     = useState([]);
  const [pendingSessions, setPendingSessions]   = useState([]);
  const [scheduledSessions, setScheduledSessions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [token, setToken]       = useState(null);
  const [tab, setTab]           = useState("hoy");
  const today = getToday();

  const load = async () => {
    if (!user || !profile?.center) { setLoading(false); return; }
    try {
      const t = await user.getIdToken(true);
      setToken(t);

      // Sesiones de hoy del centro
      const todayData = await fetchTodaySessions(t, profile.center, today);
      setTodaySessions(todayData);

      // Sesiones del centro — pendientes y programadas futuras
const nurseData = await fetchSessionsByNurse(t, profile.center);
      
      // Pendientes: sin autorizar, de cualquier fecha excepto hoy
      const pending = nurseData.filter(s => !s.authorized && s.date !== today);
      setPendingSessions(pending);

// Programadas: autorizadas, no completadas, cualquier fecha excepto hoy
const scheduled = nurseData.filter(s => s.authorized && s.date !== today && s.status !== "completado");
      setScheduledSessions(scheduled);

    } catch(e) { console.error("Error:", e); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (profile?.center) load(); }, [profile?.center]);

  const inCourse = todaySessions.filter(s => s.status === "en_curso").length;
  const waiting  = todaySessions.filter(s => !s.events?.ingreso).length;
  const done     = todaySessions.filter(s => s.status === "completado").length;

  const tabs = [
    { id:"hoy",        label:"Hoy",         count: todaySessions.length },
    { id:"pendientes", label:"Pendientes",   count: pendingSessions.length },
    { id:"programados",label:"Programados",  count: scheduledSessions.length },
  ];

  return (
    <div style={{ padding:"24px 28px", maxWidth:800, margin:"0 auto" }}>
      <div style={{ marginBottom:20, display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
        <div>
          <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Mis pacientes</h1>
          <p style={{ fontSize:13, color:"#555" }}>{profile?.center} · {new Date().toLocaleDateString("es-MX", { weekday:"long", day:"numeric", month:"long" })}</p>
        </div>
        {tab === "hoy" && (
          <div style={{ display:"flex", gap:8 }}>
            {[["en espera",waiting,"#888"],["en curso",inCourse,"#1D9E75"],["completos",done,"#4fc3f7"]].map(([l,v,c]) => (
              <div key={l} style={{ fontSize:11, padding:"5px 12px", borderRadius:99, background:`${c}14`, border:`1px solid ${c}33`, color:c }}>{v} {l}</div>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:"7px 16px", borderRadius:10, fontSize:13, fontWeight:600, cursor:"pointer",
            background: tab===t.id ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border:`1px solid ${tab===t.id ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.07)"}`,
            color: tab===t.id ? "#00d4aa" : "#666",
          }}>
            {t.label}
            {t.count > 0 && <span style={{ marginLeft:6, fontSize:10, background: tab===t.id ? "rgba(0,212,170,0.2)" : "rgba(255,255,255,0.1)", padding:"1px 6px", borderRadius:99 }}>{t.count}</span>}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color:"#555", fontSize:14, padding:24 }}>Cargando...</div>
      ) : (
        <>
          {tab === "hoy" && (
            todaySessions.length === 0 ? (
              <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
                No hay sesiones asignadas hoy.
              </div>
            ) : todaySessions.map(s => <SessionCard key={s.id} session={s} token={token} onRefresh={load} user={user} />)
          )}

          {tab === "pendientes" && (
            pendingSessions.length === 0 ? (
              <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
                No hay sesiones pendientes de autorización.
              </div>
            ) : pendingSessions.map(s => <PendingSessionCard key={s.id} session={s} user={user} onRefresh={load} />)
          )}

          {tab === "programados" && (
            scheduledSessions.length === 0 ? (
              <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
                No hay sesiones programadas próximas.
              </div>
            ) : scheduledSessions.map(s => 
                s.status === "en_curso" 
                  ? <SessionCard key={s.id} session={s} token={token} onRefresh={load} user={user} />
                  : <PendingSessionCard key={s.id} session={s} user={user} onRefresh={load} />
              )
          )}
        </>
      )}
    </div>
  );
}
