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

function SessionRow({ s, onSelect, selected }) {
  const sm = STATUS_META[s.status] || STATUS_META.pendiente;
  const isSelected = selected?.id === s.id;

  // Calcular tiempos
  const ingresoMin  = parseTime(s.events?.ingreso);
  const retiroMin   = parseTime(s.events?.retiro);
  const estancia    = (ingresoMin && retiroMin) ? retiroMin - ingresoMin : null;
  const me          = s.medEvents || {};
  const we          = s.washEvents || {};

  const totalReal = (s.meds||[]).reduce((acc, m) => {
    const ev = me[`med_${m.id}`] || {};
    if (ev.inicio && ev.fin) {
      const diff = parseTime(ev.fin) - parseTime(ev.inicio);
      return acc + (diff > 0 ? diff : 0);
    }
    return acc;
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
        </div>
       <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ fontSize:11, color:"#666", marginBottom:4 }}>{s.date}</div>
          {s.infusionNumber && <div style={{ fontSize:11, color:"#00d4aa", fontFamily:"'IBM Plex Mono', monospace", marginBottom:4 }}>#{s.infusionNumber}</div>}
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
          <div style={{ fontSize:11, color:"#555", letterSpacing:2, textTransform:"uppercase", marginBottom:12 }}>
            {filtered.length} sesión{filtered.length !== 1 ? "es" : ""} encontrada{filtered.length !== 1 ? "s" : ""}
          </div>
          {filtered.map(s => <SessionRow key={s.id} s={s} onSelect={setSelected} selected={selected} />)}
        </div>
      )}
    </div>
  );
}
