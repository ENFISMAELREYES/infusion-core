import { useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { FIRESTORE_BASE_URL } from "../config";

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

// Mismo criterio de normalización que ya usa materialCatalog.js para
// emparejar nombres de medicamento (MAYÚSCULAS, sin acentos) -- así el
// mismo nombre que se escribe en Nueva sesión encuentra su ficha aquí.
export function normalizeMedName(s) {
  return (s || "").toUpperCase().trim().replace(/[-_]/g, " ").replace(/\s+/g, " ")
    .replace(/Á/g,"A").replace(/É/g,"E").replace(/Í/g,"I").replace(/Ó/g,"O").replace(/Ú/g,"U");
}
function ficha_docId(nombreGenerico) {
  return normalizeMedName(nombreGenerico).replace(/[^A-Z0-9]/g, "_").slice(0, 200);
}

// Los campos que puede traer el JSON que se pega -- se listan explícito
// para poder ignorar cualquier otro campo que venga de más (ej. si el JSON
// trae "validado_por_dr_carlos"/"fecha_validacion", que decidimos no usar,
// simplemente no se guardan).
const FICHA_FIELDS = [
  "nombre_generico","nombre_comercial","clasificacion_terapeutica","presentacion_concentracion_vial",
  "codigo_infusioncore","codigo_cemi","clasificacion_peligrosidad","riesgo_hipersensibilidad",
  "alerta_critica_seguridad","detalle_alerta_critica","epp_requerido","manejo_derrame","disposicion_residuos",
  "dosis_estandar","dilucion_solucion_tecnica","volumen_concentracion_final","estabilidad_post_dilucion",
  "puntos_criticos_doble_verificacion","via_administracion","velocidad_tiempo_infusion",
  "acceso_vascular_requerido","premedicacion_requerida","secuencia_en_esquema","compatibilidad_y",
  "incompatibilidades_conocidas","monitoreo_durante_infusion","signos_alarma_hipersensibilidad",
  "signos_alarma_extravasacion","conducta_inmediata_reaccion","antidoto_kit_especifico",
  "fuente_referencia_clinica","notas_adicionales",
  // Para el consentimiento informado generado en Sesión de hoy (ver
  // generate-consent.js) -- es_oncologico decide título/bloques del
  // documento; categoria_farmaco/rol_en_esquema son informativos; el resto
  // alimenta directamente el contenido del PDF cuando están capturados.
  "es_oncologico","categoria_farmaco","rol_en_esquema","especialidad_clinica",
  "beneficios_esperados","alternativas_tratamiento","mecanismo_accion_paciente","riesgos_por_frecuencia",
];

const SECTIONS = [
  { title: "Información clínica", fields: [
    ["nombre_comercial","Nombre comercial"], ["clasificacion_terapeutica","Clasificación terapéutica"],
    ["presentacion_concentracion_vial","Presentación / concentración del vial"], ["dosis_estandar","Dosis estándar"],
  ]},
  { title: "Parámetros de administración", fields: [
    ["dilucion_solucion_tecnica","Dilución / técnica"], ["volumen_concentracion_final","Volumen / concentración final"],
    ["estabilidad_post_dilucion","Estabilidad post-dilución"], ["via_administracion","Vía de administración"],
    ["velocidad_tiempo_infusion","Velocidad / tiempo de infusión"], ["acceso_vascular_requerido","Acceso vascular requerido"],
    ["premedicacion_requerida","Premedicación requerida"], ["secuencia_en_esquema","Secuencia en esquema"],
    ["compatibilidad_y","Compatibilidad"], ["incompatibilidades_conocidas","Incompatibilidades conocidas"],
    ["puntos_criticos_doble_verificacion","Puntos críticos de doble verificación"],
  ]},
  { title: "Seguridad clínica", fields: [
    ["clasificacion_peligrosidad","Clasificación de peligrosidad"], ["riesgo_hipersensibilidad","Riesgo de hipersensibilidad"],
    ["epp_requerido","EPP requerido"], ["manejo_derrame","Manejo de derrame"], ["disposicion_residuos","Disposición de residuos"],
    ["monitoreo_durante_infusion","Monitoreo durante la infusión"],
    ["signos_alarma_hipersensibilidad","Signos de alarma — hipersensibilidad"],
    ["signos_alarma_extravasacion","Signos de alarma — extravasación"],
    ["conducta_inmediata_reaccion","Conducta inmediata ante reacción"], ["antidoto_kit_especifico","Antídoto / kit específico"],
  ]},
  { title: "Consentimiento informado", fields: [
    ["es_oncologico","¿Es oncológico?"], ["categoria_farmaco","Categoría del fármaco"], ["rol_en_esquema","Rol en el esquema"],
    ["especialidad_clinica","Especialidad clínica"], ["mecanismo_accion_paciente","Mecanismo de acción (para el paciente)"],
    ["beneficios_esperados","Beneficios esperados"], ["alternativas_tratamiento","Alternativas de tratamiento"],
    ["riesgos_por_frecuencia","Riesgos por frecuencia"],
  ]},
  { title: "Otros", fields: [
    ["notas_adicionales","Notas adicionales"],
    ["codigo_infusioncore","Código InfusionCore"], ["codigo_cemi","Código CEMI"],
    ["fuente_referencia_clinica","Fuente / referencia clínica"],
  ]},
];

const inputStyle = { width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"9px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };
const labelStyle = { fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:5 };

async function fetchFichas(token) {
  const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "fichas_tecnicas" }], limit: 1000 } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

// Modal para dar de alta o editar una ficha pegando el JSON tal cual lo
// arma el otro agente -- evita construir un formulario de 30 campos a
// mano; si algo queda mal, se reabre y se vuelve a pegar corregido.
function FichaJsonModal({ initialFicha, onClose, onSaved, token }) {
  const [text, setText] = useState(() => initialFicha
    ? JSON.stringify(Object.fromEntries(FICHA_FIELDS.map(k => [k, initialFicha[k] ?? ""])), null, 2)
    : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } durante alta masiva

  // Subir el .json como archivo en vez de pegarlo -- lotes grandes (como el
  // arreglo con varias fichas) a veces exceden lo que el portapapeles del
  // teléfono/navegador puede pegar de un jalón.
  const fileInputRef = useRef(null);
  const onFileSelected = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite volver a elegir el mismo archivo después
    if (!file) return;
    setError("");
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.onerror = () => setError("No se pudo leer el archivo.");
    reader.readAsText(file);
  };

  const saveOne = async (parsed) => {
    const docId = ficha_docId(parsed.nombre_generico);
    const fields = {};
    FICHA_FIELDS.forEach(k => { fields[k] = toFV(parsed[k] ?? ""); });
    fields.updatedAt = { stringValue: new Date().toISOString() };
    if (!initialFicha) fields.createdAt = { stringValue: new Date().toISOString() };
    const mask = [...FICHA_FIELDS, "updatedAt", ...(initialFicha ? [] : ["createdAt"])].map(k => `updateMask.fieldPaths=${k}`).join("&");
    const res = await fetch(`${FIRESTORE_BASE_URL}/fichas_tecnicas/${docId}?${mask}`,
      { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
    return { id: docId, ...parsed };
  };

  const save = async () => {
    setError("");
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { setError("El JSON no es válido: " + e.message); return; }

    // Alta masiva: si se pega un arreglo (en vez de un solo objeto) se
    // importan todas las fichas de un jalón -- pensado para lotes grandes
    // como los que arma "el otro agente" de una sola vez, en vez de repetir
    // el alta una por una. Solo aplica al dar de alta, no al editar (ahí
    // siempre se pega y se guarda una sola ficha).
    if (Array.isArray(parsed)) {
      if (initialFicha) { setError("Para editar solo se puede pegar un objeto, no un arreglo."); return; }
      const badIndex = parsed.findIndex(p => !p?.nombre_generico?.trim());
      if (badIndex !== -1) { setError(`El elemento #${badIndex + 1} del arreglo no trae "nombre_generico".`); return; }
      setSaving(true);
      const saved = [];
      const failedItems = [];
      const failedMsgs = [];
      for (let i = 0; i < parsed.length; i++) {
        setProgress({ done: i, total: parsed.length });
        try { saved.push(await saveOne(parsed[i])); }
        catch (e) { failedItems.push(parsed[i]); failedMsgs.push(`${parsed[i].nombre_generico}: ${e.message}`); }
      }
      setProgress(null);
      setSaving(false);
      if (saved.length > 0) onSaved(saved);
      if (failedMsgs.length > 0) {
        // Deja en el textarea SOLO lo que falló, para reintentar sin
        // repetir lo que ya se guardó correctamente.
        setText(JSON.stringify(failedItems, null, 2));
        setError(`${failedMsgs.length} de ${parsed.length} no se guardaron:\n` + failedMsgs.join("\n"));
      } else {
        onClose();
      }
      return;
    }

    if (!parsed.nombre_generico || !parsed.nombre_generico.trim()) { setError("Falta \"nombre_generico\" -- es el campo con el que se identifica y se busca la ficha."); return; }
    setSaving(true);
    try {
      const saved = await saveOne(parsed);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError("Error al guardar: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onClick={() => !saving && onClose()} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:640, maxHeight:"88vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>{initialFicha ? "✏️ Editar ficha técnica" : "＋ Nueva ficha técnica"}</div>
          <div style={{ fontSize:12, color:"#888", marginTop:2 }}>
            Pega aquí el JSON de la ficha (tal cual lo generes) -- se identifica y se busca después por "nombre_generico".
            {!initialFicha && " También puedes pegar un arreglo [ ] con varias fichas para darlas de alta todas juntas."}
          </div>
        </div>
        <div>
          <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={onFileSelected} style={{ display:"none" }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={saving}
            style={{ padding:"7px 12px", borderRadius:8, fontSize:12, fontWeight:600, cursor: saving ? "wait" : "pointer", background:"rgba(79,195,247,0.08)", border:"1px solid rgba(79,195,247,0.25)", color:"#4fc3f7" }}>
            📎 Subir archivo .json
          </button>
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder='{"nombre_generico": "Docetaxel", ...}'
          rows={16} style={{ ...inputStyle, fontFamily:"'IBM Plex Mono', monospace", fontSize:11, resize:"vertical" }} />
        {error && <div style={{ fontSize:12, color:"#ff6b6b", padding:"8px 10px", background:"rgba(255,107,107,0.08)", border:"1px solid rgba(255,107,107,0.25)", borderRadius:8, whiteSpace:"pre-line" }}>{error}</div>}
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} disabled={saving} style={{ flex:1, padding:"10px", borderRadius:9, fontSize:13, cursor: saving ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>Cancelar</button>
          <button onClick={save} disabled={saving || !text.trim()} style={{ flex:2, padding:"10px", borderRadius:9, fontSize:13, fontWeight:600, cursor: saving ? "wait" : "pointer", background:"linear-gradient(135deg,#00d4aa,#0F6E56)", border:"none", color:"#fff", opacity: (saving || !text.trim()) ? 0.6 : 1 }}>
            {saving ? (progress ? `Guardando ${progress.done + 1} de ${progress.total}…` : "Guardando…") : "✓ Guardar ficha"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FichasTecnicas() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  // "visualizador" no es solo personal médico -- también lo usa contabilidad
  // y admisión (mismo criterio que ya aplica el ícono de Monitor). Solo
  // entra aquí si es jefe, enfermera, o visualizador marcado como médico.
  const blocked = profile?.role === "visualizador" && !profile?.isMedico;
  const [token, setToken] = useState(null);
  const [fichas, setFichas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [showModal, setShowModal] = useState(false); // false | true (nueva) | ficha (editar)
  const [deleting, setDeleting] = useState(null);

  const load = async (t) => {
    setLoading(true);
    const list = await fetchFichas(t || token);
    setFichas(list.sort((a,b) => (a.nombre_generico||"").localeCompare(b.nombre_generico||"")));
    setLoading(false);
  };

  useEffect(() => {
    if (blocked) { setLoading(false); return; }
    user.getIdToken().then(t => { setToken(t); load(t); });
  }, [user, blocked]);

  const deleteFicha = async (ficha) => {
    if (!confirm(`¿Eliminar la ficha técnica de "${ficha.nombre_generico}"? No se puede deshacer.`)) return;
    setDeleting(ficha.id);
    try {
      const freshToken = await user.getIdToken(true);
      const res = await fetch(`${FIRESTORE_BASE_URL}/fichas_tecnicas/${ficha.id}`, { method:"DELETE", headers:{ Authorization:`Bearer ${freshToken}` } });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
      setFichas(prev => prev.filter(f => f.id !== ficha.id));
      if (expanded === ficha.id) setExpanded(null);
    } catch (e) {
      alert("Error al eliminar: " + e.message);
    } finally {
      setDeleting(null);
    }
  };

  const term = search.trim().toUpperCase();
  const filtered = term
    ? fichas.filter(f => (f.nombre_generico||"").toUpperCase().includes(term) || (f.nombre_comercial||"").toUpperCase().includes(term))
    : fichas;

  if (blocked) return (
    <div style={{ padding:40, color:"#666", textAlign:"center" }}>
      No tienes acceso a esta sección.
    </div>
  );
  if (loading) return <div style={{ padding:40, color:"#666", textAlign:"center" }}>Cargando…</div>;

  return (
    <div style={{ padding:"24px 28px", maxWidth:820, margin:"0 auto" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20, flexWrap:"wrap", gap:12 }}>
        <div>
          <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Fichas técnicas</h1>
          <p style={{ fontSize:13, color:"#555" }}>Manual de referencia rápida de medicamentos, por si necesitas consultar dilución, tiempos o manejo de seguridad durante la atención.</p>
        </div>
        {isJefe && (
          <button onClick={() => setShowModal(true)} style={{ padding:"9px 16px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa", whiteSpace:"nowrap" }}>
            ＋ Nueva ficha
          </button>
        )}
      </div>

      <input placeholder="Buscar por nombre genérico o comercial…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, marginBottom:16 }} />

      {filtered.length === 0 ? (
        <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
          {fichas.length === 0 ? "Sin fichas técnicas capturadas todavía." : "Sin resultados para esa búsqueda."}
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {filtered.map(f => {
            const isOpen = expanded === f.id;
            const hasCriticalAlert = (f.alerta_critica_seguridad || "").trim().toUpperCase() === "SI" || (f.alerta_critica_seguridad || "").trim().toUpperCase() === "SÍ";
            return (
              <div key={f.id} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
                <div onClick={() => setExpanded(isOpen ? null : f.id)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ flex:1, fontSize:14, color:"#f0f0f0", fontWeight:600, minWidth:160 }}>{f.nombre_generico}</span>
                  {f.nombre_comercial && <span style={{ fontSize:11, color:"#666" }}>{f.nombre_comercial}</span>}
                  {f.clasificacion_peligrosidad && (
                    <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:99, background:"rgba(255,179,71,0.1)", color:"#ffb347" }}>{f.clasificacion_peligrosidad}</span>
                  )}
                  {hasCriticalAlert && (
                    <span title={f.detalle_alerta_critica || ""} style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:99, background:"rgba(255,107,107,0.12)", color:"#ff6b6b" }}>
                      🔴 Alerta crítica
                    </span>
                  )}
                  <span style={{ color:"#555" }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {isOpen && (
                  <div style={{ padding:"0 16px 16px", display:"flex", flexDirection:"column", gap:14 }}>
                    {hasCriticalAlert && f.detalle_alerta_critica && (
                      <div style={{ fontSize:12, color:"#ff6b6b", padding:"9px 12px", background:"rgba(255,107,107,0.08)", border:"1px solid rgba(255,107,107,0.25)", borderRadius:9 }}>
                        🔴 <strong>Alerta crítica:</strong> {f.detalle_alerta_critica}
                      </div>
                    )}
                    {SECTIONS.map(section => {
                      // Truthy simple no alcanza para booleanos (false se
                      // perdería, ej. es_oncologico: false) ni distingue un
                      // arreglo/objeto vacío de uno con contenido real.
                      const hasValue = (v) => {
                        if (v === undefined || v === null || v === "") return false;
                        if (Array.isArray(v)) return v.length > 0;
                        if (typeof v === "object") return Object.keys(v).length > 0;
                        return true;
                      };
                      const rows = section.fields.filter(([key]) => hasValue(f[key]));
                      if (rows.length === 0) return null;
                      return (
                        <div key={section.title}>
                          <div style={{ fontSize:11, color:"#00d4aa", fontWeight:600, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>{section.title}</div>
                          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                            {rows.map(([key, label]) => (
                              <div key={key}>
                                <div style={{ fontSize:10, color:"#666", textTransform:"uppercase", letterSpacing:0.5, marginBottom:2 }}>{label}</div>
                                {key === "secuencia_en_esquema" ? (
                                  // Dos formatos posibles: un string con varias combinaciones
                                  // separadas por "|" (ej. "Monoterapia: N/A | +Doxorrubicina: ...")
                                  // o un arreglo de objetos {combinacion, orden, notas} -- se
                                  // muestran ambos como renglones de lista, más legible que un
                                  // párrafo corrido.
                                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                                    {(Array.isArray(f[key])
                                      ? f[key].map(item => typeof item === "string" ? item
                                          : [item.combinacion, item.orden, item.notas].filter(Boolean).join(" — "))
                                      : String(f[key]).split("|").map(s => s.trim())
                                    ).filter(Boolean).map((linea, li) => (
                                      <div key={li} style={{ display:"flex", gap:6, fontSize:12, color:"#ccc", lineHeight:1.5 }}>
                                        <span style={{ color:"#00d4aa", flexShrink:0 }}>•</span>
                                        <span>{linea}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : key === "riesgos_por_frecuencia" ? (
                                  // Objeto {frecuentes, menos_frecuentes, raros_pero_importantes} --
                                  // cada uno una lista corta.
                                  <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                                    {[["frecuentes","Frecuentes"],["menos_frecuentes","Menos frecuentes"],["raros_pero_importantes","Raros pero importantes"]].map(([subKey, subLabel]) => (
                                      (f[key][subKey] || []).length > 0 && (
                                        <div key={subKey}>
                                          <span style={{ fontSize:11, color:"#888", fontWeight:600 }}>{subLabel}: </span>
                                          <span style={{ fontSize:12, color:"#ccc" }}>{f[key][subKey].join(", ")}</span>
                                        </div>
                                      )
                                    ))}
                                  </div>
                                ) : typeof f[key] === "boolean" ? (
                                  <div style={{ fontSize:12, color:"#ccc" }}>{f[key] ? "Sí" : "No"}</div>
                                ) : Array.isArray(f[key]) ? (
                                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                                    {f[key].map((linea, li) => (
                                      <div key={li} style={{ display:"flex", gap:6, fontSize:12, color:"#ccc", lineHeight:1.5 }}>
                                        <span style={{ color:"#00d4aa", flexShrink:0 }}>•</span>
                                        <span>{linea}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div style={{ fontSize:12, color:"#ccc", lineHeight:1.5, whiteSpace:"pre-wrap" }}>{f[key]}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {isJefe && (
                      <div style={{ display:"flex", gap:8, marginTop:4 }}>
                        <button onClick={() => setShowModal(f)} style={{ padding:"6px 14px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#ccc" }}>✏️ Editar</button>
                        <button onClick={() => deleteFicha(f)} disabled={deleting === f.id} style={{ padding:"6px 14px", borderRadius:8, fontSize:12, fontWeight:600, cursor: deleting===f.id ? "wait" : "pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
                          {deleting===f.id ? "Eliminando…" : "🗑 Eliminar"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <FichaJsonModal
          initialFicha={showModal === true ? null : showModal}
          token={token}
          onClose={() => setShowModal(false)}
          onSaved={(saved) => {
            // saved puede ser una ficha sola o un arreglo (alta masiva) --
            // el modal es quien decide cuándo cerrarse (onClose), aquí solo
            // se refleja lo que ya se guardó en el listado.
            const list = Array.isArray(saved) ? saved : [saved];
            setFichas(prev => {
              let next = [...prev];
              list.forEach(item => {
                const exists = next.some(f => f.id === item.id);
                next = exists ? next.map(f => f.id === item.id ? item : f) : [...next, item];
              });
              return next.sort((a,b) => (a.nombre_generico||"").localeCompare(b.nombre_generico||""));
            });
          }}
        />
      )}
    </div>
  );
}
