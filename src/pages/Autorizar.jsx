import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where, doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase/config";
import { useAuth } from "../hooks/useAuth";

const CAT_COLOR = {
  premedicacion: { bg: "#FAEEDA", text: "#633806", border: "#FAC775", dark: "rgba(250,199,117,0.15)" },
  inmunoterapia: { bg: "#E1F5EE", text: "#085041", border: "#5DCAA5", dark: "rgba(93,202,165,0.15)" },
  quimioterapia: { bg: "#FCEBEB", text: "#791F1F", border: "#F09595", dark: "rgba(240,149,149,0.15)" },
  adicional:     { bg: "#EEEDFE", text: "#3C3489", border: "#AFA9EC", dark: "rgba(175,169,236,0.15)" },
};
const CAT_LABEL = { premedicacion:"Premedicación", inmunoterapia:"Inmunoterapia", quimioterapia:"Quimioterapia", adicional:"Adicional" };

function MedRow({ med, onApprove, onCorrect }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ diluent: "", time: "", order: "", general: "" });
  const hasCorrection = Object.values(draft).some(v => v.trim());
  const cs = CAT_COLOR[med.category] || CAT_COLOR.adicional;

  const save = () => {
    if (hasCorrection) onCorrect(med.id, draft);
    else onApprove(med.id);
    setOpen(false);
  };

  return (
    <div style={{
      borderRadius: 12, overflow: "hidden",
      border: `1px solid ${med.reviewStatus === "approved" ? "rgba(29,158,117,0.3)" : med.reviewStatus === "corrected" ? "rgba(186,117,23,0.35)" : "rgba(255,255,255,0.08)"}`,
      borderLeft: `3px solid ${cs.border}`,
      background: "rgba(255,255,255,0.02)",
    }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: "13px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{
          width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
          background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, color: "#888", fontFamily: "'IBM Plex Mono', monospace",
        }}>{med.order}</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, color: "#f0f0f0", fontWeight: 600 }}>{med.name}</span>
            <span style={{ fontSize: 12, color: "#777" }}>{med.dose}</span>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
              background: cs.dark, color: cs.border, border: `1px solid ${cs.border}44`,
            }}>{CAT_LABEL[med.category]}</span>
          </div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{med.diluent} · {med.time ? `${med.time} min` : "sin tiempo"}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {med.reviewStatus === "approved" && <span style={{ fontSize: 11, color: "#1D9E75", background: "rgba(29,158,117,0.1)", border: "1px solid rgba(29,158,117,0.25)", padding: "3px 10px", borderRadius: 99 }}>Aprobado</span>}
          {med.reviewStatus === "corrected" && <span style={{ fontSize: 11, color: "#EF9F27", background: "rgba(186,117,23,0.1)", border: "1px solid rgba(186,117,23,0.25)", padding: "3px 10px", borderRadius: 99 }}>Con corrección</span>}
          <span style={{ color: "#555", fontSize: 12 }}>{open ? "▲" : "▼"}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 16px 16px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ paddingTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Dilución */}
            {[
              ["Corrección de dilución", "diluent", med.diluent, "ej: 250 ml SF"],
              ["Corrección de tiempo",   "time",    med.time ? `${med.time} min` : "—", "ej: 60 min"],
              ["Cambio de orden",        "order",   `Posición ${med.order}`, "ej: mover a posición 2"],
            ].map(([label, key, current, ph]) => (
              <div key={key}>
                <label style={{ fontSize: 11, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", display: "block", marginBottom: 6 }}>{label}</label>
                <div style={{ fontSize: 12, color: "#555", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 5 }}>Actual: {current}</div>
                <input placeholder={ph} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
                  style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 8, padding: "9px 12px", color: "#f0f0f0", fontSize: 13, outline: "none", fontFamily: "'IBM Plex Mono', monospace" }} />
              </div>
            ))}

            <div>
              <label style={{ fontSize: 11, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", display: "block", marginBottom: 6 }}>Nota adicional</label>
              <textarea rows={2} placeholder="Indicaciones específicas..." value={draft.general} onChange={e => setDraft(d => ({ ...d, general: e.target.value }))}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 8, padding: "9px 12px", color: "#f0f0f0", fontSize: 13, outline: "none", resize: "vertical" }} />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => { onApprove(med.id); setOpen(false); }} style={{
                flex: 1, padding: "10px", borderRadius: 9, fontSize: 13, fontWeight: 600,
                background: "rgba(29,158,117,0.12)", border: "1px solid rgba(29,158,117,0.35)", color: "#1D9E75",
              }}>✓ Aprobar sin cambios</button>
              <button onClick={save} disabled={!hasCorrection} style={{
                flex: 1, padding: "10px", borderRadius: 9, fontSize: 13, fontWeight: 600,
                background: hasCorrection ? "rgba(186,117,23,0.15)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${hasCorrection ? "rgba(186,117,23,0.4)" : "rgba(255,255,255,0.06)"}`,
                color: hasCorrection ? "#EF9F27" : "#444",
              }}>⚠ Guardar corrección</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Autorizar() {
  const { user } = useAuth();
  const today    = new Date().toISOString().split("T")[0];
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [medStates, setMedStates] = useState({});
  const [globalNote, setGlobalNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const q = query(collection(db, "sessions"), where("date", "==", today), where("authorized", "==", false));
    const unsub = onSnapshot(q, snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setSessions(data);
      if (!selected && data.length > 0) setSelected(data[0]);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (selected) {
      const init = {};
      (selected.meds || []).forEach(m => { init[m.id] = { ...m, reviewStatus: "pending" }; });
      setMedStates(init);
      setGlobalNote("");
      setDone(false);
    }
  }, [selected?.id]);

  const approveMed  = (id) => setMedStates(p => ({ ...p, [id]: { ...p[id], reviewStatus: "approved" } }));
  const correctMed  = (id, corr) => setMedStates(p => ({ ...p, [id]: { ...p[id], reviewStatus: "corrected", correction: corr } }));

  const meds        = Object.values(medStates);
  const pending     = meds.filter(m => m.reviewStatus === "pending").length;
  const corrected   = meds.filter(m => m.reviewStatus === "corrected").length;
  const allReviewed = pending === 0;

  const submit = async () => {
    if (!allReviewed || !selected) return;
    setSaving(true);
    try {
      const updatedMeds = meds.map(m => ({
        ...m,
        ...(m.correction?.diluent ? { diluent: m.correction.diluent } : {}),
        ...(m.correction?.time    ? { time: parseInt(m.correction.time) || m.time } : {}),
      }));
      await updateDoc(doc(db, "sessions", selected.id), {
        authorized: true,
        authorizedBy: user.uid,
        authorizedAt: serverTimestamp(),
        hasCorrestions: corrected > 0,
        globalNote,
        meds: updatedMeds,
        status: "pendiente",
      });
      setDone(true);
      setSessions(p => p.filter(s => s.id !== selected.id));
      setSelected(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>

      {/* Left panel - session list */}
      <div style={{
        width: 280, flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.06)",
        overflowY: "auto", padding: "24px 16px",
      }}>
        <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 14 }}>
          Pendientes de autorizar
        </div>
        {sessions.length === 0 ? (
          <div style={{ fontSize: 13, color: "#444", textAlign: "center", padding: "32px 0" }}>
            ✓ Sin pendientes hoy
          </div>
        ) : sessions.map(s => (
          <div key={s.id} onClick={() => { setSelected(s); setDone(false); }}
            style={{
              padding: "13px 14px", borderRadius: 10, cursor: "pointer", marginBottom: 8,
              background: selected?.id === s.id ? "rgba(255,179,71,0.12)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${selected?.id === s.id ? "rgba(255,179,71,0.35)" : "rgba(255,255,255,0.07)"}`,
              transition: "all 0.15s",
            }}>
            <div style={{ fontSize: 13, color: "#f0f0f0", fontWeight: 600, marginBottom: 3 }}>{s.patientName}</div>
            <div style={{ fontSize: 11, color: "#666" }}>{s.center} · {s.cycle}</div>
          </div>
        ))}
      </div>

      {/* Right panel - review */}
      <div style={{ flex: 1, overflowY: "auto", padding: "28px 32px" }}>
        {done && (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>{corrected > 0 ? "⚠" : "✓"}</div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#fff", marginBottom: 8 }}>
              {corrected > 0 ? "Enviado con correcciones" : "Tratamiento autorizado"}
            </div>
            <div style={{ fontSize: 13, color: "#666" }}>
              La enfermera puede ver las indicaciones actualizadas.
            </div>
          </div>
        )}

        {!done && !selected && (
          <div style={{ textAlign: "center", padding: "80px 0", color: "#444", fontSize: 14 }}>
            Selecciona un paciente de la lista para revisar su orden.
          </div>
        )}

        {!done && selected && (
          <>
            {/* Patient header */}
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, color: "#fff", marginBottom: 4 }}>
                {selected.patientName}
              </h2>
              <p style={{ fontSize: 13, color: "#666" }}>
                {selected.diagnosis} · {selected.cycle} · {selected.physician} · {selected.center}
              </p>
              <p style={{ fontSize: 12, color: "#555", marginTop: 4 }}>
                Transcrito por: {selected.nurseName} · {selected.transcribedAt?.toDate?.()?.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) || "—"}
              </p>
            </div>

            {/* Progress */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#555", marginBottom: 7 }}>
                <span>Progreso de revisión</span>
                <span>{meds.length - pending} / {meds.length}</span>
              </div>
              <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 99, height: 5, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 99, transition: "width 0.4s",
                  width: `${((meds.length - pending) / meds.length) * 100}%`,
                  background: corrected > 0 ? "linear-gradient(90deg,#1D9E75,#EF9F27)" : "#1D9E75",
                }} />
              </div>
            </div>

            {/* Meds */}
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 22 }}>
              {meds.map(m => (
                <MedRow key={m.id} med={m} onApprove={approveMed} onCorrect={correctMed} />
              ))}
            </div>

            {/* Global note */}
            <div style={{ marginBottom: 22 }}>
              <label style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase", display: "block", marginBottom: 8 }}>
                Nota general (opcional)
              </label>
              <textarea rows={2} placeholder="Indicaciones generales para toda la sesión..." value={globalNote}
                onChange={e => setGlobalNote(e.target.value)}
                style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "11px 14px", color: "#ddd", fontSize: 13, outline: "none", resize: "vertical" }} />
            </div>

            {/* Submit */}
            <button onClick={submit} disabled={!allReviewed || saving} style={{
              width: "100%", padding: "15px", borderRadius: 12, fontSize: 15, fontWeight: 700,
              cursor: allReviewed ? "pointer" : "not-allowed", transition: "all 0.2s",
              background: allReviewed
                ? corrected > 0 ? "linear-gradient(135deg,#EF9F27,#BA7517)" : "linear-gradient(135deg,#1D9E75,#0F6E56)"
                : "rgba(255,255,255,0.05)",
              border: "none",
              color: allReviewed ? "#000" : "#444",
            }}>
              {saving ? "Guardando..." : !allReviewed
                ? `Revisa ${pending} medicamento${pending !== 1 ? "s" : ""} más`
                : corrected > 0 ? `⚠ Enviar con ${corrected} corrección${corrected > 1 ? "es" : ""}` : "✓ Autorizar tratamiento"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
