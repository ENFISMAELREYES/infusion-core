import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { computeSessionMaterial, MASTER_CATALOG, MATERIAL_DEFAULTS, PUNCION_DEFAULTS } from "../data/materialCatalog";

const PROJECT_ID = "infusion-core";

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

function toFV(val) {
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return { integerValue: String(val) };
  if (val === null || val === undefined) return { nullValue: null };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
  if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFV(v)])) } };
  return { stringValue: String(val) };
}

async function fetchTodaySessions(token, date) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`,
    { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: "sessions" }],
        where: { fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: date } } },
        limit: 300,
      }})
    }
  );
  const data = await res.json();
  return (data.filter(d => d.document) || []).map(d => parseDoc(d.document));
}

async function fetchOverrides(token) {
  try {
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/settings/materialCatalog`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 404) return { extraCatalog: [], extraDefaults: {} };
    const doc = await res.json();
    const parsed = parseDoc(doc);
    return { extraCatalog: parsed.extraCatalog || [], extraDefaults: parsed.extraDefaults || {} };
  } catch (e) {
    return { extraCatalog: [], extraDefaults: {} };
  }
}

async function saveOverrides(token, data) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/settings/materialCatalog?${mask}`,
    { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) }
  );
}

const inputStyle = { width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"8px 10px", color:"#f0f0f0", fontSize:12, outline:"none" };
const labelStyle = { fontSize:10, color:"#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:5 };

export default function Insumos() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const [tab, setTab] = useState("consolidado");
  const [token, setToken] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [centerFilter, setCenterFilter] = useState("Todos");
  const [overrides, setOverrides] = useState({ extraCatalog: [], extraDefaults: {} });
  const [loading, setLoading] = useState(true);
  const [expandedPatient, setExpandedPatient] = useState(null);

  const [newCatItem, setNewCatItem] = useState("");
  const [newCatCategory, setNewCatCategory] = useState("Insumos");
  const [savingCat, setSavingCat] = useState(false);

  const [newMedName, setNewMedName] = useState("");
  const [newMedInsumos, setNewMedInsumos] = useState([]);
  const [newMedSoluciones, setNewMedSoluciones] = useState([]);
  const [draftItem, setDraftItem] = useState("");
  const [draftQty, setDraftQty] = useState("1");
  const [savingMed, setSavingMed] = useState(false);
  const [expandedMed, setExpandedMed] = useState(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState("Todos");

  useEffect(() => { user.getIdToken().then(setToken); }, [user]);
  useEffect(() => { if (token) load(); }, [token]);

  const load = async () => {
    setLoading(true);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
    const [s, ov] = await Promise.all([fetchTodaySessions(token, today), fetchOverrides(token)]);
    setSessions(s.filter(x => Array.isArray(x.meds) && x.meds.length > 0));
    setOverrides(ov);
    setLoading(false);
  };

  const filtered = centerFilter === "Todos" ? sessions : sessions.filter(s => s.center === centerFilter);
  const perPatient = filtered.map(s => ({
    session: s,
    material: computeSessionMaterial(s, { extraDefaults: overrides.extraDefaults, extraCatalog: overrides.extraCatalog }),
  }));

  const grandTotal = {};
  perPatient.forEach(({ material }) => {
    material.items.forEach(({ item, qty }) => { grandTotal[item] = (grandTotal[item] || 0) + qty; });
  });
  const grandTotalList = Object.entries(grandTotal).map(([item, qty]) => ({ item, qty })).sort((a,b) => a.item.localeCompare(b.item));

  const addCatalogItem = async () => {
    if (!newCatItem.trim()) return;
    setSavingCat(true);
    try {
      const updated = [...overrides.extraCatalog, { category: newCatCategory, item: newCatItem.trim() }];
      await saveOverrides(token, { extraCatalog: updated });
      setOverrides(o => ({ ...o, extraCatalog: updated }));
      setNewCatItem("");
    } finally { setSavingCat(false); }
  };

  const removeCatalogItem = async (idx) => {
    const updated = overrides.extraCatalog.filter((_, i) => i !== idx);
    await saveOverrides(token, { extraCatalog: updated });
    setOverrides(o => ({ ...o, extraCatalog: updated }));
  };

  const addDraftRow = (list, setList) => {
    if (!draftItem.trim()) return;
    setList(prev => [...prev, { item: draftItem.trim(), qty: parseInt(draftQty) || 1 }]);
    setDraftItem(""); setDraftQty("1");
  };

  const saveMedDefault = async () => {
    if (!newMedName.trim() || (newMedInsumos.length === 0 && newMedSoluciones.length === 0)) return;
    setSavingMed(true);
    try {
      const key = newMedName.trim().toUpperCase();
      const updated = { ...overrides.extraDefaults, [key]: { insumos: newMedInsumos, soluciones: newMedSoluciones } };
      await saveOverrides(token, { extraDefaults: updated });
      setOverrides(o => ({ ...o, extraDefaults: updated }));
      setNewMedName(""); setNewMedInsumos([]); setNewMedSoluciones([]);
    } finally { setSavingMed(false); }
  };

  const removeMedDefault = async (key) => {
    const updated = { ...overrides.extraDefaults };
    delete updated[key];
    await saveOverrides(token, { extraDefaults: updated });
    setOverrides(o => ({ ...o, extraDefaults: updated }));
  };

  if (loading) return <div style={{ padding:40, color:"#666", textAlign:"center" }}>Cargando…</div>;

  return (
    <div style={{ padding:"24px 28px", maxWidth:820, margin:"0 auto" }}>
      <div style={{ marginBottom:20 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Insumos</h1>
        <p style={{ fontSize:13, color:"#555" }}>Solicitud de material consolidada y catálogo</p>
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
        {[["consolidado","📋 Consolidado del día"],["catalogo","⚙️ Catálogo"]].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding:"8px 16px", borderRadius:10, fontSize:13, fontWeight:600, cursor:"pointer",
            background: tab===id ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${tab===id ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.08)"}`,
            color: tab===id ? "#00d4aa" : "#666",
          }}>{label}</button>
        ))}
      </div>

      {tab === "consolidado" && (
        <div>
          <div style={{ display:"flex", gap:8, marginBottom:16 }}>
            {["Todos","CITIO","CIPI"].map(c => (
              <button key={c} onClick={() => setCenterFilter(c)} style={{
                padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
                background: centerFilter===c ? "rgba(79,195,247,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${centerFilter===c ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: centerFilter===c ? "#4fc3f7" : "#666",
              }}>{c}</button>
            ))}
            <span style={{ marginLeft:"auto", fontSize:12, color:"#555", alignSelf:"center" }}>{perPatient.length} paciente{perPatient.length!==1?"s":""} hoy</span>
          </div>

          <div style={{ background:"rgba(0,212,170,0.05)", border:"1px solid rgba(0,212,170,0.2)", borderRadius:14, padding:16, marginBottom:20 }}>
            <div style={{ fontSize:13, color:"#00d4aa", fontWeight:600, marginBottom:10 }}>Total consolidado ({grandTotalList.length} artículos)</div>
            <div style={{ maxHeight:280, overflowY:"auto", display:"flex", flexDirection:"column", gap:4 }}>
              {grandTotalList.map((t,i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 10px", borderRadius:7, background:"rgba(255,255,255,0.03)", fontSize:12 }}>
                  <span style={{ color:"#ccc" }}>{t.item}</span>
                  <span style={{ color:"#00d4aa", fontFamily:"'IBM Plex Mono', monospace", fontWeight:600 }}>{t.qty}</span>
                </div>
              ))}
              {grandTotalList.length === 0 && <div style={{ fontSize:12, color:"#444", textAlign:"center", padding:16 }}>Sin sesiones con medicamentos hoy.</div>}
            </div>
          </div>

          <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>Por paciente</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {perPatient.map(({ session: s, material }, i) => (
              <div key={i} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
                <div onClick={() => setExpandedPatient(p => p===i ? null : i)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:11, color:"#666", background:"rgba(255,255,255,0.05)", padding:"2px 8px", borderRadius:99 }}>{s.center}</span>
                  <span style={{ flex:1, fontSize:13, color:"#f0f0f0", fontWeight:600 }}>{s.patientName}</span>
                  <span style={{ fontSize:11, color:"#555" }}>{material.items.length} art.</span>
                  {material.unmatched.length > 0 && <span style={{ fontSize:11, color:"#ffb347" }}>⚠️ {material.unmatched.length}</span>}
                  <span style={{ color:"#555" }}>{expandedPatient===i ? "▲" : "▼"}</span>
                </div>
                {expandedPatient===i && (
                  <div style={{ padding:"0 16px 14px", display:"flex", flexDirection:"column", gap:4 }}>
                    {material.unmatched.length > 0 && (
                      <div style={{ fontSize:11, color:"#ffb347", marginBottom:6 }}>Sin material por defecto: {material.unmatched.join(", ")}</div>
                    )}
                    {material.items.map((t,ti) => (
                      <div key={ti} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", padding:"3px 0" }}>
                        <span>{t.item}</span><span style={{ color:"#00d4aa" }}>{t.qty}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "catalogo" && (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          {!isJefe && (
            <div style={{ fontSize:12, color:"#ffb347", padding:"10px 14px", background:"rgba(255,179,71,0.08)", border:"1px solid rgba(255,179,71,0.25)", borderRadius:10 }}>
              Solo el jefe puede editar el catálogo. Aquí puedes consultarlo.
            </div>
          )}

          <div>
            <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>+ Agregar artículo al catálogo</div>
            {isJefe && (
              <div style={{ display:"flex", gap:8, marginBottom:10 }}>
                <select value={newCatCategory} onChange={e => setNewCatCategory(e.target.value)} style={{ ...inputStyle, flex:"0 0 160px" }}>
                  <option>Insumos</option><option>Medicamentos</option><option>Oncológicos</option><option>Inmunoterapia</option>
                </select>
                <input value={newCatItem} onChange={e => setNewCatItem(e.target.value)} placeholder="Nombre del artículo..." style={inputStyle} />
                <button onClick={addCatalogItem} disabled={savingCat} style={{ padding:"8px 16px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa", whiteSpace:"nowrap" }}>
                  {savingCat ? "..." : "+ Agregar"}
                </button>
              </div>
            )}
            <div style={{ maxHeight:180, overflowY:"auto", display:"flex", flexDirection:"column", gap:4 }}>
              {overrides.extraCatalog.map((c,i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", borderRadius:7, background:"rgba(255,255,255,0.03)", fontSize:11 }}>
                  <span style={{ color:"#555", flexShrink:0 }}>{c.category}</span>
                  <span style={{ flex:1, color:"#ccc" }}>{c.item}</span>
                  {isJefe && <button onClick={() => removeCatalogItem(i)} style={{ padding:"2px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>✕</button>}
                </div>
              ))}
              {overrides.extraCatalog.length === 0 && <div style={{ fontSize:11, color:"#444" }}>Sin artículos agregados todavía (además de los {MASTER_CATALOG.length} de fábrica).</div>}
            </div>
          </div>

          {isJefe && (
            <div>
              <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>+ Definir material por defecto de un medicamento</div>
              <div style={{ display:"flex", flexDirection:"column", gap:10, padding:14, borderRadius:12, background:"rgba(175,169,236,0.05)", border:"1px solid rgba(175,169,236,0.15)" }}>
                <div>
                  <label style={labelStyle}>Nombre del medicamento</label>
                  <input value={newMedName} onChange={e => setNewMedName(e.target.value)} placeholder="ej: TRASTUZUMAB" style={inputStyle} />
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <input value={draftItem} onChange={e => setDraftItem(e.target.value)} placeholder="Nombre del insumo/solución..." style={inputStyle} />
                  <input type="number" min="1" value={draftQty} onChange={e => setDraftQty(e.target.value)} style={{ ...inputStyle, width:70 }} />
                  <button onClick={() => addDraftRow(newMedInsumos, setNewMedInsumos)} style={{ padding:"8px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#ccc", whiteSpace:"nowrap" }}>+ Insumo</button>
                  <button onClick={() => addDraftRow(newMedSoluciones, setNewMedSoluciones)} style={{ padding:"8px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(79,195,247,0.1)", border:"1px solid rgba(79,195,247,0.25)", color:"#4fc3f7", whiteSpace:"nowrap" }}>+ Solución</button>
                </div>
                {newMedInsumos.length > 0 && (
                  <div>
                    <div style={{ fontSize:10, color:"#666", marginBottom:4 }}>INSUMOS</div>
                    {newMedInsumos.map((r,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#ccc", padding:"3px 0" }}>
                        <span>{r.item}</span>
                        <span style={{ display:"flex", gap:8, alignItems:"center" }}>{r.qty}
                          <button onClick={() => setNewMedInsumos(prev => prev.filter((_,pi)=>pi!==i))} style={{ color:"#ff6b6b", background:"none", border:"none", cursor:"pointer", fontSize:11 }}>✕</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {newMedSoluciones.length > 0 && (
                  <div>
                    <div style={{ fontSize:10, color:"#666", marginBottom:4 }}>SOLUCIONES</div>
                    {newMedSoluciones.map((r,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#4fc3f7", padding:"3px 0" }}>
                        <span>{r.item}</span>
                        <span style={{ display:"flex", gap:8, alignItems:"center" }}>{r.qty}
                          <button onClick={() => setNewMedSoluciones(prev => prev.filter((_,pi)=>pi!==i))} style={{ color:"#ff6b6b", background:"none", border:"none", cursor:"pointer", fontSize:11 }}>✕</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={saveMedDefault} disabled={savingMed} style={{ padding:"9px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"linear-gradient(135deg,#AFA9EC,#8B7FD8)", border:"none", color:"#fff" }}>
                  {savingMed ? "Guardando…" : "✓ Guardar medicamento"}
                </button>
              </div>
            </div>
          )}

          <div>
            <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>
              Catálogo maestro ({MASTER_CATALOG.length + overrides.extraCatalog.length} artículos)
            </div>
            <div style={{ display:"flex", gap:8, marginBottom:10 }}>
              <input value={catalogSearch} onChange={e => setCatalogSearch(e.target.value)} placeholder="Buscar artículo..." style={inputStyle} />
              <select value={catalogCategoryFilter} onChange={e => setCatalogCategoryFilter(e.target.value)} style={{ ...inputStyle, flex:"0 0 160px" }}>
                <option>Todos</option><option>Insumos</option><option>Medicamentos</option><option>Oncológicos</option><option>Inmunoterapia</option>
              </select>
            </div>
            {(() => {
              const all = [...MASTER_CATALOG, ...overrides.extraCatalog];
              const term = catalogSearch.trim().toUpperCase();
              const shown = all
                .filter(c => catalogCategoryFilter === "Todos" || c.category === catalogCategoryFilter)
                .filter(c => !term || c.item.toUpperCase().includes(term))
                .slice(0, 100);
              return (
                <div style={{ maxHeight:260, overflowY:"auto", display:"flex", flexDirection:"column", gap:3, padding:"4px 0" }}>
                  {shown.map((c,i) => (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 10px", borderRadius:6, background:"rgba(255,255,255,0.02)", fontSize:11 }}>
                      <span style={{ color:"#555", flexShrink:0, width:90 }}>{c.category}</span>
                      <span style={{ flex:1, color:"#ccc" }}>{c.item}</span>
                    </div>
                  ))}
                  {shown.length === 0 && <div style={{ fontSize:11, color:"#444", padding:10 }}>Sin resultados.</div>}
                  {(term || catalogCategoryFilter !== "Todos") && shown.length === 100 && (
                    <div style={{ fontSize:10, color:"#444", padding:"4px 10px" }}>Mostrando los primeros 100 — afina la búsqueda para ver más específico.</div>
                  )}
                </div>
              );
            })()}
          </div>

          <div>
            <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>
              Medicamentos con material definido ({Object.keys(MATERIAL_DEFAULTS).length + Object.keys(overrides.extraDefaults).length})
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
              {[
                ...Object.keys(MATERIAL_DEFAULTS).map(key => ({ key, entry: MATERIAL_DEFAULTS[key], factory:true })),
                ...Object.entries(overrides.extraDefaults).map(([key, entry]) => ({ key, entry, factory:false })),
              ].sort((a,b) => a.key.localeCompare(b.key)).map(({ key, entry, factory }) => (
                <div key={key} style={{ borderRadius:8, background: factory ? "rgba(255,255,255,0.03)" : "rgba(175,169,236,0.06)", overflow:"hidden" }}>
                  <div onClick={() => setExpandedMed(m => m===key ? null : key)} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", cursor:"pointer" }}>
                    {!factory && <span style={{ fontSize:9, color:"#AFA9EC", background:"rgba(175,169,236,0.15)", padding:"1px 6px", borderRadius:99 }}>TUYO</span>}
                    <span style={{ flex:1, fontSize:12, color:"#ccc" }}>{key}</span>
                    <span style={{ fontSize:10, color:"#555" }}>{(entry.insumos||[]).length + (entry.soluciones||[]).length} art.</span>
                    {!factory && isJefe && (
                      <button onClick={e => { e.stopPropagation(); removeMedDefault(key); }} style={{ padding:"2px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>✕</button>
                    )}
                    <span style={{ color:"#555", fontSize:10 }}>{expandedMed===key ? "▲" : "▼"}</span>
                  </div>
                  {expandedMed===key && (
                    <div style={{ padding:"0 10px 10px 10px" }}>
                      {(entry.insumos||[]).length > 0 && (
                        <>
                          <div style={{ fontSize:9, color:"#666", marginTop:4 }}>INSUMOS</div>
                          {entry.insumos.map((r,i) => (
                            <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", padding:"2px 0" }}>
                              <span>{r.item}</span><span>{r.qty}</span>
                            </div>
                          ))}
                        </>
                      )}
                      {(entry.soluciones||[]).length > 0 && (
                        <>
                          <div style={{ fontSize:9, color:"#666", marginTop:6 }}>SOLUCIONES</div>
                          {entry.soluciones.map((r,i) => (
                            <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#4fc3f7", padding:"2px 0" }}>
                              <span>{r.item}</span><span>{r.qty}</span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>Material de punción (acceso venoso)</div>
            <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
              {Object.entries(PUNCION_DEFAULTS).map(([key, entry]) => (
                <div key={key} style={{ borderRadius:8, background:"rgba(255,255,255,0.03)", overflow:"hidden" }}>
                  <div onClick={() => setExpandedMed(m => m===`punc_${key}` ? null : `punc_${key}`)} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", cursor:"pointer" }}>
                    <span style={{ flex:1, fontSize:12, color:"#ccc", textTransform:"capitalize" }}>{key}</span>
                    <span style={{ fontSize:10, color:"#555" }}>{(entry.insumos||[]).length + (entry.soluciones||[]).length + (entry.alternativas||[]).length} art.</span>
                    <span style={{ color:"#555", fontSize:10 }}>{expandedMed===`punc_${key}` ? "▲" : "▼"}</span>
                  </div>
                  {expandedMed===`punc_${key}` && (
                    <div style={{ padding:"0 10px 10px 10px" }}>
                      <div style={{ fontSize:9, color:"#666", marginTop:4 }}>INSUMOS</div>
                      {(entry.insumos||[]).map((r,i) => (
                        <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", padding:"2px 0" }}>
                          <span>{r.item}</span><span>{r.qty}</span>
                        </div>
                      ))}
                      {(entry.alternativas||[]).map((alt,ai) => (
                        <div key={ai}>
                          <div style={{ fontSize:9, color:"#ffb347", marginTop:6 }}>{alt.label.toUpperCase()} (elegible)</div>
                          {alt.options.map((o,oi) => (
                            <div key={oi} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#ffb347", padding:"2px 0" }}>
                              <span>{o.item}</span><span>{o.qty}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                      <div style={{ fontSize:9, color:"#666", marginTop:6 }}>SOLUCIONES</div>
                      {(entry.soluciones||[]).map((r,i) => (
                        <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#4fc3f7", padding:"2px 0" }}>
                          <span>{r.item}</span><span>{r.qty}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
