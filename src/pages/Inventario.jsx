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

// El ID del documento de inventario combina centro + artículo, para llevar
// existencias separadas por centro (son ubicaciones físicas distintas).
function inventoryDocId(center, item) {
  const clean = `${center}_${item}`.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 200);
  return clean;
}

export default function Inventario() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const [tab, setTab] = useState("existencias"); // "existencias" | "movimientos"
  const [center, setCenter] = useState(profile?.center || "CITIO");
  const [token, setToken] = useState("");
  const [inventory, setInventory] = useState([]);
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [search, setSearch] = useState("");

  const [showMoveModal, setShowMoveModal] = useState(null); // "entrada" | "salida" | null
  const [moveItem, setMoveItem] = useState("");
  const [moveSearch, setMoveSearch] = useState("");
  const [moveQty, setMoveQty] = useState("1");
  const [moveReason, setMoveReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const t = await user.getIdToken(true);
      setToken(t);
      const [inv, mov] = await Promise.all([
        fetchCollection(t, "inventory"),
        fetchCollection(t, "inventory_movements"),
      ]);
      setInventory(inv);
      setMovements(mov.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setHasLoadedOnce(true);
    }
  };

  useEffect(() => { load(); }, [user]);

  const centerInventory = inventory.filter(i => i.center === center);
  const filteredInventory = search.trim()
    ? centerInventory.filter(i => i.item.toUpperCase().includes(search.toUpperCase()))
    : centerInventory;
  const lowStock = centerInventory.filter(i => i.currentStock <= (i.minStock ?? 0));

  const registerMovement = async () => {
    if (!moveItem || !moveQty || parseInt(moveQty) <= 0) { alert("Elige un artículo y una cantidad válida."); return; }
    setSaving(true);
    try {
      const qty = parseInt(moveQty);
      const type = showMoveModal; // "entrada" | "salida"
      const docId = inventoryDocId(center, moveItem);
      const existing = inventory.find(i => i.id === docId);
      const currentStock = existing?.currentStock ?? 0;
      const minStock = existing?.minStock ?? 0;
      const newStock = type === "entrada" ? currentStock + qty : Math.max(0, currentStock - qty);

      const catalogEntry = MASTER_CATALOG.find(c => c.item === moveItem);
      const invFields = {
        item: { stringValue: moveItem },
        center: { stringValue: center },
        category: { stringValue: catalogEntry?.category || existing?.category || "" },
        unit: { stringValue: catalogEntry?.unit || existing?.unit || "PIEZA" },
        currentStock: toFV(newStock),
        minStock: toFV(minStock),
        lastUpdated: { stringValue: new Date().toISOString() },
      };
      await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: invFields }),
      });

      const movFields = {
        item: { stringValue: moveItem },
        center: { stringValue: center },
        type: { stringValue: type },
        qty: toFV(qty),
        reason: { stringValue: moveReason || "" },
        userEmail: { stringValue: profile?.email || user?.email || "" },
        createdAt: { stringValue: new Date().toISOString() },
      };
      await fetch(`${FIRESTORE_BASE_URL}/inventory_movements`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: movFields }),
      });

      setShowMoveModal(null); setMoveItem(""); setMoveSearch(""); setMoveQty("1"); setMoveReason("");
      load();
    } catch (e) {
      alert("Error al registrar el movimiento: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const setMinStock = async (docId, item, newMin) => {
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

      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        {["CITIO","CIPI"].map(c => (
          <button key={c} onClick={() => setCenter(c)} style={{
            padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
            background: center===c ? "rgba(79,195,247,0.12)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${center===c ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.08)"}`,
            color: center===c ? "#4fc3f7" : "#666",
          }}>{c}</button>
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
            <button onClick={() => setShowMoveModal("entrada")} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
              ↓ Registrar entrada
            </button>
            <button onClick={() => setShowMoveModal("salida")} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
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
              Sin existencias registradas todavía en {center}. Usa "Registrar entrada" para empezar a cargar inventario.
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {filteredInventory.sort((a,b) => a.item.localeCompare(b.item)).map(i => {
                const low = i.currentStock <= (i.minStock ?? 0);
                return (
                  <div key={i.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:10, background:"rgba(255,255,255,0.03)", border:`1px solid ${low ? "rgba(255,107,107,0.3)" : "rgba(255,255,255,0.07)"}` }}>
                    <span style={{ flex:1, fontSize:13, color:"#f0f0f0" }}>{i.item}</span>
                    <span style={{ fontSize:10, color:"#555" }}>{i.category}</span>
                    <span style={{ fontSize:14, fontWeight:700, color: low ? "#ff6b6b" : "#00d4aa", fontFamily:"'IBM Plex Mono', monospace", minWidth:60, textAlign:"right" }}>{i.currentStock} {i.unit}</span>
                    {isJefe && (
                      <input type="number" min="0" defaultValue={i.minStock ?? 0} title="Mínimo antes de avisar"
                        onBlur={e => setMinStock(i.id, i.item, e.target.value)}
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
          {movements.filter(m => m.center === center).length === 0 ? (
            <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
              Sin movimientos registrados todavía en {center}.
            </div>
          ) : movements.filter(m => m.center === center).map(m => (
            <div key={m.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:10, background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)" }}>
              <span style={{ fontSize:11, padding:"3px 10px", borderRadius:99, background: m.type==="entrada" ? "rgba(0,212,170,0.12)" : "rgba(255,107,107,0.1)", color: m.type==="entrada" ? "#00d4aa" : "#ff6b6b" }}>
                {m.type==="entrada" ? "↓ Entrada" : "↑ Salida"}
              </span>
              <span style={{ flex:1, fontSize:13, color:"#f0f0f0" }}>{m.item}</span>
              <span style={{ fontSize:13, fontWeight:700, color:"#ccc", fontFamily:"'IBM Plex Mono', monospace" }}>{m.qty}</span>
              <span style={{ fontSize:11, color:"#666" }}>{m.userEmail}</span>
              <span style={{ fontSize:11, color:"#555" }}>{m.createdAt ? new Date(m.createdAt).toLocaleString("es-MX") : ""}</span>
            </div>
          ))}
        </div>
      )}

      {showMoveModal && (
        <div onClick={() => !saving && setShowMoveModal(null)}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:420, display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>
              {showMoveModal === "entrada" ? "↓ Registrar entrada" : "↑ Registrar salida"} — {center}
            </div>

            {!moveItem ? (
              <div>
                <input placeholder="Buscar artículo del catálogo..." value={moveSearch} onChange={e => setMoveSearch(e.target.value)} style={inputStyle} autoFocus />
                {moveSearch.trim().length >= 2 && (
                  <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:3, maxHeight:200, overflowY:"auto" }}>
                    {MASTER_CATALOG.filter(c => c.item.toUpperCase().includes(moveSearch.toUpperCase())).slice(0, 10).map((c, i) => (
                      <button key={i} onClick={() => { setMoveItem(c.item); setMoveSearch(""); }}
                        style={{ textAlign:"left", padding:"7px 10px", borderRadius:6, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", color:"#ccc" }}>
                        {c.item}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", borderRadius:8, background:"rgba(0,212,170,0.06)", border:"1px solid rgba(0,212,170,0.2)" }}>
                <span style={{ flex:1, fontSize:13, color:"#f0f0f0" }}>{moveItem}</span>
                <button onClick={() => setMoveItem("")} style={{ background:"none", border:"none", color:"#666", cursor:"pointer", fontSize:12 }}>✕</button>
              </div>
            )}

            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Cantidad</label>
              <input type="number" min="1" value={moveQty} onChange={e => setMoveQty(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Motivo (opcional)</label>
              <input placeholder={showMoveModal === "entrada" ? "Ej. compra a proveedor" : "Ej. consumo en sesión, merma"} value={moveReason} onChange={e => setMoveReason(e.target.value)} style={inputStyle} />
            </div>

            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setShowMoveModal(null)} disabled={saving} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, cursor: saving ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cancelar
              </button>
              <button onClick={registerMovement} disabled={saving || !moveItem} style={{ flex:2, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor: (saving || !moveItem) ? "not-allowed" : "pointer",
                background: showMoveModal === "entrada" ? "linear-gradient(135deg,#00d4aa,#0F6E56)" : "linear-gradient(135deg,#ff6b6b,#c94848)", border:"none", color:"#fff", opacity: (saving || !moveItem) ? 0.5 : 1 }}>
                {saving ? "Guardando…" : "✓ Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
