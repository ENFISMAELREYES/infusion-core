import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { computeSessionMaterial, computeMedicationPieces, MASTER_CATALOG, MATERIAL_DEFAULTS, PUNCION_DEFAULTS } from "../data/materialCatalog";
import MaterialModal from "../components/MaterialModal";

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

function toFV(val) {
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (val === null || val === undefined) return { nullValue: null };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
  if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFV(v)])) } };
  return { stringValue: String(val) };
}

async function fetchUpcomingSessions(token, fromDate) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:runQuery`,
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
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/settings/materialCatalog`,
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
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/settings/materialCatalog?${mask}`,
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

// Fila de sesión en el consolidado: incluye el botón de Solicitar material
// (reutilizando el mismo modal que antes vivía en NurseView), el botón de
// Pedido, y — cuando se está viendo "todas las cargadas" — el botón de Anexar
// para agregar material extra si hubo cambios el día de la sesión o después
// (hasta 3 anexos por sesión).
function PatientMaterialRow({ s, material, note, expanded, onToggle, token, user, onRefresh, setSessions, downloadPharmacyOrder, showAnexo, mode }) {
  const medsHecho = !!s.medsPedidoGeneradoAt;
  const materialHecho = !!s.materialPedidoGeneradoAt;
  const anexos = s.anexos || [];
  const isCipi = s.center === "CIPI";
  const [cipiVariant, setCipiVariant] = useState(s.cipiVariant || "PRO");
  const [docsRevealed, setDocsRevealed] = useState(medsHecho || materialHecho || anexos.length > 0);
  const [showAnexoModal, setShowAnexoModal] = useState(false);
  const [anexoItems, setAnexoItems] = useState([]);
  const [anexoSearch, setAnexoSearch] = useState("");
  const [anexoQty, setAnexoQty] = useState("1");
  const [anexoNote, setAnexoNote] = useState("");
  const [savingAnexo, setSavingAnexo] = useState(false);
  const [showInvModal, setShowInvModal] = useState(false);
  const [invItems, setInvItems] = useState([]);
  const [savingInv, setSavingInv] = useState(false);

  const toFV = (val) => {
    if (typeof val === "string") return { stringValue: val };
    if (typeof val === "number") return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
    if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
    if (val && typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k,v]) => [k, toFV(v)])) } };
    return { stringValue: String(val) };
  };

  const markPedidoHecho = async (field) => {
    try {
      const nowIso = new Date().toISOString();
      await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${s.id}?updateMask.fieldPaths=${field}`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: { [field]: { stringValue: nowIso } } }) });
      setSessions(prev => prev.map(x => x.id === s.id ? { ...x, [field]: nowIso } : x));
    } catch (err) { /* si falla el marcado, no bloquea la descarga */ }
  };

  const toggleExcludeFromOrder = async (e) => {
    e.stopPropagation();
    try {
      const newVal = !s.excludeFromOrder;
      await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${s.id}?updateMask.fieldPaths=excludeFromOrder`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: { excludeFromOrder: { booleanValue: newVal } } }) });
      setSessions(prev => prev.map(x => x.id === s.id ? { ...x, excludeFromOrder: newVal } : x));
    } catch (err) {
      alert("Error al actualizar: " + err.message);
    }
  };

  const generateAnexo = async () => {
    if (anexoItems.length === 0) return;
    setSavingAnexo(true);
    try {
      const anexoNumber = anexos.length + 1;
      const res = await fetch("/api/generate-material-order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          center: s.center, cipiVariant, patientName: s.patientName, cycle: s.cycle, date: s.date,
          groups: { MEDICAMENTOS: [], SOLUCIONES: [], INSUMOS: anexoItems },
          note: anexoNote, anexoNumber,
        }),
      });
      if (!res.ok) throw new Error(`Error ${res.status} al generar el anexo`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      const newAnexos = [...anexos, { number: anexoNumber, items: anexoItems, note: anexoNote, generatedAt: new Date().toISOString() }];
      await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${s.id}?updateMask.fieldPaths=anexos`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: { anexos: toFV(newAnexos) } }) });
      setSessions(prev => prev.map(x => x.id === s.id ? { ...x, anexos: newAnexos } : x));

      // Si el inventario de esta sesión ya se dio de baja (retiro ya
      // completado), este anexo se captura DESPUÉS del cierre -- se descuenta
      // del inventario aparte, automáticamente, ligado a la misma sesión.
      if (s.inventorySalidaDone) {
        const warehouse = s.center === "CIPI" ? `CIPI_${(cipiVariant || "PRO").toUpperCase()}` : (s.center || "");
        const inventoryDocId = (w, item) => `${w}_${item}`.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 200);
        for (const it of anexoItems) {
          const docId = inventoryDocId(warehouse, it.item);
          let currentStock = 0, minStock = 0, category = "", unit = "PIEZA";
          try {
            const getRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/inventory/${docId}`, { headers:{ "Authorization":`Bearer ${token}` } });
            if (getRes.ok) {
              const doc = await getRes.json();
              currentStock = parseInt(doc.fields?.currentStock?.integerValue || doc.fields?.currentStock?.doubleValue || 0);
              minStock = parseInt(doc.fields?.minStock?.integerValue || 0);
              category = doc.fields?.category?.stringValue || "";
              unit = doc.fields?.unit?.stringValue || "PIEZA";
            }
          } catch {}
          await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/inventory/${docId}`,
            { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
              body: JSON.stringify({ fields: {
                item: { stringValue: it.item }, warehouse: { stringValue: warehouse },
                category: { stringValue: category }, unit: { stringValue: unit },
                currentStock: toFV(currentStock - it.qty), minStock: toFV(minStock),
                lastUpdated: { stringValue: new Date().toISOString() },
              }}) });
        }
        await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/inventory_events`,
          { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
            body: JSON.stringify({ fields: {
              type: { stringValue: "salida" }, warehouse: { stringValue: warehouse },
              items: toFV(anexoItems),
              sessionId: { stringValue: s.id }, sessionPatientName: { stringValue: s.patientName || "" },
              reason: { stringValue: `Anexo ${anexoNumber} (posterior al retiro)` },
              userEmail: { stringValue: user?.email || "" },
              createdAt: { stringValue: new Date().toISOString() },
            }}) });
      }

      setShowAnexoModal(false); setAnexoItems([]); setAnexoNote("");
    } catch (e) {
      alert("Error al generar el anexo: " + e.message);
    } finally {
      setSavingAnexo(false);
    }
  };

  const downloadAllTogether = async () => {
    const anexoItemsFlat = anexos.flatMap(a => a.items || []);
    const combinedMaterial = { items: [...material.items, ...anexoItemsFlat] };
    await downloadPharmacyOrder(s, combinedMaterial, note, cipiVariant, "todo");
  };

  const openInvModal = () => {
    setInvItems(material.items.map(it => ({ ...it })));
    setShowInvModal(true);
  };
  const setInvQty = (idx, qty) => setInvItems(prev => prev.map((it,i) => i===idx ? { ...it, qty: Math.max(0, qty) } : it));

  // Da de baja del inventario los artículos confirmados -- acción
  // independiente del retiro de la sesión (antes vivía dentro del flujo de
  // firmas de NurseView, pero si ese flujo se interrumpía a medias podía
  // duplicar el cargo; ahora es un paso aparte, deliberado, que se puede
  // hacer en cualquier momento).
  const confirmInvSalida = async () => {
    setSavingInv(true);
    try {
      const warehouse = s.center === "CIPI" ? `CIPI_${(cipiVariant || "PRO").toUpperCase()}` : (s.center || "");
      const inventoryDocId = (w, item) => `${w}_${item}`.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 200);
      const checkOk = async (res, label) => {
        if (!res.ok) { let msg=`Error ${res.status}`; try{const b=await res.json(); msg=b?.error?.message||msg;}catch{} throw new Error(`${label}: ${msg}`); }
      };
      const itemsToDeduct = invItems.filter(x => x.qty > 0);

      for (const it of itemsToDeduct) {
        const docId = inventoryDocId(warehouse, it.item);
        let currentStock = 0, minStock = 0, category = "", unit = "PIEZA";
        try {
          const getRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/inventory/${docId}`, { headers:{ "Authorization":`Bearer ${token}` } });
          if (getRes.ok) {
            const doc = await getRes.json();
            currentStock = parseInt(doc.fields?.currentStock?.integerValue || doc.fields?.currentStock?.doubleValue || 0);
            minStock = parseInt(doc.fields?.minStock?.integerValue || 0);
            category = doc.fields?.category?.stringValue || "";
            unit = doc.fields?.unit?.stringValue || "PIEZA";
          }
        } catch {}
        const invRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/inventory/${docId}`,
          { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
            body: JSON.stringify({ fields: {
              item: { stringValue: it.item }, warehouse: { stringValue: warehouse },
              category: { stringValue: category }, unit: { stringValue: unit },
              currentStock: toFV(currentStock - it.qty), minStock: toFV(minStock),
              lastUpdated: { stringValue: new Date().toISOString() },
            }}) });
        await checkOk(invRes, `Existencias de "${it.item}"`);
      }

      if (itemsToDeduct.length > 0) {
        const evRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/inventory_events`,
          { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
            body: JSON.stringify({ fields: {
              type: { stringValue: "salida" }, warehouse: { stringValue: warehouse },
              items: toFV(itemsToDeduct),
              sessionId: { stringValue: s.id }, sessionPatientName: { stringValue: s.patientName || "" },
              reason: { stringValue: "Baja de inventario de la sesión" },
              userEmail: { stringValue: user?.email || "" },
              createdAt: { stringValue: new Date().toISOString() },
            }}) });
        await checkOk(evRes, "Registro del evento de movimiento");
      }

      const doneRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${s.id}?updateMask.fieldPaths=inventorySalidaDone&updateMask.fieldPaths=inventorySalidaAt`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: {
            inventorySalidaDone: { booleanValue: true },
            inventorySalidaAt: { stringValue: new Date().toISOString() },
          }}) });
      await checkOk(doneRes, "Marcar sesión como dada de baja");

      setSessions(prev => prev.map(x => x.id === s.id ? { ...x, inventorySalidaDone: true } : x));
      setShowInvModal(false);
    } catch (e) {
      alert("Error al dar de baja el inventario: " + e.message);
    } finally {
      setSavingInv(false);
    }
  };

  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
      <div onClick={onToggle} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
        <img src={s.center === "CIPI" ? "/logo-cipi-icon.png" : "/logo-citio-icon.png"} alt={s.center}
          style={{ width:20, height:20, borderRadius:"50%", objectFit:"cover", opacity:0.9, flexShrink:0 }} />
        <span style={{ fontSize:11, color:"#666", background:"rgba(255,255,255,0.05)", padding:"2px 8px", borderRadius:99 }}>{s.center}</span>
        <span style={{ fontSize:10, color:"#555" }}>{s.date}</span>
        <span style={{ flex:1, fontSize:13, color: s.excludeFromOrder ? "#555" : "#f0f0f0", fontWeight:600, minWidth:120, textDecoration: s.excludeFromOrder ? "line-through" : "none" }}>{s.patientName}</span>
        {s.excludeFromOrder ? (
          <span style={{ fontSize:11, color:"#888" }}>Material ya cubierto</span>
        ) : (
          <span style={{ fontSize:11, color:"#555" }}>{material.items.length} art.</span>
        )}
        {material.unmatched.length > 0 && <span style={{ fontSize:11, color:"#ffb347" }}>⚠️ {material.unmatched.length}</span>}
        {note && <span style={{ fontSize:11, color:"#4fc3f7" }}>📝</span>}
        {anexos.length > 0 && <span style={{ fontSize:11, color:"#AFA9EC" }}>📎 {anexos.length}</span>}

        {isCipi && (
          <div onClick={e => e.stopPropagation()} style={{ display:"flex", gap:2 }}>
            {["PRO","PED"].map(v => (
              <button key={v} onClick={async () => {
                  setCipiVariant(v);
                  try {
                    await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${s.id}?updateMask.fieldPaths=cipiVariant`,
                      { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
                        body: JSON.stringify({ fields: { cipiVariant: { stringValue: v } } }) });
                    setSessions(prev => prev.map(x => x.id === s.id ? { ...x, cipiVariant: v } : x));
                  } catch (err) { /* si falla, la app sigue funcionando con el valor local */ }
                }}
                title={v === "PRO" ? "Centro de Infusión Profesional Integral" : "Centro de Infusión Pediátrica Integral"}
                style={{ padding:"2px 8px", borderRadius:6, fontSize:10, fontWeight:600, cursor:"pointer",
                  background: cipiVariant===v ? "rgba(175,169,236,0.15)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${cipiVariant===v ? "rgba(175,169,236,0.4)" : "rgba(255,255,255,0.08)"}`,
                  color: cipiVariant===v ? "#AFA9EC" : "#666" }}>
                {v}
              </button>
            ))}
          </div>
        )}

        {mode === "captura" ? (
          <div onClick={e => e.stopPropagation()}>
            <MaterialModal session={s} token={token} user={user} onRefresh={onRefresh} compact
              label={s.materialSolicitudGuardada ? "✓ Solicitud guardada" : "🧰 Solicitar material"} />
          </div>
        ) : (
          <>
            <div onClick={e => e.stopPropagation()}>
              <MaterialModal session={s} token={token} user={user} onRefresh={onRefresh} compact label="✏️ Editar solicitud" />
            </div>

            {!docsRevealed ? (
              <button onClick={e => { e.stopPropagation(); setDocsRevealed(true); }}
                style={{ padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.1)", border:"1px solid rgba(0,212,170,0.25)", color:"#00d4aa" }}>
                📄 Generar documento
              </button>
            ) : (
              <>
                <button onClick={async e => { e.stopPropagation(); await downloadPharmacyOrder(s, material, note, cipiVariant, "medicamentos"); await markPedidoHecho("medsPedidoGeneradoAt"); }}
                  title={medsHecho ? `Medicamentos solicitados ${new Date(s.medsPedidoGeneradoAt).toLocaleString("es-MX")} — clic para volver a descargar` : "Solicitar medicamentos (con anticipación)"}
                  style={{ padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor:"pointer",
                    background: medsHecho ? "rgba(255,255,255,0.05)" : "rgba(0,212,170,0.1)",
                    border: `1px solid ${medsHecho ? "rgba(255,255,255,0.1)" : "rgba(0,212,170,0.25)"}`,
                    color: medsHecho ? "#666" : "#00d4aa" }}>
                  {medsHecho ? "✓ Medicamentos" : "💊 Medicamentos"}
                </button>

                <button onClick={async e => { e.stopPropagation(); await downloadPharmacyOrder(s, material, note, cipiVariant, "material"); await markPedidoHecho("materialPedidoGeneradoAt"); }}
                  title={materialHecho ? `Material solicitado ${new Date(s.materialPedidoGeneradoAt).toLocaleString("es-MX")} — clic para volver a descargar` : "Solicitar material (días antes o el mismo día)"}
                  style={{ padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor:"pointer",
                    background: materialHecho ? "rgba(255,255,255,0.05)" : "rgba(0,212,170,0.1)",
                    border: `1px solid ${materialHecho ? "rgba(255,255,255,0.1)" : "rgba(0,212,170,0.25)"}`,
                    color: materialHecho ? "#666" : "#00d4aa" }}>
                  {materialHecho ? "✓ Material" : "🧰 Material"}
                </button>

                {showAnexo && anexos.length < 3 && (
                  <button onClick={e => { e.stopPropagation(); setShowAnexoModal(true); }}
                    title="Anexar material adicional (cambios el día de la sesión o después)"
                    style={{ padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>
                    ➕ Anexar
                  </button>
                )}

                <button onClick={async e => { e.stopPropagation(); await downloadAllTogether(); }}
                  title="Descargar un solo PDF con medicamentos + material + anexos juntos"
                  style={{ padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.1)", border:"1px solid rgba(175,169,236,0.3)", color:"#AFA9EC" }}>
                  📎 Todo junto
                </button>

                <button onClick={e => { e.stopPropagation(); if (!s.inventorySalidaDone) openInvModal(); }}
                  disabled={s.inventorySalidaDone}
                  title={s.inventorySalidaDone ? `Inventario ya dado de baja ${s.inventorySalidaAt ? new Date(s.inventorySalidaAt).toLocaleString("es-MX") : ""}` : "Descontar del inventario el material de esta sesión"}
                  style={{ padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor: s.inventorySalidaDone ? "default" : "pointer",
                    background: s.inventorySalidaDone ? "rgba(0,212,170,0.08)" : "rgba(255,107,107,0.1)",
                    border: `1px solid ${s.inventorySalidaDone ? "rgba(0,212,170,0.2)" : "rgba(255,107,107,0.25)"}`,
                    color: s.inventorySalidaDone ? "#00d4aa" : "#ff6b6b" }}>
                  {s.inventorySalidaDone ? "✓ Inventario dado de baja" : "📦 Dar de baja inventario"}
                </button>
              </>
            )}
          </>
        )}

        <button onClick={toggleExcludeFromOrder}
          title={s.excludeFromOrder ? "Volver a cargar material en esta sesión" : "Marcar que el material de esta sesión ya está cubierto (ej. se pidió para varios días de una vez) y no incluirla en el consolidado"}
          style={{ padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:600, cursor:"pointer",
            background: s.excludeFromOrder ? "rgba(136,136,136,0.15)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${s.excludeFromOrder ? "rgba(136,136,136,0.4)" : "rgba(255,255,255,0.08)"}`,
            color: s.excludeFromOrder ? "#aaa" : "#666" }}>
          {s.excludeFromOrder ? "↺ Volver a cargar" : "🚫 Ya cubierto"}
        </button>

        <span style={{ color:"#555" }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
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
          {anexos.map((an,ai) => (
            <div key={ai} style={{ marginTop:8, padding:"8px 10px", borderRadius:8, background:"rgba(175,169,236,0.06)" }}>
              <div style={{ fontSize:11, color:"#AFA9EC", fontWeight:600, marginBottom:4 }}>Anexo {an.number} — {new Date(an.generatedAt).toLocaleDateString("es-MX")}</div>
              {(an.items||[]).map((t,ti) => (
                <div key={ti} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#ccc", padding:"2px 0" }}>
                  <span>{t.item}</span><span style={{ color:"#AFA9EC" }}>{t.qty}</span>
                </div>
              ))}
              {an.note && <div style={{ fontSize:10, color:"#888", marginTop:4 }}>{an.note}</div>}
            </div>
          ))}
        </div>
      )}

      {showAnexoModal && (
        <div onClick={e => { e.stopPropagation(); !savingAnexo && setShowAnexoModal(false); }}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:440, maxHeight:"85vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>
            <div>
              <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>📎 Anexo {anexos.length + 1} — {s.patientName}</div>
              <div style={{ fontSize:12, color:"#888", marginTop:2 }}>Material adicional por cambios el día de la sesión o después (máximo 3 anexos)</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <input value={anexoSearch} onChange={e => setAnexoSearch(e.target.value)} placeholder="Buscar en el catálogo..." style={inputStyle} />
              <input type="number" min="1" value={anexoQty} onChange={e => setAnexoQty(e.target.value)} style={{ ...inputStyle, width:60 }} />
            </div>
            {anexoSearch.trim().length >= 2 && (
              <div style={{ display:"flex", flexDirection:"column", gap:3, maxHeight:140, overflowY:"auto" }}>
                {MASTER_CATALOG.filter(c => c.item.toUpperCase().includes(anexoSearch.toUpperCase())).slice(0,6).map((c,i) => (
                  <button key={i} onClick={() => { setAnexoItems(prev => [...prev, { item:c.item, qty: parseInt(anexoQty)||1 }]); setAnexoSearch(""); }}
                    style={{ textAlign:"left", padding:"6px 9px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", color:"#ccc" }}>
                    + {c.item}
                  </button>
                ))}
              </div>
            )}
            {anexoItems.length > 0 && (
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {anexoItems.map((it,i) => (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ flex:1, fontSize:11, color:"#ccc" }}>{it.item}</span>
                    <span style={{ fontSize:11, color:"#ffb347" }}>{it.qty}</span>
                    <button onClick={() => setAnexoItems(prev => prev.filter((_,pi)=>pi!==i))} style={{ padding:"2px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <textarea value={anexoNote} onChange={e => setAnexoNote(e.target.value)} placeholder="Motivo del anexo (opcional)" rows={2}
              style={{ ...inputStyle, resize:"vertical" }} />
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setShowAnexoModal(false)} disabled={savingAnexo} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>Cancelar</button>
              <button onClick={generateAnexo} disabled={savingAnexo || anexoItems.length===0} style={{ flex:2, padding:"9px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"linear-gradient(135deg,#ffb347,#e08e2a)", border:"none", color:"#000", opacity: (savingAnexo||anexoItems.length===0)?0.5:1 }}>
                {savingAnexo ? "Generando…" : `✓ Generar Anexo ${anexos.length+1}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showInvModal && (
        <div onClick={() => !savingInv && setShowInvModal(false)}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:440, maxHeight:"85vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>
            <div>
              <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>📦 Dar de baja inventario</div>
              <div style={{ fontSize:12, color:"#888", marginTop:2 }}>{s.patientName} — revisa y ajusta antes de descontar del almacén de {isCipi ? `CIPI (${cipiVariant})` : s.center}</div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:"50vh", overflowY:"auto" }}>
              {invItems.map((it, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", borderRadius:8, background:"rgba(255,255,255,0.02)" }}>
                  <span style={{ flex:1, fontSize:12, color:"#ccc" }}>{it.item}</span>
                  <input type="number" min="0" value={it.qty} onChange={e => setInvQty(i, parseInt(e.target.value) || 0)}
                    style={{ width:56, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"4px 6px", color:"#f0f0f0", fontSize:12, outline:"none", textAlign:"center" }} />
                </div>
              ))}
              {invItems.length === 0 && <div style={{ fontSize:12, color:"#555", textAlign:"center", padding:12 }}>Sin material calculado para esta sesión.</div>}
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setShowInvModal(false)} disabled={savingInv}
                style={{ flex:1, padding:"10px", borderRadius:9, fontSize:13, cursor: savingInv ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cancelar
              </button>
              <button onClick={confirmInvSalida} disabled={savingInv}
                style={{ flex:2, padding:"10px", borderRadius:9, fontSize:13, fontWeight:600, cursor: savingInv ? "wait" : "pointer", background:"linear-gradient(135deg,#ff6b6b,#c94848)", border:"none", color:"#fff", opacity: savingInv ? 0.6 : 1 }}>
                {savingInv ? "Dando de baja…" : "✓ Confirmar baja de inventario"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Insumos() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  // Solo Paola Vargas puede ver ambos centros siendo enfermera; el resto solo
  // ve el material/inventario de su propio centro asignado.
  const canSeeAllCenters = isJefe || profile?.name === "Paola Vargas";
  const [tab, setTab] = useState("consolidado");
  const [token, setToken] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [centerFilter, setCenterFilter] = useState(() => canSeeAllCenters ? "Todos" : (profile?.center || "CITIO"));
  useEffect(() => {
    if (!canSeeAllCenters && profile?.center && centerFilter !== profile.center) {
      setCenterFilter(profile.center);
    }
  }, [profile, canSeeAllCenters]);
  const [dateFilter, setDateFilter] = useState("rango"); // "hoy" | "rango" | "todas"
  const [rangeFrom, setRangeFrom] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }));
  const [rangeTo, setRangeTo] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 6); return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }); });
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

  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const load = async () => {
    setLoading(true);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
    const [s, ov] = await Promise.all([fetchUpcomingSessions(token, today), fetchOverrides(token)]);
    setSessions(s.filter(x => Array.isArray(x.meds) && x.meds.length > 0));
    setOverrides(ov);
    setLoading(false);
    setHasLoadedOnce(true);
  };

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  const dateFiltered = dateFilter === "todas" ? sessions.filter(s => !!s.materialSolicitudGuardada)
    : dateFilter === "hoy" ? sessions.filter(s => s.date === today)
    : sessions.filter(s => s.date >= rangeFrom && s.date <= rangeTo && !s.materialSolicitudGuardada); // "rango"
  const filtered = centerFilter === "Todos" ? dateFiltered : dateFiltered.filter(s => s.center === centerFilter);
  const calcOverrides = {
    extraDefaults: overrides.extraDefaults,
    extraCatalog: overrides.extraCatalog,
    puncionOverrides: overrides.puncionOverrides,
    patientDefaultMaterial: overrides.patientDefaultMaterial,
  };
  const perPatient = filtered.map(s => {
    if (s.excludeFromOrder) {
      return { session: s, material: { items: [], unmatched: [] }, note: s.materialNote || "" };
    }
    const preview = computeSessionMaterial(s, calcOverrides);
    return { session: s, material: { items: preview.items, unmatched: preview.unmatched }, note: s.materialNote || "" };
  });

  const grandTotal = {};
  perPatient.forEach(({ material }) => {
    material.items.forEach(({ item, qty }) => { grandTotal[item] = (grandTotal[item] || 0) + qty; });
  });
  const grandTotalList = Object.entries(grandTotal).map(([item, qty]) => ({ item, qty })).sort((a,b) => a.item.localeCompare(b.item));

  const downloadPharmacyOrder = async (s, material, note, cipiVariant, scope = "todo") => {
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

    // Paso 1 (medicamentos, con anticipación) vs paso 2 (material: soluciones +
    // insumos, días antes o el mismo día) vs "todo" (compatibilidad / anexos)
    const sendGroups = scope === "medicamentos" ? { MEDICAMENTOS: groups.MEDICAMENTOS, SOLUCIONES: [], INSUMOS: [] }
      : scope === "material" ? { MEDICAMENTOS: [], SOLUCIONES: groups.SOLUCIONES, INSUMOS: groups.INSUMOS }
      : groups;

    try {
      const res = await fetch("/api/generate-material-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          center: s.center, cipiVariant, patientName: s.patientName, cycle: s.cycle, date: s.date,
          groups: sendGroups, note, scope,
        }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `Error ${res.status}`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      alert("Error al generar el pedido: " + e.message);
    }
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

  if (loading && !hasLoadedOnce) return <div style={{ padding:40, color:"#666", textAlign:"center" }}>Cargando…</div>;

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
            {(canSeeAllCenters ? ["Todos","CITIO","CIPI"] : [profile?.center || "CITIO"]).map(c => (
              <button key={c} onClick={() => setCenterFilter(c)} style={{
                padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
                background: centerFilter===c ? "rgba(79,195,247,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${centerFilter===c ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: centerFilter===c ? "#4fc3f7" : "#666",
              }}>{c}</button>
            ))}
          </div>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            {[["hoy","Hoy"],["rango","Rango de fechas"],["todas","Con solicitud generada"]].map(([val,label]) => (
              <button key={val} onClick={() => setDateFilter(val)} style={{
                padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
                background: dateFilter===val ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${dateFilter===val ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: dateFilter===val ? "#00d4aa" : "#666",
              }}>{label}</button>
            ))}
            {dateFilter === "rango" && (
              <>
                <input type="date" value={rangeFrom} onChange={e => setRangeFrom(e.target.value)}
                  style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"5px 8px", color:"#f0f0f0", fontSize:12 }} />
                <span style={{ fontSize:12, color:"#555" }}>a</span>
                <input type="date" value={rangeTo} onChange={e => setRangeTo(e.target.value)}
                  style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"5px 8px", color:"#f0f0f0", fontSize:12 }} />
              </>
            )}
            <span style={{ marginLeft:"auto", fontSize:12, color:"#555", alignSelf:"center" }}>{perPatient.length} sesión{perPatient.length!==1?"es":""}</span>
          </div>

          <div style={{ background:"rgba(0,212,170,0.05)", border:"1px solid rgba(0,212,170,0.2)", borderRadius:14, padding:16, marginBottom:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontSize:13, color:"#00d4aa", fontWeight:600 }}>Total consolidado ({grandTotalList.length} artículos)</div>
              <button onClick={() => {
                  const rows = grandTotalList.map(t => `<tr><td>${t.item}</td><td style="text-align:right;font-weight:bold;">${t.qty}</td></tr>`).join("");
                  const win = window.open("", "_blank", "width=700,height=900");
                  win.document.write(`<!DOCTYPE html><html><head><title>Total consolidado</title><style>
                    body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#111;}
                    h1{font-size:18px;margin-bottom:2px;} p{font-size:12px;color:#555;margin-top:0;margin-bottom:16px;}
                    table{width:100%;border-collapse:collapse;font-size:12px;}
                    td{padding:6px 8px;border-bottom:1px solid #ddd;}
                  </style></head><body>
                    <h1>Total consolidado de material</h1>
                    <p>${centerFilter} · ${dateFilter === "todas" ? "Con solicitud generada" : dateFilter === "hoy" ? "Hoy" : `${rangeFrom} a ${rangeTo}`} · Generado ${new Date().toLocaleString("es-MX")}</p>
                    <table>${rows}</table>
                    <script>window.onload = () => window.print();<\/script>
                  </body></html>`);
                  win.document.close();
                }}
                style={{ padding:"6px 14px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#ccc" }}>
                🖨️ Imprimir
              </button>
            </div>
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
            {perPatient.map(({ session: s, material, note }, i) => (
              <PatientMaterialRow key={s.id} s={s} material={material} note={note}
                expanded={expandedPatient===i} onToggle={() => setExpandedPatient(p => p===i ? null : i)}
                token={token} user={user} onRefresh={load} setSessions={setSessions}
                downloadPharmacyOrder={downloadPharmacyOrder} showAnexo={dateFilter==="todas"}
                mode={dateFilter==="todas" ? "solicitud" : "captura"} />
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
