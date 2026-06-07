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
        ]},
        limit: 500,
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

async function updateSessionField(token, sessionId, field, value) {
  const toFV = (val) => {
    if (typeof val === "string") return { stringValue: val };
    return { stringValue: String(val) };
  };
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions/${sessionId}?updateMask.fieldPaths=${field}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ fields: { [field]: toFV(value) } }),
    }
  );
}

async function bulkUpdate(token, sessions, field, oldValue, newValue) {
  const targets = sessions.filter(s => s[field] === oldValue);
  for (const s of targets) {
    await updateSessionField(token, s.id, field, newValue);
  }
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
    } else {
      groups.push({ canonical: val, variants: [val], count: 1 });
    }
  });
  return groups.sort((a, b) => b.count - a.count);
}

function CatalogSection({ title, icon, groups, field, sessions, token, onRefresh }) {
  const [editing, setEditing] = useState(null);
  const [newName, setNewName] = useState("");
  const [mergeTarget, setMergeTarget] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [search, setSearch]   = useState("");

  const filtered = groups.filter(g =>
    normalize(g.canonical).includes(normalize(search)) ||
    g.variants.some(v => normalize(v).includes(normalize(search)))
  );

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
    if (!confirm(`¿Fusionar "${fromVal}" → "${toVal}"?\n\nTodas las sesiones con "${fromVal}" se actualizarán a "${toVal}".`)) return;
    setSaving(true);
    try {
      const count = await bulkUpdate(token, sessions, field, fromVal, toVal);
      alert(`✓ Fusionado en ${count} sesión${count !== 1 ? "es" : ""}`);
      onRefresh();
    } catch(e) { alert("Error: " + e.message); }
    finally { setSaving(false); setMergeTarget(null); }
  };

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 18, color: "#fff" }}>{title}</h2>
        <span style={{ fontSize: 12, color: "#555", background: "rgba(255,255,255,0.04)", padding: "2px 10px", borderRadius: 99 }}>{groups.length} entradas</span>
      </div>

      <input placeholder={`Buscar en ${title.toLowerCase()}...`} value={search} onChange={e => setSearch(e.target.value)}
        style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 9, padding: "9px 13px", color: "#f0f0f0", fontSize: 13, outline: "none", marginBottom: 12 }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map((g, i) => {
          const hasDuplicates = g.variants.length > 1;
          const isEditing = editing === g.canonical;
          const isMerging = mergeTarget === g.canonical;

          return (
            <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${hasDuplicates ? "rgba(255,179,71,0.25)" : "rgba(255,255,255,0.07)"}`, borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  {isEditing ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input value={newName} onChange={e => setNewName(e.target.value)} autoFocus
                        style={{ flex: 1, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(0,212,170,0.4)", borderRadius: 8, padding: "7px 12px", color: "#f0f0f0", fontSize: 13, outline: "none" }} />
                      <button onClick={() => handleEdit(g.canonical)} disabled={saving} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(29,158,117,0.15)", border: "1px solid rgba(29,158,117,0.4)", color: "#1D9E75" }}>✓</button>
                      <button onClick={() => { setEditing(null); setNewName(""); }} style={{ padding: "7px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#666" }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 14, color: "#f0f0f0", fontWeight: 600 }}>{g.canonical}</div>
                  )}
                  <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>{g.count} sesión{g.count !== 1 ? "es" : ""}</div>
                  {hasDuplicates && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 10, color: "#ffb347", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>⚠ Variantes similares:</div>
                      {g.variants.filter(v => v !== g.canonical).map((v, j) => (
                        <div key={j} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 12, color: "#888", fontFamily: "'IBM Plex Mono', monospace" }}>{v}</span>
                          <button onClick={() => handleMerge(v, g.canonical)} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, cursor: "pointer", background: "rgba(255,179,71,0.1)", border: "1px solid rgba(255,179,71,0.25)", color: "#ffb347" }}>
                            Fusionar → {g.canonical.split(" ")[0]}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {!isEditing && (
                  <button onClick={() => { setEditing(g.canonical); setNewName(g.canonical); }}
                    style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#666", flexShrink: 0 }}>
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
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [token, setToken]       = useState(null);
 const [centerFilter, setCenterFilter] = useState("Todos");
const [tab, setTab] = useState("patients");
  
  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const t = await user.getIdToken(true);
      setToken(t);
      const data = await fetchAllSessions(t);
      setSessions(data);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [user]);

  const filteredSessions = centerFilter === "Todos" ? sessions : sessions.filter(s => s.center === centerFilter);
const patientGroups   = groupSimilar(filteredSessions, "patientName");
const physicianGroups = groupSimilar(filteredSessions, "physician");
const diagnosisGroups = groupSimilar(filteredSessions, "diagnosis");

  const tabs = [
    { id: "patients",   label: "Pacientes",   icon: "👤", groups: patientGroups,   field: "patientName" },
    { id: "physicians", label: "Médicos",      icon: "🩺", groups: physicianGroups, field: "physician" },
    { id: "diagnoses",  label: "Diagnósticos", icon: "📋", groups: diagnosisGroups, field: "diagnosis" },
  ];

  const current = tabs.find(t => t.id === tab);

  const duplicateCount = tabs.reduce((acc, t) => acc + t.groups.filter(g => g.variants.length > 1).length, 0);

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#fff", marginBottom: 4 }}>Catálogo</h1>
        <p style={{ fontSize: 13, color: "#555" }}>
          Gestiona pacientes, médicos y diagnósticos
          {duplicateCount > 0 && <span style={{ marginLeft: 10, color: "#ffb347" }}>⚠ {duplicateCount} posible{duplicateCount !== 1 ? "s" : ""} duplicado{duplicateCount !== 1 ? "s" : ""}</span>}
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "8px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: tab === t.id ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${tab === t.id ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.07)"}`,
            color: tab === t.id ? "#00d4aa" : "#666",
          }}>
            {t.icon} {t.label}
            {t.groups.filter(g => g.variants.length > 1).length > 0 && (
              <span style={{ marginLeft: 6, fontSize: 10, color: "#ffb347" }}>
                {t.groups.filter(g => g.variants.length > 1).length}
              </span>
            )}
          </button>
        ))}
      </div>
      {/* Filtro por centro */}
<div style={{ display:"flex", gap:8, marginBottom:16 }}>
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
        <div style={{ color: "#555", fontSize: 14, padding: 24 }}>Cargando catálogo...</div>
      ) : (
        <CatalogSection
          key={current.id}
          title={current.label}
          icon={current.icon}
          groups={current.groups}
          field={current.field}
          sessions={sessions}
          token={token}
          onRefresh={load}
        />
      )}
    </div>
  );
}
