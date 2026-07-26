import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { PROJECT_ID, FIRESTORE_BASE_URL, IS_TEST_ENV } from "../config";
import { MASTER_CATALOG } from "../data/materialCatalog";

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

async function fetchCollection(token, collectionId, limit = 1000) {
  const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

// El almacén ahora se identifica por centro real: CITIO, CIPI_PED, CIPI_PRO
// (CIPI se dividió en dos almacenes separados por variante).
const WAREHOUSES = [
  { key: "CITIO", label: "CITIO" },
  { key: "CIPI_PRO", label: "CIPI (Profesional)" },
  { key: "CIPI_PED", label: "CIPI (Pediátrico)" },
];

function inventoryDocId(warehouse, item) {
  return `${warehouse}_${item}`.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 200);
}

export default function Inventario() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const [tab, setTab] = useState("existencias"); // "existencias" | "movimientos"
  const [warehouse, setWarehouse] = useState("CITIO");
  const [token, setToken] = useState("");
  const [inventory, setInventory] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedEvent, setExpandedEvent] = useState(null);

  const [showMoveModal, setShowMoveModal] = useState(null); // "entrada" | "salida" | null
  const [moveList, setMoveList] = useState([]); // [{item, qty}] -- varios artículos por movimiento
  const [moveSearch, setMoveSearch] = useState("");
  const [moveQty, setMoveQty] = useState("1");
  const [moveReason, setMoveReason] = useState("");
  const [invoiceFolio, setInvoiceFolio] = useState(""); // folio fiscal opcional, para relacionar con una factura
  const [saving, setSaving] = useState(false);
  const [xmlReview, setXmlReview] = useState(null); // [{descripcion, cantidad, matchedItem}] mientras se revisa antes de agregar

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const t = await user.getIdToken(true);
      setToken(t);
      const [inv, ev] = await Promise.all([
        fetchCollection(t, "inventory"),
        fetchCollection(t, "inventory_events"),
      ]);
      setInventory(inv);
      setEvents(ev.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setHasLoadedOnce(true);
    }
  };

  useEffect(() => { load(); }, [user]);

  const warehouseInventory = inventory.filter(i => i.warehouse === warehouse);
  const filteredInventory = search.trim()
    ? warehouseInventory.filter(i => i.item.toUpperCase().includes(search.toUpperCase()))
    : warehouseInventory;
  const lowStock = warehouseInventory.filter(i => i.currentStock <= (i.minStock ?? 0));

  const addToMoveList = (item) => {
    const qty = parseInt(moveQty) || 1;
    setMoveList(prev => {
      const existing = prev.find(x => x.item === item);
      if (existing) return prev.map(x => x.item === item ? { ...x, qty: x.qty + qty } : x);
      return [...prev, { item, qty }];
    });
    setMoveSearch(""); setMoveQty("1");
  };
  const removeFromMoveList = (item) => setMoveList(prev => prev.filter(x => x.item !== item));
  const setMoveListQty = (item, qty) => setMoveList(prev => prev.map(x => x.item === item ? { ...x, qty: Math.max(0, qty) } : x));

  // Busca en el catálogo el artículo que mejor coincida con la descripción
  // que trae la factura (nunca son idénticas letra por letra).
  const suggestCatalogMatch = (descripcion) => {
    const up = (descripcion || "").toUpperCase().trim();
    if (!up) return "";
    const exact = MASTER_CATALOG.find(c => c.item.toUpperCase() === up);
    if (exact) return exact.item;
    const contains = MASTER_CATALOG.find(c => up.includes(c.item.toUpperCase()) || c.item.toUpperCase().includes(up));
    if (contains) return contains.item;
    // Coincidencia por palabras compartidas (al menos 2 palabras en común)
    const upWords = new Set(up.split(/\s+/).filter(w => w.length > 2));
    let best = null, bestScore = 0;
    MASTER_CATALOG.forEach(c => {
      const cWords = c.item.toUpperCase().split(/\s+/);
      const score = cWords.filter(w => upWords.has(w)).length;
      if (score > bestScore) { bestScore = score; best = c.item; }
    });
    return bestScore >= 2 ? best : "";
  };

  const handleXmlFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, "text/xml");
      if (xmlDoc.querySelector("parsererror")) throw new Error("El archivo no es un XML válido.");

      let conceptos = xmlDoc.getElementsByTagName("cfdi:Concepto");
      if (conceptos.length === 0) conceptos = xmlDoc.getElementsByTagName("Concepto");
      if (conceptos.length === 0) throw new Error("No se encontraron conceptos en la factura -- ¿es un CFDI válido?");

      const review = Array.from(conceptos).map(c => {
        const descripcion = c.getAttribute("Descripcion") || "";
        const cantidad = Math.round(parseFloat(c.getAttribute("Cantidad")) || 1);
        return { descripcion, cantidad, matchedItem: suggestCatalogMatch(descripcion) };
      });
      setXmlReview(review);

      let uuidNode = xmlDoc.getElementsByTagName("tfd:TimbreFiscalDigital")[0] || xmlDoc.getElementsByTagName("TimbreFiscalDigital")[0];
      const uuid = uuidNode?.getAttribute("UUID") || "";
      if (uuid) setInvoiceFolio(uuid);
    } catch (e) {
      alert("Error al leer la factura: " + e.message);
    }
  };

  const confirmXmlReview = () => {
    const unmatched = xmlReview.filter(r => !r.matchedItem);
    if (unmatched.length > 0) {
      if (!confirm(`${unmatched.length} artículo(s) de la factura no tienen un emparejamiento elegido y NO se agregarán. ¿Continuar de todas formas?`)) return;
    }
    setMoveList(prev => {
      const map = new Map(prev.map(x => [x.item, x.qty]));
      xmlReview.filter(r => r.matchedItem).forEach(r => {
        map.set(r.matchedItem, (map.get(r.matchedItem) || 0) + r.cantidad);
      });
      return Array.from(map, ([item, qty]) => ({ item, qty }));
    });
    setXmlReview(null);
  };

  const registerMovement = async () => {
    if (moveList.length === 0) { alert("Agrega al menos un artículo."); return; }
    setSaving(true);
    try {
      const type = showMoveModal; // "entrada" | "salida"

      // Actualizar existencias de cada artículo -- ahora se PERMITE negativo,
      // para reflejar que ya se usó algo que aún no se ha registrado como
      // recibido (ej. hay un ingreso pendiente de factura).
      for (const { item, qty } of moveList) {
        const docId = inventoryDocId(warehouse, item);
        const existing = inventory.find(i => i.id === docId);
        const currentStock = existing?.currentStock ?? 0;
        const minStock = existing?.minStock ?? 0;
        const catalogEntry = MASTER_CATALOG.find(c => c.item === item);
        const newStock = type === "entrada" ? currentStock + qty : currentStock - qty;

        await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            item: { stringValue: item }, warehouse: { stringValue: warehouse },
            category: { stringValue: catalogEntry?.category || existing?.category || "" },
            unit: { stringValue: catalogEntry?.unit || existing?.unit || "PIEZA" },
            currentStock: toFV(newStock), minStock: toFV(minStock),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}),
        });
      }

      // Un solo evento con todos los artículos juntos (no un renglón por
      // artículo), para poder resumir por movimiento en vez de por producto.
      const eventFields = {
        type: { stringValue: type },
        warehouse: { stringValue: warehouse },
        items: toFV(moveList),
        reason: { stringValue: moveReason || "" },
        invoiceFolio: { stringValue: invoiceFolio || "" },
        userEmail: { stringValue: profile?.email || user?.email || "" },
        createdAt: { stringValue: new Date().toISOString() },
      };
      await fetch(`${FIRESTORE_BASE_URL}/inventory_events`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: eventFields }),
      });

      setShowMoveModal(null); setMoveList([]); setMoveReason(""); setInvoiceFolio("");
      load();
    } catch (e) {
      alert("Error al registrar el movimiento: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const setMinStock = async (docId, newMin) => {
    try {
      await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}?updateMask.fieldPaths=minStock`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: { minStock: toFV(parseInt(newMin) || 0) } }),
      });
      setInventory(prev => prev.map(i => i.id === docId ? { ...i, minStock: parseInt(newMin) || 0 } : i));
    } catch (e) { console.error(e); }
  };

  const inputStyle = { background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"8px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };

  if (loading && !hasLoadedOnce) return <div style={{ padding:40, color:"#666", textAlign:"center" }}>Cargando…</div>;

  return (
    <div style={{ padding:"24px 28px", maxWidth:900, margin:"0 auto" }}>
      {IS_TEST_ENV && (
        <div style={{ marginBottom:16, padding:"8px 14px", borderRadius:9, background:"rgba(255,179,71,0.12)", border:"1px solid rgba(255,179,71,0.3)", color:"#ffb347", fontSize:12, fontWeight:600, textAlign:"center" }}>
          ⚠️ Estás en el entorno de PRUEBAS ({PROJECT_ID}) — estos datos no son reales
        </div>
      )}

      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Inventario</h1>
        <p style={{ fontSize:13, color:"#555" }}>Existencias y movimientos de entrada/salida de material</p>
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
        {WAREHOUSES.map(w => (
          <button key={w.key} onClick={() => setWarehouse(w.key)} style={{
            padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
            background: warehouse===w.key ? "rgba(79,195,247,0.12)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${warehouse===w.key ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.08)"}`,
            color: warehouse===w.key ? "#4fc3f7" : "#666",
          }}>{w.label}</button>
        ))}
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:20, borderBottom:"1px solid rgba(255,255,255,0.07)" }}>
        {[["existencias","Existencias"],["movimientos","Movimientos"]].map(([val,label]) => (
          <button key={val} onClick={() => setTab(val)} style={{
            padding:"10px 16px", fontSize:13, fontWeight:600, cursor:"pointer", background:"none", border:"none",
            borderBottom: tab===val ? "2px solid #00d4aa" : "2px solid transparent",
            color: tab===val ? "#00d4aa" : "#666",
          }}>{label}</button>
        ))}
      </div>

      {tab === "existencias" && (
        <div>
          <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            <input placeholder="Buscar artículo..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, flex:1, minWidth:200 }} />
            <button onClick={() => { setShowMoveModal("entrada"); setMoveList([]); setXmlReview(null); setInvoiceFolio(""); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
              ↓ Registrar entrada
            </button>
            <button onClick={() => { setShowMoveModal("salida"); setMoveList([]); setXmlReview(null); setInvoiceFolio(""); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
              ↑ Registrar salida
            </button>
          </div>

          {lowStock.length > 0 && (
            <div style={{ marginBottom:16, padding:"10px 14px", borderRadius:10, background:"rgba(255,107,107,0.08)", border:"1px solid rgba(255,107,107,0.25)" }}>
              <div style={{ fontSize:12, color:"#ff6b6b", fontWeight:600, marginBottom:4 }}>⚠️ {lowStock.length} artículo{lowStock.length!==1?"s":""} en o bajo el mínimo</div>
              <div style={{ fontSize:11, color:"#ffb0b0" }}>{lowStock.map(i => i.item).join(", ")}</div>
            </div>
          )}

          {filteredInventory.length === 0 ? (
            <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
              Sin existencias registradas todavía en este almacén. Usa "Registrar entrada" para empezar a cargar inventario.
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {filteredInventory.sort((a,b) => a.item.localeCompare(b.item)).map(i => {
                const low = i.currentStock <= (i.minStock ?? 0);
                const negative = i.currentStock < 0;
                return (
                  <div key={i.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:10, background: negative ? "rgba(255,107,107,0.06)" : "rgba(255,255,255,0.03)", border:`1px solid ${negative ? "rgba(255,107,107,0.4)" : low ? "rgba(255,107,107,0.3)" : "rgba(255,255,255,0.07)"}` }}>
                    <span style={{ flex:1, fontSize:13, color:"#f0f0f0" }}>{i.item}</span>
                    <span style={{ fontSize:10, color:"#555" }}>{i.category}</span>
                    {negative && (
                      <span title="Existencia negativa: ya se usó más de lo registrado como recibido -- probablemente hay un ingreso pendiente de capturar"
                        style={{ fontSize:10, color:"#ff6b6b", background:"rgba(255,107,107,0.12)", padding:"2px 8px", borderRadius:99, fontWeight:600 }}>
                        ⚠ ingreso pendiente
                      </span>
                    )}
                    <span style={{ fontSize:14, fontWeight:700, color: negative ? "#ff6b6b" : low ? "#ffb347" : "#00d4aa", fontFamily:"'IBM Plex Mono', monospace", minWidth:60, textAlign:"right" }}>{i.currentStock} {i.unit}</span>
                    {isJefe && (
                      <input type="number" defaultValue={i.minStock ?? 0} title="Mínimo antes de avisar"
                        onBlur={e => setMinStock(i.id, e.target.value)}
                        style={{ width:50, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"3px 6px", color:"#888", fontSize:11, outline:"none", textAlign:"center" }} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "movimientos" && (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {events.filter(e => e.warehouse === warehouse).length === 0 ? (
            <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
              Sin movimientos registrados todavía en este almacén.
            </div>
          ) : events.filter(e => e.warehouse === warehouse).map(ev => {
            const isOpen = expandedEvent === ev.id;
            const itemCount = (ev.items || []).length;
            return (
              <div key={ev.id} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
                <div onClick={() => setExpandedEvent(isOpen ? null : ev.id)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ fontSize:11, padding:"3px 10px", borderRadius:99, background: ev.type==="entrada" ? "rgba(0,212,170,0.12)" : "rgba(255,107,107,0.1)", color: ev.type==="entrada" ? "#00d4aa" : "#ff6b6b" }}>
                    {ev.type==="entrada" ? "↓ Entrada" : "↑ Salida"}
                  </span>
                  <span style={{ fontSize:13, color:"#f0f0f0" }}>{itemCount} artículo{itemCount!==1?"s":""}</span>
                  {ev.sessionPatientName && <span style={{ fontSize:12, color:"#4fc3f7" }}>👤 {ev.sessionPatientName}</span>}
                  {ev.invoiceFolio && <span style={{ fontSize:11, color:"#AFA9EC" }}>📄 {ev.invoiceFolio}</span>}
                  {ev.reason && <span style={{ fontSize:11, color:"#888" }}>{ev.reason}</span>}
                  <span style={{ marginLeft:"auto", fontSize:11, color:"#555" }}>{ev.createdAt ? new Date(ev.createdAt).toLocaleString("es-MX") : ""}</span>
                  <span style={{ color:"#555" }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {isOpen && (
                  <div style={{ padding:"0 16px 14px", display:"flex", flexDirection:"column", gap:4 }}>
                    {(ev.items || []).map((it, i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#ccc", padding:"3px 0" }}>
                        <span>{it.item}</span><span style={{ color: ev.type==="entrada" ? "#00d4aa" : "#ff6b6b" }}>{it.qty}</span>
                      </div>
                    ))}
                    {/* Quién lo hizo: solo visible para el jefe */}
                    {isJefe && (
                      <div style={{ marginTop:8, paddingTop:8, borderTop:"1px solid rgba(255,255,255,0.06)", fontSize:11, color:"#666" }}>
                        Registrado por: {ev.userEmail || "—"}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showMoveModal && (
        <div onClick={() => !saving && (setShowMoveModal(null), setXmlReview(null))}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:460, maxHeight:"85vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>
              {showMoveModal === "entrada" ? "↓ Registrar entrada" : "↑ Registrar salida"} — {WAREHOUSES.find(w=>w.key===warehouse)?.label}
            </div>

            {showMoveModal === "entrada" && !xmlReview && (
              <label style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"10px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.1)", border:"1px dashed rgba(175,169,236,0.35)", color:"#AFA9EC" }}>
                📄 Cargar factura (XML)
                <input type="file" accept=".xml" style={{ display:"none" }} onChange={e => handleXmlFile(e.target.files?.[0])} />
              </label>
            )}

            {xmlReview && (
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                <div style={{ fontSize:12, color:"#AFA9EC", fontWeight:600 }}>Revisa el emparejamiento antes de agregar ({xmlReview.length} conceptos)</div>
                <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:280, overflowY:"auto" }}>
                  {xmlReview.map((r, i) => (
                    <div key={i} style={{ padding:"8px 10px", borderRadius:8, background: r.matchedItem ? "rgba(255,255,255,0.03)" : "rgba(255,107,107,0.06)", border:`1px solid ${r.matchedItem ? "rgba(255,255,255,0.07)" : "rgba(255,107,107,0.25)"}` }}>
                      <div style={{ fontSize:11, color:"#666", marginBottom:4 }}>Factura: "{r.descripcion}" · cant. {r.cantidad}</div>
                      <select value={r.matchedItem} onChange={e => setXmlReview(prev => prev.map((x,xi) => xi===i ? { ...x, matchedItem: e.target.value } : x))}
                        style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"6px 8px", color: r.matchedItem ? "#f0f0f0" : "#ff6b6b", fontSize:12, outline:"none", cursor:"pointer" }}>
                        <option value="">— Sin emparejar (no se agregará) —</option>
                        {MASTER_CATALOG.map((c,ci) => <option key={ci} value={c.item}>{c.item}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => setXmlReview(null)} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                    Cancelar
                  </button>
                  <button onClick={confirmXmlReview} style={{ flex:2, padding:"9px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.15)", border:"1px solid rgba(175,169,236,0.4)", color:"#AFA9EC" }}>
                    ✓ Agregar {xmlReview.filter(r=>r.matchedItem).length} artículo{xmlReview.filter(r=>r.matchedItem).length!==1?"s":""} a la lista
                  </button>
                </div>
              </div>
            )}

            {!xmlReview && (
            <div>
              <input placeholder="Buscar artículo del catálogo..." value={moveSearch} onChange={e => setMoveSearch(e.target.value)} style={inputStyle} autoFocus />
              {moveSearch.trim().length >= 2 && (
                <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:3, maxHeight:160, overflowY:"auto" }}>
                  {MASTER_CATALOG.filter(c => c.item.toUpperCase().includes(moveSearch.toUpperCase())).slice(0, 10).map((c, i) => (
                    <button key={i} onClick={() => addToMoveList(c.item)}
                      style={{ textAlign:"left", padding:"7px 10px", borderRadius:6, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", color:"#ccc" }}>
                      + {c.item}
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}

            {/* Lista de artículos ya agregados a este movimiento -- pueden ser varios */}
            {moveList.length > 0 && (
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:200, overflowY:"auto" }}>
                {moveList.map((it, i) => (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", borderRadius:8, background:"rgba(255,255,255,0.03)" }}>
                    <span style={{ flex:1, fontSize:12, color:"#f0f0f0" }}>{it.item}</span>
                    <input type="number" min="0" value={it.qty} onChange={e => setMoveListQty(it.item, parseInt(e.target.value) || 0)}
                      style={{ width:56, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"4px 6px", color:"#f0f0f0", fontSize:12, outline:"none", textAlign:"center" }} />
                    <button onClick={() => removeFromMoveList(it.item)} style={{ padding:"3px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Folio de factura (opcional)</label>
              <input placeholder="Ej. folio fiscal / UUID del CFDI" value={invoiceFolio} onChange={e => setInvoiceFolio(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Motivo (opcional)</label>
              <input placeholder={showMoveModal === "entrada" ? "Ej. compra a proveedor" : "Ej. consumo, merma"} value={moveReason} onChange={e => setMoveReason(e.target.value)} style={inputStyle} />
            </div>

            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setShowMoveModal(null)} disabled={saving} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, cursor: saving ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cancelar
              </button>
              <button onClick={registerMovement} disabled={saving || moveList.length===0} style={{ flex:2, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor: (saving || moveList.length===0) ? "not-allowed" : "pointer",
                background: showMoveModal === "entrada" ? "linear-gradient(135deg,#00d4aa,#0F6E56)" : "linear-gradient(135deg,#ff6b6b,#c94848)", border:"none", color:"#fff", opacity: (saving || moveList.length===0) ? 0.5 : 1 }}>
                {saving ? "Guardando…" : `✓ Guardar (${moveList.length} artículo${moveList.length!==1?"s":""})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
