import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

const PATIENT_STATUS = {
  activo:      { label:"Activo",      color:"#1D9E75" },
  alta:        { label:"Alta",        color:"#4fc3f7" },
  suspendido:  { label:"Suspendido",  color:"#ffb347" },
  institucion: { label:"Institución", color:"#AFA9EC" },
  defuncion:   { label:"Defunción",   color:"#ff6b6b" },
};

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

function normalize(str) {
  return str?.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "").trim() || "";
}

function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const words = nb.split(" ");
  const matches = words.filter(w => w.length > 2 && na.includes(w)).length;
  return matches / words.length;
}

async function fetchAllSessions(token) {
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
          { fieldPath: "date" }, { fieldPath: "cycle" },
        ]},
        orderBy: [{ field: { fieldPath: "date" }, direction: "DESCENDING" }],
        limit: 500,
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

async function fetchPatientCatalog(token) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "patients" }], limit: 500 } })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

async function savePatientStatus(token, patientName, status) {
  const toFV = (val) => ({ stringValue: val });
  // Buscar si ya existe
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "patients" }],
        where: { fieldFilter: { field: { fieldPath: "name" }, op: "EQUAL", value: { stringValue: patientName } } },
        limit: 1,
      }
    })
  });
  const data = await res.json();
  const existing = data.find(d => d.document);

  if (existing) {
    // Actualizar
    const docId = existing.document.name.split("/").pop();
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/patients/${docId}?updateMask.fieldPaths=status`,
      { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: { status: toFV(status) } }) }
    );
  } else {
    // Crear nuevo
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/patients?key=${API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: { name: toFV(patientName), status: toFV(status) } }) }
    );
  }
}

async function updateSessionField(token, sessionId, field, value) {
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions/${sessionId}?updateMask.fieldPaths=${field}`,
    { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ fields: { [field]: { stringValue: value } } }) }
  );
}

async function bulkUpdate(token, sessions, field, oldValue, newValue) {
  const targets = sessions.filter(s => s[field] === oldValue);
  for (const s of targets) await updateSessionField(token, s.id, field, newValue);
  return targets.length;
}

function groupSimilar(items, key) {
  const groups = [];
  items.forEach(item => {
    const val = item[key];
    if (!val) return;
    const existing = groups.find(g => similarity(g.canonical, val) > 0.75);
    if (existing) {
      if (!existing.variants.includes(val)) existing.variants.push(val);
      existing.count += 1;
      if (!existing.sessions) existing.sessions = [];
      existing.sessions.push(item);
    } else {
      groups.push({ canonical: val, variants: [val], count: 1, sessions: [item] });
    }
  });
  return groups.sort((a, b) => b.count - a.count);
}

function PatientCatalogSection({ groups, sessions, token, patientStatuses, onRefresh, centerFilter }) {
  const [editing, setEditing]   = useState(null);
  const [newName, setNewName]   = useState("");
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState("");
  const [expanded, setExpanded] = useState(null);
  const [editingData, setEditingData] = useState(null);
const [editDraft, setEditDraft] = useState({ dob:"", diagnosis:"", physician:"" });

const handleDataEdit = async (patientName, draft) => {
  try {
    const targets = sessions.filter(s => s.patientName === patientName);
    for (const s of targets) {
      if (draft.dob && draft.dob !== s.dob) await updateSessionField(token, s.id, "dob", draft.dob);
      if (draft.diagnosis && draft.diagnosis !== s.diagnosis) await updateSessionField(token, s.id, "diagnosis", draft.diagnosis);
      if (draft.physician && draft.physician !== s.physician) await updateSessionField(token, s.id, "physician", draft.physician);
    }
    setEditingData(null);
    onRefresh();
  } catch(e) { alert("Error: " + e.message); }
};

  const filtered = groups.filter(g => {
    if (centerFilter !== "Todos") {
      const hasSessions = (g.sessions||[]).some(s => s.center === centerFilter);
      if (!hasSessions) return false;
    }
    if (!search) return true;
    return normalize(g.canonical).includes(normalize(search)) ||
           g.variants.some(v => normalize(v).includes(normalize(search)));
  });

  const handleEdit = async (oldVal) => {
    if (!newName.trim() || newName === oldVal) { setEditing(null); return; }
    setSaving(true);
    try {
      const count = await bulkUpdate(token, sessions, "patientName", oldVal, newName.trim());
      alert(`✓ Actualizado en ${count} sesión${count !== 1 ? "es" : ""}`);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
    finally { setSaving(false); setEditing(null); setNewName(""); }
  };

  const handleMerge = async (fromVal, toVal) => {
    if (!confirm(`¿Fusionar "${fromVal}" → "${toVal}"?`)) return;
    setSaving(true);
    try {
      const count = await bulkUpdate(token, sessions, "patientName", fromVal, toVal);
      alert(`✓ Fusionado en ${count} sesión${count !== 1 ? "es" : ""}`);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  const handleStatusChange = async (patientName, status) => {
    try {
      await savePatientStatus(token, patientName, status);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
  };

  return (
    <div>
      <input placeholder="Buscar paciente..." value={search} onChange={e => setSearch(e.target.value)}
        style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"9px 13px", color:"#f0f0f0", fontSize:13, outline:"none", marginBottom:12 }} />

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {filtered.map((g, i) => {
          const isEditing   = editing === g.canonical;
          const isExpanded  = expanded === g.canonical;
          const status      = patientStatuses[g.canonical] || "activo";
          const statusMeta  = PATIENT_STATUS[status] || PATIENT_STATUS.activo;
          const hasDups     = g.variants.length > 1;
          const patientSessions = (g.sessions||[]).sort((a,b) => (b.date||"").localeCompare(a.date||""));

          return (
            <div key={i} style={{ background:"rgba(255,255,255,0.03)", border:`1px solid ${hasDups ? "rgba(255,179,71,0.25)" : "rgba(255,255,255,0.07)"}`, borderRadius:12, overflow:"hidden" }}>
              <div onClick={() => setExpanded(isExpanded ? null : g.canonical)} style={{ padding:"14px 16px", cursor:"pointer", display:"flex", alignItems:"flex-start", gap:12 }}>
                <div style={{ flex:1 }}>
                  {isEditing ? (
                    <div style={{ display:"flex", gap:8 }} onClick={e => e.stopPropagation()}>
                      <input value={newName} onChange={e => setNewName(e.target.value)} autoFocus
                        style={{ flex:1, background:"rgba(255,255,255,0.07)", border:"1px solid rgba(0,212,170,0.4)", borderRadius:8, padding:"7px 12px", color:"#f0f0f0", fontSize:13, outline:"none" }} />
                      <button onClick={() => handleEdit(g.canonical)} disabled={saving} style={{ padding:"7px 14px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(29,158,117,0.15)", border:"1px solid rgba(29,158,117,0.4)", color:"#1D9E75" }}>✓</button>
                      <button onClick={() => { setEditing(null); setNewName(""); }} style={{ padding:"7px 12px", borderRadius:8, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", color:"#666" }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                      <span style={{ fontSize:14, color:"#f0f0f0", fontWeight:600 }}>{g.canonical}</span>
                      <span style={{ fontSize:11, padding:"2px 10px", borderRadius:99, background:`${statusMeta.color}18`, color:statusMeta.color, border:`1px solid ${statusMeta.color}44` }}>{statusMeta.label}</span>
                      {hasDups && <span style={{ fontSize:10, color:"#ffb347" }}>⚠ {g.variants.length} variantes</span>}
                    </div>
                  )}
                  <div style={{ fontSize:11, color:"#555", marginTop:4 }}>{g.count} sesión{g.count !== 1 ? "es" : ""}</div>
                </div>
                <div style={{ display:"flex", gap:6, flexShrink:0 }} onClick={e => e.stopPropagation()}>
                  <button onClick={() => { setEditing(g.canonical); setNewName(g.canonical); }}
                    style={{ padding:"5px 10px", borderRadius:8, fontSize:11, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#666" }}>✏️</button>
                  <span style={{ color:"#555", fontSize:12, padding:"5px 4px" }}>{isExpanded?"▲":"▼"}</span>
                </div>
              </div>

              {isExpanded && (
                <div style={{ padding:"0 16px 16px", borderTop:"1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ paddingTop:12, display:"flex", flexDirection:"column", gap:12 }}>

                    {/* Datos del paciente */}
{(() => {
  const sample = patientSessions[0] || {};
  const isEditingData = editingData === g.canonical;
  const [draft, setDraftLocal] = [editDraft, setEditDraft];

  if (!isEditingData) {
    return (
      <div style={{ padding:"10px 14px", borderRadius:10, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
            {sample.dob && (
              <div>
                <div style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1 }}>Fecha de nacimiento</div>
                <div style={{ fontSize:13, color:"#aaa", fontFamily:"'IBM Plex Mono', monospace", marginTop:2 }}>
                  {sample.dob}
                  {(() => {
                    try {
                      const [y,m,d] = sample.dob.split("-").map(Number);
                      const today = new Date();
                      let age = today.getFullYear() - y;
                      if (today.getMonth()+1 < m || (today.getMonth()+1 === m && today.getDate() < d)) age--;
                      return <span style={{ fontSize:11, color:"#666", marginLeft:8 }}>{age} años</span>;
                    } catch(e) { return null; }
                  })()}
                </div>
              </div>
            )}
            {sample.diagnosis && (
              <div>
                <div style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1 }}>Diagnóstico</div>
                <div style={{ fontSize:13, color:"#aaa", marginTop:2 }}>{sample.diagnosis}</div>
              </div>
            )}
            {sample.physician && (
              <div>
                <div style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1 }}>Médico tratante</div>
                <div style={{ fontSize:13, color:"#aaa", marginTop:2 }}>{sample.physician}</div>
              </div>
            )}
          </div>
          <button onClick={() => { setEditingData(g.canonical); setEditDraft({ dob:sample.dob||"", diagnosis:sample.diagnosis||"", physician:sample.physician||"" }); }}
            style={{ padding:"4px 10px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347", flexShrink:0 }}>✏️ Editar</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:"12px 14px", borderRadius:10, background:"rgba(255,179,71,0.05)", border:"1px solid rgba(255,179,71,0.2)" }}>
      <div style={{ fontSize:11, color:"#ffb347", fontWeight:600, marginBottom:10 }}>✏️ Editar datos del paciente</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:10 }}>
        <div>
          <label style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:4 }}>Fecha de nacimiento</label>
          <input type="date" value={draft.dob} onChange={e => setEditDraft(d=>({...d,dob:e.target.value}))}
            style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"7px 10px", color:"#f0f0f0", fontSize:12, outline:"none" }} />
        </div>
        <div>
          <label style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:4 }}>Diagnóstico</label>
          <input value={draft.diagnosis} onChange={e => setEditDraft(d=>({...d,diagnosis:e.target.value}))}
            style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"7px 10px", color:"#f0f0f0", fontSize:12, outline:"none" }} />
        </div>
        <div>
          <label style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:4 }}>Médico tratante</label>
          <input value={draft.physician} onChange={e => setEditDraft(d=>({...d,physician:e.target.value}))}
            style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"7px 10px", color:"#f0f0f0", fontSize:12, outline:"none" }} />
        </div>
      </div>
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={() => handleDataEdit(g.canonical, draft)} style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(29,158,117,0.15)", border:"1px solid rgba(29,158,117,0.4)", color:"#1D9E75" }}>✓ Guardar cambios</button>
        <button onClick={() => setEditingData(null)} style={{ padding:"8px 16px", borderRadius:8, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#666" }}>Cancelar</button>
      </div>
    </div>
  );
})()}
                    
                    {/* Estatus */}
                    <div>
                      <div style={{ fontSize:11, color:"#555", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Estatus del paciente</div>
                      <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                        {Object.entries(PATIENT_STATUS).map(([k, v]) => (
                          <button key={k} onClick={() => handleStatusChange(g.canonical, k)} style={{
                            padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
                            background: status === k ? `${v.color}20` : "rgba(255,255,255,0.04)",
                            border:`1px solid ${status === k ? v.color : "rgba(255,255,255,0.07)"}`,
                            color: status === k ? v.color : "#666",
                          }}>{v.label}</button>
                        ))}
                      </div>
                    </div>

                    {/* Variantes duplicadas */}
                    {hasDups && (
                      <div>
                        <div style={{ fontSize:11, color:"#ffb347", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>⚠ Variantes similares</div>
                        {g.variants.filter(v => v !== g.canonical).map((v, j) => (
                          <div key={j} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                            <span style={{ fontSize:12, color:"#888", fontFamily:"'IBM Plex Mono', monospace" }}>{v}</span>
                            <button onClick={() => handleMerge(v, g.canonical)} style={{ fontSize:10, padding:"3px 8px", borderRadius:6, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>
                              Fusionar
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Sesiones del paciente */}
                    <div>
                      <div style={{ fontSize:11, color:"#555", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Sesiones registradas</div>
                      <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:200, overflowY:"auto" }}>
                        {patientSessions.map((s, j) => (
                          <div key={j} style={{ display:"flex", justifyContent:"space-between", padding:"7px 10px", borderRadius:8, background:"rgba(255,255,255,0.02)", fontSize:11 }}>
                            <span style={{ color:"#888", fontFamily:"'IBM Plex Mono', monospace" }}>{s.date}</span>
                            <span style={{ color:"#666" }}>{s.cycle}</span>
                            <span style={{ color:"#555" }}>{s.center}</span>
                            <span style={{ color:"#555" }}>{s.diagnosis}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CatalogSection({ title, icon, groups, field, sessions, token, onRefresh, centerFilter }) {
  const [editing, setEditing]   = useState(null);
  const [newName, setNewName]   = useState("");
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState("");

  const filtered = groups.filter(g => {
    if (centerFilter !== "Todos") {
      const hasSessions = (g.sessions||[]).some(s => s.center === centerFilter);
      if (!hasSessions) return false;
    }
    if (!search) return true;
    return normalize(g.canonical).includes(normalize(search)) ||
           g.variants.some(v => normalize(v).includes(normalize(search)));
  });

  const handleEdit = async (oldVal) => {
    if (!newName.trim() || newName === oldVal) { setEditing(null); return; }
    setSaving(true);
    try {
      const count = await bulkUpdate(token, sessions, field, oldVal, newName.trim());
      alert(`✓ Actualizado en ${count} sesión${count !== 1 ? "es" : ""}`);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
    finally { setSaving(false); setEditing(null); setNewName(""); }
  };

  const handleMerge = async (fromVal, toVal) => {
    if (!confirm(`¿Fusionar "${fromVal}" → "${toVal}"?`)) return;
    setSaving(true);
    try {
      const count = await bulkUpdate(token, sessions, field, fromVal, toVal);
      alert(`✓ Fusionado en ${count} sesión${count !== 1 ? "es" : ""}`);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <input placeholder={`Buscar en ${title.toLowerCase()}...`} value={search} onChange={e => setSearch(e.target.value)}
        style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"9px 13px", color:"#f0f0f0", fontSize:13, outline:"none", marginBottom:12 }} />

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {filtered.map((g, i) => {
          const isEditing  = editing === g.canonical;
          const hasDups    = g.variants.length > 1;

          return (
            <div key={i} style={{ background:"rgba(255,255,255,0.03)", border:`1px solid ${hasDups ? "rgba(255,179,71,0.25)" : "rgba(255,255,255,0.07)"}`, borderRadius:12, padding:"14px 16px" }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
                <div style={{ flex:1 }}>
                  {isEditing ? (
                    <div style={{ display:"flex", gap:8 }}>
                      <input value={newName} onChange={e => setNewName(e.target.value)} autoFocus
                        style={{ flex:1, background:"rgba(255,255,255,0.07)", border:"1px solid rgba(0,212,170,0.4)", borderRadius:8, padding:"7px 12px", color:"#f0f0f0", fontSize:13, outline:"none" }} />
                      <button onClick={() => handleEdit(g.canonical)} disabled={saving} style={{ padding:"7px 14px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(29,158,117,0.15)", border:"1px solid rgba(29,158,117,0.4)", color:"#1D9E75" }}>✓</button>
                      <button onClick={() => { setEditing(null); setNewName(""); }} style={{ padding:"7px 12px", borderRadius:8, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", color:"#666" }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ fontSize:14, color:"#f0f0f0", fontWeight:600 }}>{g.canonical}</div>
                  )}
                  <div style={{ fontSize:11, color:"#555", marginTop:4 }}>{g.count} sesión{g.count !== 1 ? "es" : ""}</div>
                  {hasDups && (
                    <div style={{ marginTop:6 }}>
                      <div style={{ fontSize:10, color:"#ffb347", letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>⚠ Variantes similares:</div>
                      {g.variants.filter(v => v !== g.canonical).map((v, j) => (
                        <div key={j} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                          <span style={{ fontSize:12, color:"#888", fontFamily:"'IBM Plex Mono', monospace" }}>{v}</span>
                          <button onClick={() => handleMerge(v, g.canonical)} style={{ fontSize:10, padding:"3px 8px", borderRadius:6, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>Fusionar</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {!isEditing && (
                  <button onClick={() => { setEditing(g.canonical); setNewName(g.canonical); }}
                    style={{ padding:"6px 12px", borderRadius:8, fontSize:11, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#666", flexShrink:0 }}>
                    ✏️ Editar
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Catalogo() {
  const { user } = useAuth();
  const [sessions, setSessions]         = useState([]);
  const [patientCatalog, setPatientCatalog] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [token, setToken]               = useState(null);
  const [tab, setTab]                   = useState("patients");
  const [centerFilter, setCenterFilter] = useState("Todos");

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const t = await user.getIdToken(true);
      setToken(t);
      const [data, catalog] = await Promise.all([fetchAllSessions(t), fetchPatientCatalog(t)]);
      setSessions(data);
      setPatientCatalog(catalog);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [user]);

  const filteredSessions  = centerFilter === "Todos" ? sessions : sessions.filter(s => s.center === centerFilter);
  const patientGroups     = groupSimilar(filteredSessions, "patientName");
  const physicianGroups   = groupSimilar(filteredSessions, "physician");
  const diagnosisGroups   = groupSimilar(filteredSessions, "diagnosis");

  // Mapa de estatus por nombre de paciente
  const patientStatuses = {};
  patientCatalog.forEach(p => { if (p.name) patientStatuses[p.name] = p.status || "activo"; });

  const tabs = [
    { id:"patients",   label:"Pacientes",   icon:"👤", count: patientGroups.filter(g => g.variants.length > 1).length },
    { id:"physicians", label:"Médicos",      icon:"🩺", count: physicianGroups.filter(g => g.variants.length > 1).length },
    { id:"diagnoses",  label:"Diagnósticos", icon:"📋", count: diagnosisGroups.filter(g => g.variants.length > 1).length },
  ];

  const duplicateCount = tabs.reduce((acc, t) => acc + t.count, 0);

  return (
    <div style={{ padding:"24px 28px", maxWidth:900, margin:"0 auto" }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Catálogo</h1>
        <p style={{ fontSize:13, color:"#555" }}>
          Gestiona pacientes, médicos y diagnósticos
          {duplicateCount > 0 && <span style={{ marginLeft:10, color:"#ffb347" }}>⚠ {duplicateCount} posible{duplicateCount !== 1 ? "s" : ""} duplicado{duplicateCount !== 1 ? "s" : ""}</span>}
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:"8px 18px", borderRadius:10, fontSize:13, fontWeight:600, cursor:"pointer",
            background: tab===t.id ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border:`1px solid ${tab===t.id ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.07)"}`,
            color: tab===t.id ? "#00d4aa" : "#666",
          }}>
            {t.icon} {t.label}
            {t.count > 0 && <span style={{ marginLeft:6, fontSize:10, color:"#ffb347" }}>{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Filtro por centro */}
      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
        {["Todos","CIPI","CITIO"].map(c => (
          <button key={c} onClick={() => setCenterFilter(c)} style={{
            padding:"5px 14px", borderRadius:99, fontSize:11, fontWeight:600, cursor:"pointer",
            background: centerFilter===c ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border:`1px solid ${centerFilter===c ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.07)"}`,
            color: centerFilter===c ? "#00d4aa" : "#666",
          }}>{c}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ color:"#555", fontSize:14, padding:24 }}>Cargando catálogo...</div>
      ) : (
        <>
          {tab === "patients" && (
            <PatientCatalogSection
              groups={patientGroups}
              sessions={sessions}
              token={token}
              patientStatuses={patientStatuses}
              onRefresh={load}
              centerFilter={centerFilter}
            />
          )}
          {tab === "physicians" && (
            <CatalogSection
              title="Médicos" icon="🩺"
              groups={physicianGroups} field="physician"
              sessions={sessions} token={token}
              onRefresh={load} centerFilter={centerFilter}
            />
          )}
          {tab === "diagnoses" && (
            <CatalogSection
              title="Diagnósticos" icon="📋"
              groups={diagnosisGroups} field="diagnosis"
              sessions={sessions} token={token}
              onRefresh={load} centerFilter={centerFilter}
            />
          )}
        </>
      )}
    </div>
  );
}
