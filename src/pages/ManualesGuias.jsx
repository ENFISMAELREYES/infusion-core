import { useState, useEffect, useRef } from "react";
import { useAuth } from "../hooks/useAuth";
import { PROJECT_ID, DATABASE_ID } from "../config";
import { Block } from "../components/ContentBlocks";
import { uploadManualFile } from "../firebase";
import { openPdfBlob } from "../pdfOpen";

const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

// Son manuales del centro: cualquier copia fuera de la app queda marcada
// como no controlada (mismo criterio que una leyenda de "copia no
// controlada" en un sistema de calidad) -- se estampa en el PDF mismo, así
// que viaja con el archivo sin importar cómo se imprima/capture/comparta.
const WATERMARK_TEXT = "COPIA NO CONTROLADA — SOLO CONSULTA DENTRO DE INFUSIONCORE";

// pdf-lib pesa bastante (~180 KB) y solo lo usa el jefe al subir un
// manual -- se carga bajo demanda en vez de ir en el paquete principal
// que descarga todo el personal cada vez que abre la app.
async function watermarkPdf(file) {
  const { PDFDocument, rgb, degrees, StandardFonts } = await import("pdf-lib");
  const bytes = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  pdfDoc.getPages().forEach(page => {
    const { width, height } = page.getSize();
    const size = 20;
    const textWidth = font.widthOfTextAtSize(WATERMARK_TEXT, size);
    page.drawText(WATERMARK_TEXT, {
      x: width / 2 - textWidth / 2,
      y: height / 2,
      size,
      font,
      color: rgb(0.8, 0.1, 0.1),
      opacity: 0.16,
      rotate: degrees(45),
    });
    page.drawText(WATERMARK_TEXT, {
      x: 20,
      y: 16,
      size: 7,
      font,
      color: rgb(0.4, 0.4, 0.4),
      opacity: 0.6,
    });
  });
  const watermarkedBytes = await pdfDoc.save();
  return new Blob([watermarkedBytes], { type: "application/pdf" });
}

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

async function fetchManuales(token) {
  const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "manuales_guias" }], limit: 500 } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

const inputStyle = { width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 9, padding: "9px 12px", color: "#f0f0f0", fontSize: 13, outline: "none", boxSizing: "border-box" };

const TIPO_LABEL = { manual: "📘 Manual completo", guia_rapida: "⚡ Guía rápida" };

const PLACEHOLDER = `[
  {
    "id_interno": "manual-desfibrilador-philips",
    "titulo": "Manual de uso — Desfibrilador Philips HeartStart",
    "categoria": "Equipo médico",
    "tipo": "manual",
    "resumen": "Pasos para preparar, aplicar y dar mantenimiento al desfibrilador.",
    "bloques": [
      { "type": "h2", "text": "Antes de usar" },
      { "type": "p", "text": "Texto libre…" },
      { "type": "bullet", "lead": "Paso 1 — ", "text": "Enciende el equipo…" },
      { "type": "callout", "tone": "danger", "title": "Importante", "lines": ["…"] }
    ]
  }
]`;

function ImportModal({ token, onClose, onImported }) {
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
    const badIndex = items.findIndex(it => !it?.id_interno);
    if (badIndex !== -1) { setError(`El elemento #${badIndex + 1} no trae "id_interno" -- es el campo con el que se identifica.`); return; }
    setSaving(true);
    const failedMsgs = [];
    let savedCount = 0;
    for (let i = 0; i < items.length; i++) {
      setProgress({ done: i, total: items.length });
      const item = items[i];
      try {
        const docId = String(item.id_interno).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
        const data = { ...item, updatedAt: new Date().toISOString() };
        const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
        const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join("&");
        const res = await fetch(`${FIRESTORE_BASE_URL}/manuales_guias/${docId}?${mask}`,
          { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
        savedCount++;
      } catch (e) {
        failedMsgs.push(`${item.id_interno}: ${e.message}`);
      }
    }
    setProgress(null);
    setSaving(false);
    if (savedCount > 0) onImported();
    if (failedMsgs.length > 0) setError(`${failedMsgs.length} de ${items.length} no se guardaron:\n` + failedMsgs.join("\n"));
    else onClose();
  };

  return (
    <div onClick={() => !saving && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#161616", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 20, width: "100%", maxWidth: 640, maxHeight: "88vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#f0f0f0" }}>📘 Importar manual / guía</div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Pega el JSON (uno o varios, en arreglo) tal cual lo prepares -- reemplaza cada elemento existente por su "id_interno". Formato esperado:</div>
        </div>
        <div>
          <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={onFileSelected} style={{ display: "none" }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={saving}
            style={{ padding: "7px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(79,195,247,0.08)", border: "1px solid rgba(79,195,247,0.25)", color: "#4fc3f7" }}>
            📎 Subir archivo .json
          </button>
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder={PLACEHOLDER}
          rows={16} style={{ ...inputStyle, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, resize: "vertical" }} />
        {error && <div style={{ fontSize: 12, color: "#ff6b6b", padding: "8px 10px", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.25)", borderRadius: 8, whiteSpace: "pre-line" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: "10px", borderRadius: 9, fontSize: 13, cursor: saving ? "wait" : "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#888" }}>Cancelar</button>
          <button onClick={save} disabled={saving || !text.trim()} style={{ flex: 2, padding: "10px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "linear-gradient(135deg,#00d4aa,#0F6E56)", border: "none", color: "#fff", opacity: (saving || !text.trim()) ? 0.6 : 1 }}>
            {saving ? (progress ? `Guardando ${progress.done + 1} de ${progress.total}…` : "Guardando…") : "✓ Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

const CATEGORIAS_SUGERIDAS = ["Equipo médico", "Procedimiento", "Protocolo de emergencia", "Guía rápida", "Otro"];

function UploadPdfModal({ onClose, onSaved }) {
  const { user } = useAuth();
  const [titulo, setTitulo] = useState("");
  const [categoria, setCategoria] = useState("");
  const [tipo, setTipo] = useState("manual");
  const [resumen, setResumen] = useState("");
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);

  const onFileSelected = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.type !== "application/pdf") { setError("Solo se aceptan archivos PDF."); return; }
    setError("");
    setFile(f);
  };

  const save = async () => {
    if (!titulo.trim()) { setError("Falta el título."); return; }
    if (!file) { setError("Falta elegir el archivo PDF."); return; }
    setError("");
    setSaving(true);
    try {
      const idInterno = titulo.trim().toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
        .slice(0, 80) + "-" + Date.now();
      const watermarked = await watermarkPdf(file);
      const archivoUrl = await uploadManualFile(idInterno, watermarked);
      const token = await user.getIdToken(true);
      const data = {
        id_interno: idInterno,
        titulo: titulo.trim(),
        categoria: categoria.trim(),
        tipo,
        resumen: resumen.trim(),
        archivo_url: archivoUrl,
        archivo_nombre: file.name,
        updatedAt: new Date().toISOString(),
      };
      const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
      const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join("&");
      const res = await fetch(`${FIRESTORE_BASE_URL}/manuales_guias/${idInterno}?${mask}`,
        { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
      onSaved();
      onClose();
    } catch (e) {
      setError("Error al guardar: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onClick={() => !saving && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#161616", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 20, width: "100%", maxWidth: 480, maxHeight: "88vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#f0f0f0" }}>📄 Subir manual / guía en PDF</div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>El personal solo puede ver/imprimir, no descargar. Se marca automáticamente como "copia no controlada" en el PDF.</div>
        </div>

        <div>
          <label style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>Título</label>
          <input value={titulo} onChange={e => setTitulo(e.target.value)} placeholder="ej: Manual de uso — Desfibrilador Philips HeartStart" style={inputStyle} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <label style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>Categoría</label>
            <input value={categoria} onChange={e => setCategoria(e.target.value)} placeholder="ej: Equipo médico" list="categorias-sugeridas" style={inputStyle} />
            <datalist id="categorias-sugeridas">
              {CATEGORIAS_SUGERIDAS.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div>
            <label style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>Tipo</label>
            <select value={tipo} onChange={e => setTipo(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
              <option value="manual">📘 Manual completo</option>
              <option value="guia_rapida">⚡ Guía rápida</option>
            </select>
          </div>
        </div>

        <div>
          <label style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>Resumen (opcional)</label>
          <textarea value={resumen} onChange={e => setResumen(e.target.value)} rows={2} placeholder="Una línea de qué trata, se ve en la lista antes de abrirlo" style={{ ...inputStyle, resize: "vertical" }} />
        </div>

        <div>
          <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" onChange={onFileSelected} style={{ display: "none" }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={saving}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(79,195,247,0.08)", border: "1px solid rgba(79,195,247,0.25)", color: "#4fc3f7" }}>
            {file ? `📄 ${file.name}` : "📎 Elegir archivo PDF"}
          </button>
        </div>

        {error && <div style={{ fontSize: 12, color: "#ff6b6b", padding: "8px 10px", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.25)", borderRadius: 8, whiteSpace: "pre-line" }}>{error}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: "10px", borderRadius: 9, fontSize: 13, cursor: saving ? "wait" : "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#888" }}>Cancelar</button>
          <button onClick={save} disabled={saving} style={{ flex: 2, padding: "10px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "linear-gradient(135deg,#00d4aa,#0F6E56)", border: "none", color: "#fff", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Subiendo…" : "✓ Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ManualesGuias() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const blocked = profile?.role === "visualizador" && !profile?.isMedico;

  const [token, setToken] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tipoFilter, setTipoFilter] = useState("");
  const [categoriaFilter, setCategoriaFilter] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [openingPdf, setOpeningPdf] = useState(null);

  const viewPdf = async (it) => {
    setOpeningPdf(it.id);
    try {
      const res = await fetch(it.archivo_url);
      if (!res.ok) throw new Error("No se pudo descargar el archivo.");
      const blob = await res.blob();
      openPdfBlob(blob, (it.archivo_nombre || `${it.titulo}.pdf`), { allowDownload: false });
    } catch (e) {
      alert("Error al abrir el PDF: " + e.message);
    } finally {
      setOpeningPdf(null);
    }
  };

  const load = async (t) => {
    setLoading(true);
    const list = await fetchManuales(t || token);
    setItems(list.sort((a, b) => (a.titulo || "").localeCompare(b.titulo || "")));
    setLoading(false);
  };

  useEffect(() => {
    if (blocked) { setLoading(false); return; }
    user.getIdToken().then(t => { setToken(t); load(t); });
  }, [user, blocked]);

  const deleteItem = async (it) => {
    if (!confirm(`¿Eliminar "${it.titulo}"? No se puede deshacer.`)) return;
    setDeleting(it.id);
    try {
      const freshToken = await user.getIdToken(true);
      const res = await fetch(`${FIRESTORE_BASE_URL}/manuales_guias/${it.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${freshToken}` } });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
      setItems(prev => prev.filter(x => x.id !== it.id));
      if (expanded === it.id) setExpanded(null);
    } catch (e) {
      alert("Error al eliminar: " + e.message);
    } finally {
      setDeleting(null);
    }
  };

  const categorias = [...new Set(items.map(i => i.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const term = search.trim().toUpperCase();
  const filtered = items.filter(it => {
    if (tipoFilter && it.tipo !== tipoFilter) return false;
    if (categoriaFilter && it.categoria !== categoriaFilter) return false;
    if (!term) return true;
    const haystack = [it.titulo, it.resumen, it.categoria, ...(it.bloques || []).map(b => [b.text, b.title, ...(b.lines || [])].filter(Boolean).join(" "))].join(" ").toUpperCase();
    return haystack.includes(term);
  });

  if (blocked) return (
    <div style={{ padding: 40, color: "#666", textAlign: "center" }}>No tienes acceso a esta sección.</div>
  );
  if (loading) return <div style={{ padding: 40, color: "#666", textAlign: "center" }}>Cargando…</div>;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 820, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#fff", marginBottom: 4 }}>📘 Manuales y guías</h1>
          <p style={{ fontSize: 13, color: "#555" }}>Procedimientos, manuales de equipo y guías rápidas de referencia -- consulta libre para todo el personal.</p>
        </div>
        {isJefe && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setShowUpload(true)} style={{ padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "rgba(0,212,170,0.12)", border: "1px solid rgba(0,212,170,0.3)", color: "#00d4aa", whiteSpace: "nowrap" }}>
              ＋ Subir PDF
            </button>
            <button onClick={() => setShowImport(true)} style={{ padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#888", whiteSpace: "nowrap" }}>
              ＋ Importar JSON
            </button>
          </div>
        )}
      </div>

      <input placeholder="Buscar por título o contenido…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 }}>
        {[["", "Todos"], ["manual", "📘 Manuales"], ["guia_rapida", "⚡ Guías rápidas"]].map(([val, label]) => (
          <button key={val} onClick={() => setTipoFilter(val)} style={{
            padding: "6px 12px", borderRadius: 99, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
            background: tipoFilter === val ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${tipoFilter === val ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.08)"}`,
            color: tipoFilter === val ? "#00d4aa" : "#888",
          }}>{label}</button>
        ))}
        {categorias.length > 0 && <div style={{ width: 1, background: "rgba(255,255,255,0.1)", margin: "0 4px" }} />}
        {categorias.map(c => (
          <button key={c} onClick={() => setCategoriaFilter(categoriaFilter === c ? "" : c)} style={{
            padding: "6px 12px", borderRadius: 99, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
            background: categoriaFilter === c ? "rgba(79,195,247,0.12)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${categoriaFilter === c ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.08)"}`,
            color: categoriaFilter === c ? "#4fc3f7" : "#888",
          }}>{c}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ color: "#444", fontSize: 14, padding: 40, textAlign: "center", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 14 }}>
          {items.length === 0 ? "Sin manuales ni guías capturados todavía." : "Sin resultados para esa búsqueda."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(it => {
            const isOpen = expanded === it.id;
            return (
              <div key={it.id} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, overflow: "hidden" }}>
                <div onClick={() => setExpanded(isOpen ? null : it.id)} style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ flex: 1, fontSize: 14, color: "#f0f0f0", fontWeight: 600, minWidth: 160 }}>{it.titulo}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: it.tipo === "manual" ? "rgba(79,195,247,0.1)" : "rgba(255,179,71,0.1)", color: it.tipo === "manual" ? "#4fc3f7" : "#ffb347" }}>
                    {TIPO_LABEL[it.tipo] || it.tipo}
                  </span>
                  {it.archivo_url && <span style={{ fontSize: 13 }}>📄</span>}
                  {it.categoria && <span style={{ fontSize: 11, color: "#666" }}>{it.categoria}</span>}
                  <span style={{ color: "#555" }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {!isOpen && it.resumen && (
                  <div style={{ padding: "0 16px 12px", fontSize: 12, color: "#777" }}>{it.resumen}</div>
                )}
                {isOpen && (
                  <div style={{ padding: "0 16px 16px" }}>
                    {it.resumen && <p style={{ fontSize: 12.5, color: "#999", fontStyle: "italic", marginBottom: 10 }}>{it.resumen}</p>}
                    {it.archivo_url && (
                      <button onClick={() => viewPdf(it)} disabled={openingPdf === it.id} style={{ padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: openingPdf === it.id ? "wait" : "pointer", background: "rgba(79,195,247,0.1)", border: "1px solid rgba(79,195,247,0.3)", color: "#4fc3f7", marginBottom: 10 }}>
                        {openingPdf === it.id ? "Abriendo…" : "🖨️ Ver / Imprimir PDF"}
                      </button>
                    )}
                    {(it.bloques || []).map((b, i) => <Block key={i} block={b} />)}
                    {isJefe && (
                      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                        <button onClick={() => deleteItem(it)} disabled={deleting === it.id} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: deleting === it.id ? "wait" : "pointer", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.25)", color: "#ff6b6b" }}>
                          {deleting === it.id ? "Eliminando…" : "🗑 Eliminar"}
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

      {showImport && (
        <ImportModal
          token={token}
          onClose={() => setShowImport(false)}
          onImported={() => load()}
        />
      )}

      {showUpload && (
        <UploadPdfModal
          onClose={() => setShowUpload(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}
