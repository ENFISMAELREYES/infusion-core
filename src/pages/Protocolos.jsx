import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { FIRESTORE_BASE_URL } from "../config";
import { MASTER_CATALOG } from "../data/materialCatalog";
import { patchInventoryDoc } from "../inventoryPatch";
import { PROTOCOLOS } from "../data/protocolos";

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

// El almacén de cada protocolo es "PROTOCOLO_<código>" (ej. PROTOCOLO_WO46063)
// -- mismo criterio que CIPI_PRO/CIPI_PED en Inventario.jsx, uno por
// protocolo en vez de uno genérico. Así el material que se estoquea ahí
// sirve tanto para las visitas de muestras/IM capturadas aquí como para
// las sesiones de infusión/hidratación de ese mismo protocolo en Insumos.jsx
// (ver régimen de atención -> almacén de protocolo).
const warehouseFor = (code) => `PROTOCOLO_${code}`;
const MED_CATEGORIES = ["Medicamentos", "Oncológicos", "Inmunoterapia"];

// Insumos más usados en una visita de toma de muestra/IM (según el registro
// real de mayo) -- aparecen como botón de acceso rápido arriba de la lista
// de material, para no tener que buscarlos uno por uno cada vez. Nombres
// tal cual el catálogo oficial de la app, no como se anotaron en la hoja de
// control (que usaba apodos del mismo insumo). Es solo el valor por defecto:
// el jefe puede personalizar la lista (se guarda en
// settings/materialCatalog.protocoloQuickMaterial, mismo documento que ya
// usa el catálogo extra de Insumos/Inventario).
const QUICK_MATERIAL = [
  "GUANTE DE LATEX MEDIANO ESTERIL",
  "CUBREBOCAS DESECHABLE",
  "BATA P/ CIRUJANO DESECHABLE",
  "TOALLITAS DE ALCOHOL",
  "BANDA ADHESIVA CIRCULAR 22 MM",
];

async function saveQuickMaterial(token, updated) {
  await fetch(`${FIRESTORE_BASE_URL}/settings/materialCatalog?updateMask.fieldPaths=protocoloQuickMaterial`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { protocoloQuickMaterial: toFV(updated) } }),
  });
}

function inventoryDocId(warehouse, item) {
  return `${warehouse}_${item}`.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 200);
}

// Diferencia entre lo que ya se había descontado (oldArr) y lo que debería
// quedar descontado ahora (newArr) -- se usa al editar una visita ya
// guardada, para no volver a descontar todo desde cero (duplicaría el
// descuento) sino solo el delta: positivo = descontar más, negativo =
// regresar al inventario lo que ya no se usó.
function inventoryDeltas(oldArr, newArr) {
  const oldMap = Object.fromEntries((oldArr || []).map(x => [x.item, x.qty || 0]));
  const newMap = Object.fromEntries((newArr || []).map(x => [x.item, x.qty || 0]));
  const items = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
  const out = [];
  items.forEach(item => {
    const delta = (newMap[item] || 0) - (oldMap[item] || 0);
    if (delta !== 0) out.push({ item, delta });
  });
  return out;
}

// Descuenta (o regresa, si delta es negativo) un insumo del almacén del
// protocolo -- a diferencia de antes, si el artículo todavía no tiene
// existencia registrada ahí, SÍ se crea y se le permite quedar en números
// rojos (igual que ya funciona en Inventario.jsx: refleja que ya se usó
// algo pendiente de reponer, en vez de saltárselo en silencio).
async function applyInventoryDelta(token, warehouse, item, delta) {
  const docId = inventoryDocId(warehouse, item);
  let existing = null;
  try {
    const getRes = await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (getRes.ok) existing = parseDoc(await getRes.json());
  } catch {}
  const currentStock = existing?.currentStock ?? 0;
  const newStock = currentStock - delta;
  await patchInventoryDoc(token, docId, existing,
    { currentStock: newStock, lastUpdated: new Date().toISOString() },
    { item, warehouse, category: "", unit: "PIEZA" });
  return newStock;
}

const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
// Hora actual en HH:MM, mismo formato que el input type="time" -- para el
// botón "Ahora" de hora de toma, en vez de teclearla a mano.
const nowTimeStr = () => new Date().toLocaleTimeString("en-GB", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" });

const fmtMaterial = (arr) => (arr || []).map(m => `${m.item} ×${m.qty}`).join(", ") || "—";
const fmtMuestras = (arr) => (arr || []).map(m => `${m.tipo}${m.cantidad ? ` ×${m.cantidad}` : ""}${m.hora ? ` (${m.hora})` : ""}`).join(", ") || "—";
const fmtMedicamento = (arr) => (arr || []).map(m => `${m.item}${m.dosis ? ` ${m.dosis}` : ""}${m.qty ? ` ×${m.qty}` : ""}`).join(", ") || "—";

function openPrintWindow(title, bodyHtml) {
  const win = window.open("", "_blank", "width=850,height=900");
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#111;}
    h1{font-size:18px;margin-bottom:2px;} h2{font-size:14px;margin:20px 0 6px;}
    p{font-size:12px;color:#555;margin-top:0;margin-bottom:16px;}
    table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:18px;}
    th{text-align:left;padding:6px 8px;border-bottom:2px solid #333;}
    td{padding:5px 8px;border-bottom:1px solid #ddd;vertical-align:top;}
  </style></head><body>${bodyHtml}
    <script>window.onload = () => window.print();<\/script>
  </body></html>`);
  win.document.close();
}

const inputStyle = { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 8, padding: "7px 10px", color: "#f0f0f0", fontSize: 12 };
const btnStyle = { padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.3)", color: "#00d4aa" };
const removeBtnStyle = { padding: "3px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)", color: "#ff6b6b" };

export default function Protocolos() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const isEnfermera = profile?.role === "enfermera";
  const canCapture = isJefe || isEnfermera;
  // El coordinador de protocolos y cualquier otra cuenta visualizador
  // marcada con puedeVerProtocolos solo consultan reportes -- igual que ya
  // hace ManualesGuias.jsx con el visualizador no-médico.
  const blocked = profile?.role === "visualizador" && !profile?.isCoordinadorProtocolos && !profile?.puedeVerProtocolos;

  const [token, setToken] = useState("");
  useEffect(() => { user?.getIdToken().then(setToken); }, [user]);

  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [extraCatalog, setExtraCatalog] = useState([]);
  const [quickMaterial, setQuickMaterial] = useState(QUICK_MATERIAL);

  const loadVisits = async (t) => {
    const data = await fetchCollection(t, "protocol_visits");
    setVisits(data.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "")));
    setLoading(false);
  };
  useEffect(() => { if (token) loadVisits(token); }, [token]);

  useEffect(() => {
    if (!token) return;
    fetch(`${FIRESTORE_BASE_URL}/settings/materialCatalog`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.status === 404 ? null : res.json())
      .then(doc => {
        const parsed = doc ? parseDoc(doc) : {};
        setExtraCatalog(parsed.extraCatalog || []);
        setQuickMaterial(parsed.protocoloQuickMaterial?.length ? parsed.protocoloQuickMaterial : QUICK_MATERIAL);
      })
      .catch(() => { setExtraCatalog([]); setQuickMaterial(QUICK_MATERIAL); });
  }, [token]);

  const fullCatalog = [...MASTER_CATALOG, ...extraCatalog];
  const insumoOptions = fullCatalog.filter(c => !MED_CATEGORIES.includes(c.category)).map(c => c.item);
  const medOptions = fullCatalog.filter(c => MED_CATEGORIES.includes(c.category)).map(c => c.item);

  // Selector único a nivel de página -- qué protocolo se está capturando o
  // consultando. Con un solo protocolo de alta no hace nada todavía, pero
  // ya identifica cada visita con su código real y queda listo para elegir
  // entre varios en cuanto se dé de alta el siguiente.
  const [protocolo, setProtocolo] = useState(PROTOCOLOS[0].code);
  const protocoloLabel = PROTOCOLOS.find(p => p.code === protocolo)?.label || protocolo;
  const visitsDelProtocolo = visits.filter(v => v.protocolo === protocolo);
  const patientOptions = [...new Set(visitsDelProtocolo.map(v => v.patientName).filter(Boolean))].sort();

  const [tab, setTab] = useState(canCapture ? "captura" : "paciente");
  // Visita que se está corrigiendo (ej. faltó agregar material, o al final
  // sí pasó a hidratación) -- null cuando el formulario es para una nueva.
  const [editingVisit, setEditingVisit] = useState(null);
  const startEdit = (v) => { setEditingVisit(v); setTab("captura"); };

  if (blocked) return <div style={{ padding: 40, color: "#666", textAlign: "center" }}>No tienes acceso a esta sección.</div>;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#fff", marginBottom: 4 }}>Protocolos</h1>
        <p style={{ fontSize: 13, color: "#555" }}>Material, muestras y medicamento de los pacientes en protocolo de investigación clínica</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <label style={{ fontSize: 11, color: "#666" }}>Protocolo</label>
        <select value={protocolo} onChange={e => setProtocolo(e.target.value)} style={inputStyle}>
          {PROTOCOLOS.map(p => <option key={p.code} value={p.code}>{p.label}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {[...(canCapture ? [["captura", "＋ Nueva visita"]] : []), ["paciente", "👤 Por paciente"], ["dia", "📅 Por día"], ["mes", "🗓️ Por mes"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: tab === id ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${tab === id ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.08)"}`,
            color: tab === id ? "#00d4aa" : "#666",
          }}>{label}</button>
        ))}
      </div>

      {loading ? <div style={{ color: "#555", padding: 40, textAlign: "center" }}>Cargando…</div> : (
        <>
          {tab === "captura" && canCapture && (
            <CapturaForm token={token} profile={profile} isJefe={isJefe} visits={visitsDelProtocolo} protocolo={protocolo} insumoOptions={insumoOptions} medOptions={medOptions}
              patientOptions={patientOptions} editingVisit={editingVisit} onCancelEdit={() => setEditingVisit(null)}
              quickMaterial={quickMaterial} onQuickMaterialChange={async (updated) => { await saveQuickMaterial(token, updated); setQuickMaterial(updated); }}
              onSaved={() => { setEditingVisit(null); loadVisits(token); }} />
          )}
          {tab === "paciente" && <ReportePorPaciente visits={visitsDelProtocolo} patientOptions={patientOptions} protocoloLabel={protocoloLabel} canEdit={canCapture} onEdit={startEdit} />}
          {tab === "dia" && <ReportePorDia visits={visitsDelProtocolo} protocoloLabel={protocoloLabel} canEdit={canCapture} onEdit={startEdit} />}
          {tab === "mes" && <ReportePorMes visits={visitsDelProtocolo} protocoloLabel={protocoloLabel} canEdit={canCapture} onEdit={startEdit} />}
        </>
      )}
    </div>
  );
}

function CapturaForm({ token, profile, isJefe, visits, protocolo, insumoOptions, medOptions, patientOptions, editingVisit, onCancelEdit, onSaved, quickMaterial, onQuickMaterialChange }) {
  const [patientName, setPatientName] = useState("");
  const [dob, setDob] = useState("");
  const [date, setDate] = useState(todayStr());
  const [visitNumber, setVisitNumber] = useState("");
  const [material, setMaterial] = useState([]);
  const [muestras, setMuestras] = useState([]);
  const [medicamento, setMedicamento] = useState([]);
  const [notas, setNotas] = useState("");
  const [draftMaterial, setDraftMaterial] = useState("");
  const [draftMed, setDraftMed] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [materialOpen, setMaterialOpen] = useState(true);
  const [editingQuick, setEditingQuick] = useState(false);
  const [savingQuick, setSavingQuick] = useState(false);

  // Precarga el formulario con la visita a corregir -- faltó agregar
  // material, o al final sí pasó a hidratación y hay que sumar algo más.
  useEffect(() => {
    if (!editingVisit) return;
    setPatientName(editingVisit.patientName || "");
    setDob(editingVisit.dob || "");
    setDate(editingVisit.date || todayStr());
    setVisitNumber(editingVisit.visitNumber != null ? String(editingVisit.visitNumber) : "");
    setMaterial(editingVisit.material || []);
    setMuestras(editingVisit.muestras || []);
    setMedicamento(editingVisit.medicamento || []);
    setNotas(editingVisit.notas || "");
    setNotice("");
  }, [editingVisit?.id]);

  // Precarga la fecha de nacimiento de visitas anteriores con el mismo
  // nombre -- igual que ya se hace con dob en NuevaSession, la fecha de
  // nacimiento es la regla de identificación real, el nombre solo no basta
  // (dos pacientes pueden compartir nombre). Si hay más de una fecha
  // distinta para el mismo nombre, no se precarga nada -- se avisa para
  // que se escriba a mano y no se arrastre la de otro paciente.
  const handlePatientBlur = () => {
    if (!patientName.trim() || dob) return;
    const dobs = [...new Set(visits
      .filter(v => (v.patientName || "").toUpperCase() === patientName.trim().toUpperCase() && v.dob)
      .map(v => v.dob))];
    if (dobs.length === 1) setDob(dobs[0]);
    else if (dobs.length > 1) setNotice("Hay más de una fecha de nacimiento registrada con este nombre -- verifica cuál paciente es y captúrala a mano.");
  };

  const addMaterial = () => {
    if (!draftMaterial.trim()) return;
    setMaterial(prev => [...prev, { item: draftMaterial.trim().toUpperCase(), qty: 1 }]);
    setDraftMaterial("");
  };
  // Botón de acceso rápido: agrega el insumo con cantidad 1 si no estaba ya
  // en la lista -- si ya está, no hace nada (la cantidad se ajusta en el
  // campo numérico de abajo, no a base de tocar varias veces el botón).
  const addQuickMaterial = (item) => {
    setMaterial(prev => prev.some(m => m.item === item) ? prev : [...prev, { item, qty: 1 }]);
  };
  const addMedicamento = () => {
    if (!draftMed.trim()) return;
    setMedicamento(prev => [...prev, { item: draftMed.trim().toUpperCase(), dosis: "", qty: 1 }]);
    setDraftMed("");
  };
  const addMuestra = () => setMuestras(prev => [...prev, { tipo: "", cantidad: 1, hora: "" }]);

  const save = async () => {
    if (!patientName.trim()) { setNotice("Falta el nombre del paciente."); return; }
    if (!dob) { setNotice("Falta la fecha de nacimiento (regla de identificación del paciente)."); return; }
    if (material.length === 0 && muestras.length === 0 && medicamento.length === 0 && !notas.trim()) {
      setNotice("Agrega al menos material, una muestra, medicamento o una nota.");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      const visit = {
        protocolo,
        patientName: patientName.trim(),
        dob,
        date, visitNumber: visitNumber.trim() || null,
        material, muestras, medicamento, notas: notas.trim(),
        capturedBy: profile?.name || "",
        createdAt: new Date().toISOString(),
      };
      const res = await fetch(`${FIRESTORE_BASE_URL}/protocol_visits`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries(visit).map(([k, v]) => [k, toFV(v)])) }),
      });
      if (!res.ok) throw new Error(`Error ${res.status} al guardar la visita`);

      // Descontar del almacén "Protocolos" de Inventario -- igual que en
      // Inventario.jsx, se PERMITE quedar en números rojos si no hay
      // existencia suficiente (o el artículo nunca se había registrado
      // ahí): refleja que ya se usó, pendiente de reponer, en vez de
      // saltarse el descuento en silencio.
      const negativos = [];
      for (const it of [...material, ...medicamento]) {
        const newStock = await applyInventoryDelta(token, warehouseFor(protocolo), it.item, it.qty || 0);
        if (newStock < 0) negativos.push(it.item);
      }

      setPatientName(""); setDob(""); setVisitNumber(""); setMaterial([]); setMuestras([]); setMedicamento([]); setNotas("");
      setNotice(negativos.length > 0
        ? `Visita guardada. Sin existencia suficiente (quedó en números rojos en Inventario, hay que reponer): ${negativos.join(", ")}.`
        : "Visita guardada.");
      onSaved();
    } catch (e) {
      setNotice("Error al guardar: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!patientName.trim()) { setNotice("Falta el nombre del paciente."); return; }
    if (!dob) { setNotice("Falta la fecha de nacimiento (regla de identificación del paciente)."); return; }
    setSaving(true);
    setNotice("");
    try {
      const updated = {
        patientName: patientName.trim(), dob, date, visitNumber: visitNumber.trim() || null,
        material, muestras, medicamento, notas: notas.trim(),
      };
      const mask = Object.keys(updated).map(k => `updateMask.fieldPaths=${k}`).join("&");
      const res = await fetch(`${FIRESTORE_BASE_URL}/protocol_visits/${editingVisit.id}?${mask}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries(updated).map(([k, v]) => [k, toFV(v)])) }),
      });
      if (!res.ok) throw new Error(`Error ${res.status} al guardar los cambios`);

      // Solo se ajusta el delta contra lo que ya se había descontado --
      // evita volver a descontar todo desde cero (lo que duplicaría el
      // descuento de lo que no cambió).
      const oldCombined = [...(editingVisit.material || []), ...(editingVisit.medicamento || [])];
      const newCombined = [...material, ...medicamento];
      const negativos = [];
      for (const { item, delta } of inventoryDeltas(oldCombined, newCombined)) {
        const newStock = await applyInventoryDelta(token, warehouseFor(editingVisit.protocolo || protocolo), item, delta);
        if (newStock < 0) negativos.push(item);
      }

      setNotice(negativos.length > 0
        ? `Cambios guardados. Sin existencia suficiente (quedó en números rojos en Inventario, hay que reponer): ${negativos.join(", ")}.`
        : "Cambios guardados.");
      onCancelEdit();
      setPatientName(""); setDob(""); setVisitNumber(""); setMaterial([]); setMuestras([]); setMedicamento([]); setNotas("");
      onSaved();
    } catch (e) {
      setNotice("Error al guardar: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {editingVisit && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#ffb347", background: "rgba(255,179,71,0.08)", border: "1px solid rgba(255,179,71,0.25)", borderRadius: 8, padding: "8px 12px" }}>
          <span>✏️ Editando la visita de {editingVisit.patientName} ({editingVisit.date})</span>
          <button onClick={() => { onCancelEdit(); setPatientName(""); setDob(""); setVisitNumber(""); setMaterial([]); setMuestras([]); setMedicamento([]); setNotas(""); setNotice(""); }}
            style={removeBtnStyle}>Cancelar</button>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#666", marginBottom: 4 }}>Paciente</label>
          <input list="protocolos-pacientes" value={patientName} onChange={e => { setPatientName(e.target.value); setDob(""); }} onBlur={handlePatientBlur}
            placeholder="Nombre del paciente" style={{ ...inputStyle, width: 240 }} />
          <datalist id="protocolos-pacientes">{patientOptions.map(p => <option key={p} value={p} />)}</datalist>
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#666", marginBottom: 4 }}>Fecha de nacimiento</label>
          <input type="date" value={dob} onChange={e => setDob(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#666", marginBottom: 4 }}>Fecha</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#666", marginBottom: 4 }}>Visita (ej. C4D15)</label>
          <input value={visitNumber} onChange={e => setVisitNumber(e.target.value)} placeholder="C4D15" style={{ ...inputStyle, width: 90 }} />
        </div>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div onClick={() => setMaterialOpen(o => !o)} style={{ fontSize: 13, fontWeight: 600, color: "#f0f0f0", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, userSelect: "none" }}>
            <span style={{ fontSize: 10, color: "#666" }}>{materialOpen ? "▾" : "▸"}</span>
            🧰 Material usado
            {material.length > 0 && <span style={{ fontSize: 11, color: "#888", fontWeight: 400 }}>({material.length})</span>}
          </div>
          {isJefe && (
            <button onClick={() => setEditingQuick(true)} style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#888" }}>
              ⚙️ Personalizar accesos rápidos
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {quickMaterial.map(item => {
            const added = material.some(m => m.item === item);
            return (
              <button key={item} onClick={() => addQuickMaterial(item)} disabled={added}
                style={{ padding: "6px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: added ? "default" : "pointer",
                  background: added ? "rgba(0,212,170,0.1)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${added ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.08)"}`,
                  color: added ? "#00d4aa" : "#ccc" }}>
                {added ? "✓ " : "+ "}{item}
              </button>
            );
          })}
        </div>
        {materialOpen && material.map((m, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ flex: 1, fontSize: 12, color: "#ccc" }}>{m.item}</span>
            <input type="number" min="1" value={m.qty} onChange={e => setMaterial(prev => prev.map((x, xi) => xi === i ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x))}
              style={{ ...inputStyle, width: 60 }} />
            <button onClick={() => setMaterial(prev => prev.filter((_, xi) => xi !== i))} style={removeBtnStyle}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <input list="protocolos-insumos" value={draftMaterial} onChange={e => setDraftMaterial(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addMaterial()} placeholder="Agregar material…" style={{ ...inputStyle, flex: 1 }} />
          <datalist id="protocolos-insumos">{insumoOptions.map(o => <option key={o} value={o} />)}</datalist>
          <button onClick={addMaterial} style={btnStyle}>＋ Agregar</button>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#f0f0f0", marginBottom: 8 }}>🧪 Muestras tomadas</div>
        {muestras.map((m, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <input list="protocolos-tipos-muestra" value={m.tipo} onChange={e => setMuestras(prev => prev.map((x, xi) => xi === i ? { ...x, tipo: e.target.value } : x))}
              placeholder="Tipo (ej. sangre)" style={{ ...inputStyle, flex: 1 }} />
            <input type="number" min="1" value={m.cantidad} onChange={e => setMuestras(prev => prev.map((x, xi) => xi === i ? { ...x, cantidad: Math.max(1, Number(e.target.value)) } : x))}
              style={{ ...inputStyle, width: 60 }} />
            <input type="time" value={m.hora} onChange={e => setMuestras(prev => prev.map((x, xi) => xi === i ? { ...x, hora: e.target.value } : x))} style={{ ...inputStyle, width: 90 }} />
            <button onClick={() => setMuestras(prev => prev.map((x, xi) => xi === i ? { ...x, hora: nowTimeStr() } : x))} title="Registrar la hora de ahora, sin teclearla"
              style={{ padding: "6px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.3)", color: "#00d4aa", whiteSpace: "nowrap" }}>
              🕐 Ahora
            </button>
            <button onClick={() => setMuestras(prev => prev.filter((_, xi) => xi !== i))} style={removeBtnStyle}>✕</button>
          </div>
        ))}
        <datalist id="protocolos-tipos-muestra">
          {["Sangre", "Orina", "Saliva", "Hisopado", "Biopsia"].map(o => <option key={o} value={o} />)}
        </datalist>
        <button onClick={addMuestra} style={btnStyle}>＋ Agregar muestra</button>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#f0f0f0", marginBottom: 8 }}>💉 Medicamento aplicado (IM)</div>
        {medicamento.map((m, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ flex: 1, fontSize: 12, color: "#ccc" }}>{m.item}</span>
            <input placeholder="Dosis" value={m.dosis} onChange={e => setMedicamento(prev => prev.map((x, xi) => xi === i ? { ...x, dosis: e.target.value } : x))}
              style={{ ...inputStyle, width: 90 }} />
            <input type="number" min="1" value={m.qty} onChange={e => setMedicamento(prev => prev.map((x, xi) => xi === i ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x))}
              style={{ ...inputStyle, width: 60 }} />
            <button onClick={() => setMedicamento(prev => prev.filter((_, xi) => xi !== i))} style={removeBtnStyle}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <input list="protocolos-medicamentos" value={draftMed} onChange={e => setDraftMed(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addMedicamento()} placeholder="Agregar medicamento…" style={{ ...inputStyle, flex: 1 }} />
          <datalist id="protocolos-medicamentos">{medOptions.map(o => <option key={o} value={o} />)}</datalist>
          <button onClick={addMedicamento} style={btnStyle}>＋ Agregar</button>
        </div>
      </div>

      <div>
        <label style={{ display: "block", fontSize: 11, color: "#666", marginBottom: 4 }}>Notas (ej. días de hidratación relacionados, observaciones)</label>
        <textarea value={notas} onChange={e => setNotas(e.target.value)} rows={2} placeholder="Texto libre…"
          style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit" }} />
      </div>

      {notice && <div style={{ fontSize: 12, color: notice.startsWith("Error") ? "#ff6b6b" : "#00d4aa", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "8px 12px" }}>{notice}</div>}

      <button onClick={editingVisit ? saveEdit : save} disabled={saving} style={{ ...btnStyle, alignSelf: "flex-start", padding: "10px 20px", fontSize: 13, cursor: saving ? "wait" : "pointer" }}>
        {saving ? "Guardando…" : editingVisit ? "Guardar cambios" : "Guardar visita"}
      </button>

      {editingQuick && (
        <QuickMaterialModal options={insumoOptions} current={quickMaterial} saving={savingQuick}
          onClose={() => setEditingQuick(false)}
          onSave={async (updated) => {
            setSavingQuick(true);
            try { await onQuickMaterialChange(updated); setEditingQuick(false); }
            catch (e) { alert("Error al guardar: " + e.message); }
            finally { setSavingQuick(false); }
          }} />
      )}
    </div>
  );
}

// Permite al jefe elegir qué insumos aparecen como botón de acceso rápido
// arriba de la lista de material -- antes era una lista fija en el código
// (QUICK_MATERIAL), ahora se guarda en settings/materialCatalog y se puede
// ajustar sin tocar código conforme cambie lo que más se usa.
function QuickMaterialModal({ options, current, saving, onClose, onSave }) {
  const [selected, setSelected] = useState(current);
  const [filter, setFilter] = useState("");
  const toggle = (item) => setSelected(prev => prev.includes(item) ? prev.filter(x => x !== item) : [...prev, item]);
  const filtered = options.filter(o => o.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#161616", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 20, width: "100%", maxWidth: 440, maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#f0f0f0" }}>Accesos rápidos de material</div>
        <div style={{ fontSize: 12, color: "#888" }}>Elige qué insumos aparecen como botón arriba de la lista, en vez de buscarlos uno por uno.</div>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Buscar insumo…" style={{ ...inputStyle, width: "100%" }} />
        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {filtered.map(item => (
            <label key={item} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, fontSize: 12, color: "#ccc", cursor: "pointer" }}>
              <input type="checkbox" checked={selected.includes(item)} onChange={() => toggle(item)} />
              {item}
            </label>
          ))}
          {filtered.length === 0 && <div style={{ color: "#555", fontSize: 12, padding: 10, textAlign: "center" }}>Sin resultados.</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#666" }}>{selected.length} seleccionado{selected.length !== 1 ? "s" : ""}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#888" }}>Cancelar</button>
            <button onClick={() => onSave(selected)} disabled={saving} style={{ ...btnStyle, cursor: saving ? "wait" : "pointer" }}>{saving ? "Guardando…" : "Guardar"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function VisitTable({ rows, showPatient, canEdit, onEdit }) {
  if (rows.length === 0) return <div style={{ color: "#444", padding: 30, textAlign: "center", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 14 }}>Sin visitas para este filtro.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#666" }}>
            <th style={{ padding: "6px 8px" }}>Fecha</th>
            {showPatient && <th style={{ padding: "6px 8px" }}>Paciente</th>}
            {showPatient && <th style={{ padding: "6px 8px" }}>Fecha nac.</th>}
            <th style={{ padding: "6px 8px" }}>Visita</th>
            <th style={{ padding: "6px 8px" }}>Material</th>
            <th style={{ padding: "6px 8px" }}>Muestras</th>
            <th style={{ padding: "6px 8px" }}>Medicamento</th>
            <th style={{ padding: "6px 8px" }}>Notas</th>
            {canEdit && <th style={{ padding: "6px 8px" }}></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(v => (
            <tr key={v.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <td style={{ padding: "6px 8px", color: "#ccc" }}>{v.date}</td>
              {showPatient && <td style={{ padding: "6px 8px", color: "#f0f0f0", fontWeight: 600 }}>{v.patientName}</td>}
              {showPatient && <td style={{ padding: "6px 8px", color: "#888" }}>{v.dob || "—"}</td>}
              <td style={{ padding: "6px 8px", color: "#888" }}>{v.visitNumber ?? "—"}</td>
              <td style={{ padding: "6px 8px", color: "#AFA9EC" }}>{fmtMaterial(v.material)}</td>
              <td style={{ padding: "6px 8px", color: "#00d4aa" }}>{fmtMuestras(v.muestras)}</td>
              <td style={{ padding: "6px 8px", color: "#ffb347" }}>{fmtMedicamento(v.medicamento)}</td>
              <td style={{ padding: "6px 8px", color: "#999" }}>{v.notas || "—"}</td>
              {canEdit && <td style={{ padding: "6px 8px" }}>
                <button onClick={() => onEdit(v)} title="Editar material/muestras/medicamento de esta visita"
                  style={{ padding: "3px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "rgba(175,169,236,0.1)", border: "1px solid rgba(175,169,236,0.3)", color: "#AFA9EC" }}>✏️</button>
              </td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportePorPaciente({ visits, patientOptions, protocoloLabel, canEdit, onEdit }) {
  const [patient, setPatient] = useState(patientOptions[0] || "");
  useEffect(() => { if (!patient && patientOptions.length > 0) setPatient(patientOptions[0]); }, [patientOptions]);

  if (patientOptions.length === 0) return <div style={{ color: "#444", padding: 40, textAlign: "center" }}>Aún no hay visitas registradas para {protocoloLabel}.</div>;

  const rows = visits.filter(v => v.patientName === patient).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const dob = rows.find(v => v.dob)?.dob;

  const print = () => {
    const body = `
      <h1>Protocolo ${protocoloLabel} — ${patient}</h1>
      <p>${dob ? `Fecha de nacimiento: ${dob} · ` : ""}${rows.length} visita${rows.length !== 1 ? "s" : ""} · Generado ${new Date().toLocaleString("es-MX")}</p>
      <table><thead><tr><th>Fecha</th><th>Visita</th><th>Material</th><th>Muestras</th><th>Medicamento</th><th>Notas</th></tr></thead><tbody>
      ${rows.map(v => `<tr><td>${v.date}</td><td>${v.visitNumber ?? "—"}</td><td>${fmtMaterial(v.material)}</td><td>${fmtMuestras(v.muestras)}</td><td>${fmtMedicamento(v.medicamento)}</td><td>${v.notas || "—"}</td></tr>`).join("")}
      </tbody></table>`;
    openPrintWindow(`Protocolo ${protocoloLabel} — ${patient}`, body);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
        <select value={patient} onChange={e => setPatient(e.target.value)} style={inputStyle}>
          {patientOptions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        {dob && <span style={{ fontSize: 12, color: "#888" }}>Fecha de nacimiento: {dob}</span>}
        <button onClick={print} style={btnStyle}>🖨️ Imprimir</button>
      </div>
      <VisitTable rows={rows} showPatient={false} canEdit={canEdit} onEdit={onEdit} />
    </div>
  );
}

function ReportePorDia({ visits, protocoloLabel, canEdit, onEdit }) {
  const [day, setDay] = useState(todayStr());
  const rows = visits.filter(v => v.date === day).sort((a, b) => (a.patientName || "").localeCompare(b.patientName || ""));

  const print = () => {
    const body = `
      <h1>Protocolo ${protocoloLabel} — ${day}</h1>
      <p>${rows.length} visita${rows.length !== 1 ? "s" : ""} · Generado ${new Date().toLocaleString("es-MX")}</p>
      <table><thead><tr><th>Paciente</th><th>Fecha nac.</th><th>Visita</th><th>Material</th><th>Muestras</th><th>Medicamento</th><th>Notas</th></tr></thead><tbody>
      ${rows.map(v => `<tr><td>${v.patientName}</td><td>${v.dob || "—"}</td><td>${v.visitNumber ?? "—"}</td><td>${fmtMaterial(v.material)}</td><td>${fmtMuestras(v.muestras)}</td><td>${fmtMedicamento(v.medicamento)}</td><td>${v.notas || "—"}</td></tr>`).join("")}
      </tbody></table>`;
    openPrintWindow(`Protocolo ${protocoloLabel} — ${day}`, body);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <button onClick={() => { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() - 1); setDay(d.toLocaleDateString("en-CA")); }} style={{ ...inputStyle, cursor: "pointer" }}>◀</button>
        <input type="date" value={day} onChange={e => setDay(e.target.value)} style={inputStyle} />
        <button onClick={() => { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() + 1); setDay(d.toLocaleDateString("en-CA")); }} style={{ ...inputStyle, cursor: "pointer" }}>▶</button>
        <button onClick={print} style={btnStyle}>🖨️ Imprimir</button>
      </div>
      <VisitTable rows={rows} showPatient={true} canEdit={canEdit} onEdit={onEdit} />
    </div>
  );
}

function ReportePorMes({ visits, protocoloLabel, canEdit, onEdit }) {
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const rows = visits.filter(v => (v.date || "").startsWith(month)).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const patients = new Set(rows.map(v => v.patientName));

  const matTotals = {}, medTotals = {}, muestraTotals = {};
  rows.forEach(v => {
    (v.material || []).forEach(m => { matTotals[m.item] = (matTotals[m.item] || 0) + (m.qty || 0); });
    (v.medicamento || []).forEach(m => { medTotals[m.item] = (medTotals[m.item] || 0) + (m.qty || 0); });
    (v.muestras || []).forEach(m => { muestraTotals[m.tipo] = (muestraTotals[m.tipo] || 0) + (m.cantidad || 0); });
  });
  const totalsRows = (totals) => Object.entries(totals).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([item, qty]) => `<tr><td>${item}</td><td style="text-align:right;">${qty}</td></tr>`).join("") || `<tr><td colspan="2">—</td></tr>`;

  const print = () => {
    const body = `
      <h1>Protocolo ${protocoloLabel} — ${month}</h1>
      <p>${rows.length} visita${rows.length !== 1 ? "s" : ""} · ${patients.size} paciente${patients.size !== 1 ? "s" : ""} · Generado ${new Date().toLocaleString("es-MX")}</p>
      <h2>Material consumido</h2>
      <table><thead><tr><th>Artículo</th><th style="text-align:right;">Cantidad</th></tr></thead><tbody>${totalsRows(matTotals)}</tbody></table>
      <h2>Medicamento aplicado</h2>
      <table><thead><tr><th>Medicamento</th><th style="text-align:right;">Cantidad</th></tr></thead><tbody>${totalsRows(medTotals)}</tbody></table>
      <h2>Muestras tomadas</h2>
      <table><thead><tr><th>Tipo</th><th style="text-align:right;">Cantidad</th></tr></thead><tbody>${totalsRows(muestraTotals)}</tbody></table>
      <h2>Detalle por visita</h2>
      <table><thead><tr><th>Fecha</th><th>Paciente</th><th>Fecha nac.</th><th>Visita</th><th>Material</th><th>Muestras</th><th>Medicamento</th><th>Notas</th></tr></thead><tbody>
      ${rows.map(v => `<tr><td>${v.date}</td><td>${v.patientName}</td><td>${v.dob || "—"}</td><td>${v.visitNumber ?? "—"}</td><td>${fmtMaterial(v.material)}</td><td>${fmtMuestras(v.muestras)}</td><td>${fmtMedicamento(v.medicamento)}</td><td>${v.notas || "—"}</td></tr>`).join("")}
      </tbody></table>`;
    openPrintWindow(`Protocolo ${protocoloLabel} — ${month}`, body);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={inputStyle} />
        <button onClick={print} style={btnStyle}>🖨️ Imprimir</button>
      </div>
      <div style={{ marginBottom: 16, fontSize: 13, color: "#888" }}>
        {rows.length} visita{rows.length !== 1 ? "s" : ""} · {patients.size} paciente{patients.size !== 1 ? "s" : ""}
      </div>
      <VisitTable rows={rows} showPatient={true} canEdit={canEdit} onEdit={onEdit} />
    </div>
  );
}
