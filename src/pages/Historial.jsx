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

async function fetchSessions(token, filters) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const filtersList = [];
  if (filters.date)   filtersList.push({ fieldFilter: { field: { fieldPath: "date" },   op: "EQUAL", value: { stringValue: filters.date } } });
  if (filters.center) filtersList.push({ fieldFilter: { field: { fieldPath: "center" }, op: "EQUAL", value: { stringValue: filters.center } } });

  const where = filtersList.length === 1 ? filtersList[0] :
    filtersList.length > 1 ? { compositeFilter: { op: "AND", filters: filtersList } } : null;

  const query = {
    from: [{ collectionId: "sessions" }],
    orderBy: [{ field: { fieldPath: "date" }, direction: "DESCENDING" }],
    limit: 100,
  };
  if (where) query.where = where;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: query })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

const CAT_COLOR = { premedicacion:"#FAC775", inmunoterapia:"#5DCAA5", quimioterapia:"#F09595", adicional:"#AFA9EC", domicilio:"#82C4F8" };
const CAT_LABEL = { premedicacion:"Pre", inmunoterapia:"Inmuno", quimioterapia:"Quimio", adicional:"Adic.", domicilio:"Dom." };

function parseTime(t) {
  if (!t) return null;
  if (t.includes("a.m.") || t.includes("p.m.")) {
    const [time, period] = t.split(" ");
    const [h, m] = time.split(":").map(Number);
    let hours = h;
    if (period === "p.m." && h !== 12) hours += 12;
    if (period === "a.m." && h === 12) hours = 0;
    return hours * 60 + m;
  }
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function formatDiff(diff) {
  if (!diff || diff <= 0) return "—";
  return `${Math.floor(diff/60)}h ${diff%60}m`;
}

const STATUS_META = {
  completado: { label:"Completado", color:"#4fc3f7" },
  en_curso:   { label:"En curso",   color:"#1D9E75" },
  pendiente:  { label:"Pendiente",  color:"#ffb347" },
};

function SessionRow({ s, selected, onSelect, isJefe, token, onRefresh }) {
  const sm = STATUS_META[s.status] || STATUS_META.pendiente;
  const isSelected = selected?.id === s.id;
  const [editing, setEditing] = useState(false);
const [editDraft, setEditDraft] = useState(null);

const openEditor = () => {
    setEditDraft({
      date: s.date || "",
      cycle: s.cycle || "",
      physician: s.physician || "",
      diagnosis: s.diagnosis || "",
      sessionType: s.sessionType || "iv",
      infusionNumber: s.infusionNumber || s.imNumber || s.scNumber || s.deliveryNumber || s.procedureNumber || "",
      ingreso: s.events?.ingreso || "",
      retiro: s.events?.retiro || "",
      globalNote: s.globalNote || "",
      meds: (s.meds || []).map(m => ({
        ...m,
        inicio: s.medEvents?.[`med_${m.id}`]?.inicio || "",
        fin: s.medEvents?.[`med_${m.id}`]?.fin || "",
        washInicio: s.washEvents?.[`wash_${m.id}`]?.inicio || "",
        washFin: s.washEvents?.[`wash_${m.id}`]?.fin || "",
      })),
    });
    setEditing(true);
  };

const saveEdit = async () => {
    const toFV = (val) => {
      if (typeof val === "string") return { stringValue: val };
      if (typeof val === "number") return { integerValue: String(val) };
      if (val === null) return { nullValue: null };
      if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
      if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k,v]) => [k, toFV(v)])) } };
      return { stringValue: String(val) };
    };
    try {
      const numField = s.sessionType === "entrega" ? "deliveryNumber" : s.sessionType === "im" ? "imNumber" : s.sessionType === "sc" ? "scNumber" : s.sessionType === "procedimiento" ? "procedureNumber" : "infusionNumber";
     const fields = {
        date:        { stringValue: editDraft.date },
        cycle:       { stringValue: editDraft.cycle },
        physician:   { stringValue: editDraft.physician },
        diagnosis:   { stringValue: editDraft.diagnosis },
        sessionType: { stringValue: editDraft.sessionType },
        globalNote:  { stringValue: editDraft.globalNote },
        [numField]:  { integerValue: String(parseInt(editDraft.infusionNumber)||0) },
        events: toFV({ ingreso: editDraft.ingreso, retiro: editDraft.retiro }),
        meds: toFV(editDraft.meds.map(m => {
          const { inicio, fin, washInicio, washFin, ...rest } = m;
          return rest;
        })),
        medEvents: toFV(Object.fromEntries(editDraft.meds.map(m => [`med_${m.id}`, { inicio: m.inicio, fin: m.fin }]))),
        washEvents: toFV(Object.fromEntries(editDraft.meds.map(m => [`wash_${m.id}`, { inicio: m.washInicio, fin: m.washFin }]))),
      };
      const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
      await fetch(
        `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/sessions/${s.id}?${mask}`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body: JSON.stringify({ fields }) }
      );
      setEditing(false);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  // Calcular tiempos
  const ingresoMin  = parseTime(s.events?.ingreso);
  const retiroMin   = parseTime(s.events?.retiro);
  const estancia    = (ingresoMin && retiroMin) ? retiroMin - ingresoMin : null;
  const me          = s.medEvents || {};
  const we          = s.washEvents || {};

  const totalReal = (s.meds||[]).reduce((acc, m) => {
    let total = acc;
    const ev = me[`med_${m.id}`] || {};
    if (ev.inicio && ev.fin) {
      const diff = parseTime(ev.fin) - parseTime(ev.inicio);
      total += (diff > 0 ? diff : 0);
    }
    const wev = we[`wash_${m.id}`] || {};
    if (wev.inicio && wev.fin) {
      const washDiff = parseTime(wev.fin) - parseTime(wev.inicio);
      total += (washDiff > 0 ? washDiff : 0);
    }
    return total;
  }, 0);

  const totalProg = (s.meds||[]).reduce((acc, m) => acc + (m.time||0) + (m.wash?.time||0), 0);

  return (
    <div onClick={() => onSelect(isSelected ? null : s)}
      style={{ padding:"14px 18px", borderRadius:12, cursor:"pointer", marginBottom:8,
        background: isSelected ? "rgba(0,212,170,0.08)" : "rgba(255,255,255,0.03)",
        border:`1px solid ${isSelected ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.07)"}`,
        transition:"all 0.15s" }}>

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, color:"#f0f0f0", fontWeight:600, marginBottom:3 }}>{s.patientName}</div>
          <div style={{ fontSize:12, color:"#666" }}>{s.diagnosis} · {s.cycle}</div>
          <div style={{ fontSize:11, color:"#555", marginTop:2 }}>{s.physician} · {s.center} · {s.nurseName}</div>
          <div style={{ marginTop:4 }}>
  {(() => {
    const TYPE = {
      iv:            { label:"Infusión IV",   color:"#4fc3f7" },
      intramuscular: { label:"IM",            color:"#AFA9EC" },
      subcutaneo:    { label:"SC",            color:"#5DCAA5" },
      entrega:       { label:"Entrega",       color:"#82C4F8" },
      procedimiento: { label:"Procedimiento", color:"#FAC775" },
    };
    const t = TYPE[s.sessionType] || TYPE.iv;
    return <span style={{ fontSize:10, padding:"2px 8px", borderRadius:99, background:`${t.color}18`, color:t.color, border:`1px solid ${t.color}44` }}>{t.label}</span>;
  })()}
</div>
        </div>
       <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ fontSize:11, color:"#666", marginBottom:4 }}>{s.date}</div>
          {s.infusionNumber && <div style={{ fontSize:11, color:"#00d4aa", fontFamily:"'IBM Plex Mono', monospace", marginBottom:4 }}>#{s.infusionNumber}</div>}
         {s.expedienteNumber && <div style={{ fontSize:11, color:"#AFA9EC", fontFamily:"'IBM Plex Mono', monospace", marginBottom:4 }}>Exp. {String(s.expedienteNumber).padStart(3,"0")}</div>}
          <span style={{ fontSize:11, padding:"3px 10px", borderRadius:99, background:`${sm.color}18`, color:sm.color, border:`1px solid ${sm.color}44` }}>{sm.label}</span>
        </div>
      </div>

      {/* Resumen de tiempos */}
      {s.events?.ingreso && (
        <div style={{ display:"flex", gap:16, marginTop:10, flexWrap:"wrap" }}>
          <div style={{ fontSize:11, color:"#666" }}>▶ {s.events.ingreso}{s.events?.retiro ? ` — ■ ${s.events.retiro}` : ""}</div>
          {estancia && <div style={{ fontSize:11, color:"#EF9F27" }}>⏱ Estancia: {formatDiff(estancia)}</div>}
          {totalReal > 0 && <div style={{ fontSize:11, color: totalReal <= totalProg ? "#1D9E75" : "#EF9F27" }}>Real: {totalReal} min {totalProg > 0 ? `/ Prog: ${totalProg} min` : ""}</div>}
        </div>
      )}

      {/* Detalle expandido */}
      {isSelected && (
        <div style={{ marginTop:14, paddingTop:14, borderTop:"1px solid rgba(255,255,255,0.07)" }}>

          {/* Medicamentos con tiempos */}
          <div style={{ fontSize:11, color:"#555", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Medicamentos</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {(s.meds||[]).map(m => {
              const ev      = me[`med_${m.id}`] || {};
              const wev     = we[`wash_${m.id}`] || {};
              const color   = CAT_COLOR[m.category] || "#888";
              const done    = !!ev.fin;
              const medDiff = (ev.inicio && ev.fin) ? parseTime(ev.fin) - parseTime(ev.inicio) : null;
              const washDiff = (wev.inicio && wev.fin) ? parseTime(wev.fin) - parseTime(wev.inicio) : null;

              return (
                <div key={m.id} style={{ borderRadius:9, overflow:"hidden", borderLeft:`3px solid ${color}`, background:"rgba(255,255,255,0.02)", border:`1px solid rgba(255,255,255,0.06)` }}>
                  <div style={{ padding:"10px 14px", display:"flex", alignItems:"flex-start", gap:10 }}>
                    <span style={{ width:20, height:20, borderRadius:"50%", background:"rgba(255,255,255,0.06)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:"#888", flexShrink:0 }}>{m.order}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                        <span style={{ fontSize:13, color:"#f0f0f0", fontWeight:600 }}>{m.name} {m.dose}</span>
                        <span style={{ fontSize:10, padding:"1px 7px", borderRadius:99, background:`${color}22`, color:color }}>{CAT_LABEL[m.category]}</span>
                        {done ? <span style={{ fontSize:10, color:"#1D9E75" }}>✓</span> : <span style={{ fontSize:10, color:"#555" }}>○</span>}
                      </div>
                      <div style={{ fontSize:11, color:"#666", marginTop:2 }}>{m.diluent}{m.time ? ` · ${m.time} min programado` : ""}</div>

                      {/* Tiempos del medicamento */}
                      {ev.inicio && (
                        <div style={{ marginTop:6, display:"flex", gap:12, flexWrap:"wrap" }}>
                          <span style={{ fontSize:11, color:"#1D9E75", fontFamily:"'IBM Plex Mono', monospace" }}>▶ {ev.inicio}</span>
                          {ev.fin && <span style={{ fontSize:11, color:"#4fc3f7", fontFamily:"'IBM Plex Mono', monospace" }}>■ {ev.fin}</span>}
                          {medDiff && (
                            <span style={{ fontSize:11, color: m.time && medDiff <= m.time ? "#1D9E75" : "#EF9F27" }}>
                              {medDiff} min real {m.time ? `/ ${m.time} min prog` : ""}
                              {m.time && medDiff > m.time ? " ▲" : m.time && medDiff < m.time ? " ▼" : ""}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Tiempos del lavado */}
                      {m.wash && wev.inicio && (
                        <div style={{ marginTop:4, padding:"5px 8px", borderRadius:6, background:"rgba(79,195,247,0.06)", border:"1px solid rgba(79,195,247,0.15)" }}>
                          <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
                            <span style={{ fontSize:10, color:"#4fc3f7" }}>💧 Lavado {m.wash.solution} {m.wash.speed ? `${m.wash.speed} ml/hr` : ""}</span>
                            <span style={{ fontSize:10, color:"#4fc3f7", fontFamily:"'IBM Plex Mono', monospace" }}>▶ {wev.inicio}</span>
                            {wev.fin && <span style={{ fontSize:10, color:"#4fc3f7", fontFamily:"'IBM Plex Mono', monospace" }}>■ {wev.fin}</span>}
                            {washDiff && <span style={{ fontSize:10, color:"#4fc3f7" }}>{washDiff} min real / {m.wash.time} min prog</span>}
                          </div>
                        </div>
                      )}

                      {/* Medicamento domicilio */}
                      {m.category === "domicilio" && ev.inicio && (
                        <div style={{ marginTop:4, fontSize:11, color:"#82C4F8" }}>📦 Entregado a las {ev.inicio}</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Resumen total */}
          {s.events?.ingreso && (
            <div style={{ marginTop:12, padding:"12px 14px", borderRadius:10, background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)" }}>
              <div style={{ fontSize:11, color:"#555", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Resumen del tratamiento</div>
              <div style={{ display:"flex", gap:20, flexWrap:"wrap" }}>
                <div>
                  <div style={{ fontSize:10, color:"#555" }}>Ingreso</div>
                  <div style={{ fontSize:13, color:"#aaa", fontFamily:"'IBM Plex Mono', monospace" }}>{s.events.ingreso}</div>
                </div>
                {s.events?.retiro && (
                  <div>
                    <div style={{ fontSize:10, color:"#555" }}>Retiro</div>
                    <div style={{ fontSize:13, color:"#aaa", fontFamily:"'IBM Plex Mono', monospace" }}>{s.events.retiro}</div>
                  </div>
                )}
                {estancia && (
                  <div>
                    <div style={{ fontSize:10, color:"#555" }}>Estancia total</div>
                    <div style={{ fontSize:13, color:"#EF9F27", fontFamily:"'IBM Plex Mono', monospace" }}>{formatDiff(estancia)}</div>
                  </div>
                )}
                {totalReal > 0 && (
                  <div>
                    <div style={{ fontSize:10, color:"#555" }}>Tiempo real infusión</div>
                    <div style={{ fontSize:13, color: totalReal <= totalProg ? "#1D9E75" : "#EF9F27", fontFamily:"'IBM Plex Mono', monospace" }}>{totalReal} min</div>
                  </div>
                )}
                {totalProg > 0 && (
                  <div>
                    <div style={{ fontSize:10, color:"#555" }}>Tiempo programado</div>
                    <div style={{ fontSize:13, color:"#666", fontFamily:"'IBM Plex Mono', monospace" }}>{totalProg} min</div>
                  </div>
                )}
              </div>
            </div>
          )}

         {s.globalNote && (
            <div style={{ marginTop:10, padding:"8px 12px", borderRadius:8, background:"rgba(255,255,255,0.02)", fontSize:12, color:"#666" }}>
              📋 {s.globalNote}
            </div>
          )}

          {isJefe && !editing && (
            <button onClick={e => { e.stopPropagation(); openEditor(); }} style={{ marginTop:12, padding:"7px 16px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>
              ✏️ Editar sesión
            </button>
          )}

          {editing && editDraft && (
            <div onClick={e => e.stopPropagation()} style={{ marginTop:14, padding:"16px", borderRadius:12, background:"rgba(255,179,71,0.04)", border:"1px solid rgba(255,179,71,0.2)" }}>
              <div style={{ fontSize:12, color:"#ffb347", fontWeight:600, marginBottom:14 }}>✏️ Editar sesión</div>

              {/* Tipo de sesión */}
              <div style={{ marginBottom:12 }}>
                <label style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:4 }}>Tipo de sesión</label>
                <select value={editDraft.sessionType || "iv"} onChange={e => setEditDraft(d => ({...d, sessionType: e.target.value}))}
                  style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"7px 10px", color:"#f0f0f0", fontSize:12, outline:"none", cursor:"pointer" }}>
                  <option value="iv">Infusión IV</option>
                  <option value="im">Intramuscular</option>
                  <option value="sc">Subcutánea</option>
                  <option value="entrega">Entrega de medicamento</option>
                  <option value="procedimiento">Procedimiento</option>
                </select>
              </div>

              {/* Datos generales */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:12 }}>
               {[["Fecha","date","date"],["Ciclo","cycle","text"],["Médico","physician","text"],["Diagnóstico","diagnosis","text"],["# Global","infusionNumber","number"],["No. Expediente","expedienteNumber","number"],["Ingreso","ingreso","time"],["Retiro","retiro","time"]].map(([label,field,type]) => (
                  <div key={field}>
                    <label style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:4 }}>{label}</label>
                    <input type={type} value={editDraft[field]} onChange={e => setEditDraft(d => ({...d,[field]:e.target.value}))}
                      style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"7px 10px", color:"#f0f0f0", fontSize:12, outline:"none" }} />
                  </div>
                ))}
              </div>

              {/* Nota global */}
              <div style={{ marginBottom:12 }}>
                <label style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:4 }}>Nota global</label>
                <textarea rows={2} value={editDraft.globalNote} onChange={e => setEditDraft(d => ({...d,globalNote:e.target.value}))}
                  style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"7px 10px", color:"#f0f0f0", fontSize:12, outline:"none", resize:"vertical" }} />
              </div>

              {/* Medicamentos */}
              <div style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Medicamentos y tiempos</div>
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:12 }}>
                {editDraft.meds.map((m, idx) => (
                  <div key={m.id} style={{ padding:"10px 12px", borderRadius:8, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)" }}>
                    <div style={{ fontSize:12, color:"#f0f0f0", fontWeight:600, marginBottom:8 }}>{m.order}. {m.name} {m.dose}</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8 }}>
                      {[["Nombre","name"],["Dosis","dose"],["Dilución","diluent"],["Tiempo (min)","time"]].map(([label,field]) => (
                        <div key={field}>
                          <label style={{ fontSize:9, color:"#555", textTransform:"uppercase", display:"block", marginBottom:3 }}>{label}</label>
                          <input value={m[field]||""} onChange={e => setEditDraft(d => ({...d, meds: d.meds.map((x,i) => i===idx ? {...x,[field]:e.target.value} : x)}))}
                            style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:6, padding:"5px 8px", color:"#f0f0f0", fontSize:11, outline:"none" }} />
                        </div>
                      ))}
                      {[["Inicio med","inicio"],["Fin med","fin"],["Inicio lavado","washInicio"],["Fin lavado","washFin"]].map(([label,field]) => (
                        <div key={field}>
                          <label style={{ fontSize:9, color:"#555", textTransform:"uppercase", display:"block", marginBottom:3 }}>{label}</label>
                          <input value={m[field]||""} onChange={e => setEditDraft(d => ({...d, meds: d.meds.map((x,i) => i===idx ? {...x,[field]:e.target.value} : x)}))}
                            style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:6, padding:"5px 8px", color:"#f0f0f0", fontSize:11, outline:"none" }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display:"flex", gap:8 }}>
                <button onClick={saveEdit} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"rgba(29,158,117,0.15)", border:"1px solid rgba(29,158,117,0.4)", color:"#1D9E75" }}>✓ Guardar cambios</button>
                <button onClick={e => { e.stopPropagation(); setEditing(false); }} style={{ padding:"9px 16px", borderRadius:9, fontSize:13, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#666" }}>Cancelar</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Historial() {
 const { user, profile } = useAuth();
const isJefe = profile?.role === "jefe";
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [selected, setSelected] = useState(null);
  const [token, setToken] = useState("");
  const [filters, setFilters]   = useState({ date:"", center:"", search:"" });

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken(true);
      const t = await user.getIdToken(true);
setToken(t);
      const data  = await fetchSessions(token, filters);
      setSessions(data);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [user]);

  const filtered = sessions.filter(s => {
    if (!filters.search) return true;
    const q = filters.search.toLowerCase();
    return s.patientName?.toLowerCase().includes(q) ||
           s.physician?.toLowerCase().includes(q) ||
           s.diagnosis?.toLowerCase().includes(q);
  });

  const inputStyle = { background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"8px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };

  return (
    <div style={{ padding:"24px 28px", maxWidth:900, margin:"0 auto" }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Historial</h1>
        <p style={{ fontSize:13, color:"#555" }}>Consulta de sesiones pasadas</p>
      </div>

      <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
        <input type="date" value={filters.date} onChange={e => setFilters(f => ({ ...f, date:e.target.value }))} style={inputStyle} />
        <select value={filters.center} onChange={e => setFilters(f => ({ ...f, center:e.target.value }))} style={{ ...inputStyle, cursor:"pointer" }}>
          <option value="">Todos los centros</option>
          <option value="CIPI">CIPI</option>
          <option value="CITIO">CITIO</option>
        </select>
        <input placeholder="Buscar paciente, médico o diagnóstico..." value={filters.search}
          onChange={e => setFilters(f => ({ ...f, search:e.target.value }))}
          style={{ ...inputStyle, flex:1, minWidth:200 }} />
        <button onClick={load} style={{ padding:"8px 20px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
          Buscar
        </button>
      </div>

      {loading ? (
        <div style={{ color:"#555", fontSize:14, padding:24 }}>Cargando...</div>
      ) : filtered.length === 0 ? (
        <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
          No hay sesiones con esos filtros.
        </div>
      ) : (
        <div>
         {(() => {
            const iv = filtered.filter(s => !s.sessionType || s.sessionType === "iv");
            const im = filtered.filter(s => s.sessionType === "intramuscular");
            const sc = filtered.filter(s => s.sessionType === "subcutaneo");
            const entregas = filtered.filter(s => s.sessionType === "entrega");
            const procs = filtered.filter(s => s.sessionType === "procedimiento");
            return (
              <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:12 }}>
                {iv.length > 0 && <span style={{ fontSize:10, padding:"3px 10px", borderRadius:99, background:"rgba(79,195,247,0.1)", color:"#4fc3f7", border:"1px solid rgba(79,195,247,0.25)" }}>IV: {iv.length}</span>}
                {im.length > 0 && <span style={{ fontSize:10, padding:"3px 10px", borderRadius:99, background:"rgba(175,169,236,0.1)", color:"#AFA9EC", border:"1px solid rgba(175,169,236,0.25)" }}>IM: {im.length}</span>}
                {sc.length > 0 && <span style={{ fontSize:10, padding:"3px 10px", borderRadius:99, background:"rgba(93,202,165,0.1)", color:"#5DCAA5", border:"1px solid rgba(93,202,165,0.25)" }}>SC: {sc.length}</span>}
                {entregas.length > 0 && <span style={{ fontSize:10, padding:"3px 10px", borderRadius:99, background:"rgba(130,196,248,0.1)", color:"#82C4F8", border:"1px solid rgba(130,196,248,0.25)" }}>Entregas: {entregas.length}</span>}
                {procs.length > 0 && <span style={{ fontSize:10, padding:"3px 10px", borderRadius:99, background:"rgba(250,199,117,0.1)", color:"#FAC775", border:"1px solid rgba(250,199,117,0.25)" }}>Procedimientos: {procs.length}</span>}
                <span style={{ fontSize:10, padding:"3px 10px", borderRadius:99, background:"rgba(255,255,255,0.05)", color:"#666", border:"1px solid rgba(255,255,255,0.09)" }}>Total: {filtered.length}</span>
              </div>
            );
          })()}
          {filtered.map(s => <SessionRow key={s.id} s={s} onSelect={setSelected} selected={selected} isJefe={isJefe} token={token} onRefresh={load} />)}
        </div>
      )}
    </div>
  );
}
