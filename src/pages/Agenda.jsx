import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

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

async function fetchCollection(token, collection) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }], limit: 500 } })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

async function savePatientScheme(token, data, schemes) {
  const toFV = (val) => {
    if (typeof val === "string") return { stringValue: val };
    if (typeof val === "boolean") return { booleanValue: val };
    if (typeof val === "number") return { integerValue: String(val) };
    if (val === null) return { nullValue: null };
    if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
    if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFV(v)])) } };
    return { stringValue: String(val) };
  };

  let psId = data.id;

  if (data.id) {
    const fields = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "id").map(([k, v]) => [k, toFV(v)]));
    const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
    await fetch(
      `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/patientSchemes/${data.id}?${mask}`,
      { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields }) }
    );
  } else {
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/patientSchemes?key=${API_KEY}`,
      { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields }) }
    );
    const doc = await res.json();
    psId = doc.name.split("/").pop();

    // Generar citas automáticamente
    if (data.startDate && data.schemeId) {
      const scheme = schemes.find(s => s.id === data.schemeId);
      if (scheme) {
        const effectiveCycles = data.totalCyclesOverride || scheme.totalCycles;
        const effectiveScheme = { ...scheme, totalCycles: effectiveCycles };
        const dates = calcDates(data.startDate, effectiveScheme, data.currentCycle || 1);
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
        for (const d of dates) {
          const apptFields = {
            patientSchemeId: toFV(psId),
            patientName:     toFV(data.patientName),
            schemeId:        toFV(data.schemeId),
            date:            toFV(d.date),
            cycle:           toFV(d.cycle),
            day:             toFV(d.day),
            label:           toFV(d.label),
            status:          toFV(d.date < today ? "past" : "scheduled"),
            center:          toFV(data.center || ""),
            createdAt:       toFV(new Date().toISOString()),
          };
          await fetch(
            `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/appointments?key=${API_KEY}`,
            { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields: apptFields }) }
          );
        }
      }
    }
  }
}

async function fetchAppointments(token) {
  const url = `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: {
      from:[{ collectionId:"appointments" }],
      orderBy:[{ field:{ fieldPath:"date" }, direction:"ASCENDING" }],
      limit: 2000,
    }})
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

async function rescheduleAppointment(token, apptId, newDate) {
  await fetch(
    `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/appointments/${apptId}?updateMask.fieldPaths=date&updateMask.fieldPaths=rescheduled&updateMask.fieldPaths=originalDate`,
    { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
      body: JSON.stringify({ fields: {
        date:         { stringValue: newDate },
        rescheduled:  { booleanValue: true },
        originalDate: { stringValue: newDate },
      }})
    }
  );
}

async function deletePatientScheme(token, id) {
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/patientSchemes/${id}`,
    { method: "DELETE", headers: { "Authorization": `Bearer ${token}` } }
  );
}

function calcDates(startDate, scheme, currentCycle) {
  const dates = [];
  const start = new Date(startDate + "T12:00:00");
  for (let cycle = currentCycle; cycle <= scheme.totalCycles; cycle++) {
    const cycleStart = new Date(start);
    cycleStart.setDate(start.getDate() + (cycle - 1) * scheme.cycleDurationDays);
    for (const day of scheme.administrationDays) {
      const d = new Date(cycleStart);
      d.setDate(cycleStart.getDate() + (day - 1));
      dates.push({
        date: d.toISOString().split("T")[0],
        cycle, day,
        label: `C${cycle}D${day}`,
        isPast: d < new Date(),
      });
    }
  }
  return dates.sort((a, b) => a.date.localeCompare(b.date));
}

function CalendarView({ appointments, schemes, selectedMonth, onSelectDate }) {
  const year  = selectedMonth.getFullYear();
  const month = selectedMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

  const monthStr = `${year}-${String(month+1).padStart(2,"0")}`;
  const monthEvents = {};
 (appointments||[]).forEach(a => {
    if (!a.date?.startsWith(monthStr)) return;
    if (a.status === "suspendida" || a.status === "cancelada") return;
    if (!monthEvents[a.date]) monthEvents[a.date] = [];
    const scheme = schemes.find(s => s.id === a.schemeId);
    monthEvents[a.date].push({ ...a, schemeName: scheme?.name || "", apptId: a.id, patientSchemeId: a.patientSchemeId });
  });

  const days = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2, marginBottom:4 }}>
        {["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"].map(d => (
          <div key={d} style={{ textAlign:"center", fontSize:11, color:"#555", padding:"4px 0", letterSpacing:1 }}>{d}</div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {days.map((day, i) => {
          if (!day) return <div key={i} />;
          const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
          const events  = monthEvents[dateStr] || [];
          const isToday = dateStr === today;
          return (
            <div key={i} onClick={() => events.length && onSelectDate(dateStr, events)}
              style={{
                minHeight:60, padding:"4px 6px", borderRadius:8, cursor:events.length?"pointer":"default",
                background: isToday ? "rgba(0,212,170,0.12)" : events.length ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)",
                border:`1px solid ${isToday ? "rgba(0,212,170,0.4)" : events.length ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)"}`,
              }}>
              <div style={{ fontSize:12, color: isToday ? "#00d4aa" : "#888", fontWeight: isToday ? 700 : 400, marginBottom:3 }}>{day}</div>
              {events.slice(0,3).map((e, j) => (
                <div key={j} style={{ fontSize:9, padding:"1px 4px", borderRadius:4, background: e.status==="confirmed" ? "rgba(29,158,117,0.2)" : e.center==="CITIO" ? "rgba(79,195,247,0.15)" : "rgba(175,169,236,0.15)", color: e.status==="confirmed" ? "#1D9E75" : e.center==="CITIO" ? "#4fc3f7" : "#AFA9EC", marginBottom:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                  {e.label} {e.patientName?.split(" ")[0]}
                </div>
              ))}
              {events.length > 3 && <div style={{ fontSize:9, color:"#555" }}>+{events.length-3} más</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SchemeForm({ schemes, sessions, onSave, onCancel, editing }) {
  const inputStyle = { width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"9px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };
  const labelStyle = { fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 };

 const [form, setForm] = useState(editing || { patientName:"", schemeId:"", startDate:"", currentCycle:1, totalCyclesOverride:"", notes:"", active:true, center:"CITIO", schemeStatus:"activo" });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const selectedScheme = schemes.find(s => s.id === form.schemeId);

  // Autocompletado de pacientes
  const patients = [...new Set(sessions.map(s => s.patientName).filter(Boolean))].sort();

  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:14, padding:"20px" }}>
      <div style={{ fontSize:14, color:"#00d4aa", fontWeight:600, marginBottom:16 }}>{editing ? "✏️ Editar esquema" : "➕ Asignar esquema"}</div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
        <div style={{ gridColumn:"1/-1" }}>
          <label style={labelStyle}>Paciente</label>
          <input list="patients-list" value={form.patientName} onChange={e => set("patientName", e.target.value)} placeholder="Nombre del paciente" style={inputStyle} />
          <datalist id="patients-list">
            {patients.map((p, i) => <option key={i} value={p} />)}
          </datalist>
        </div>
        <div style={{ gridColumn:"1/-1" }}>
          <label style={labelStyle}>Esquema oncológico</label>
          <select value={form.schemeId} onChange={e => set("schemeId", e.target.value)} style={{ ...inputStyle, cursor:"pointer" }}>
            <option value="">Seleccionar esquema...</option>
            {schemes.sort((a,b) => a.name.localeCompare(b.name)).map(s => (
              <option key={s.id} value={s.id}>{s.name} — {s.description}</option>
            ))}
          </select>
        </div>

        {selectedScheme && (
          <div style={{ gridColumn:"1/-1", padding:"10px 14px", borderRadius:10, background:"rgba(0,212,170,0.06)", border:"1px solid rgba(0,212,170,0.2)", fontSize:12, color:"#888" }}>
            <span style={{ color:"#00d4aa" }}>{selectedScheme.name}</span> · {selectedScheme.cycleDurationDays} días por ciclo · días {selectedScheme.administrationDays?.join(", ")} · {selectedScheme.totalCycles} ciclos totales
          </div>
        )}

        <div>
          <label style={labelStyle}>Fecha de inicio (primera infusión)</label>
          <input type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Ciclo actual</label>
          <input type="number" min="1" value={form.currentCycle} onChange={e => set("currentCycle", parseInt(e.target.value)||1)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Total de ciclos (override)</label>
          <input type="number" min="1" value={form.totalCyclesOverride} onChange={e => set("totalCyclesOverride", e.target.value)} placeholder={selectedScheme?.totalCycles || "—"} style={inputStyle} />
        </div>
        <div>
  <label style={labelStyle}>Centro</label>
  <select value={form.center || "CITIO"} onChange={e => set("center", e.target.value)} style={{ ...inputStyle, cursor:"pointer" }}>
    <option value="CITIO">CITIO</option>
    <option value="CIPI">CIPI</option>
  </select>
</div>
          <div>
  <label style={labelStyle}>Estatus del esquema</label>
  <select value={form.schemeStatus || "activo"} onChange={e => set("schemeStatus", e.target.value)} style={{ ...inputStyle, cursor:"pointer" }}>
    <option value="activo">Activo</option>
    <option value="suspendido">Suspendido</option>
    <option value="completado">Completado</option>
    <option value="cancelado">Cancelado</option>
  </select>
</div>
        <div style={{ gridColumn:"1/-1" }}>
          <label style={labelStyle}>Notas</label>
          <textarea rows={2} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Observaciones..." style={{ ...inputStyle, resize:"vertical" }} />
        </div>
      </div>

      <div style={{ display:"flex", gap:10, marginTop:16 }}>
        <button onClick={() => onSave({ ...form, totalCyclesOverride: form.totalCyclesOverride ? parseInt(form.totalCyclesOverride) : null })}
          style={{ flex:1, padding:"10px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"linear-gradient(135deg,#1D9E75,#0F6E56)", border:"none", color:"#fff" }}>
          ✓ Guardar
        </button>
        <button onClick={onCancel} style={{ padding:"10px 16px", borderRadius:9, fontSize:13, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#666" }}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
function SchemeEditor({ scheme, onSave, onCancel }) {
  const inp = { width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"9px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };
  const lbl = { fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 };
  const [form, setForm] = useState(scheme ? {
    ...scheme,
    administrationDays: scheme.administrationDays?.join(", ") || "",
  } : { name:"", description:"", totalCycles:6, cycleDurationDays:21, administrationDays:"1", active:true });
  const set = (k,v) => setForm(f => ({ ...f, [k]:v }));

  const handleSave = () => {
    const days = form.administrationDays.toString().split(",").map(d => parseInt(d.trim())).filter(d => !isNaN(d));
    onSave({
      ...(scheme?.id ? { id: scheme.id } : {}),
      name: form.name,
      description: form.description || "",
      totalCycles: parseInt(form.totalCycles) || 6,
      cycleDurationDays: parseInt(form.cycleDurationDays) || 21,
      administrationDays: days,
      active: true,
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(0,212,170,0.25)", borderRadius:12, padding:"18px", marginBottom:16 }}>
      <div style={{ fontSize:13, color:"#00d4aa", fontWeight:600, marginBottom:14 }}>{scheme ? "✏️ Editar esquema" : "➕ Nuevo esquema"}</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
        <div style={{ gridColumn:"1/-1" }}>
          <label style={lbl}>Nombre del esquema</label>
          <input value={form.name} onChange={e => set("name", e.target.value)} placeholder="ej: BEP" style={inp} />
        </div>
        <div style={{ gridColumn:"1/-1" }}>
          <label style={lbl}>Descripción (medicamentos)</label>
          <input value={form.description} onChange={e => set("description", e.target.value)} placeholder="ej: BLEOMICINA - ETOPOSIDO - CISPLATINO" style={inp} />
        </div>
        <div>
          <label style={lbl}>Duración del ciclo (días)</label>
          <input type="number" min="1" value={form.cycleDurationDays} onChange={e => set("cycleDurationDays", e.target.value)} style={inp} />
        </div>
        <div>
          <label style={lbl}>Total de ciclos</label>
          <input type="number" min="1" value={form.totalCycles} onChange={e => set("totalCycles", e.target.value)} style={inp} />
        </div>
        <div style={{ gridColumn:"1/-1" }}>
          <label style={lbl}>Días de administración (separados por coma)</label>
          <input value={form.administrationDays} onChange={e => set("administrationDays", e.target.value)} placeholder="ej: 1, 8, 15" style={inp} />
          <div style={{ fontSize:11, color:"#555", marginTop:4 }}>Ejemplo: "1" para solo día 1, "1, 8, 15" para días 1, 8 y 15</div>
        </div>
      </div>
      <div style={{ display:"flex", gap:8, marginTop:14 }}>
        <button onClick={handleSave} style={{ flex:1, padding:"10px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"linear-gradient(135deg,#1D9E75,#0F6E56)", border:"none", color:"#fff" }}>✓ Guardar</button>
        <button onClick={onCancel} style={{ padding:"10px 16px", borderRadius:9, fontSize:13, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#666" }}>Cancelar</button>
      </div>
    </div>
  );
}

export default function Agenda() {
  const { user, profile } = useAuth();
const isJefe = profile?.role === "jefe";
const isVisualizador = profile?.role === "visualizador";
  const [schemes, setSchemes]               = useState([]);
  const [patientSchemes, setPatientSchemes] = useState([]);
  const [sessions, setSessions]             = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading]               = useState(true);
  const [token, setToken]                   = useState(null);
  const [view, setView]                     = useState("calendar");
  const [selectedMonth, setSelectedMonth]   = useState(new Date());
  const [showForm, setShowForm]             = useState(false);
  const [showSchemeForm, setShowSchemeForm] = useState(false);
const [editingScheme, setEditingScheme] = useState(null);
  const [editing, setEditing]               = useState(null);
  const [selectedDate, setSelectedDate]     = useState(null);
  const [expandedScheme, setExpandedScheme] = useState(null);
  const [selectedEvents, setSelectedEvents] = useState([]);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const t = await user.getIdToken(true);
      setToken(t);
      const [s, ps, sess, appts] = await Promise.all([
  fetchCollection(t, "schemes"),
  fetchCollection(t, "patientSchemes"),
  fetchCollection(t, "sessions"),
  fetchAppointments(t),
]);
setSchemes(s);
setPatientSchemes(ps);
setSessions(sess);
setAppointments(appts);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [user]);

  const handleSave = async (data) => {
    try {
      const t = await user.getIdToken(true);
      await savePatientScheme(t, { ...data, updatedAt: new Date().toISOString() }, schemes);
      // Actualizar citas futuras si el esquema cambia de estatus
      if (data.id && data.schemeStatus) {
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
        const futureAppts = appointments.filter(a =>
          a.patientSchemeId === data.id &&
          a.date > today &&
          a.status !== "confirmed"
        );
        if (data.schemeStatus === "suspendido" || data.schemeStatus === "cancelado") {
          const newStatus = data.schemeStatus === "suspendido" ? "suspendida" : "cancelada";
          for (const appt of futureAppts) {
            await fetch(
              `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/appointments/${appt.id}?updateMask.fieldPaths=status`,
              { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${t}` },
                body: JSON.stringify({ fields: { status: { stringValue: newStatus } } }) }
            );
          }
        } else if (data.schemeStatus === "activo") {
          // Reactivar citas suspendidas
          const suspendedAppts = appointments.filter(a =>
            a.patientSchemeId === data.id &&
            a.date > today &&
            a.status === "suspendida"
          );
          for (const appt of suspendedAppts) {
            await fetch(
              `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/appointments/${appt.id}?updateMask.fieldPaths=status`,
              { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${t}` },
                body: JSON.stringify({ fields: { status: { stringValue: "scheduled" } } }) }
            );
          }
        }
      }
      setShowForm(false);
      setEditing(null);
      load();
    } catch(e) { alert("Error: " + e.message); }
  };

  const handleDelete = async (id) => {
    if (!confirm("¿Eliminar este esquema del paciente?")) return;
    try {
      const t = await user.getIdToken(true);
      await deletePatientScheme(t, id);
      load();
    } catch(e) { alert("Error: " + e.message); }
  };

  const handleSaveScheme = async (data) => {
    const toFV = (val) => {
      if (typeof val === "string") return { stringValue: val };
      if (typeof val === "boolean") return { booleanValue: val };
      if (typeof val === "number") return { integerValue: String(val) };
      if (val === null) return { nullValue: null };
      if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
      return { stringValue: String(val) };
    };
    try {
      const t = await user.getIdToken(true);
      if (data.id) {
        const fields = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "id").map(([k, v]) => [k, toFV(v)]));
        const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
        await fetch(
          `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/schemes/${data.id}?${mask}`,
          { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${t}` }, body:JSON.stringify({ fields }) }
        );
      } else {
        const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
        await fetch(
          `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/schemes?key=${API_KEY}`,
          { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${t}` }, body:JSON.stringify({ fields }) }
        );
      }
      setShowSchemeForm(false);
      setEditingScheme(null);
      load();
    } catch(e) { alert("Error: " + e.message); }
  };

const handleDeleteScheme = async (id) => {
    if (!confirm("¿Eliminar este esquema?")) return;
    try {
      const t = await user.getIdToken(true);
      await fetch(
        `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/schemes/${id}`,
        { method:"DELETE", headers:{ "Authorization":`Bearer ${t}` } }
      );
      load();
    } catch(e) { alert("Error: " + e.message); }
  };
  
  const prevMonth = () => setSelectedMonth(m => new Date(m.getFullYear(), m.getMonth()-1, 1));
  const nextMonth = () => setSelectedMonth(m => new Date(m.getFullYear(), m.getMonth()+1, 1));

  // Lista de próximas citas
  const upcomingDates = [];
 const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  patientSchemes.forEach(ps => {
    const scheme = schemes.find(s => s.id === ps.schemeId);
    if (!scheme || !ps.startDate || (ps.schemeStatus && ps.schemeStatus !== "activo")) return;
    const effectiveCycles = ps.totalCyclesOverride || scheme.totalCycles;
    const effectiveScheme = { ...scheme, totalCycles: effectiveCycles };
    const dates = calcDates(ps.startDate, effectiveScheme, ps.currentCycle || 1);
    dates.filter(d => d.date >= today).forEach(d => {
      upcomingDates.push({ ...d, patientName: ps.patientName, schemeName: scheme.name, notes: ps.notes, psId: ps.id });
    });
  });
  upcomingDates.sort((a, b) => a.date.localeCompare(b.date));

  const monthName = selectedMonth.toLocaleDateString("es-MX", { month:"long", year:"numeric" });

  return (
    <div style={{ padding:"24px 28px", maxWidth:1100, margin:"0 auto" }}>
      <div style={{ marginBottom:24, display:"flex", justifyContent:"space-between", alignItems:"flex-end", flexWrap:"wrap", gap:12 }}>
        <div>
          <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Agenda de ciclos</h1>
          <p style={{ fontSize:13, color:"#555" }}>{patientSchemes.filter(p=>p.active).length} pacientes activos · {schemes.length} esquemas disponibles</p>
        </div>
       {isJefe && (
          <button onClick={() => { setShowForm(true); setEditing(null); }} style={{ padding:"9px 18px", borderRadius:10, fontSize:13, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
            + Asignar esquema
          </button>
        )}
      </div>

      {showForm && (
        <div style={{ marginBottom:20 }}>
          <SchemeForm schemes={schemes} sessions={sessions} onSave={handleSave} onCancel={() => { setShowForm(false); setEditing(null); }} editing={editing} />
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
       {[["calendar","📅","Calendario"],["list","📋","Lista de citas"],["patients","👥","Pacientes"],["schemes","🧬","Esquemas"]].map(([id,icon,label]) => (
          <button key={id} onClick={() => setView(id)} style={{
            padding:"7px 16px", borderRadius:10, fontSize:13, fontWeight:600, cursor:"pointer",
            background: view===id ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border:`1px solid ${view===id ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.07)"}`,
            color: view===id ? "#00d4aa" : "#666",
          }}>{icon} {label}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ color:"#555", fontSize:14, padding:24 }}>Cargando agenda...</div>
      ) : (
        <>
          {/* Vista calendario */}
          {view === "calendar" && (
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:16 }}>
                <button onClick={prevMonth} style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"6px 12px", color:"#888", cursor:"pointer", fontSize:16 }}>‹</button>
                <div style={{ fontSize:16, color:"#fff", fontWeight:600, textTransform:"capitalize", minWidth:200, textAlign:"center" }}>{monthName}</div>
                <button onClick={nextMonth} style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"6px 12px", color:"#888", cursor:"pointer", fontSize:16 }}>›</button>
              </div>
              <CalendarView appointments={appointments} schemes={schemes} selectedMonth={selectedMonth}
  onSelectDate={(date, events) => { setSelectedDate(date); setSelectedEvents(events); }} />
              {selectedDate && (
                <div style={{ marginTop:16, padding:"16px 18px", borderRadius:12, background:"rgba(0,212,170,0.06)", border:"1px solid rgba(0,212,170,0.2)" }}>
                  <div style={{ fontSize:13, color:"#00d4aa", fontWeight:600, marginBottom:10 }}>📅 {selectedDate}</div>
                 {selectedEvents.map((e, i) => (
  <div key={i} style={{ padding:"8px 12px", borderRadius:8, background:"rgba(255,255,255,0.03)", marginBottom:6, fontSize:13, display:"flex", alignItems:"center", gap:10 }}>
    <div style={{ flex:1 }}>
      <span style={{ color:"#f0f0f0", fontWeight:600 }}>{e.patientName}</span>
      <span style={{ color:"#666", marginLeft:8 }}>{e.schemeName}</span>
      <span style={{ color:"#00d4aa", marginLeft:8, fontFamily:"'IBM Plex Mono', monospace" }}>{e.label}</span>
      {e.status === "confirmed" && <span style={{ marginLeft:8, fontSize:11, color:"#1D9E75" }}>✓ Confirmada</span>}
      {e.rescheduled && <span style={{ marginLeft:8, fontSize:11, color:"#ffb347" }}>↻ Reagendada</span>}
    </div>
    {!isVisualizador && e.status !== "confirmed" && e.date >= today && (
      <button onClick={async () => {
        const newDate = prompt(`Nueva fecha para ${e.patientName} ${e.label}:`, e.date);
        if (!newDate || newDate === e.date) return;
        const t = await user.getIdToken(true);
        
        // Calcular desfase en días
        const oldD = new Date(e.date + "T12:00:00");
        const newD = new Date(newDate + "T12:00:00");
        const diffDays = Math.round((newD - oldD) / (1000 * 60 * 60 * 24));
        
        // Reagendar esta cita
        await rescheduleAppointment(t, e.apptId, newDate);
        
        // Preguntar si recalcular posteriores
        if (diffDays !== 0) {
          const recalc = confirm(`¿Recorrer ${diffDays > 0 ? "+" : ""}${diffDays} días a las citas futuras de este esquema?\n\n"Aceptar" = Sí, recorrer todas las citas futuras\n"Cancelar" = No, solo esta cita`);
          if (recalc) {
            const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
            const futureAppts = appointments.filter(a =>
              a.patientSchemeId === e.patientSchemeId &&
              a.id !== e.apptId &&
              a.date > today &&
              a.status !== "confirmed"
            );
            for (const appt of futureAppts) {
              const apptDate = new Date(appt.date + "T12:00:00");
              apptDate.setDate(apptDate.getDate() + diffDays);
              const newApptDate = apptDate.toISOString().split("T")[0];
              await rescheduleAppointment(t, appt.id, newApptDate);
            }
          }
        }
        load();
      }} style={{ padding:"4px 10px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>
        ↻ Reagendar
      </button>
    )}
    </div>
  ))}
                </div>
              )}
            </div>
          )}

          {/* Vista lista */}
          {view === "list" && (
            <div>
              <div style={{ fontSize:11, color:"#555", letterSpacing:2, textTransform:"uppercase", marginBottom:12 }}>
                Próximas {upcomingDates.slice(0,50).length} citas
              </div>
              {upcomingDates.length === 0 ? (
                <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
                  No hay citas programadas.
                </div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {upcomingDates.slice(0,50).map((d, i) => {
                    const isToday = d.date === today;
                    return (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 14px", borderRadius:10, borderLeft:`3px solid ${d.center==="CITIO" ? "#4fc3f7" : "#AFA9EC"}`, background: isToday ? "rgba(0,212,170,0.08)" : "rgba(255,255,255,0.03)", border:`1px solid ${isToday ? "rgba(0,212,170,0.25)" : "rgba(255,255,255,0.07)"}` }}>
                        <div style={{ width:80, fontSize:12, color: isToday ? "#00d4aa" : "#888", fontFamily:"'IBM Plex Mono', monospace", flexShrink:0 }}>{d.date}</div>
                        <div style={{ flex:1 }}>
                          <span style={{ fontSize:13, color:"#f0f0f0", fontWeight:600 }}>{d.patientName}</span>
                          <span style={{ fontSize:12, color:"#666", marginLeft:8 }}>{d.schemeName}</span>
                        </div>
                        <div style={{ fontSize:12, color:"#00d4aa", fontFamily:"'IBM Plex Mono', monospace", background:"rgba(0,212,170,0.1)", padding:"3px 10px", borderRadius:99 }}>{d.label}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Vista pacientes */}
          {view === "patients" && (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {patientSchemes.length === 0 ? (
                <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
                  No hay pacientes con esquemas asignados.
                </div>
              ) : patientSchemes.map(ps => {
                const scheme = schemes.find(s => s.id === ps.schemeId);
                const effectiveCycles = ps.totalCyclesOverride || scheme?.totalCycles;
                const nextDates = scheme ? calcDates(ps.startDate, { ...scheme, totalCycles: effectiveCycles }, ps.currentCycle||1).filter(d => d.date >= today).slice(0,3) : [];
                return (
                  <div key={ps.id} style={{ background:"rgba(255,255,255,0.03)", borderLeft:`3px solid ${ps.center==="CITIO" ? "#4fc3f7" : "#AFA9EC"}`, border:`1px solid ${ps.active ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.03)"}`, borderRadius:12, padding:"14px 18px" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                          <span style={{ fontSize:14, color: ps.active ? "#f0f0f0" : "#555", fontWeight:600 }}>{ps.patientName}</span>
                          {(() => {
  const STATUS = {
    activo:     { color:"#1D9E75", label:"Activo" },
    suspendido: { color:"#ffb347", label:"Suspendido" },
    completado: { color:"#4fc3f7", label:"Completado" },
    cancelado:  { color:"#ff6b6b", label:"Cancelado" },
  };
  const s = STATUS[ps.schemeStatus || (ps.active ? "activo" : "suspendido")] || STATUS.activo;
  return (
    <span style={{ fontSize:11, padding:"2px 8px", borderRadius:99, background:`${s.color}18`, color:s.color, border:`1px solid ${s.color}44` }}>
      {s.label}
    </span>
  );
})()}
                        </div>
                        <div style={{ fontSize:12, color:"#666" }}>{scheme?.name} · C{ps.currentCycle||1}/{effectiveCycles} · cada {scheme?.cycleDurationDays} días</div>
                        {ps.notes && <div style={{ fontSize:11, color:"#555", marginTop:3 }}>📝 {ps.notes}</div>}
                        {nextDates.length > 0 && (
                          <div style={{ marginTop:8, display:"flex", gap:6, flexWrap:"wrap" }}>
                            {nextDates.map((d, i) => (
                              <span key={i} style={{ fontSize:11, padding:"3px 8px", borderRadius:6, background:"rgba(0,212,170,0.08)", color:"#00d4aa", border:"1px solid rgba(0,212,170,0.2)", fontFamily:"'IBM Plex Mono', monospace" }}>
                                {d.date} {d.label}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {isJefe && (
                        <div style={{ display:"flex", gap:6 }}>
                          <button onClick={() => { setEditing(ps); setShowForm(true); }} style={{ padding:"5px 10px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>✏️</button>
                          <button onClick={() => handleDelete(ps.id)} style={{ padding:"5px 10px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>🗑</button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {/* Vista esquemas */}
{view === "schemes" && (
  <div>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
      <div style={{ fontSize:11, color:"#555", letterSpacing:2, textTransform:"uppercase" }}>{schemes.length} esquemas registrados</div>
      {isJefe && (
        <button onClick={() => { setShowSchemeForm(true); setEditingScheme(null); }} style={{ padding:"7px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
          + Nuevo esquema
        </button>
      )}
    </div>

    {showSchemeForm && (
      <SchemeEditor scheme={editingScheme} onSave={handleSaveScheme} onCancel={() => { setShowSchemeForm(false); setEditingScheme(null); }} />
    )}

    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
   {schemes.sort((a,b) => a.name.localeCompare(b.name)).map(s => {
        const myPatients = patientSchemes.filter(ps => ps.schemeId === s.id);
        const isExpanded = expandedScheme === s.id;
        return (
        <div key={s.id} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, padding:"14px 18px" }}>
        <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, color:"#f0f0f0", fontWeight:600, marginBottom:3 }}>{s.name}</div>
            {s.description && <div style={{ fontSize:12, color:"#666", marginBottom:4 }}>{s.description}</div>}
            <div style={{ display:"flex", gap:12, flexWrap:"wrap", fontSize:11, color:"#555" }}>
              <span>🔄 Cada {s.cycleDurationDays} días</span>
              <span>📅 Días: {s.administrationDays?.join(", ")}</span>
              <span>🎯 {s.totalCycles} ciclos</span>
            </div>
            {myPatients.length > 0 && (
              <button onClick={() => setExpandedScheme(isExpanded ? null : s.id)} style={{ marginTop:8, padding:"4px 12px", borderRadius:99, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.1)", border:"1px solid rgba(0,212,170,0.25)", color:"#00d4aa" }}>
                👥 {myPatients.length} paciente{myPatients.length!==1?"s":""} — {isExpanded ? "Ocultar" : "Ver pacientes"}
              </button>
            )}
          </div>
           {isJefe && (
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={() => { setEditingScheme(s); setShowSchemeForm(true); }} style={{ padding:"5px 10px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>✏️</button>
              <button onClick={() => handleDeleteScheme(s.id)} style={{ padding:"5px 10px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>🗑</button>
            </div>
          )}
        </div>

        {isExpanded && (
          <div style={{ marginTop:12, paddingTop:12, borderTop:"1px solid rgba(255,255,255,0.06)", display:"flex", flexDirection:"column", gap:6 }}>
            {myPatients.map(ps => {
             const myAppts = appointments.filter(a => a.patientSchemeId === ps.id).sort((a,b) => a.date.localeCompare(b.date));
              const activeAppts = myAppts.filter(a => a.status !== "cancelada");
              const confirmed = myAppts.filter(a => a.status === "confirmed");
              const lastDate = activeAppts.length ? activeAppts[activeAppts.length-1].date : null;
              return (
                <div key={ps.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", borderRadius:8, background:"rgba(255,255,255,0.02)", fontSize:12 }}>
                  <span style={{ flex:1, color:"#f0f0f0", fontWeight:600 }}>{ps.patientName}</span>
                  <span style={{ fontSize:10, padding:"1px 8px", borderRadius:99, background: ps.center==="CITIO" ? "rgba(79,195,247,0.12)" : "rgba(175,169,236,0.12)", color: ps.center==="CITIO" ? "#4fc3f7" : "#AFA9EC" }}>{ps.center}</span>
                  <span style={{ color:"#666", fontFamily:"'IBM Plex Mono', monospace" }}>Inicio: {ps.startDate}</span>
                  <span style={{ color:"#666", fontFamily:"'IBM Plex Mono', monospace" }}>Fin: {lastDate || "—"}</span>
                  <span style={{ fontSize:10, color:"#1D9E75" }}>{confirmed.length}/{myAppts.length} confirmadas</span>
                </div>
              );
            })}
          </div>
        )}
        </div>
        );
      })}
    </div>
  </div>
)}
        </>
      )}
    </div>
  );
}
