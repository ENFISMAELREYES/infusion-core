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

// Palabras/símbolos que no cambian de qué fármaco se trata -- solo dosis,
// unidades y formato. Si lo que sobra al comparar un nombre capturado
// contra el de una ficha es SOLO esto, es seguro asumir que es el mismo
// fármaco (ej. "Dexametasona 8MG" vs ficha "Dexametasona").
const DOSE_UNITS = new Set(["MG","MCG","UG","ML","UI","G","MEQ","L","KG","MMOL"]);
function isDoseNoise(leftover) {
  // Se quitan números/puntuación primero -- así "90MG" (pegado, sin
  // espacio) también se reconoce como unidad y no como palabra real.
  const tokens = leftover.replace(/[0-9.,%x×/()\-]/g, " ").split(/\s+/).filter(Boolean);
  return tokens.every(t => DOSE_UNITS.has(t));
}

// Busca la ficha técnica de un medicamento capturado, con el mismo criterio
// en todos los consumidores (Autorizar, NurseView, Monitor, Historial) --
// antes cada archivo repetía su propia versión de esto, y la búsqueda
// difusa por contención (fn.includes(norm) / norm.includes(fn)) podía
// confundir un fármaco genérico con una variante más específica cuyo
// nombre lo contiene como sub-cadena (ej. "Doxorrubicina" capturado
// calzaba, por contención, con "Doxorrubicina liposomal pegilizada" --
// que trae instrucciones de dilución OPUESTAS a la doxorrubicina simple).
// Reglas, en orden:
//  1. Coincidencia exacta por nombre normalizado.
//  2. Coincidencia exacta ignorando el texto entre paréntesis (ej.
//     "Carboplatino" capturado vs ficha guardada como
//     "Carboplatino (CBDCA)") -- solo si un único fármaco calza así.
//  3. Contención difusa -- pero solo si UN único fármaco calza, Y solo si
//     lo que sobra al comparar es ruido de dosis/formato (números,
//     unidades, paréntesis) cuando el nombre CAPTURADO es el más largo.
//     Si sobra una palabra real (ej. capturan "Trastuzumab Emtansina" y
//     solo existe la ficha "Trastuzumab"), NO se asume que es el mismo
//     fármaco -- podría ser una variante sin ficha propia todavía
//     (mismo caso que Kadcyla/T-DM1, que hoy no está en el catálogo), y
//     mostrarle a la enfermera los datos del fármaco genérico sería
//     peligroso, no solo impreciso. Cuando es la FICHA la que trae más
//     texto que lo capturado (ej. "Zoledronico" vs ficha "Ácido
//     zoledrónico", o "Brentuximab" vs "Brentuximab vedotina"), no hay
//     ese riesgo -- ya existe una ficha específica para ese fármaco, solo
//     falta una palabra que la enfermera no escribió.
export function findFichaMatch(medName, fichasByName) {
  if (!medName || !fichasByName) return null;
  const norm = normalizeMedName(medName);
  if (fichasByName[norm]) return fichasByName[norm];

  const stripParens = (s) => s.replace(/\s*\([^)]*\)/g, "").trim();
  const normNoParens = stripParens(norm);
  const exactNoParens = Object.values(fichasByName).filter(f => stripParens(normalizeMedName(f.nombre_generico)) === normNoParens);
  if (exactNoParens.length === 1) return exactNoParens[0];

  const fuzzy = Object.values(fichasByName).filter(f => {
    const fn = normalizeMedName(f.nombre_generico);
    if (!fn) return false;
    if (fn.includes(norm)) return true;
    if (norm.includes(fn)) return isDoseNoise(norm.replace(fn, ""));
    return false;
  });
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

// Una sesión cuenta como C1D1 (inicio de línea de tratamiento, requiere
// consentimiento nuevo) si la casilla explícita de Nueva sesión quedó
// marcada, O si el texto libre de "Ciclo" dice literalmente "C1D1" -- la
// casilla es la señal confiable, pero en la práctica a veces no se marca
// aunque el ciclo sí diga C1D1, así que el texto sirve de respaldo (solo
// para ese patrón exacto, no interpretaciones más amplias como "Ciclo 1
// Día 1", que son las que se descartaron por poco confiables).
export function isSessionC1D1(session) {
  return !!session?.isC1D1 || /\bC1D1\b/i.test(session?.cycle || "");
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
  // Modelo v2 (piloto de reestructura, sept. 2026) -- conviven con los
  // campos planos de arriba mientras se migra el resto del catálogo.
  // productos_comerciales reemplaza a nombre_comercial (varias marcas por
  // fármaco, con su propia estabilidad/registro sanitario en vez de un
  // solo texto libre); premedicacion reemplaza a premedicacion_requerida
  // (registro estructurado en vez de texto libre); modulos_compartidos
  // referencia por id contenido común a varios fármacos (extravasación,
  // hipersensibilidad, toxicidad inmunomediada -- ver colección aparte
  // modulos_clinicos_compartidos). id_interno/version/historial_cambios
  // son metadatos de gobernanza del propio contenido.
  "id_interno","version","historial_cambios","productos_comerciales","premedicacion","modulos_compartidos",
];

// Un campo puede venir como texto plano (fichas viejas) o como
// {valor, reference_id} (modelo v2, con trazabilidad de la fuente por
// dato) -- esto siempre da el texto a mostrar, sin importar cuál trajo.
export function valorTexto(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v.valor || "";
  return v || "";
}

// alerta_critica_seguridad viene como texto ("Sí"/"No", fichas viejas) o
// como booleano real (modelo v2) -- compararlo como texto sin más revienta
// cuando es un booleano (true/false no tienen .trim()).
export function isAlertaCritica(v) {
  if (typeof v === "boolean") return v;
  return ["SI","SÍ"].includes((v || "").trim().toUpperCase());
}

// Nombre(s) comercial(es) a mostrar, sea el campo viejo (nombre_comercial,
// un texto) o el nuevo (productos_comerciales, un arreglo de marcas).
export function nombresComerciales(f) {
  if (f.nombre_comercial) return f.nombre_comercial;
  return (f.productos_comerciales || []).map(p => p.marca).filter(Boolean).join(", ");
}

const SECTIONS = [
  { title: "Información clínica", fields: [
    ["nombre_comercial","Nombre comercial"], ["productos_comerciales","Productos comerciales"],
    ["clasificacion_terapeutica","Clasificación terapéutica"],
    ["presentacion_concentracion_vial","Presentación / concentración del vial"], ["dosis_estandar","Dosis estándar"],
  ]},
  { title: "Parámetros de administración", fields: [
    ["dilucion_solucion_tecnica","Dilución / técnica"], ["volumen_concentracion_final","Volumen / concentración final"],
    ["estabilidad_post_dilucion","Estabilidad post-dilución"], ["via_administracion","Vía de administración"],
    ["velocidad_tiempo_infusion","Velocidad / tiempo de infusión"], ["acceso_vascular_requerido","Acceso vascular requerido"],
    ["premedicacion_requerida","Premedicación requerida"], ["premedicacion","Premedicación"],
    ["secuencia_en_esquema","Secuencia en esquema"],
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

// Etiqueta legible de cada campo, para mostrar "qué cambió" sin tener que
// repetir a mano la lista de SECTIONS.
const FIELD_LABELS = Object.fromEntries(SECTIONS.flatMap(s => s.fields));

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

// Contenido común a varios fármacos (extravasación, hipersensibilidad,
// toxicidad inmunomediada) -- colección aparte, referenciada por id desde
// modulos_compartidos en cada ficha, en vez de repetir el mismo texto en
// cada una (modelo v2).
async function fetchModulos(token) {
  const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "modulos_clinicos_compartidos" }], limit: 200 } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return {};
  const byId = {};
  data.filter(d => d.document).map(d => parseDoc(d.document)).forEach(m => { if (m.modulo_id) byId[m.modulo_id] = m; });
  return byId;
}

// Fuentes citadas por reference_id desde cualquier campo con trazabilidad
// (modelo v2) -- solo se usa para mostrar la cita completa al pasar el
// cursor, no se pinta de por sí en ningún lado.
async function fetchReferencias(token) {
  const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "referencias_bibliograficas" }], limit: 500 } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return {};
  const byId = {};
  data.filter(d => d.document).map(d => parseDoc(d.document)).forEach(r => { if (r.reference_id) byId[r.reference_id] = r; });
  return byId;
}

// Marca o quita una de las dos validaciones independientes de una ficha
// (técnica/farmacia y clínica oncológica) -- no toca el contenido clínico
// de la ficha para nada, es un campo aparte que solo jefe/Carlos/Omar
// pueden tocar (ver canValidate más abajo).
async function setValidation(token, fichaId, slot, value) {
  const fieldName = slot === "farmacia" ? "validacion_farmacia" : "validacion_clinica";
  const fields = { [fieldName]: value ? toFV(value) : { nullValue: null } };
  const res = await fetch(`${FIRESTORE_BASE_URL}/fichas_tecnicas/${fichaId}?updateMask.fieldPaths=${fieldName}`,
    { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
}

// Una validación cuenta como vigente solo si es posterior a la última
// modificación de contenido de la ficha -- si la ficha se editó después de
// que alguien la validó, esa validación queda desactualizada aunque el
// registro siga ahí (para no perder el rastro de quién la validó antes).
function validationState(ficha, slot) {
  const v = ficha[slot === "farmacia" ? "validacion_farmacia" : "validacion_clinica"];
  if (!v?.fecha) return "sin_validar";
  const updatedAt = ficha.updatedAt || ficha.createdAt;
  if (updatedAt && new Date(updatedAt) > new Date(v.fecha)) return "desactualizada";
  return "vigente";
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

  const saveOne = async (parsed, baseFicha) => {
    const docId = ficha_docId(parsed.nombre_generico);
    const fields = {};
    FICHA_FIELDS.forEach(k => { fields[k] = toFV(parsed[k] ?? ""); });
    fields.updatedAt = { stringValue: new Date().toISOString() };
    const extraKeys = ["updatedAt"];
    if (!baseFicha) {
      fields.createdAt = { stringValue: new Date().toISOString() };
      extraKeys.push("createdAt");
    } else {
      // Qué campos cambiaron respecto a la versión anterior -- para que
      // Carlos/Omar sepan exactamente qué revisar de nuevo en vez de releer
      // las 32 columnas cada vez que se corrige algo (ver sección de
      // pendientes de validar, más abajo).
      const changed = FICHA_FIELDS.filter(k => JSON.stringify(baseFicha[k] ?? "") !== JSON.stringify(parsed[k] ?? ""));
      fields.campos_modificados = toFV(changed);
      extraKeys.push("campos_modificados");
    }
    const mask = [...FICHA_FIELDS, ...extraKeys].map(k => `updateMask.fieldPaths=${k}`).join("&");
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
      const saved = await saveOne(parsed, initialFicha);
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

// Alta de módulos clínicos compartidos o referencias bibliográficas --
// colecciones nuevas del modelo v2, chicas y de edición poco frecuente, así
// que no necesitan un editor campo por campo como las fichas: se pega el
// arreglo completo tal cual lo arma el agente de contenido y se sobrescribe
// cada documento por su id (modulo_id o reference_id). Sin lista blanca de
// campos -- a diferencia de FICHA_FIELDS, aquí no hay riesgo de perder
// datos clínicos sensibles por un campo inesperado, así que se guarda tal
// cual viene.
function ImportJsonModal({ title, placeholder, collectionId, idField, onClose, onImported, token }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileInputRef = useRef(null);

  const onFileSelected = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.onerror = () => setError("No se pudo leer el archivo.");
    reader.readAsText(file);
  };

  const save = async () => {
    setError("");
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { setError("El JSON no es válido: " + e.message); return; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const badIndex = items.findIndex(it => !it?.[idField]);
    if (badIndex !== -1) { setError(`El elemento #${badIndex + 1} no trae "${idField}" -- es el campo con el que se identifica.`); return; }
    setSaving(true);
    const failedMsgs = [];
    let savedCount = 0;
    for (let i = 0; i < items.length; i++) {
      setProgress({ done: i, total: items.length });
      const item = items[i];
      try {
        const docId = String(item[idField]).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
        const fields = {};
        Object.entries(item).forEach(([k, v]) => { fields[k] = toFV(v); });
        const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join("&");
        const res = await fetch(`${FIRESTORE_BASE_URL}/${collectionId}/${docId}?${mask}`,
          { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
        savedCount++;
      } catch (e) {
        failedMsgs.push(`${item[idField]}: ${e.message}`);
      }
    }
    setProgress(null);
    setSaving(false);
    if (savedCount > 0) onImported();
    if (failedMsgs.length > 0) setError(`${failedMsgs.length} de ${items.length} no se guardaron:\n` + failedMsgs.join("\n"));
    else onClose();
  };

  return (
    <div onClick={() => !saving && onClose()} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:640, maxHeight:"88vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>{title}</div>
          <div style={{ fontSize:12, color:"#888", marginTop:2 }}>Pega el arreglo JSON completo tal cual lo genere el agente de contenido -- reemplaza cada elemento existente por su "{idField}".</div>
        </div>
        <div>
          <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={onFileSelected} style={{ display:"none" }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={saving}
            style={{ padding:"7px 12px", borderRadius:8, fontSize:12, fontWeight:600, cursor: saving ? "wait" : "pointer", background:"rgba(79,195,247,0.08)", border:"1px solid rgba(79,195,247,0.25)", color:"#4fc3f7" }}>
            📎 Subir archivo .json
          </button>
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder={placeholder}
          rows={14} style={{ ...inputStyle, fontFamily:"'IBM Plex Mono', monospace", fontSize:11, resize:"vertical" }} />
        {error && <div style={{ fontSize:12, color:"#ff6b6b", padding:"8px 10px", background:"rgba(255,107,107,0.08)", border:"1px solid rgba(255,107,107,0.25)", borderRadius:8, whiteSpace:"pre-line" }}>{error}</div>}
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} disabled={saving} style={{ flex:1, padding:"10px", borderRadius:9, fontSize:13, cursor: saving ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>Cancelar</button>
          <button onClick={save} disabled={saving || !text.trim()} style={{ flex:2, padding:"10px", borderRadius:9, fontSize:13, fontWeight:600, cursor: saving ? "wait" : "pointer", background:"linear-gradient(135deg,#00d4aa,#0F6E56)", border:"none", color:"#fff", opacity: (saving || !text.trim()) ? 0.6 : 1 }}>
            {saving ? (progress ? `Guardando ${progress.done + 1} de ${progress.total}…` : "Guardando…") : "✓ Guardar"}
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
  // Validar una ficha (gobernanza clínica: Carlos/farmacia y el oncólogo)
  // es aparte de poder editar su contenido -- lo hace jefe o cualquier
  // visualizador médico, pero no enfermería (no es su rol validar el
  // catálogo, solo consultarlo durante la atención).
  const canValidate = isJefe || (profile?.role === "visualizador" && profile?.isMedico);
  const [validating, setValidating] = useState(null); // `${fichaId}_${slot}` mientras se guarda
  const [token, setToken] = useState(null);
  const [fichas, setFichas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [showModal, setShowModal] = useState(false); // false | true (nueva) | ficha (editar)
  const [showImportModulos, setShowImportModulos] = useState(false);
  const [showImportRefs, setShowImportRefs] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [modulosById, setModulosById] = useState({});
  const [refsById, setRefsById] = useState({});

  const load = async (t) => {
    setLoading(true);
    const list = await fetchFichas(t || token);
    setFichas(list.sort((a,b) => (a.nombre_generico||"").localeCompare(b.nombre_generico||"")));
    setLoading(false);
  };

  useEffect(() => {
    if (blocked) { setLoading(false); return; }
    user.getIdToken().then(t => {
      setToken(t);
      load(t);
      fetchModulos(t).then(setModulosById);
      fetchReferencias(t).then(setRefsById);
    });
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

  // Alterna una validación: si ya estaba vigente, se quita (por si se marcó
  // por error); si no, se marca con quien está firmando y ahora mismo.
  const toggleValidation = async (ficha, slot) => {
    const key = `${ficha.id}_${slot}`;
    const isVigente = validationState(ficha, slot) === "vigente";
    setValidating(key);
    try {
      const freshToken = await user.getIdToken(true);
      const value = isVigente ? null : { validado_por: profile?.name || user?.email || "", fecha: new Date().toISOString() };
      await setValidation(freshToken, ficha.id, slot, value);
      const fieldName = slot === "farmacia" ? "validacion_farmacia" : "validacion_clinica";
      setFichas(prev => prev.map(f => f.id === ficha.id ? { ...f, [fieldName]: value } : f));
    } catch (e) {
      alert("Error al guardar la validación: " + e.message);
    } finally {
      setValidating(null);
    }
  };

  const term = search.trim().toUpperCase();
  const filtered = term
    ? fichas.filter(f => (f.nombre_generico||"").toUpperCase().includes(term) || nombresComerciales(f).toUpperCase().includes(term))
    : fichas;

  // Fichas a las que les falta alguna de las dos validaciones, o que se
  // modificaron después de haberse validado -- para que Carlos/Omar sepan
  // qué revisar sin tener que abrir las 46 una por una.
  const pending = canValidate ? fichas.filter(f =>
    validationState(f, "farmacia") !== "vigente" || validationState(f, "clinica") !== "vigente"
  ) : [];

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
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <button onClick={() => setShowImportRefs(true)} style={{ padding:"9px 14px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888", whiteSpace:"nowrap" }}>
              📖 Referencias
            </button>
            <button onClick={() => setShowImportModulos(true)} style={{ padding:"9px 14px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888", whiteSpace:"nowrap" }}>
              📚 Módulos compartidos
            </button>
            <button onClick={() => setShowModal(true)} style={{ padding:"9px 16px", borderRadius:9, fontSize:13, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa", whiteSpace:"nowrap" }}>
              ＋ Nueva ficha
            </button>
          </div>
        )}
      </div>

      {canValidate && pending.length > 0 && (
        <div style={{ marginBottom:20, background:"rgba(255,179,71,0.05)", border:"1px solid rgba(255,179,71,0.2)", borderRadius:12, padding:14 }}>
          <div style={{ fontSize:12, color:"#ffb347", fontWeight:600, marginBottom:10 }}>⚠ Pendientes de validar ({pending.length})</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {pending.map(f => {
              const st = { farmacia: validationState(f, "farmacia"), clinica: validationState(f, "clinica") };
              const changedLabels = (f.campos_modificados || []).map(k => FIELD_LABELS[k] || k);
              const stLabel = { vigente: "✓ vigente", desactualizada: "⚠ desactualizada", sin_validar: "sin validar" };
              return (
                <div key={f.id} onClick={() => setExpanded(f.id)} style={{ cursor:"pointer", fontSize:12, padding:"8px 10px", borderRadius:8, background:"rgba(255,255,255,0.03)" }}>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center" }}>
                    <span style={{ color:"#f0f0f0", fontWeight:600 }}>{f.nombre_generico}</span>
                    <span style={{ color: st.farmacia === "vigente" ? "#1D9E75" : "#888" }}>Dr. Carlos Sorroza: {stLabel[st.farmacia]}</span>
                    <span style={{ color: st.clinica === "vigente" ? "#1D9E75" : "#888" }}>Dr. Omar Macedo: {stLabel[st.clinica]}</span>
                  </div>
                  {(st.farmacia === "desactualizada" || st.clinica === "desactualizada") && changedLabels.length > 0 && (
                    <div style={{ color:"#666", marginTop:3 }}>Cambió: {changedLabels.join(", ")}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <input placeholder="Buscar por nombre genérico o comercial…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, marginBottom:16 }} />

      {filtered.length === 0 ? (
        <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
          {fichas.length === 0 ? "Sin fichas técnicas capturadas todavía." : "Sin resultados para esa búsqueda."}
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {filtered.map(f => {
            const isOpen = expanded === f.id;
            const hasCriticalAlert = isAlertaCritica(f.alerta_critica_seguridad);
            return (
              <div key={f.id} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
                <div onClick={() => setExpanded(isOpen ? null : f.id)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ flex:1, fontSize:14, color:"#f0f0f0", fontWeight:600, minWidth:160 }}>{f.nombre_generico}</span>
                  {nombresComerciales(f) && <span style={{ fontSize:11, color:"#666" }}>{nombresComerciales(f)}</span>}
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
                                ) : key === "productos_comerciales" ? (
                                  // Varias marcas por fármaco (modelo v2) -- cada una con su propio
                                  // registro sanitario/estabilidad, en vez de un solo texto libre.
                                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                                    {f[key].map((p, pi) => (
                                      <div key={pi} style={{ fontSize:12, color:"#ccc", lineHeight:1.5 }}>
                                        <span style={{ color:"#f0f0f0", fontWeight:600 }}>{p.marca || "Marca sin especificar"}</span>
                                        {p.laboratorio && <span style={{ color:"#888" }}> — {p.laboratorio}</span>}
                                        {p.registro_sanitario && <span style={{ color:"#666" }}> · Reg. {p.registro_sanitario}</span>}
                                        {p.presentacion && <div>Presentación: {p.presentacion}</div>}
                                        {p.estabilidad_post_dilucion && <div>Estabilidad: {valorTexto(p.estabilidad_post_dilucion)}</div>}
                                        {p.disponibilidad && <div style={{ color:"#666" }}>Disponibilidad: {p.disponibilidad}</div>}
                                      </div>
                                    ))}
                                  </div>
                                ) : key === "premedicacion" ? (
                                  // Registro estructurado (modelo v2) en vez del texto libre de
                                  // premedicacion_requerida -- un renglón por medicamento.
                                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                                    {f[key].map((p, pi) => (
                                      <div key={pi} style={{ display:"flex", gap:6, fontSize:12, color:"#ccc", lineHeight:1.5 }}>
                                        <span style={{ color: p.obligatorio ? "#ff6b6b" : "#00d4aa", flexShrink:0 }}>•</span>
                                        <span>
                                          {p.medicamento}{p.dosis && ` ${p.dosis}`}{p.via && ` ${p.via}`}
                                          {p.tiempo_antes_min != null && ` — ${p.tiempo_antes_min} min antes`}
                                          {p.obligatorio === false && " (a criterio médico)"}
                                          {p.nota && ` · ${p.nota}`}
                                        </span>
                                      </div>
                                    ))}
                                    {f[key].length === 0 && <div style={{ color:"#666" }}>Sin premedicación requerida</div>}
                                  </div>
                                ) : typeof f[key] === "boolean" ? (
                                  <div style={{ fontSize:12, color:"#ccc" }}>{f[key] ? "Sí" : "No"}</div>
                                ) : f[key] && typeof f[key] === "object" && !Array.isArray(f[key]) ? (
                                  // {valor, reference_id} (modelo v2, trazabilidad por dato) en vez
                                  // de texto plano -- se muestra el valor; la fuente exacta vive en
                                  // referencias_bibliograficas por su reference_id.
                                  <div style={{ fontSize:12, color:"#ccc", lineHeight:1.5, whiteSpace:"pre-wrap" }}>{valorTexto(f[key])}</div>
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
                    {(f.modulos_compartidos || []).length > 0 && (
                      <div>
                        <div style={{ fontSize:11, color:"#00d4aa", fontWeight:600, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Contenido compartido</div>
                        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                          {f.modulos_compartidos.map(mid => {
                            const m = modulosById[mid];
                            if (!m) return <div key={mid} style={{ fontSize:12, color:"#666" }}>({mid} — módulo no encontrado)</div>;
                            return (
                              <div key={mid} style={{ padding:"10px 12px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:9 }}>
                                <div style={{ fontSize:12, color:"#f0f0f0", fontWeight:600, marginBottom:6 }}>{m.nombre || mid}</div>
                                {m.aim && <div style={{ fontSize:12, color:"#ccc", marginBottom:4 }}><strong>Objetivo:</strong> {m.aim}</div>}
                                {(m.medidas_iniciales || []).length > 0 && (
                                  <div style={{ marginBottom:4 }}>
                                    <div style={{ fontSize:11, color:"#888" }}>Medidas iniciales:</div>
                                    {m.medidas_iniciales.map((s,i) => <div key={i} style={{ fontSize:12, color:"#ccc", paddingLeft:10 }}>• {s}</div>)}
                                  </div>
                                )}
                                {m.antidoto_especifico && <div style={{ fontSize:12, color:"#ccc", marginBottom:4 }}><strong>Antídoto:</strong> {m.antidoto_especifico}</div>}
                                {m.referir_a && <div style={{ fontSize:12, color:"#ccc", marginBottom:4 }}><strong>Referir a:</strong> {m.referir_a}</div>}
                                {m.seguimiento && <div style={{ fontSize:12, color:"#ccc", marginBottom:4 }}><strong>Seguimiento:</strong> {m.seguimiento}</div>}
                                {(m.grados || []).length > 0 && (
                                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                                    {m.grados.map((g,i) => (
                                      <div key={i} style={{ fontSize:12, color:"#ccc" }}><strong>Grado {g.grado}:</strong> {g.sintomas} — {g.conducta}</div>
                                    ))}
                                  </div>
                                )}
                                {(m.sistemas_afectados || []).length > 0 && (
                                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                                    {m.sistemas_afectados.map((s,i) => (
                                      <div key={i} style={{ fontSize:12, color:"#ccc" }}><strong>{s.sistema}:</strong> {s.signo_alarma} → {s.conducta}</div>
                                    ))}
                                  </div>
                                )}
                                {m.nota_corticoides && <div style={{ fontSize:11, color:"#ffb347", marginTop:4 }}>⚠ {m.nota_corticoides}</div>}
                                {m.rol_enfermeria && <div style={{ fontSize:11, color:"#666", marginTop:4 }}>Rol de enfermería: {m.rol_enfermeria}</div>}
                                {m.notas && <div style={{ fontSize:11, color:"#666", marginTop:4 }}>{m.notas}</div>}
                                {(m.reference_ids || []).length > 0 && (
                                  <div style={{ fontSize:10, color:"#555", marginTop:6 }}>
                                    Fuentes: {m.reference_ids.map(rid => refsById[rid]?.cita || rid).join(" · ")}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {canValidate && (() => {
                      const changedLabels = (f.campos_modificados || []).map(k => FIELD_LABELS[k] || k);
                      const slotInfo = [
                        ["farmacia", "Dr. Carlos Sorroza", f.validacion_farmacia],
                        ["clinica", "Dr. Omar Macedo", f.validacion_clinica],
                      ];
                      return (
                        <div>
                          <div style={{ fontSize:11, color:"#00d4aa", fontWeight:600, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Validación clínica</div>
                          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                            {slotInfo.map(([slot, who, v]) => {
                              const st = validationState(f, slot);
                              const key = `${f.id}_${slot}`;
                              return (
                                <div key={slot} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12 }}>
                                  <button onClick={() => toggleValidation(f, slot)} disabled={validating === key}
                                    style={{ padding:"4px 10px", borderRadius:99, fontSize:11, fontWeight:600, cursor: validating===key ? "wait" : "pointer",
                                      background: st === "vigente" ? "rgba(29,158,117,0.12)" : "rgba(255,255,255,0.05)",
                                      border: `1px solid ${st === "vigente" ? "rgba(29,158,117,0.3)" : "rgba(255,255,255,0.09)"}`,
                                      color: st === "vigente" ? "#1D9E75" : "#888" }}>
                                    {st === "vigente" ? "✓" : "☐"} {who}
                                  </button>
                                  {st === "desactualizada" && <span style={{ color:"#ffb347" }}>⚠ desactualizada desde la última edición</span>}
                                  {v?.fecha && <span style={{ color:"#555" }}>{st === "vigente" ? "validado" : "última vez"} el {new Date(v.fecha).toLocaleDateString("es-MX")}</span>}
                                </div>
                              );
                            })}
                          </div>
                          {changedLabels.length > 0 && (
                            <div style={{ fontSize:11, color:"#666", marginTop:6 }}>Última edición cambió: {changedLabels.join(", ")}</div>
                          )}
                        </div>
                      );
                    })()}
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
      {showImportModulos && (
        <ImportJsonModal
          title="Módulos clínicos compartidos"
          placeholder='[{"modulo_id": "extravasacion_...", "nombre": "...", ...}]'
          collectionId="modulos_clinicos_compartidos"
          idField="modulo_id"
          token={token}
          onClose={() => setShowImportModulos(false)}
          onImported={() => fetchModulos(token).then(setModulosById)}
        />
      )}
      {showImportRefs && (
        <ImportJsonModal
          title="Referencias bibliográficas"
          placeholder='[{"reference_id": "ref_...", "cita": "...", ...}]'
          collectionId="referencias_bibliograficas"
          idField="reference_id"
          token={token}
          onClose={() => setShowImportRefs(false)}
          onImported={() => fetchReferencias(token).then(setRefsById)}
        />
      )}
    </div>
  );
}
