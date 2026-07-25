import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

import { PROJECT_ID, DATABASE_ID } from "../config";

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
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:runQuery`;
  const filtersList = [];
  if (filters.from) filtersList.push({ fieldFilter: { field: { fieldPath: "date" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: filters.from } } });
  if (filters.to)   filtersList.push({ fieldFilter: { field: { fieldPath: "date" }, op: "LESS_THAN_OR_EQUAL",    value: { stringValue: filters.to } } });
  if (filters.center) filtersList.push({ fieldFilter: { field: { fieldPath: "center" }, op: "EQUAL", value: { stringValue: filters.center } } });

  const where = filtersList.length === 1 ? filtersList[0] :
    filtersList.length > 1 ? { compositeFilter: { op: "AND", filters: filtersList } } : null;

  const query = { from: [{ collectionId: "sessions" }], limit: 1000 };
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

function StatBox({ label, value, sub, color }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, borderRadius: 13, padding: "18px 20px" }}>
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 32, fontFamily: "'DM Serif Display', serif", color: "#fff" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function BarChart({ data, color, label }) {
  if (!data.length) return null;
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div>
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12 }}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {data.slice(0, 10).map((d, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 140, fontSize: 12, color: "#888", textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</div>
            <div style={{ flex: 1, background: "rgba(255,255,255,0.05)", borderRadius: 99, height: 20, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(d.value / max) * 100}%`, background: color, borderRadius: 99, display: "flex", alignItems: "center", paddingLeft: 8, transition: "width 0.5s" }}>
                <span style={{ fontSize: 10, color: "#000", fontWeight: 700 }}>{d.value}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthlyChart({ data, label, color = "rgba(0,212,170,0.7)" }) {
  if (!data.length) return null;
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div>
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120 }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontSize: 10, color: "#666" }}>{d.value}</div>
            <div style={{ width: "100%", background: color, borderRadius: "4px 4px 0 0", height: `${(d.value / max) * 90}px`, minHeight: d.value ? 4 : 0, transition: "height 0.5s" }} />
            <div style={{ fontSize: 9, color: "#555", textAlign: "center" }}>{d.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Reportes() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [filters, setFilters]   = useState({
    from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0],
    to:   new Date().toISOString().split("T")[0],
    center: "",
  });

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

  const exportCSV = () => {
    const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const headers = ["date","patientName","dob","physician","diagnosis","sessionType","center","status","cycle","schemeName","insurance","allergies","medications"];
    const rows = sessions.map(s => [
      s.date, s.patientName, s.dob, s.physician, s.diagnosis, s.sessionType, s.center, s.status, s.cycle, s.schemeName || "",
      s.insurance, s.allergies,
      (s.meds || []).map(m => m.name).filter(Boolean).join(" | "),
    ]);
    const csv = "\uFEFF" + [headers, ...rows].map(r => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sesiones_${filters.from || "inicio"}_a_${filters.to || "hoy"}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  useEffect(() => { load(); }, [user]);

  // Separar entregas del resto
  const deliveries     = sessions.filter(s => s.sessionType === "entrega");
  const clinicSessions = sessions.filter(s => s.sessionType !== "entrega");

  // Métricas
  const completed  = clinicSessions.filter(s => s.status === "completado").length;
  const inProgress = clinicSessions.filter(s => s.status === "en_curso").length;
  const pending    = clinicSessions.filter(s => s.status === "pendiente").length;
  const cipi       = clinicSessions.filter(s => s.center === "CIPI").length;
  const citio      = clinicSessions.filter(s => s.center === "CITIO").length;

  // Promedio de estancia
  const pt = (t) => {
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
  };
  const withTimes = sessions.filter(s => s.events?.ingreso && s.events?.retiro);
  const avgStay   = withTimes.length ? Math.round(withTimes.reduce((acc, s) => {
    const diff = pt(s.events.retiro) - pt(s.events.ingreso);
    return acc + (diff > 0 ? diff : 0);
  }, 0) / withTimes.length) : 0;

  // Pacientes únicos
  const uniquePatients = [...new Set(clinicSessions.map(s => s.patientName).filter(Boolean))].length;
  
  // Por médico
  const byPhysician = Object.entries(
   clinicSessions.reduce((acc, s) => { if (s.physician) acc[s.physician] = (acc[s.physician]||0)+1; return acc; }, {})
  ).map(([label, value]) => ({ label, value })).sort((a,b) => b.value - a.value);

  // Por diagnóstico
  const byDiagnosis = Object.entries(
    clinicSessions.reduce((acc, s) => { if (s.diagnosis) acc[s.diagnosis] = (acc[s.diagnosis]||0)+1; return acc; }, {})
  ).map(([label, value]) => ({ label, value })).sort((a,b) => b.value - a.value);

  // Por mes
  const monthLabel = (key) => {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("es-MX", { month:"short", year:"2-digit" });
  };
  const byMonth = Object.entries(
    clinicSessions.reduce((acc, s) => {
      if (!s.date) return acc;
      const month = s.date.substring(0, 7);
      acc[month] = (acc[month]||0)+1;
      return acc;
    }, {})
  ).sort(([a],[b]) => a.localeCompare(b))
   .map(([key, value]) => ({ label: monthLabel(key), value }));

  // Pacientes nuevos por mes (primera vez)
  const firstVisit = {};
  sessions.sort((a,b) => (a.date||"").localeCompare(b.date||"")).forEach(s => {
    if (s.patientName && !firstVisit[s.patientName]) firstVisit[s.patientName] = s.date?.substring(0,7);
  });
  const newByMonth = Object.entries(
    Object.values(firstVisit).reduce((acc, month) => { if (month) acc[month] = (acc[month]||0)+1; return acc; }, {})
  ).sort(([a],[b]) => a.localeCompare(b))
   .map(([key, value]) => ({ label: monthLabel(key), value }));

  // Medicamento más ocupado (se descarta todo lo de premedicación)
  const byMedication = Object.entries(
    clinicSessions.reduce((acc, s) => {
      (s.meds || []).forEach(m => {
        if (!m.name || m.category === "premedicacion") return;
        const key = m.name.trim();
        acc[key] = (acc[key]||0) + 1;
      });
      return acc;
    }, {})
  ).map(([label, value]) => ({ label, value })).sort((a,b) => b.value - a.value);

  // Totales por tipo de sesión (todas, incluyendo entregas)
  const totalIV            = sessions.filter(s => s.sessionType === "iv").length;
  const totalIM             = sessions.filter(s => s.sessionType === "im").length;
  const totalSC             = sessions.filter(s => s.sessionType === "sc").length;
  const totalEntregas       = sessions.filter(s => s.sessionType === "entrega").length;
  const totalProcedimientos = sessions.filter(s => s.sessionType === "procedimiento").length;

  // Atenciones en total por mes (todos los tipos, incluye entregas)
  const byMonthTotal = Object.entries(
    sessions.reduce((acc, s) => {
      if (!s.date) return acc;
      const month = s.date.substring(0, 7);
      acc[month] = (acc[month]||0)+1;
      return acc;
    }, {})
  ).sort(([a],[b]) => a.localeCompare(b))
   .map(([key, value]) => ({ label: monthLabel(key), value }));

  // Pacientes atendidos por mes (únicos dentro de cada mes, sin importar si ya habían venido antes)
  const patientsPerMonth = {};
  sessions.forEach(s => {
    if (!s.date || !s.patientName) return;
    const month = s.date.substring(0, 7);
    (patientsPerMonth[month] ||= new Set()).add(s.patientName);
  });
  const attendedByMonth = Object.entries(patientsPerMonth)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([key, set]) => ({ label: monthLabel(key), value: set.size }));

  // Médicos nuevos por mes (primera vez que aparecen como médico tratante)
  const firstDoctorVisit = {};
  sessions.slice().sort((a,b) => (a.date||"").localeCompare(b.date||"")).forEach(s => {
    if (s.physician && !firstDoctorVisit[s.physician]) firstDoctorVisit[s.physician] = s.date?.substring(0,7);
  });
  const newDoctorsByMonth = Object.entries(
    Object.values(firstDoctorVisit).reduce((acc, month) => { if (month) acc[month] = (acc[month]||0)+1; return acc; }, {})
  ).sort(([a],[b]) => a.localeCompare(b))
   .map(([key, value]) => ({ label: monthLabel(key), value }));

  const inputStyle = { background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"8px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };

  return (
    <div style={{ padding:"24px 28px", maxWidth:1000, margin:"0 auto" }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Reportes y estadísticas</h1>
        <p style={{ fontSize:13, color:"#555" }}>Análisis del período seleccionado</p>
      </div>

      {/* Filtros */}
      <div style={{ display:"flex", gap:10, marginBottom:24, flexWrap:"wrap", alignItems:"center" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <label style={{ fontSize:11, color:"#555" }}>Desde</label>
          <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from:e.target.value }))} style={inputStyle} />
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <label style={{ fontSize:11, color:"#555" }}>Hasta</label>
          <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to:e.target.value }))} style={inputStyle} />
        </div>
        <select value={filters.center} onChange={e => setFilters(f => ({ ...f, center:e.target.value }))} style={{ ...inputStyle, cursor:"pointer" }}>
          <option value="">Ambos centros</option>
          <option value="CIPI">CIPI</option>
          <option value="CITIO">CITIO</option>
        </select>
        <button onClick={load} style={{ padding:"8px 20px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
          Buscar
        </button>
        <button onClick={exportCSV} disabled={!sessions.length} style={{ padding:"8px 20px", borderRadius:9, fontSize:13, fontWeight:600, cursor: sessions.length ? "pointer" : "not-allowed", background:"rgba(79,195,247,0.12)", border:"1px solid rgba(79,195,247,0.3)", color:"#4fc3f7", opacity: sessions.length ? 1 : 0.5 }}>
          ⬇ Exportar CSV
        </button>
      </div>

      {loading ? (
        <div style={{ color:"#555", fontSize:14, padding:24 }}>Cargando...</div>
      ) : (
        <>
          {/* Stats principales */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))", gap:12, marginBottom:14 }}>
            <StatBox label="Sesiones IV"          value={totalIV}             color="#4fc3f7" />
            <StatBox label="Sesiones IM"           value={totalIM}             color="#AFA9EC" />
            <StatBox label="Sesiones SC"           value={totalSC}             color="#5DCAA5" />
            <StatBox label="Entregas"              value={totalEntregas}       color="#82C4F8" />
            <StatBox label="Procedimientos"        value={totalProcedimientos} color="#FAC775" />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))", gap:12, marginBottom:28 }}>
            <StatBox label="Total sesiones"    value={clinicSessions.length} color="#00d4aa" />
            <StatBox label="Completadas"        value={completed}       color="#4fc3f7" />
            <StatBox label="Pacientes únicos"   value={uniquePatients}  color="#AFA9EC" />
            <StatBox label="Estancia promedio"  value={avgStay ? `${Math.floor(avgStay/60)}h ${avgStay%60}m` : "—"} color="#FAC775" />
           <StatBox label="CIPI"  value={cipi}  sub={`${clinicSessions.length ? Math.round(cipi/clinicSessions.length*100) : 0}% del total`} color="#5DCAA5" />
            <StatBox label="CITIO" value={citio} sub={`${clinicSessions.length ? Math.round(citio/clinicSessions.length*100) : 0}% del total`} color="#F09595" />
          </div>

          {/* Atenciones en total por mes (todos los tipos) */}
          {byMonthTotal.length > 0 && (
            <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:20 }}>
              <MonthlyChart data={byMonthTotal} label="Atenciones en total por mes" color="rgba(0,212,170,0.7)" />
            </div>
          )}

          {/* Gráfica por mes (infusiones) */}
          {byMonth.length > 0 && (
            <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:20 }}>
              <MonthlyChart data={byMonth} label="Infusiones por mes" color="rgba(79,195,247,0.7)" />
            </div>
          )}

          {/* Pacientes atendidos por mes (total) */}
          {attendedByMonth.length > 0 && (
            <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:20 }}>
              <MonthlyChart data={attendedByMonth} label="Pacientes atendidos por mes" color="rgba(250,199,117,0.7)" />
            </div>
          )}

          {/* Pacientes nuevos por mes */}
          {newByMonth.length > 0 && (
            <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:20 }}>
              <MonthlyChart data={newByMonth} label="Pacientes nuevos por mes" color="rgba(175,169,236,0.7)" />
            </div>
          )}

          {/* Médicos nuevos por mes */}
          {newDoctorsByMonth.length > 0 && (
            <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:20 }}>
              <MonthlyChart data={newDoctorsByMonth} label="Médicos nuevos por mes" color="rgba(240,149,149,0.7)" />
            </div>
          )}

          {/* Pacientes por médico */}
          <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:20 }}>
            <BarChart data={byPhysician} color="rgba(0,212,170,0.7)" label="Pacientes por médico" />
          </div>

          {/* Por diagnóstico */}
          <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:20 }}>
            <BarChart data={byDiagnosis} color="rgba(175,169,236,0.7)" label="Por diagnóstico" />
          </div>

          {/* Medicamento más ocupado (sin premedicación) */}
          {byMedication.length > 0 && (
            <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:20 }}>
              <BarChart data={byMedication} color="rgba(250,199,117,0.7)" label="Medicamento más ocupado (sin premedicación)" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
