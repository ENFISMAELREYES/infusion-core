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

async function fetchAuditLog(token, filters) {
  const filtersList = [];
  if (filters.collection) filtersList.push({ fieldFilter: { field: { fieldPath: "collection" }, op: "EQUAL", value: { stringValue: filters.collection } } });
  if (filters.docId)      filtersList.push({ fieldFilter: { field: { fieldPath: "docId" },      op: "EQUAL", value: { stringValue: filters.docId } } });
  if (filters.userEmail)  filtersList.push({ fieldFilter: { field: { fieldPath: "userEmail" },  op: "EQUAL", value: { stringValue: filters.userEmail } } });

  const where = filtersList.length === 1 ? filtersList[0]
    : filtersList.length > 1 ? { compositeFilter: { op: "AND", filters: filtersList } }
    : null;

  const query = {
    from: [{ collectionId: "audit_log" }],
    orderBy: [{ field: { fieldPath: "timestamp" }, direction: "DESCENDING" }],
    limit: 300,
  };
  if (where) query.where = where;

  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: query }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

// Trae, de un lote de sesiones referenciadas en la auditoría, sus datos
// actuales (paciente, estatus, quién la registró) -- el registro de
// auditoría solo guarda QUÉ CAMBIÓ, no estos datos de contexto por sí solos.
async function fetchSessionsInfo(token, sessionIds) {
  if (sessionIds.length === 0) return {};
  const docPaths = sessionIds.map(id => `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${id}`);
  const info = {};
  // batchGet acepta hasta 500 documentos por solicitud; se trocea por si acaso.
  for (let i = 0; i < docPaths.length; i += 300) {
    const chunk = docPaths.slice(i, i + 300);
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:batchGet`, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ documents: chunk }),
    });
    const data = await res.json();
    (Array.isArray(data) ? data : []).forEach(d => {
      if (!d.found) return;
      const parsed = parseDoc(d.found);
      info[parsed.id] = { patientName: parsed.patientName || "", status: parsed.status || "", nurseName: parsed.nurseName || "" };
    });
  }
  return info;
}

// Etiquetas legibles para los nombres de campo más comunes que se auditan
const FIELD_LABELS = {
  meds: "Medicamentos", medEvents: "Eventos de medicamento", washEvents: "Eventos de lavado",
  events: "Ingreso/Retiro", signatures: "Firmas", globalNote: "Nota global",
  catheterType: "Tipo de acceso", catheterGauge: "Calibre de catéter", equipoChoice: "Equipo de infusión",
  extraMaterial: "Material adicional", excludedMaterial: "Material excluido",
  qtyOverrides: "Cantidades ajustadas", pieceOverrides: "Piezas ajustadas", materialNote: "Nota de material",
  excludePatientDefault: "Excluir material de paciente", excludeFromOrder: "Excluida del pedido",
  pedidoGeneradoAt: "Pedido generado", anexos: "Anexos", date: "Fecha", cycle: "Ciclo",
  physician: "Médico", diagnosis: "Diagnóstico", sessionType: "Tipo de sesión", schemeName: "Esquema",
  expedienteNumber: "No. expediente",
};

const STATUS_LABEL = { pendiente: "Pendiente", en_curso: "En curso", completado: "Completado" };
const STATUS_COLOR = { pendiente: "#ffb347", en_curso: "#4fc3f7", completado: "#00d4aa" };

function formatValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

export default function Auditoria() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [filters, setFilters] = useState({ collection: "", docId: "", userEmail: "" });

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken(true);
      const data = await fetchAuditLog(token, filters);
      const sessionIds = [...new Set(data.filter(e => e.collection === "sessions").map(e => e.docId))];
      const sessionsInfo = await fetchSessionsInfo(token, sessionIds);
      setEntries(data.map(e => ({ ...e, sessionInfo: sessionsInfo[e.docId] })));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setHasLoadedOnce(true);
    }
  };

  useEffect(() => { load(); }, [user]);

  const inputStyle = { background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"8px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };

  if (!isJefe) {
    return (
      <div style={{ padding:"24px 28px", maxWidth:900, margin:"0 auto" }}>
        <div style={{ color:"#888", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
          Solo el jefe de enfermería puede consultar el registro de auditoría.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:"24px 28px", maxWidth:900, margin:"0 auto" }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Auditoría</h1>
        <p style={{ fontSize:13, color:"#555" }}>Quién cambió qué, en qué registro y cuándo — de solo lectura, no se puede editar ni borrar.</p>
      </div>

      <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
        <select value={filters.collection} onChange={e => setFilters(f => ({ ...f, collection: e.target.value }))} style={{ ...inputStyle, cursor:"pointer" }}>
          <option value="">Toda colección</option>
          <option value="sessions">Sesiones</option>
        </select>
        <input placeholder="ID del documento (opcional)" value={filters.docId}
          onChange={e => setFilters(f => ({ ...f, docId: e.target.value }))} style={{ ...inputStyle, minWidth:220 }} />
        <input placeholder="Correo del usuario (opcional)" value={filters.userEmail}
          onChange={e => setFilters(f => ({ ...f, userEmail: e.target.value }))} style={{ ...inputStyle, minWidth:220 }} />
        <button onClick={load} style={{ padding:"8px 20px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
          Buscar
        </button>
      </div>

      {loading && !hasLoadedOnce ? (
        <div style={{ color:"#555", fontSize:14, padding:24 }}>Cargando…</div>
      ) : entries.length === 0 ? (
        <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
          Sin registros con esos filtros.
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:12, color:"#555", marginBottom:4 }}>{entries.length} registro{entries.length !== 1 ? "s" : ""} (últimos 300)</div>
          {entries.map(e => {
            const isOpen = expanded === e.id;
            const changeKeys = Object.keys(e.changes || {});
            return (
              <div key={e.id} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
                <div onClick={() => setExpanded(isOpen ? null : e.id)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ fontSize:11, color:"#666", background:"rgba(255,255,255,0.05)", padding:"2px 8px", borderRadius:99 }}>{e.collection}</span>
                  {e.sessionInfo?.patientName && <span style={{ fontSize:12, color:"#f0f0f0", fontWeight:600 }}>{e.sessionInfo.patientName}</span>}
                  {e.sessionInfo?.status && (
                    <span style={{ fontSize:10, color: STATUS_COLOR[e.sessionInfo.status] || "#888", background:"rgba(255,255,255,0.05)", padding:"2px 8px", borderRadius:99, fontWeight:600 }}>
                      {STATUS_LABEL[e.sessionInfo.status] || e.sessionInfo.status}
                    </span>
                  )}
                  <span style={{ fontSize:12, color:"#aaa" }}>👤 {e.userEmail || "(sin correo)"}</span>
                  <span style={{ fontSize:10, color:"#555", fontFamily:"'IBM Plex Mono', monospace" }}>ID: {e.docId}</span>
                  <span style={{ flex:1, fontSize:11, color:"#555" }}>{changeKeys.length} campo{changeKeys.length !== 1 ? "s" : ""} cambiado{changeKeys.length !== 1 ? "s" : ""}</span>
                  <span style={{ fontSize:11, color:"#00d4aa", fontFamily:"'IBM Plex Mono', monospace" }}>{e.timestamp ? new Date(e.timestamp).toLocaleString("es-MX") : ""}</span>
                  <span style={{ color:"#555" }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {isOpen && (
                  <div style={{ padding:"0 16px 14px", display:"flex", flexDirection:"column", gap:6 }}>
                    <div style={{ fontSize:11, color:"#555" }}>ID del documento: <span style={{ color:"#888", fontFamily:"'IBM Plex Mono', monospace" }}>{e.docId}</span></div>
                    <div style={{ fontSize:11, color:"#555", marginTop:4 }}>Campos modificados:</div>
                    {changeKeys.map(k => (
                      <div key={k} style={{ padding:"8px 10px", borderRadius:8, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)" }}>
                        <div style={{ fontSize:11, color:"#ffb347", marginBottom:3 }}>{FIELD_LABELS[k] || k}</div>
                        <div style={{ fontSize:11, color:"#ccc", wordBreak:"break-word", fontFamily: typeof e.changes[k] === "object" ? "'IBM Plex Mono', monospace" : "inherit" }}>
                          {formatValue(e.changes[k])}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
