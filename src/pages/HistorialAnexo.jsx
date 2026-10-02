import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { PROJECT_ID, DATABASE_ID } from "../config";
import { openPdfBlob } from "../pdfOpen";

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

async function runQuery(token, structuredQuery) {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

const emptyMed = () => ({ id: Date.now() + Math.random(), name: "", dose: "", diluent: "", time: "" });

const inputStyle = { width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 8, padding: "8px 10px", color: "#f0f0f0", fontSize: 13, outline: "none", boxSizing: "border-box" };
const labelStyle = { fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 };

export default function HistorialAnexo() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const allowed = isJefe || profile?.puedeEditarTratamientos;

  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [allSessions, setAllSessions] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patientSessions, setPatientSessions] = useState([]);
  const [anexos, setAnexos] = useState([]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);

  useEffect(() => {
    if (!user || !allowed) return;
    (async () => {
      const t = await user.getIdToken(true);
      setToken(t);
      setLoading(true);
      try {
        const data = await runQuery(t, { from: [{ collectionId: "sessions" }], orderBy: [{ field: { fieldPath: "date" }, direction: "DESCENDING" }], limit: 1000 });
        setAllSessions(data);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, [user, allowed]);

  const patientNames = [...new Set(allSessions.map(s => s.patientName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const suggestions = search.trim() && search !== selectedPatient
    ? patientNames.filter(n => n.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 8)
    : [];

  const loadPatient = async (name) => {
    setSelectedPatient(name);
    setSearch(name);
    setForm(null);
    setPatientSessions(allSessions.filter(s => s.patientName === name && !s.eliminado).sort((a, b) => (b.date || "").localeCompare(a.date || "")));
    setLoading(true);
    try {
      const t = token || await user.getIdToken(true);
      const data = await runQuery(t, {
        from: [{ collectionId: "historial_anexo" }],
        where: { fieldFilter: { field: { fieldPath: "patientName" }, op: "EQUAL", value: { stringValue: name } } },
      });
      data.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      setAnexos(data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const refreshAnexos = () => selectedPatient && loadPatient(selectedPatient);

  const openNewFromSession = (s) => {
    setForm({
      sourceSessionId: s.id,
      sourceSessionDate: s.date || "",
      date: s.date || "",
      cycle: s.cycle || "",
      meds: (s.meds || []).length ? s.meds.map(m => ({ id: m.id || (Date.now() + Math.random()), name: m.name || "", dose: m.dose || "", diluent: m.diluent || "", time: m.time || "" })) : [emptyMed()],
      note: "",
    });
  };
  const openNewBlank = () => {
    setForm({ sourceSessionId: null, sourceSessionDate: null, date: "", cycle: "", meds: [emptyMed()], note: "" });
  };
  const openEdit = (a) => {
    setForm({ id: a.id, sourceSessionId: a.sourceSessionId || null, sourceSessionDate: a.sourceSessionDate || null, date: a.date || "", cycle: a.cycle || "", meds: (a.meds || []).length ? a.meds : [emptyMed()], note: a.note || "" });
  };

  const saveForm = async () => {
    if (!form.date || !form.cycle) { alert("Completa fecha y ciclo."); return; }
    setSaving(true);
    try {
      const data = {
        patientName: selectedPatient,
        center: profile?.center || "",
        date: form.date,
        cycle: form.cycle,
        meds: form.meds.filter(m => m.name),
        note: form.note || "",
        sourceSessionId: form.sourceSessionId,
        sourceSessionDate: form.sourceSessionDate,
        updatedAt: new Date().toISOString(),
        updatedBy: profile?.name || profile?.email || "",
      };
      const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
      if (form.id) {
        const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
        const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/historial_anexo/${form.id}?${mask}`,
          { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) });
        if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || "Error al guardar"); }
      } else {
        fields.createdAt = toFV(new Date().toISOString());
        fields.createdBy = toFV(profile?.name || profile?.email || "");
        const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/historial_anexo`,
          { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) });
        if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || "Error al guardar"); }
      }
      setForm(null);
      refreshAnexos();
    } catch (e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  const deleteAnexo = async (a) => {
    const msg = a.eliminada
      ? `¿Quitar la exclusión? La sesión del ${a.date} volverá a aparecer en la bitácora.`
      : `¿Eliminar este anexo (${a.date})? Esto no afecta el historial clínico real.`;
    if (!confirm(msg)) return;
    try {
      await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/historial_anexo/${a.id}`,
        { method: "DELETE", headers: { "Authorization": `Bearer ${token}` } });
      refreshAnexos();
    } catch (e) { alert("Error: " + e.message); }
  };

  // Excluye una sesión real de la bitácora de seguro -- no la toca ni la
  // borra del historial clínico (sessions), solo guarda un anexo marcado
  // eliminada:true que buildBitacoraEntries() usa para saltarla al generar
  // el PDF. Igual que una corrección: un anexo por sesión, nunca los dos.
  const excludeSession = async (s) => {
    if (!confirm(`¿Excluir la sesión del ${s.date} de la bitácora para el seguro? No se borra del historial real, solo no va a aparecer en el PDF.`)) return;
    setSaving(true);
    try {
      const data = {
        patientName: selectedPatient,
        center: profile?.center || "",
        date: s.date || "",
        cycle: s.cycle || "",
        meds: [],
        note: "Excluida de la bitácora",
        sourceSessionId: s.id,
        sourceSessionDate: s.date || "",
        eliminada: true,
        createdAt: new Date().toISOString(),
        createdBy: profile?.name || profile?.email || "",
        updatedAt: new Date().toISOString(),
        updatedBy: profile?.name || profile?.email || "",
      };
      const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
      const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/historial_anexo`,
        { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ fields }) });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || "Error al excluir"); }
      refreshAnexos();
    } catch (e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  // Arma la lista final para la bitácora en PDF: cada sesión real se
  // reemplaza por su versión corregida si tiene un anexo que la referencia
  // (sourceSessionId), y los anexos sin sesión de origen se agregan como
  // ciclos nuevos -- el PDF sale exactamente igual al de una sesión real,
  // sin marcar nada como "corregido", porque es lo que se entrega al seguro.
  const buildBitacoraEntries = () => {
    const bySource = {};
    anexos.forEach(a => { if (a.sourceSessionId) bySource[a.sourceSessionId] = a; });
    const fromSessions = patientSessions
      .filter(s => !bySource[s.id]?.eliminada)
      .map(s => {
        const a = bySource[s.id];
        if (a) {
          return { id: `anexo_${a.id}`, date: a.date, cycle: a.cycle, schemeName: s.schemeName, events: s.events, meds: a.meds, globalNote: a.note || "" };
        }
        return { id: s.id, date: s.date, cycle: s.cycle, schemeName: s.schemeName, events: s.events, meds: s.meds, globalNote: s.globalNote, signatures: s.signatures };
      });
    const standaloneAnexos = anexos.filter(a => !a.sourceSessionId && !a.eliminada).map(a => ({
      id: `anexo_${a.id}`, date: a.date, cycle: a.cycle, meds: a.meds, globalNote: a.note || "",
    }));
    return [...fromSessions, ...standaloneAnexos];
  };

  const generateBitacora = async () => {
    if (!selectedPatient) return;
    const entries = buildBitacoraEntries();
    if (entries.length === 0) { alert("No hay sesiones ni anexos para este paciente."); return; }
    setGeneratingPdf(true);
    try {
      const t = token || await user.getIdToken(true);
      const sample = patientSessions[0] || {};
      const res = await fetch("/api/generate-bitacora-anexo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${t}` },
        body: JSON.stringify({
          patientName: selectedPatient,
          center: sample.center || profile?.center || "CITIO",
          sample: { dob: sample.dob, diagnosis: sample.diagnosis, physician: sample.physician, allergies: sample.allergies, insurance: sample.insurance },
          entries,
          token: t,
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Error al generar la bitácora"); }
      const blob = await res.blob();
      openPdfBlob(blob, `bitacora-${selectedPatient.replace(/\s+/g, "_")}.pdf`);
    } catch (e) { alert("Error: " + e.message); }
    finally { setGeneratingPdf(false); }
  };

  if (!allowed) return (
    <div style={{ padding: 40, color: "#666", textAlign: "center" }}>No tienes acceso a esta sección.</div>
  );

  return (
    <div style={{ padding: "24px 28px", maxWidth: 820, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#fff", marginBottom: 4 }}>📎 Historial anexo</h1>
        <p style={{ fontSize: 13, color: "#555" }}>Correcciones y ciclos adicionales para trámites de seguro de gastos médicos — no modifican el historial clínico real.</p>
      </div>

      <div style={{ position: "relative", marginBottom: 24 }}>
        <label style={labelStyle}>Paciente</label>
        <input
          value={search}
          onChange={e => { setSearch(e.target.value); if (e.target.value !== selectedPatient) { setSelectedPatient(null); setForm(null); } }}
          placeholder="Busca por nombre del paciente…"
          style={inputStyle}
        />
        {suggestions.length > 0 && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, marginTop: 4, background: "#161616", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, overflow: "hidden" }}>
            {suggestions.map(n => (
              <div key={n} onClick={() => loadPatient(n)} style={{ padding: "9px 12px", fontSize: 13, color: "#ddd", cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                {n}
              </div>
            ))}
          </div>
        )}
      </div>

      {loading && <div style={{ color: "#666", fontSize: 13, textAlign: "center", padding: 20 }}>Cargando…</div>}

      {!loading && selectedPatient && (
        <>
          <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Sesiones reales — solo consulta</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
            {patientSessions.length === 0 && <div style={{ color: "#555", fontSize: 13 }}>Sin sesiones registradas para este paciente.</div>}
            {patientSessions.map(s => {
              const linkedAnexo = anexos.find(a => a.sourceSessionId === s.id);
              return (
                <div key={s.id} style={{ padding: "10px 14px", borderRadius: 10, background: linkedAnexo?.eliminada ? "rgba(255,107,107,0.04)" : "rgba(255,255,255,0.02)", border: `1px solid ${linkedAnexo?.eliminada ? "rgba(255,107,107,0.2)" : "rgba(255,255,255,0.06)"}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 13, color: "#f0f0f0", fontWeight: 600, textDecoration: linkedAnexo?.eliminada ? "line-through" : "none" }}>{s.date} · {s.cycle}</div>
                    <div style={{ fontSize: 11.5, color: "#777", marginTop: 2 }}>{(s.meds || []).map(m => m.name).filter(Boolean).join(", ") || "—"}</div>
                    {linkedAnexo?.eliminada && <div style={{ fontSize: 10.5, color: "#ff6b6b", marginTop: 4 }}>🗑 Excluida de la bitácora</div>}
                    {linkedAnexo && !linkedAnexo.eliminada && <div style={{ fontSize: 10.5, color: "#4fc3f7", marginTop: 4 }}>📎 Ya tiene una corrección anexada</div>}
                  </div>
                  {!linkedAnexo && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => openNewFromSession(s)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: "rgba(79,195,247,0.1)", border: "1px solid rgba(79,195,247,0.3)", color: "#4fc3f7" }}>
                        📎 Anexar corrección
                      </button>
                      <button onClick={() => excludeSession(s)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.25)", color: "#ff6b6b" }}>
                        🗑 Excluir de bitácora
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>Anexos (seguro)</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={generateBitacora} disabled={generatingPdf} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: generatingPdf ? "wait" : "pointer", background: "rgba(255,179,71,0.1)", border: "1px solid rgba(255,179,71,0.25)", color: "#ffb347", opacity: generatingPdf ? 0.6 : 1 }}>
                {generatingPdf ? "Generando…" : "🖨️ Generar bitácora (PDF)"}
              </button>
              <button onClick={openNewBlank} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.25)", color: "#00d4aa" }}>
                + Nuevo anexo (ciclo nuevo)
              </button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            {anexos.length === 0 && <div style={{ color: "#555", fontSize: 13 }}>Sin anexos para este paciente todavía.</div>}
            {anexos.map(a => (
              <div key={a.id} style={{ padding: "12px 14px", borderRadius: 10, background: a.eliminada ? "rgba(255,107,107,0.05)" : "rgba(79,195,247,0.04)", border: `1px solid ${a.eliminada ? "rgba(255,107,107,0.2)" : "rgba(79,195,247,0.18)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 13, color: "#f0f0f0", fontWeight: 600 }}>{a.date} · {a.cycle}</div>
                    {a.eliminada ? (
                      <div style={{ fontSize: 10.5, color: "#ff6b6b", marginTop: 4 }}>🗑 Excluida de la bitácora — no aparecerá en el PDF</div>
                    ) : (
                      <>
                        <div style={{ fontSize: 11.5, color: "#777", marginTop: 2 }}>{(a.meds || []).map(m => `${m.name}${m.dose ? " " + m.dose : ""}`).filter(Boolean).join(", ") || "—"}</div>
                        <div style={{ fontSize: 10.5, color: "#4fc3f7", marginTop: 4 }}>
                          {a.sourceSessionDate ? `Corrige la sesión del ${a.sourceSessionDate}` : "Ciclo nuevo — no existe en el historial real"}
                        </div>
                      </>
                    )}
                    {a.note && !a.eliminada && <div style={{ fontSize: 11.5, color: "#999", marginTop: 4 }}>📋 {a.note}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {!a.eliminada && (
                      <button onClick={() => openEdit(a)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "rgba(255,179,71,0.1)", border: "1px solid rgba(255,179,71,0.25)", color: "#ffb347" }}>✏️ Editar</button>
                    )}
                    <button onClick={() => deleteAnexo(a)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.25)", color: "#ff6b6b" }}>
                      {a.eliminada ? "↺ Quitar exclusión" : "🗑"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {form && (
        <div onClick={() => !saving && setForm(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#161616", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 20, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#f0f0f0" }}>{form.id ? "✏️ Editar anexo" : "📎 Nuevo anexo"}</div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                {selectedPatient}{form.sourceSessionDate ? ` — corrige la sesión del ${form.sourceSessionDate}` : " — ciclo nuevo"}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={labelStyle}>Fecha</label>
                <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Ciclo</label>
                <input value={form.cycle} onChange={e => setForm(f => ({ ...f, cycle: e.target.value }))} placeholder="ej: Ciclo 3 Día 1" style={inputStyle} />
              </div>
            </div>

            <div>
              <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Medicamentos</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {form.meds.map((m, idx) => (
                  <div key={m.id} style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                      <button onClick={() => setForm(f => ({ ...f, meds: f.meds.filter((_, i) => i !== idx) }))} style={{ background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.25)", color: "#ff6b6b", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}>✕</button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      {[["Nombre", "name"], ["Dosis", "dose"], ["Dilución", "diluent"], ["Tiempo (min)", "time"]].map(([label, field]) => (
                        <div key={field}>
                          <label style={{ fontSize: 9, color: "#555", textTransform: "uppercase", display: "block", marginBottom: 3 }}>{label}</label>
                          <input value={m[field] || ""} onChange={e => setForm(f => ({ ...f, meds: f.meds.map((x, i) => i === idx ? { ...x, [field]: e.target.value } : x) }))}
                            style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "5px 8px", color: "#f0f0f0", fontSize: 11, outline: "none", boxSizing: "border-box" }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => setForm(f => ({ ...f, meds: [...f.meds, emptyMed()] }))} style={{ marginTop: 8, padding: "6px 14px", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.25)", color: "#00d4aa" }}>
                + Agregar medicamento
              </button>
            </div>

            <div>
              <label style={labelStyle}>Nota (opcional)</label>
              <textarea rows={2} value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} style={{ ...inputStyle, resize: "vertical" }} />
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setForm(null)} disabled={saving} style={{ flex: 1, padding: "9px", borderRadius: 9, fontSize: 13, cursor: saving ? "wait" : "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#888" }}>
                Cancelar
              </button>
              <button onClick={saveForm} disabled={saving} style={{ flex: 2, padding: "9px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(0,212,170,0.15)", border: "1px solid rgba(0,212,170,0.4)", color: "#00d4aa", opacity: saving ? 0.5 : 1 }}>
                {saving ? "Guardando…" : "✓ Guardar anexo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
