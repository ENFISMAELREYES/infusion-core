import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { computeSessionMaterial, computeMedicationPieces, MASTER_CATALOG, MATERIAL_DEFAULTS, PUNCION_DEFAULTS } from "../data/materialCatalog";

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

async function fetchUpcomingSessions(token, fromDate) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`,
    { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: "sessions" }],
        where: { fieldFilter: { field: { fieldPath: "date" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: fromDate } } },
        orderBy: [{ field: { fieldPath: "date" }, direction: "ASCENDING" }],
        limit: 500,
      }})
    }
  );
  const data = await res.json();
  return (data.filter(d => d.document) || []).map(d => parseDoc(d.document));
}

async function fetchOverrides(token) {
  const empty = { extraCatalog: [], extraDefaults: {}, puncionOverrides: {}, patientDefaultMaterial: null };
  try {
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/settings/materialCatalog`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 404) return empty;
    const doc = await res.json();
    const parsed = parseDoc(doc);
    return {
      extraCatalog: parsed.extraCatalog || [],
      extraDefaults: parsed.extraDefaults || {},
      puncionOverrides: parsed.puncionOverrides || {},
      patientDefaultMaterial: parsed.patientDefaultMaterial || null,
    };
  } catch (e) {
    return empty;
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

// Sugerencias del catálogo existente mientras se escribe, para elegir un producto
// ya existente en vez de teclear uno nuevo (evita duplicados).
function CatalogSuggestions({ query, catalog, onSelect }) {
  if (!query || query.trim().length < 2) return null;
  const term = query.trim().toUpperCase();
  const matches = catalog.filter(c => c.item.toUpperCase().includes(term)).slice(0, 6);
  if (matches.length === 0) return null;
  return (
    <div style={{ marginTop:4, display:"flex", flexDirection:"column", gap:2, background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:7, padding:4 }}>
      {matches.map((c,i) => (
        <button key={i} onClick={() => onSelect(c.item)} style={{ textAlign:"left", padding:"5px 8px", borderRadius:5, fontSize:11, cursor:"pointer", background:"transparent", border:"none", color:"#ccc" }}>
          {c.item} <span style={{ color:"#555" }}>({c.category})</span>
        </button>
      ))}
    </div>
  );
}

export default function Insumos() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const [tab, setTab] = useState("consolidado");
  const [token, setToken] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [centerFilter, setCenterFilter] = useState("Todos");
  const [dateFilter, setDateFilter] = useState("semana"); // "hoy" | "semana" | "todas"
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

  const [editingPuncion, setEditingPuncion] = useState(null); // "periferico" | "puerto" | null
  const [puncionInsumos, setPuncionInsumos] = useState([]);
  const [puncionSoluciones, setPuncionSoluciones] = useState([]);
  const [savingPuncion, setSavingPuncion] = useState(false);

  const [editingPatientDefault, setEditingPatientDefault] = useState(false);
  const [patientInsumos, setPatientInsumos] = useState([]);
  const [patientSoluciones, setPatientSoluciones] = useState([]);
  const [savingPatientDefault, setSavingPatientDefault] = useState(false);

  useEffect(() => { user.getIdToken().then(setToken); }, [user]);
  useEffect(() => { if (token) load(); }, [token]);

  const load = async () => {
    setLoading(true);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
    const [s, ov] = await Promise.all([fetchUpcomingSessions(token, today), fetchOverrides(token)]);
    setSessions(s.filter(x => Array.isArray(x.meds) && x.meds.length > 0));
    setOverrides(ov);
    setLoading(false);
  };

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  const weekEnd = (() => { const d = new Date(); d.setDate(d.getDate() + 6); return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }); })();
  const dateFiltered = dateFilter === "todas" ? sessions
    : dateFilter === "hoy" ? sessions.filter(s => s.date === today)
    : sessions.filter(s => s.date >= today && s.date <= weekEnd); // "semana"
  const filtered = centerFilter === "Todos" ? dateFiltered : dateFiltered.filter(s => s.center === centerFilter);
  const calcOverrides = {
    extraDefaults: overrides.extraDefaults,
    extraCatalog: overrides.extraCatalog,
    puncionOverrides: overrides.puncionOverrides,
    patientDefaultMaterial: overrides.patientDefaultMaterial,
  };
  const perPatient = filtered.map(s => {
    const preview = computeSessionMaterial(s, calcOverrides);
    const excluded = s.excludedMaterial || [];
    const qtyOv = s.qtyOverrides || {};
    const pieceOv = s.pieceOverrides || {};
    const combined = {};
    preview.items.forEach(({ item, qty }) => {
      if (excluded.includes(item)) return;
      combined[item] = (combined[item] || 0) + (qtyOv[item] !== undefined ? qtyOv[item] : qty);
    });
    (s.meds || []).forEach(m => {
      const auto = computeMedicationPieces(m.name, m.dose, overrides.extraCatalog, overrides.extraDefaults);
      if (!auto) return;
      const finalPieces = pieceOv[m.name] || auto.pieces;
      finalPieces.forEach(({ item, count }) => { combined[item] = (combined[item] || 0) + count; });
    });
    (s.extraMaterial || []).forEach(({ item, qty }) => { combined[item] = (combined[item] || 0) + (qty || 0); });
    const items = Object.entries(combined).map(([item, qty]) => ({ item, qty })).sort((a,b) => a.item.localeCompare(b.item));
    return { session: s, material: { items, unmatched: preview.unmatched }, note: s.materialNote || "" };
  });

  const grandTotal = {};
  perPatient.forEach(({ material }) => {
    material.items.forEach(({ item, qty }) => { grandTotal[item] = (grandTotal[item] || 0) + qty; });
  });
  const grandTotalList = Object.entries(grandTotal).map(([item, qty]) => ({ item, qty })).sort((a,b) => a.item.localeCompare(b.item));

  const downloadPharmacyOrder = (s, material, note) => {
    // Clasifica cada artículo en Medicamentos / Soluciones / Insumos según el catálogo maestro
    const catalogByName = {};
    MASTER_CATALOG.forEach(c => { catalogByName[c.item.toUpperCase()] = c.category; });
    const categoryFor = (itemName) => {
      const up = itemName.toUpperCase();
      if (up.includes("CLORURO DE SODIO") || up.includes("GLUCOSA") || up.includes("HARTMANN")) return "SOLUCIONES";
      if (catalogByName[up]) {
        const cat = catalogByName[up];
        return (cat === "Medicamentos" || cat === "Oncológicos" || cat === "Inmunoterapia") ? "MEDICAMENTOS" : "INSUMOS";
      }
      // Respaldo: si no hay coincidencia exacta, buscar por coincidencia parcial
      const fuzzy = MASTER_CATALOG.find(c => up.startsWith(c.item.toUpperCase()) || c.item.toUpperCase().startsWith(up));
      if (fuzzy) return (["Medicamentos","Oncológicos","Inmunoterapia"].includes(fuzzy.category)) ? "MEDICAMENTOS" : "INSUMOS";
      return "INSUMOS";
    };
    const groups = { MEDICAMENTOS: [], SOLUCIONES: [], INSUMOS: [] };
    material.items.forEach(t => groups[categoryFor(t.item)].push(t));

    const today = new Date().toLocaleDateString("es-MX");
    const entrega = s.date ? new Date(s.date + "T12:00:00").toLocaleDateString("es-MX") : "";
    const empresa = s.center || "";
    const concepto = `${(s.patientName || "").toUpperCase()} ${s.cycle || ""}`.trim();

    const lbl = 'style="font-size:11px;font-weight:bold;font-family:Calibri;"';
    const val = 'style="font-size:11px;font-family:Calibri;"';
    const sectionRow = (label) => `<tr><td colspan="8" ${lbl}>${label}</td></tr>`;
    const itemRow = (item, qty) => `<tr><td colspan="7" ${lbl}>${item}</td><td ${lbl} align="right">${qty}</td></tr>`;
    const esc = (v) => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    let html = `<table border="0">
      <tr><td colspan="8" align="center" style="font-size:14px;font-weight:bold;font-family:Calibri;">SOLICITUD DE MATERIAL</td></tr>
      <tr><td colspan="8"></td></tr>
      <tr><td ${lbl}>EMPRESA</td><td colspan="3" ${val}>${esc(empresa)}</td><td colspan="2" ${lbl}>FECHA DE SOLICITUD:</td><td colspan="2" ${val}>${today}</td></tr>
      <tr><td ${lbl}>CONCEPTO</td><td colspan="7" ${val}>${esc(concepto)}</td></tr>
      <tr><td colspan="2" ${lbl}>FECHA DE ENTREGA:</td><td colspan="6" ${val}>${entrega}</td></tr>
      <tr><td colspan="8"></td></tr>`;

    ["MEDICAMENTOS", "SOLUCIONES", "INSUMOS"].forEach(cat => {
      if (groups[cat].length === 0) return;
      html += sectionRow(cat);
      groups[cat].forEach(t => { html += itemRow(esc(t.item), t.qty); });
      html += `<tr><td colspan="8"></td></tr>`;
    });

    if (note) {
      html += sectionRow("NOTA");
      html += `<tr><td colspan="8" ${val}>${esc(note)}</td></tr>`;
    }
    html += "</table>";

    const blob = new Blob(["\ufeff", html], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `SOLICITUD_${empresa}_${(s.patientName || "paciente").replace(/\s+/g, "_")}.xls`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

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

  // Carga un medicamento existente (de fábrica o ya editado) en el formulario para modificarlo.
  // Al guardar con la MISMA clave, se sobreescribe (funciona para ambos casos).
  const loadMedForEdit = (key) => {
    const entry = overrides.extraDefaults[key] || MATERIAL_DEFAULTS[key];
    if (!entry) return;
    setNewMedName(key);
    setNewMedInsumos(entry.insumos || []);
    setNewMedSoluciones(entry.soluciones || []);
    setExpandedMed(null);
  };

  const loadPuncionForEdit = (type) => {
    const entry = overrides.puncionOverrides[type] || PUNCION_DEFAULTS[type];
    if (!entry) return;
    setEditingPuncion(type);
    setPuncionInsumos(entry.insumos || []);
    setPuncionSoluciones(entry.soluciones || []);
  };

  const savePuncionOverride = async () => {
    if (!editingPuncion) return;
    setSavingPuncion(true);
    try {
      const base = overrides.puncionOverrides[editingPuncion] || PUNCION_DEFAULTS[editingPuncion] || {};
      const updated = { ...overrides.puncionOverrides, [editingPuncion]: { ...base, insumos: puncionInsumos, soluciones: puncionSoluciones } };
      await saveOverrides(token, { puncionOverrides: updated });
      setOverrides(o => ({ ...o, puncionOverrides: updated }));
      setEditingPuncion(null);
    } finally { setSavingPuncion(false); }
  };

  const loadPatientDefaultForEdit = () => {
    const entry = overrides.patientDefaultMaterial || { insumos: [], soluciones: [] };
    setPatientInsumos(entry.insumos || []);
    setPatientSoluciones(entry.soluciones || []);
    setEditingPatientDefault(true);
  };

  const savePatientDefault = async () => {
    setSavingPatientDefault(true);
    try {
      const updated = { insumos: patientInsumos, soluciones: patientSoluciones };
      await saveOverrides(token, { patientDefaultMaterial: updated });
      setOverrides(o => ({ ...o, patientDefaultMaterial: updated }));
      setEditingPatientDefault(false);
    } finally { setSavingPatientDefault(false); }
  };

  const removePatientDefault = async () => {
    await saveOverrides(token, { patientDefaultMaterial: null });
    setOverrides(o => ({ ...o, patientDefaultMaterial: null }));
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
          <div style={{ display:"flex", gap:8, marginBottom:10, flexWrap:"wrap" }}>
            {["Todos","CITIO","CIPI"].map(c => (
              <button key={c} onClick={() => setCenterFilter(c)} style={{
                padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
                background: centerFilter===c ? "rgba(79,195,247,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${centerFilter===c ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: centerFilter===c ? "#4fc3f7" : "#666",
              }}>{c}</button>
            ))}
          </div>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
            {[["hoy","Hoy"],["semana","Próximos 7 días"],["todas","Todas las cargadas"]].map(([val,label]) => (
              <button key={val} onClick={() => setDateFilter(val)} style={{
                padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
                background: dateFilter===val ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${dateFilter===val ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: dateFilter===val ? "#00d4aa" : "#666",
              }}>{label}</button>
            ))}
            <span style={{ marginLeft:"auto", fontSize:12, color:"#555", alignSelf:"center" }}>{perPatient.length} sesión{perPatient.length!==1?"es":""}</span>
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
              {grandTotalList.length === 0 && <div style={{ fontSize:12, color:"#444", textAlign:"center", padding:16 }}>Sin sesiones con medicamentos en este rango.</div>}
            </div>
          </div>

          <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>Por paciente</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {perPatient.map(({ session: s, material, note }, i) => {
              const pedidoHecho = !!s.pedidoGeneradoAt;
              return (
              <div key={i} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
                <div onClick={() => setExpandedPatient(p => p===i ? null : i)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}>
                  <img src={s.center === "CIPI" ? "/logo-cipi-icon.png" : "/logo-citio-icon.png"} alt={s.center}
                    style={{ width:20, height:20, borderRadius:"50%", objectFit:"cover", opacity:0.9, flexShrink:0 }} />
                  <span style={{ fontSize:11, color:"#666", background:"rgba(255,255,255,0.05)", padding:"2px 8px", borderRadius:99 }}>{s.center}</span>
                  <span style={{ fontSize:10, color:"#555" }}>{s.date}</span>
                  <span style={{ flex:1, fontSize:13, color:"#f0f0f0", fontWeight:600 }}>{s.patientName}</span>
                  <span style={{ fontSize:11, color:"#555" }}>{material.items.length} art.</span>
                  {material.unmatched.length > 0 && <span style={{ fontSize:11, color:"#ffb347" }}>⚠️ {material.unmatched.length}</span>}
                  {note && <span style={{ fontSize:11, color:"#4fc3f7" }}>📝</span>}
                  <button onClick={async e => {
                      e.stopPropagation();
                      downloadPharmacyOrder(s, material, note);
                      try {
                        const nowIso = new Date().toISOString();
                        await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions/${s.id}?updateMask.fieldPaths=pedidoGeneradoAt`,
                          { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
                            body: JSON.stringify({ fields: { pedidoGeneradoAt: { stringValue: nowIso } } }) });
                        setSessions(prev => prev.map(x => x.id === s.id ? { ...x, pedidoGeneradoAt: nowIso } : x));
                      } catch (err) { /* si falla el marcado, no bloquea la descarga */ }
                    }}
                    title={pedidoHecho ? `Pedido generado ${new Date(s.pedidoGeneradoAt).toLocaleString("es-MX")} — clic para volver a descargar` : "Descargar pedido para farmacia"}
                    style={{ padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor:"pointer",
                      background: pedidoHecho ? "rgba(255,255,255,0.05)" : "rgba(0,212,170,0.1)",
                      border: `1px solid ${pedidoHecho ? "rgba(255,255,255,0.1)" : "rgba(0,212,170,0.25)"}`,
                      color: pedidoHecho ? "#666" : "#00d4aa" }}>
                    {pedidoHecho ? "✓ Pedido hecho" : "📄 Pedido"}
                  </button>
                  <span style={{ color:"#555" }}>{expandedPatient===i ? "▲" : "▼"}</span>
                </div>
                {expandedPatient===i && (
                  <div style={{ padding:"0 16px 14px", display:"flex", flexDirection:"column", gap:4 }}>
                    {material.unmatched.length > 0 && (
                      <div style={{ fontSize:11, color:"#ffb347", marginBottom:6 }}>Sin material por defecto: {material.unmatched.join(", ")}</div>
                    )}
                    {note && (
                      <div style={{ fontSize:11, color:"#4fc3f7", marginBottom:6, padding:"6px 8px", background:"rgba(79,195,247,0.06)", borderRadius:6 }}>📝 {note}</div>
                    )}
                    {material.items.map((t,ti) => (
                      <div key={ti} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", padding:"3px 0" }}>
                        <span>{t.item}</span><span style={{ color:"#00d4aa" }}>{t.qty}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              );
            })}
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
            {isJefe && (() => {
              const fullCatalog = [...MASTER_CATALOG, ...overrides.extraCatalog];
              const term = newCatItem.trim().toUpperCase();
              const exact = term.length >= 2 && fullCatalog.find(c => c.item.toUpperCase() === term);
              const similar = term.length >= 2 && !exact ? fullCatalog.filter(c => c.item.toUpperCase().includes(term)).slice(0, 4) : [];
              return (
                <div style={{ marginBottom:10 }}>
                  <div style={{ display:"flex", gap:8 }}>
                    <select value={newCatCategory} onChange={e => setNewCatCategory(e.target.value)} style={{ ...inputStyle, flex:"0 0 160px" }}>
                      <option>Insumos</option><option>Medicamentos</option><option>Oncológicos</option><option>Inmunoterapia</option>
                    </select>
                    <input value={newCatItem} onChange={e => setNewCatItem(e.target.value)} placeholder="Nombre del artículo..." style={inputStyle} />
                    <button onClick={addCatalogItem} disabled={savingCat || !!exact} style={{ padding:"8px 16px", borderRadius:8, fontSize:12, fontWeight:600, cursor: exact ? "not-allowed" : "pointer", background: exact ? "rgba(255,255,255,0.03)" : "rgba(0,212,170,0.12)", border: `1px solid ${exact ? "rgba(255,255,255,0.06)" : "rgba(0,212,170,0.3)"}`, color: exact ? "#555" : "#00d4aa", whiteSpace:"nowrap" }}>
                      {savingCat ? "..." : "+ Agregar"}
                    </button>
                  </div>
                  {exact && <div style={{ fontSize:11, color:"#ffb347", marginTop:5 }}>⚠️ Ya existe exactamente igual en {exact.category} — no se puede duplicar.</div>}
                  {!exact && similar.length > 0 && (
                    <div style={{ fontSize:11, color:"#ffb347", marginTop:5 }}>
                      Ya hay productos parecidos, revisa antes de agregar: {similar.map(s => s.item).join(", ")}
                    </div>
                  )}
                </div>
              );
            })()}
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
              <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>+ Definir o editar material de un medicamento</div>
              <div style={{ display:"flex", flexDirection:"column", gap:10, padding:14, borderRadius:12, background:"rgba(175,169,236,0.05)", border:"1px solid rgba(175,169,236,0.15)" }}>
                <div>
                  <label style={labelStyle}>Editar uno existente (opcional)</label>
                  <select value="" onChange={e => e.target.value && loadMedForEdit(e.target.value)} style={inputStyle}>
                    <option value="">— elegir para cargar y editar —</option>
                    {[...Object.keys(MATERIAL_DEFAULTS), ...Object.keys(overrides.extraDefaults)].sort().map(k => (
                      <option key={k} value={k}>{k}{overrides.extraDefaults[k] ? " (editado)" : ""}</option>
                    ))}
                  </select>
                </div>
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
                <CatalogSuggestions query={draftItem} catalog={[...MASTER_CATALOG, ...overrides.extraCatalog]} onSelect={setDraftItem} />
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

          {isJefe && (
            <div>
              <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>Material de punción (editar periférico / puerto)</div>
              <div style={{ display:"flex", gap:8, marginBottom:10 }}>
                {["periferico","puerto"].map(t => (
                  <button key={t} onClick={() => loadPuncionForEdit(t)} style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer",
                    background: editingPuncion===t ? "rgba(79,195,247,0.12)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${editingPuncion===t ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.08)"}`,
                    color: editingPuncion===t ? "#4fc3f7" : "#666", textTransform:"capitalize" }}>
                    Editar {t}{overrides.puncionOverrides[t] ? " (editado)" : ""}
                  </button>
                ))}
              </div>
              {editingPuncion && (
                <div style={{ display:"flex", flexDirection:"column", gap:10, padding:14, borderRadius:12, background:"rgba(79,195,247,0.05)", border:"1px solid rgba(79,195,247,0.15)" }}>
                  <div style={{ display:"flex", gap:8 }}>
                    <input value={draftItem} onChange={e => setDraftItem(e.target.value)} placeholder="Nombre del insumo/solución..." style={inputStyle} />
                    <input type="number" min="1" value={draftQty} onChange={e => setDraftQty(e.target.value)} style={{ ...inputStyle, width:70 }} />
                    <button onClick={() => addDraftRow(puncionInsumos, setPuncionInsumos)} style={{ padding:"8px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#ccc", whiteSpace:"nowrap" }}>+ Insumo</button>
                    <button onClick={() => addDraftRow(puncionSoluciones, setPuncionSoluciones)} style={{ padding:"8px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(79,195,247,0.1)", border:"1px solid rgba(79,195,247,0.25)", color:"#4fc3f7", whiteSpace:"nowrap" }}>+ Solución</button>
                  </div>
                  <CatalogSuggestions query={draftItem} catalog={[...MASTER_CATALOG, ...overrides.extraCatalog]} onSelect={setDraftItem} />
                  {puncionInsumos.length > 0 && (
                    <div>
                      <div style={{ fontSize:10, color:"#666", marginBottom:4 }}>INSUMOS</div>
                      {puncionInsumos.map((r,i) => (
                        <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#ccc", padding:"3px 0" }}>
                          <span>{r.item}</span>
                          <span style={{ display:"flex", gap:8, alignItems:"center" }}>{r.qty}
                            <button onClick={() => setPuncionInsumos(prev => prev.filter((_,pi)=>pi!==i))} style={{ color:"#ff6b6b", background:"none", border:"none", cursor:"pointer", fontSize:11 }}>✕</button>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {puncionSoluciones.length > 0 && (
                    <div>
                      <div style={{ fontSize:10, color:"#666", marginBottom:4 }}>SOLUCIONES</div>
                      {puncionSoluciones.map((r,i) => (
                        <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#4fc3f7", padding:"3px 0" }}>
                          <span>{r.item}</span>
                          <span style={{ display:"flex", gap:8, alignItems:"center" }}>{r.qty}
                            <button onClick={() => setPuncionSoluciones(prev => prev.filter((_,pi)=>pi!==i))} style={{ color:"#ff6b6b", background:"none", border:"none", cursor:"pointer", fontSize:11 }}>✕</button>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize:10, color:"#555" }}>Nota: las alternativas (ej. calibre de catéter) no se editan aquí todavía — sigue viniendo del catálogo de fábrica.</div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={() => setEditingPuncion(null)} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>Cancelar</button>
                    <button onClick={savePuncionOverride} disabled={savingPuncion} style={{ flex:2, padding:"9px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"linear-gradient(135deg,#4fc3f7,#1e88c7)", border:"none", color:"#fff" }}>
                      {savingPuncion ? "Guardando…" : "✓ Guardar cambios"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <div style={{ fontSize:13, color:"#888", fontWeight:600, marginBottom:10 }}>
              Material por paciente ({(overrides.patientDefaultMaterial?.insumos?.length||0) + (overrides.patientDefaultMaterial?.soluciones?.length||0)} artículos)
            </div>
            <div style={{ fontSize:11, color:"#555", marginBottom:8 }}>
              Se suma a (casi) todas las sesiones automáticamente — en el modal 🧰 de cada paciente se puede desmarcar si no aplica.
            </div>
            {!editingPatientDefault ? (
              <div style={{ display:"flex", gap:8 }}>
                {isJefe && (
                  <button onClick={loadPatientDefaultForEdit} style={{ padding:"8px 16px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
                    {overrides.patientDefaultMaterial ? "✎ Editar" : "+ Definir material por paciente"}
                  </button>
                )}
                {isJefe && overrides.patientDefaultMaterial && (
                  <button onClick={removePatientDefault} style={{ padding:"8px 16px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
                    ✕ Quitar
                  </button>
                )}
                {overrides.patientDefaultMaterial && (
                  <div style={{ flex:1, display:"flex", flexDirection:"column", gap:3 }}>
                    {[...(overrides.patientDefaultMaterial.insumos||[]), ...(overrides.patientDefaultMaterial.soluciones||[])].map((r,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa" }}>
                        <span>{r.item}</span><span>{r.qty}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:10, padding:14, borderRadius:12, background:"rgba(0,212,170,0.05)", border:"1px solid rgba(0,212,170,0.15)" }}>
                <div style={{ display:"flex", gap:8 }}>
                  <input value={draftItem} onChange={e => setDraftItem(e.target.value)} placeholder="Nombre del insumo/solución..." style={inputStyle} />
                  <input type="number" min="1" value={draftQty} onChange={e => setDraftQty(e.target.value)} style={{ ...inputStyle, width:70 }} />
                  <button onClick={() => addDraftRow(patientInsumos, setPatientInsumos)} style={{ padding:"8px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#ccc", whiteSpace:"nowrap" }}>+ Insumo</button>
                  <button onClick={() => addDraftRow(patientSoluciones, setPatientSoluciones)} style={{ padding:"8px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(79,195,247,0.1)", border:"1px solid rgba(79,195,247,0.25)", color:"#4fc3f7", whiteSpace:"nowrap" }}>+ Solución</button>
                </div>
                <CatalogSuggestions query={draftItem} catalog={[...MASTER_CATALOG, ...overrides.extraCatalog]} onSelect={setDraftItem} />
                {patientInsumos.length > 0 && (
                  <div>
                    <div style={{ fontSize:10, color:"#666", marginBottom:4 }}>INSUMOS</div>
                    {patientInsumos.map((r,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#ccc", padding:"3px 0" }}>
                        <span>{r.item}</span>
                        <span style={{ display:"flex", gap:8, alignItems:"center" }}>{r.qty}
                          <button onClick={() => setPatientInsumos(prev => prev.filter((_,pi)=>pi!==i))} style={{ color:"#ff6b6b", background:"none", border:"none", cursor:"pointer", fontSize:11 }}>✕</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {patientSoluciones.length > 0 && (
                  <div>
                    <div style={{ fontSize:10, color:"#666", marginBottom:4 }}>SOLUCIONES</div>
                    {patientSoluciones.map((r,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#4fc3f7", padding:"3px 0" }}>
                        <span>{r.item}</span>
                        <span style={{ display:"flex", gap:8, alignItems:"center" }}>{r.qty}
                          <button onClick={() => setPatientSoluciones(prev => prev.filter((_,pi)=>pi!==i))} style={{ color:"#ff6b6b", background:"none", border:"none", cursor:"pointer", fontSize:11 }}>✕</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => setEditingPatientDefault(false)} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>Cancelar</button>
                  <button onClick={savePatientDefault} disabled={savingPatientDefault} style={{ flex:2, padding:"9px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"linear-gradient(135deg,#00d4aa,#00997a)", border:"none", color:"#000" }}>
                    {savingPatientDefault ? "Guardando…" : "✓ Guardar material por paciente"}
                  </button>
                </div>
              </div>
            )}
          </div>

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
              const filteredAll = all
                .filter(c => catalogCategoryFilter === "Todos" || c.category === catalogCategoryFilter)
                .filter(c => !term || c.item.toUpperCase().includes(term));
              const grouped = {};
              filteredAll.forEach(c => { (grouped[c.category] = grouped[c.category] || []).push(c); });
              const categoryOrder = ["Insumos", "Medicamentos", "Oncológicos", "Inmunoterapia"];
              const categories = categoryOrder.filter(cat => grouped[cat]);
              return (
                <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                  {categories.map(cat => (
                    <div key={cat}>
                      <div style={{ fontSize:11, color:"#4fc3f7", fontWeight:600, marginBottom:5, display:"flex", justifyContent:"space-between" }}>
                        <span>{cat}</span><span style={{ color:"#555" }}>{grouped[cat].length}</span>
                      </div>
                      <div style={{ maxHeight:160, overflowY:"auto", display:"flex", flexDirection:"column", gap:3 }}>
                        {grouped[cat].sort((a,b) => a.item.localeCompare(b.item)).map((c,i) => (
                          <div key={i} style={{ padding:"5px 10px", borderRadius:6, background:"rgba(255,255,255,0.02)", fontSize:11, color:"#ccc" }}>
                            {c.item}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {categories.length === 0 && <div style={{ fontSize:11, color:"#444", padding:10 }}>Sin resultados.</div>}
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
                    {isJefe && (
                      <button onClick={e => { e.stopPropagation(); loadMedForEdit(key); }} style={{ padding:"2px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(0,212,170,0.1)", border:"1px solid rgba(0,212,170,0.25)", color:"#00d4aa" }}>✎</button>
                    )}
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
              {Object.keys(PUNCION_DEFAULTS).map((key) => {
                const entry = overrides.puncionOverrides[key] || PUNCION_DEFAULTS[key];
                return (
                <div key={key} style={{ borderRadius:8, background:"rgba(255,255,255,0.03)", overflow:"hidden" }}>
                  <div onClick={() => setExpandedMed(m => m===`punc_${key}` ? null : `punc_${key}`)} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", cursor:"pointer" }}>
                    <span style={{ flex:1, fontSize:12, color:"#ccc", textTransform:"capitalize" }}>{key}{overrides.puncionOverrides[key] && <span style={{ fontSize:9, color:"#4fc3f7", marginLeft:6 }}>(editado)</span>}</span>
                    <span style={{ fontSize:10, color:"#555" }}>{(entry.insumos||[]).length + (entry.soluciones||[]).length + (entry.alternativas||[]).length} art.</span>
                    {isJefe && (
                      <button onClick={e => { e.stopPropagation(); loadPuncionForEdit(key); }} style={{ padding:"2px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(0,212,170,0.1)", border:"1px solid rgba(0,212,170,0.25)", color:"#00d4aa" }}>✎</button>
                    )}
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
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
