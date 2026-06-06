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

const STATUS_META = {
  completado: { label:"Completado", color:"#4fc3f7" },
  en_curso:   { label:"En curso",   color:"#1D9E75" },
  pendiente:  { label:"Pendiente",  color:"#ffb347" },
};

function SessionRow({ s, onSelect, selected }) {
  const sm = STATUS_META[s.status] || STATUS_META.pendiente;
  const isSelected = selected?.id === s.id;
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
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ fontSize:11, color:"#666", marginBottom:4 }}>{s.date}</div>
          <span style={{ fontSize:11, padding:"3px 10px", borderRadius:99, background:`${sm.color}18`, color:sm.color, border:`1px solid ${sm.color}44` }}>{sm.label}</span>
        </div>
      </div>

      {/* Detalle expandido */}
      {isSelected && (
        <div style={{ marginTop:14, paddingTop:14, borderTop:"1px solid rgba(255,255,255,0.07)" }}>
          {/* Tiempos */}
          {s.events?.ingreso && (
            <div style={{ display:"flex", gap:16, marginBottom:12, flexWrap:"wrap" }}>
              <div style={{ fontSize:12, color:"#777" }}>▶ Ingreso: <span style={{ color:"#aaa", fontFamily:"'IBM Plex Mono', monospace" }}>{s.events.ingreso}</span></div>
              {s.events?.retiro && <div style={{ fontSize:12, color:"#4fc3f7" }}>■ Retiro: <span style={{ fontFamily:"'IBM Plex Mono', monospace" }}>{s.events.retiro}</span></div>}
            </div>
          )}

          {/* Medicamentos */}
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {(s.meds || []).map(m => {
              const me = s.medEvents || {};
              const ev = me[`med_${m.id}`] || {};
              const done = !!ev.fin;
              const CAT_COLOR = { premedicacion:"#FAC775", inmunoterapia:"#5DCAA5", quimioterapia:"#F09595", adicional:"#AFA9EC" };
              const color = CAT_COLOR[m.category] || "#888";
              return (
                <div key={m.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", background:"rgba(255,255,255,0.02)", borderRadius:8, borderLeft:`3px solid ${color}` }}>
                  <span style={{ fontSize:12, color: done ? "#1D9E75" : "#555" }}>{done ? "✓" : "○"}</span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, color:"#ddd", fontWeight:600 }}>{m.name} {m.dose}</div>
                    <div style={{ fontSize:11, color:"#555" }}>{m.diluent} · {m.time} min</div>
                  </div>
                  {ev.inicio && ev.fin && (
                    <div style={{ fontSize:11, color:"#666", fontFamily:"'IBM Plex Mono', monospace", textAlign:"right" }}>
                      {ev.inicio} → {ev.fin}
                      {(() => {
                        try {
                          const pt = (t) => {
                            if (t.includes("a.m.") || t.includes("p.m.")) {
                              const [time, period] = t.split(" ");
                              const [h, mm] = time.split(":").map(Number);
                              let hours = h;
                              if (period === "p.m." && h !== 12) hours += 12;
                              if (period === "a.m." && h === 12) hours = 0;
                              return hours * 60 + mm;
                            }
                            const [h, mm] = t.split(":").map(Number);
                            return h * 60 + mm;
                          };
                          const diff = pt(ev.fin) - pt(ev.inicio);
                          if (diff > 0) return <span style={{ color: diff <= m.time ? "#1D9E75" : "#EF9F27" }}> ({diff} min)</span>;
                        } catch(e) {}
                        return null;
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {s.globalNote && (
            <div style={{ marginTop:10, padding:"8px 12px", borderRadius:8, background:"rgba(255,255,255,0.02)", fontSize:12, color:"#666" }}>
              📋 {s.globalNote}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Historial() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [selected, setSelected] = useState(null);
  const [filters, setFilters]   = useState({ date:"", center:"", search:"" });

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken(true);
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

      {/* Filtros */}
      <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
        <input type="date" value={filters.date} onChange={e => setFilters(f => ({ ...f, date: e.target.value }))}
          style={{ ...inputStyle }} />
        <select value={filters.center} onChange={e => setFilters(f => ({ ...f, center: e.target.value }))}
          style={{ ...inputStyle, cursor:"pointer" }}>
          <option value="">Todos los centros</option>
          <option value="CIPI">CIPI</option>
          <option value="CITIO">CITIO</option>
        </select>
        <input placeholder="Buscar paciente, médico o diagnóstico..." value={filters.search}
          onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          style={{ ...inputStyle, flex:1, minWidth:200 }} />
        <button onClick={load} style={{ padding:"8px 20px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
          Buscar
        </button>
      </div>

      {/* Resultados */}
      {loading ? (
        <div style={{ color:"#555", fontSize:14, padding:24 }}>Cargando...</div>
      ) : filtered.length === 0 ? (
        <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
          No hay sesiones con esos filtros.
        </div>
      ) : (
        <div>
          <div style={{ fontSize:11, color:"#555", letterSpacing:2, textTransform:"uppercase", marginBottom:12 }}>
            {filtered.length} sesión{filtered.length !== 1 ? "es" : ""} encontrada{filtered.length !== 1 ? "s" : ""}
          </div>
          {filtered.map(s => <SessionRow key={s.id} s={s} onSelect={setSelected} selected={selected} />)}
        </div>
      )}
    </div>
  );
}
