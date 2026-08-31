import { useState, useEffect } from "react";
import { computeSessionMaterial, computeMedicationPieces, getMedicationPresentations, MASTER_CATALOG } from "../data/materialCatalog";
import { useAuth } from "../hooks/useAuth";

import { PROJECT_ID, DATABASE_ID } from "../config";

function parseFirestoreDoc(doc) {
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

async function fetchCatalogOverrides(token) {
  try {
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/settings/materialCatalog`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 404) return { extraCatalog: [], extraDefaults: {}, puncionOverrides: {}, patientDefaultMaterial: null };
    const doc = await res.json();
    const parsed = parseFirestoreDoc(doc);
    return {
      extraCatalog: parsed.extraCatalog || [],
      extraDefaults: parsed.extraDefaults || {},
      puncionOverrides: parsed.puncionOverrides || {},
      patientDefaultMaterial: parsed.patientDefaultMaterial || null,
    };
  } catch (e) {
    return { extraCatalog: [], extraDefaults: {}, puncionOverrides: {}, patientDefaultMaterial: null };
  }
}

function decodeTokenClaims(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return { uid: payload.user_id || payload.sub || null, email: payload.email || null };
  } catch { return { uid: null, email: null }; }
}

async function logAudit(token, collection, docId, changes) {
  try {
    const { uid, email } = decodeTokenClaims(token);
    const toFV = (val) => {
      if (typeof val === "string") return { stringValue:val };
      if (typeof val === "boolean") return { booleanValue:val };
      if (typeof val === "number") return Number.isInteger(val) ? { integerValue:String(val) } : { doubleValue:val };
      if (val === null || val === undefined) return { nullValue:null };
      if (Array.isArray(val)) return { arrayValue:{ values:val.map(toFV) } };
      if (typeof val === "object") return { mapValue:{ fields:Object.fromEntries(Object.entries(val).map(([k,v]) => [k,toFV(v)])) } };
      return { stringValue:String(val) };
    };
    const fields = {
      collection:  { stringValue: collection },
      docId:       { stringValue: docId },
      userId:      uid ? { stringValue: uid } : { nullValue: null },
      userEmail:   email ? { stringValue: email } : { nullValue: null },
      changes:     toFV(changes),
      timestamp:   { stringValue: new Date().toISOString() },
    };
    await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/audit_log`,
      { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields }) });
  } catch (e) {
    console.error("No se pudo registrar la auditoría:", e);
  }
}

async function patchSession(token, sessionId, updates) {
  const toFV = (val) => {
    if (typeof val === "string") return { stringValue:val };
    if (typeof val === "boolean") return { booleanValue:val };
    if (typeof val === "number") return Number.isInteger(val) ? { integerValue:String(val) } : { doubleValue:val };
    if (val === null) return { nullValue:null };
    if (Array.isArray(val)) return { arrayValue:{ values:val.map(toFV) } };
    if (typeof val === "object") return { mapValue:{ fields:Object.fromEntries(Object.entries(val).map(([k,v]) => [k,toFV(v)])) } };
    return { stringValue:String(val) };
  };
  const checkOk = async (res) => {
    if (!res.ok) {
      let msg = `Error ${res.status}`;
      try { const body = await res.json(); msg = body?.error?.message || msg; } catch {}
      throw new Error(msg);
    }
  };
  const simpleUpdates = {}, nestedUpdates = {};
  Object.entries(updates).forEach(([k,v]) => {
    if (k.includes(".")) nestedUpdates[k] = v;
    else simpleUpdates[k] = v;
  });
  if (Object.keys(simpleUpdates).length > 0) {
    const fields = Object.fromEntries(Object.entries(simpleUpdates).map(([k,v]) => [k,toFV(v)]));
    const mask   = Object.keys(simpleUpdates).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${sessionId}?${mask}`,
      { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields }) });
    await checkOk(res);
  }
  for (const [path, value] of Object.entries(nestedUpdates)) {
    const parts = path.split(".");
    const mask  = `updateMask.fieldPaths=${encodeURIComponent(path)}`;
    let fields  = {};
    if (parts.length === 2) fields[parts[0]] = { mapValue:{ fields:{ [parts[1]]:toFV(value) } } };
    else if (parts.length === 3) fields[parts[0]] = { mapValue:{ fields:{ [parts[1]]:{ mapValue:{ fields:{ [parts[2]]:toFV(value) } } } } } };
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${sessionId}?${mask}`,
      { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body:JSON.stringify({ fields }) });
    await checkOk(res);
  }
  logAudit(token, "sessions", sessionId, updates); // no se espera (await) para no retrasar el guardado
}

// Botón + modal de "Solicitar material", como unidad reutilizable. Se le pasa
// la sesión, el token/usuario y un onRefresh (para recargar tras guardar).
export default function MaterialModal({ session, token, user, onRefresh, compact, label }) {
  const { profile } = useAuth();
  const [showMaterialModal, setShowMaterialModal] = useState(false);
  const [catalogOverrides, setCatalogOverrides] = useState(null);
  const [excludePatientDefault, setExcludePatientDefault] = useState(!!session.excludePatientDefault);

  useEffect(() => {
    if (showMaterialModal && catalogOverrides === null) {
      fetchCatalogOverrides(token).then(setCatalogOverrides);
    }
  }, [showMaterialModal]);
  const [catheterType, setCatheterType] = useState(session.catheterType || "");
  const [catheterGauge, setCatheterGauge] = useState(session.catheterGauge || "");
  const [equipoChoice, setEquipoChoice] = useState(session.equipoChoice || "");
  const [excludedItems, setExcludedItems] = useState(session.excludedMaterial || []);
  const [extraItems, setExtraItems] = useState(session.extraMaterial || []);
  const [extraSearch, setExtraSearch] = useState("");
  const [qtyOverrides, setQtyOverrides] = useState(session.qtyOverrides || {});
  const [pieceOverrides, setPieceOverrides] = useState(session.pieceOverrides || {});
  const [materialNote, setMaterialNote] = useState(session.materialNote || "");
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [savingMeds, setSavingMeds] = useState(false);

  // Medicamentos e insumos/soluciones se guardan por separado -- antes un
  // solo "Guardar solicitud" mezclaba ambas categorías, así que no había
  // forma de que el checkup de Paola o tu autorización aplicaran solo a
  // medicamentos sin afectar (o ignorar) los insumos, y viceversa. El
  // cálculo se sigue viendo junto en esta misma pantalla -- solo el
  // guardado quedó separado.
  const saveMedsRequest = async (newPieceOverrides) => {
    setSavingMeds(true);
    try {
      const freshToken = await user.getIdToken(true);
      await patchSession(freshToken, session.id, {
        pieceOverrides: newPieceOverrides,
        medsSolicitudGuardada: true,
        medsSolicitudGuardadaAt: new Date().toISOString(),
        // SOLICITA es quien guarda el cálculo, no quien después descarga el
        // PDF -- "el guardado es su firma" (pueden ser personas distintas si
        // alguien más vuelve a generar el documento después).
        medsRequestedBy: user?.uid || "", medsRequestedByName: profile?.name || "",
        // Cualquier edición invalida el filtro de Paola y tu autorización ya
        // hechos -- el contenido cambió, hay que volver a revisarlo.
        medsValidatedBy: null, medsValidatedByName: null, medsValidatedAt: null, medsValidationSignatureUrl: null,
        medsAuthorizedBy: null, medsAuthorizedByName: null, medsAuthorizedAt: null, medsAuthorizationSignatureUrl: null,
      });
      await onRefresh();
    } catch(e) {
      alert("Error al guardar los medicamentos: " + e.message);
    } finally {
      setSavingMeds(false);
    }
  };

  const saveMaterialRequest = async (newCatheterType, newCatheterGauge, newExtraItems, newExcludedItems, newExcludePatientDefault, newQtyOverrides, newNote, newEquipoChoice) => {
    setSavingMaterial(true);
    try {
      const freshToken = await user.getIdToken(true);
      await patchSession(freshToken, session.id, {
        catheterType: newCatheterType || null,
        catheterGauge: newCatheterGauge || null,
        extraMaterial: newExtraItems,
        excludedMaterial: newExcludedItems,
        excludePatientDefault: !!newExcludePatientDefault,
        qtyOverrides: newQtyOverrides,
        materialNote: newNote || "",
        equipoChoice: newEquipoChoice || null,
        materialSolicitudGuardada: true,
        materialSolicitudGuardadaAt: new Date().toISOString(),
        // SOLICITA es quien guarda el cálculo, no quien después descarga el
        // PDF -- mismo criterio que medicamentos.
        materialRequestedBy: user?.uid || "", materialRequestedByName: profile?.name || "",
        // Cualquier edición del material invalida un checkup ya hecho -- si
        // Paola ya lo había revisado, tiene que volver a revisarlo porque el
        // contenido cambió.
        materialValidatedBy: null,
        materialValidatedByName: null,
        materialValidatedAt: null,
        materialValidationSignatureUrl: null,
      });
      await onRefresh();
    } catch(e) {
      alert("Error al guardar el material: " + e.message);
    } finally {
      setSavingMaterial(false);
    }
  };

  return (
    <>
      <button onClick={e => { e.stopPropagation(); setShowMaterialModal(true); }}
        title="Solicitar material" style={{ padding: compact ? "4px 10px" : "5px 9px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.1)", border:"1px solid rgba(175,169,236,0.3)", color:"#AFA9EC", flexShrink:0 }}>
        {label || "🧰 Solicitar material"}
      </button>

      {showMaterialModal && (() => {
        if (catalogOverrides === null) {
          return (
            <div onClick={e => e.stopPropagation()} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 }}>
              <div style={{ color:"#888", fontSize:13 }}>Cargando catálogo…</div>
            </div>
          );
        }
        const sessionForCalc = { ...session, catheterType, catheterGauge, excludePatientDefault, equipoChoice };
        const calcOverrides = {
          extraDefaults: catalogOverrides.extraDefaults,
          extraCatalog: catalogOverrides.extraCatalog,
          puncionOverrides: catalogOverrides.puncionOverrides,
          patientDefaultMaterial: catalogOverrides.patientDefaultMaterial,
        };
        const preview = computeSessionMaterial(sessionForCalc, calcOverrides);
        const medPieces = (session.meds || [])
          .map((m, idx) => {
            const auto = computeMedicationPieces(m.name, m.dose, catalogOverrides.extraCatalog, catalogOverrides.extraDefaults);
            if (!auto) return null;
            const medKey = `${idx}_${m.name}`;
            const overridden = pieceOverrides[medKey];
            return { medKey, name: m.name, dose: m.dose, calc: overridden ? { ...auto, pieces: overridden } : auto, isOverridden: !!overridden, autoPieces: auto.pieces };
          })
          .filter(Boolean);
        // Combinar defaults + extras, respetando lo excluido y las cantidades editadas, en una sola lista consolidada.
        // Las piezas de medicamento se excluyen de preview.items aquí porque
        // ya se agregan aparte desde medPieces (que refleja la edición en
        // vivo, no solo lo último guardado) -- evita contarlas dos veces.
        const medPieceItemNames = new Set();
        medPieces.forEach(p => {
          getMedicationPresentations(p.name, catalogOverrides.extraCatalog, catalogOverrides.extraDefaults)
            .forEach(pr => medPieceItemNames.add(pr.item));
        });
        const combined = {};
        preview.items.forEach(({ item, qty }) => {
          if (medPieceItemNames.has(item)) return;
          if (excludedItems.includes(item)) return;
          const finalQty = qtyOverrides[item] !== undefined ? qtyOverrides[item] : qty;
          combined[item] = (combined[item]||0) + finalQty;
        });
        medPieces.forEach(p => p.calc.pieces.forEach(({ item, count }) => { combined[item] = (combined[item]||0) + count; }));
        extraItems.forEach(({ item, qty }) => { combined[item] = (combined[item]||0) + (qty||0); });
        const totalList = Object.entries(combined).map(([item, qty]) => ({ item, qty })).sort((a,b) => a.item.localeCompare(b.item));
        const filteredCatalog = extraSearch.trim().length >= 2
          ? [...MASTER_CATALOG, ...catalogOverrides.extraCatalog].filter(c => c.item.toUpperCase().includes(extraSearch.toUpperCase())).slice(0, 8)
          : [];
        const toggleExcluded = (item) => setExcludedItems(prev => prev.includes(item) ? prev.filter(x => x!==item) : [...prev, item]);
        const setItemQty = (item, qty) => setQtyOverrides(prev => ({ ...prev, [item]: qty }));
        const setPieceCount = (medKey, allPresentations, item, mg, newCount) => {
          setPieceOverrides(prev => {
            const currentPieces = prev[medKey] || medPieces.find(p => p.medKey === medKey)?.autoPieces || [];
            const map = new Map(currentPieces.map(p => [p.item, p.count]));
            map.set(item, Math.max(0, newCount));
            // No se filtran los ceros: si la persona puso todo en 0 a propósito
            // (ej. "no hay en existencia, no incluir nada"), eso debe quedar
            // guardado explícito -- de lo contrario no hay forma de distinguir
            // "nunca se tocó" de "se puso en cero a propósito".
            const next = allPresentations.map(pr => ({ item: pr.item, mg: pr.mg, count: map.get(pr.item) || 0 }));
            return { ...prev, [medKey]: next };
          });
        };
        const resetPieceOverride = (medKey) => setPieceOverrides(prev => { const n = { ...prev }; delete n[medKey]; return n; });

        return (
          <div onClick={e => { e.stopPropagation(); !savingMaterial && setShowMaterialModal(false); }}
            style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:480, maxHeight:"88vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:14 }}>
              <div>
                <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>🧰 Solicitar material</div>
                <div style={{ fontSize:12, color:"#888", marginTop:2 }}>{session.patientName} — según medicamentos de la sesión{catheterType && " + acceso venoso"}</div>
              </div>

              <div>
                <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Tipo de acceso venoso</label>
                <div style={{ display:"flex", gap:8 }}>
                  {[["", "Sin definir"], ["periferico", "Periférico"], ["puerto", "Puerto"]].map(([val, label]) => (
                    <button key={val} onClick={() => { setCatheterType(val); setCatheterGauge(""); }}
                      style={{ flex:1, padding:"8px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer",
                        background: catheterType===val ? "rgba(175,169,236,0.15)" : "rgba(255,255,255,0.04)",
                        border: `1px solid ${catheterType===val ? "rgba(175,169,236,0.4)" : "rgba(255,255,255,0.08)"}`,
                        color: catheterType===val ? "#AFA9EC" : "#666" }}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize:10, color:"#555", marginTop:4 }}>Puedes definirlo o cambiarlo aquí mismo aunque el paciente ya haya ingresado.</div>
              </div>

              {catalogOverrides.patientDefaultMaterial && (
                <label style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 12px", borderRadius:9, background:"rgba(0,212,170,0.05)", border:"1px solid rgba(0,212,170,0.2)", cursor:"pointer" }}>
                  <input type="checkbox" checked={!excludePatientDefault} onChange={e => setExcludePatientDefault(!e.target.checked)} />
                  <span style={{ fontSize:12, color:"#ccc" }}>Incluir material base del paciente ({(catalogOverrides.patientDefaultMaterial.insumos?.length||0) + (catalogOverrides.patientDefaultMaterial.soluciones?.length||0)} artículos)</span>
                </label>
              )}

              <div>
                <label style={{ fontSize:11, color: preview.pendingEquipo ? "#ffb347" : "#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Equipo de infusión {preview.pendingEquipo && "(elige uno)"}</label>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  {[
                    ["fotoprotector", "Primario c/ filtro 22 micras fotoprotector"],
                    ["plum", "Plum c/ filtro 0.15 micras"],
                    ["ninguno", "Sin equipo"],
                  ].map(([val, label]) => (
                    <button key={val} onClick={() => setEquipoChoice(val)}
                      style={{ flex:"1 1 auto", padding:"8px 10px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer",
                        background: equipoChoice===val ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
                        border: `1px solid ${equipoChoice===val ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.08)"}`,
                        color: equipoChoice===val ? "#00d4aa" : "#888" }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {preview.pendingAlternatives.map((alt, ai) => (
                <div key={ai}>
                  <label style={{ fontSize:11, color:"#ffb347", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>{alt.label} (elige uno)</label>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                    {alt.options.map((opt, oi) => (
                      <button key={oi} onClick={() => setCatheterGauge(opt.item)}
                        style={{ flex:"1 1 auto", padding:"8px 10px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer",
                          background: catheterGauge===opt.item ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
                          border: `1px solid ${catheterGauge===opt.item ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.08)"}`,
                          color: catheterGauge===opt.item ? "#00d4aa" : "#888" }}>
                        {opt.item}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {preview.unmatched.length > 0 && (
                <div style={{ padding:"8px 12px", borderRadius:8, background:"rgba(255,179,71,0.08)", border:"1px solid rgba(255,179,71,0.25)", fontSize:11, color:"#ffb347" }}>
                  ⚠️ No se encontró material por defecto para: {preview.unmatched.join(", ")}. Agrégalo manualmente abajo si hace falta.
                </div>
              )}

              {preview.unmatchedSolutions.length > 0 && (
                <div style={{ padding:"8px 12px", borderRadius:8, background:"rgba(255,179,71,0.08)", border:"1px solid rgba(255,179,71,0.25)", fontSize:11, color:"#ffb347" }}>
                  ⚠️ No se pudo calcular la solución de: {preview.unmatchedSolutions.map(u => `${u.name} (${u.diluent})`).join(", ")}. Agrégala manualmente abajo si hace falta.
                </div>
              )}

              {medPieces.length > 0 && (
                <div>
                  <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Piezas de medicamento (frascos/ampolletas según dosis — ajustables si en existencia solo hay ciertas presentaciones)</label>
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {medPieces.map((p, i) => {
                      const allPresentations = getMedicationPresentations(p.name, catalogOverrides.extraCatalog, catalogOverrides.extraDefaults);
                      const countFor = (item) => p.calc.pieces.find(pc => pc.item === item)?.count || 0;
                      const totalMg = allPresentations.reduce((acc, pr) => acc + pr.mg * countFor(pr.item), 0);
                      return (
                        <div key={p.medKey} style={{ padding:"8px 10px", borderRadius:8, background:"rgba(0,212,170,0.05)", border:"1px solid rgba(0,212,170,0.15)" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                            <span style={{ fontSize:11, color:"#ccc" }}>{p.name} — dosis {p.dose}</span>
                            {p.isOverridden && <button onClick={() => resetPieceOverride(p.medKey)} style={{ fontSize:10, color:"#ffb347", background:"none", border:"none", cursor:"pointer" }}>↺ Restaurar auto</button>}
                          </div>
                          {allPresentations.map((pr, pri) => (
                            <div key={pri} style={{ display:"flex", alignItems:"center", gap:8, padding:"2px 0" }}>
                              <span style={{ flex:1, fontSize:11, color:"#00d4aa" }}>{pr.item}</span>
                              <input type="number" min="0" value={countFor(pr.item)}
                                onChange={e => setPieceCount(p.medKey, allPresentations, pr.item, pr.mg, parseInt(e.target.value) || 0)}
                                style={{ width:50, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"3px 6px", color:"#f0f0f0", fontSize:11, outline:"none", textAlign:"center" }} />
                            </div>
                          ))}
                          <div style={{ fontSize:10, color:"#666", marginTop:2 }}>Total: {totalMg} mg (dosis {p.calc.doseMg} mg, sobrante {Math.max(0, totalMg - p.calc.doseMg)} mg)</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Nota</label>
                <textarea value={materialNote} onChange={e => setMaterialNote(e.target.value)} placeholder="Ej: aumento de material durante la infusión, motivo del cambio, etc."
                  rows={2} style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"8px 10px", color:"#f0f0f0", fontSize:12, outline:"none", resize:"vertical" }} />
              </div>

              <div>
                <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Material por defecto (desmarca lo que no aplique, o ajusta la cantidad)</label>
                <div style={{ maxHeight:160, overflowY:"auto", display:"flex", flexDirection:"column", gap:3 }}>
                  {preview.items.filter(t => !medPieceItemNames.has(t.item)).map((t,i) => {
                    const excluded = excludedItems.includes(t.item);
                    const currentQty = qtyOverrides[t.item] !== undefined ? qtyOverrides[t.item] : t.qty;
                    return (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 8px", borderRadius:6, opacity: excluded ? 0.4 : 1 }}>
                        <input type="checkbox" checked={!excluded} onChange={() => toggleExcluded(t.item)} style={{ cursor:"pointer" }} />
                        <span style={{ flex:1, fontSize:11, color:"#ccc", textDecoration: excluded ? "line-through" : "none" }}>{t.item}</span>
                        <input type="number" min="0" value={currentQty} disabled={excluded} onChange={e => setItemQty(t.item, parseInt(e.target.value) || 0)}
                          style={{ width:46, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"3px 4px", color:"#f0f0f0", fontSize:11, outline:"none", textAlign:"center" }} />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>+ Anexar material adicional</label>
                <input value={extraSearch} onChange={e => setExtraSearch(e.target.value)} placeholder="Buscar en el catálogo (mín. 2 letras)..."
                  style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"8px 12px", color:"#f0f0f0", fontSize:12, outline:"none" }} />
                {filteredCatalog.length > 0 && (
                  <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:4 }}>
                    {filteredCatalog.map((c,i) => (
                      <button key={i} onClick={() => { setExtraItems(prev => [...prev, { item:c.item, qty:1 }]); setExtraSearch(""); }}
                        style={{ textAlign:"left", padding:"7px 10px", borderRadius:7, fontSize:11, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", color:"#ccc" }}>
                        + {c.item} <span style={{ color:"#555" }}>({c.category})</span>
                      </button>
                    ))}
                  </div>
                )}
                {extraItems.length > 0 && (
                  <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                    {extraItems.map((ei, i) => (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <span style={{ flex:1, fontSize:11, color:"#ccc" }}>{ei.item}</span>
                        <input type="number" min="1" value={ei.qty} onChange={e => setExtraItems(prev => prev.map((p,pi) => pi===i ? {...p, qty:parseInt(e.target.value)||1} : p))}
                          style={{ width:50, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"4px 6px", color:"#f0f0f0", fontSize:11, outline:"none", textAlign:"center" }} />
                        <button onClick={() => setExtraItems(prev => prev.filter((_,pi) => pi!==i))}
                          style={{ padding:"4px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Consolidado final ({totalList.length} artículos)</label>
                <div style={{ maxHeight:220, overflowY:"auto", display:"flex", flexDirection:"column", gap:4 }}>
                  {totalList.map((t,i) => (
                    <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 10px", borderRadius:7, background:"rgba(255,255,255,0.025)", fontSize:11 }}>
                      <span style={{ color:"#ccc" }}>{t.item}</span>
                      <span style={{ color:"#00d4aa", fontFamily:"'IBM Plex Mono', monospace", fontWeight:600 }}>{t.qty}</span>
                    </div>
                  ))}
                  {totalList.length === 0 && <div style={{ fontSize:11, color:"#444", textAlign:"center", padding:12 }}>Sin material aún — agrega medicamentos o elige el tipo de acceso.</div>}
                </div>
              </div>

              <div style={{ display:"flex", gap:8 }}>
                <button onClick={async () => await saveMedsRequest(pieceOverrides)} disabled={savingMeds || session.inventorySalidaDone}
                  title={session.inventorySalidaDone ? "Ya se dio de baja el inventario de esta sesión -- si necesitas agregar algo, usa Anexar en Insumos" : "Guarda solo las piezas de medicamento -- activa el filtro de Paola y, si aplica, tu autorización"}
                  style={{ flex:1, padding:"10px", borderRadius:9, fontSize:13, fontWeight:600, cursor: (savingMeds || session.inventorySalidaDone) ? "not-allowed" : "pointer", background: session.inventorySalidaDone ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#5DCAA5,#2f8f74)", border:"none", color: session.inventorySalidaDone ? "#666" : "#fff", opacity: savingMeds ? 0.6 : 1 }}>
                  {savingMeds ? "Guardando…" : session.medsSolicitudGuardada ? "✓ Medicamentos guardados" : "✓ Guardar medicamentos"}
                </button>
                <button onClick={async () => await saveMaterialRequest(catheterType, catheterGauge, extraItems, excludedItems, excludePatientDefault, qtyOverrides, materialNote, equipoChoice)} disabled={savingMaterial || session.inventorySalidaDone}
                  title={session.inventorySalidaDone ? "Ya se dio de baja el inventario de esta sesión -- si necesitas agregar algo, usa Anexar en Insumos" : "Guarda catéter/equipo/insumos/soluciones -- activa el checkup de Paola"}
                  style={{ flex:1, padding:"10px", borderRadius:9, fontSize:13, fontWeight:600, cursor: (savingMaterial || session.inventorySalidaDone) ? "not-allowed" : "pointer", background: session.inventorySalidaDone ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#AFA9EC,#8B7FD8)", border:"none", color: session.inventorySalidaDone ? "#666" : "#fff", opacity: savingMaterial ? 0.6 : 1 }}>
                  {savingMaterial ? "Guardando…" : session.inventorySalidaDone ? "🔒 Inventario ya dado de baja" : session.materialSolicitudGuardada ? "✓ Material guardado" : "✓ Guardar material"}
                </button>
              </div>
              <button onClick={() => setShowMaterialModal(false)} disabled={savingMaterial || savingMeds}
                style={{ padding:"9px", borderRadius:9, fontSize:12, cursor: (savingMaterial || savingMeds) ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cerrar
              </button>
            </div>
          </div>
        );
      })()}

    </>
  );
}
