import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

const CAT_COLOR = {
  premedicacion: "#FAC775", inmunoterapia: "#5DCAA5",
  quimioterapia: "#F09595", adicional: "#AFA9EC",
};

function nowStr() {
  return new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

function getToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function parseFirestoreDoc(doc) {
  const parse = (v) => {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return parseInt(v.integerValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.nullValue !== undefined) return null;
    if (v.arrayValue) return (v.arrayValue.values || []).map(parse);
    if (v.mapValue) return Object.fromEntries(
      Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, parse(val)])
    );
    return null;
  };
  const id = doc.name.split("/").pop();
  return { id, ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, parse(v)])) };
}

async function fetchSessions(token, center, date) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "sessions" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              { fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: date } } },
              { fieldFilter: { field: { fieldPath: "center" }, op: "EQUAL", value: { stringValue: center } } },
            ]
          }
        }
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) { console.error("Error fetch:", data); return []; }
  return data.filter(d => d.document).map(d => parseFirestoreDoc(d.document));
}

async function patchSession(token, sessionId, updates) {
  const toFV = (val) => {
    if (typeof val === "string") return { stringValue: val };
    if (typeof val === "boolean") return { booleanValue: val };
    if (typeof val === "number") return { integerValue: String(val) };
    if (val === null) return { nullValue: null };
    if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
    if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFV(v)])) } };
    return { stringValue: String(val) };
  };
  const fields = Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, toFV(v)]));
  const mask = Object.keys(updates).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sessions/${sessionId}?${mask}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ fields }),
    }
  );
}

function TimeBtn({ label, time, onRecord, disabled }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 14px", borderRadius: 10,
      background: time ? "rgba(29,158,117,0.08)" : "rgba(255,255,255,0.03)",
      border: `1px solid ${time ? "rgba(29,158,117,0.25)" : "rgba(255,255,255,0.07)"}`,
    }}>
      <div>
        <div style={{ fontSize: 11, color: "#666", letterSpacing: 1, textTransform: "uppercase" }}>{label}</div>
        {time && <div style={{ fontSize: 14, color: "#1D9E75", fontFamily: "'IBM Plex Mono', monospace", marginTop: 2, fontWeight: 600 }}>{time}</div>}
      </div>
      {!time && !disabled && (
        <button onClick={onRecord} style={{
          background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)",
          color: "#ddd", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}>Registrar</button>
      )}
      {disabled && !time && <span style={{ fontSize: 11, color: "#444" }}>—</span>}
    </div>
  );
}

function SessionCard({ session, token, onRefresh, user }) {
  const [open, setOpen] = useState(false);
  const events = session.events || {};
  const medEvents = session.medEvents || {};

 const recordEvent = async (key) => {
    try {
      const freshToken = await user.getIdToken(true);
      const t = nowStr();
      const updates = { [`events.${key}`]: t };
      if (key === "ingreso") updates.status = "en_curso";
      if (key === "retiro") updates.status = "completado";
      await patchSession(freshToken, session.id, updates);
      onRefresh();
    } catch(e) {
      console.error("Error registrando evento:", e);
      alert("Error: " + e.message);
    }
  };

  const recordMedEvent = async (medId, key) => {
    try {
      const freshToken = await user.getIdToken(true);
      await patchSession(freshToken, session.id, { [`medEvents.${medId}.${key}`]: nowStr() });
      onRefresh();
    } catch(e) {
      console.error("Error registrando med evento:", e);
      alert("Error: " + e.message);
    }
  };

  const completedMeds = (session.meds || []).filter(m => medEvents[m.id]?.fin).length;
  const totalTimed = (session.meds || []).filter(m => m.time).length;
  const pct = totalTimed ? Math.round((completedMeds / totalTimed) * 100) : 0;

  const canStartMed = (med) => {
    if (!session.authorized || !events.ingreso) return false;
    const prev = (session.meds || []).find(m => m.order === med.order - 1);
    if (!prev || !prev.time) return true;
    return !!(medEvents[prev.id]?.fin);
  };

  const statusColor = !session.authorized ? "#ffb347" : !events.ingreso ? "#888" : events.retiro ? "#4fc3f7" : "#1D9E75";

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderLeft: `3px solid ${statusColor}`, borderRadius: 16, overflow: "hidden", marginBottom: 12 }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: "16px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, color: "#f0f0f0", fontWeight: 600 }}>{session.patientName}</div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 3 }}>{session.diagnosis} · {session.cycle} · {session.physician}</div>
        </div>
        {events.ingreso && <div style={{ fontSize: 13, color: "#aaa", fontFamily: "'IBM Plex Mono', monospace" }}>{pct}%</div>}
        {!session.authorized && <span style={{ fontSize: 11, color: "#ffb347", background: "rgba(255,179,71,0.1)", border: "1px solid rgba(255,179,71,0.25)", padding: "3px 10px", borderRadius: 99 }}>⏳ Sin autorizar</span>}
        <span style={{ color: "#555" }}>{open ? "▲" : "▼"}</span>
      </div>

      {events.ingreso && (
        <div style={{ padding: "0 20px 2px" }}>
          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 99, height: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: "#1D9E75", borderRadius: 99 }} />
          </div>
        </div>
      )}

      {open && (
        <div style={{ padding: "16px 20px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          {!session.authorized && (
            <div style={{ padding: "12px 16px", borderRadius: 10, marginBottom: 14, background: "rgba(255,179,71,0.07)", border: "1px solid rgba(255,179,71,0.2)", fontSize: 13, color: "#ffb347" }}>
              ⏳ Esperando autorización del Jefe de Enfermería.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
            <TimeBtn label="Ingreso del paciente" time={events.ingreso} onRecord={() => recordEvent("ingreso")} disabled={!session.authorized} />
            <TimeBtn label="Retiro del paciente" time={events.retiro} onRecord={() => recordEvent("retiro")} disabled={!events.ingreso || pct < 100} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(session.meds || []).map(med => {
              const ev = medEvents[med.id] || {};
              const color = CAT_COLOR[med.category] || "#888";
              const started = !!ev.inicio, ended = !!ev.fin;
              const canStart = canStartMed(med);
              return (
                <div key={med.id} style={{ borderRadius: 11, overflow: "hidden", border: `1px solid ${ended ? "rgba(79,195,247,0.2)" : started ? "rgba(29,158,117,0.2)" : "rgba(255,255,255,0.07)"}`, borderLeft: `3px solid ${color}`, background: "rgba(255,255,255,0.02)" }}>
                  <div style={{ padding: "11px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 22, height: 22, borderRadius: "50%", background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#888", fontFamily: "'IBM Plex Mono', monospace", flexShrink: 0 }}>{med.order}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: "#f0f0f0", fontWeight: 600 }}>{med.name} {med.dose}</div>
                      <div style={{ fontSize: 11, color: "#666", marginTop: 1 }}>{med.diluent}{med.time ? ` · ${med.time} min` : ""}</div>
                    </div>
                    <span style={{ fontSize: 14 }}>{ended ? "✓" : started ? "⏳" : "○"}</span>
                  </div>
                  {med.correction && (
                    <div style={{ margin: "0 14px 8px", padding: "7px 11px", borderRadius: 8, background: "rgba(186,117,23,0.09)", border: "1px solid rgba(186,117,23,0.22)" }}>
                      <div style={{ fontSize: 11, color: "#EF9F27", fontWeight: 600, marginBottom: 3 }}>⚠ Corrección del Jefe</div>
                      {med.correction.diluent && <div style={{ fontSize: 11, color: "#aaa" }}>Dilución: {med.correction.diluent}</div>}
                      {med.correction.time && <div style={{ fontSize: 11, color: "#aaa" }}>Tiempo: {med.correction.time}</div>}
                      {med.correction.general && <div style={{ fontSize: 11, color: "#aaa" }}>Nota: {med.correction.general}</div>}
                    </div>
                  )}
                  {med.time && (
                    <div style={{ padding: "0 14px 12px", display: "flex", gap: 8 }}>
                      {!started && <button onClick={() => recordMedEvent(med.id, "inicio")} disabled={!canStart} style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: canStart ? "pointer" : "not-allowed", background: canStart ? "rgba(29,158,117,0.12)" : "rgba(255,255,255,0.03)", border: `1px solid ${canStart ? "rgba(29,158,117,0.3)" : "rgba(255,255,255,0.06)"}`, color: canStart ? "#1D9E75" : "#444" }}>▶ Iniciar</button>}
                      {started && !ended && (
                        <>
                          <div style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, textAlign: "center", background: "rgba(29,158,117,0.07)", border: "1px solid rgba(29,158,117,0.18)", color: "#1D9E75" }}>▶ {ev.inicio}</div>
                          <button onClick={() => recordMedEvent(med.id, "fin")} style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(79,195,247,0.12)", border: "1px solid rgba(79,195,247,0.3)", color: "#4fc3f7" }}>■ Terminar</button>
                        </>
                      )}
                      {ended && (
                        <div style={{ flex: 1, display: "flex", gap: 8 }}>
                          <div style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, textAlign: "center", background: "rgba(29,158,117,0.06)", border: "1px solid rgba(29,158,117,0.15)", color: "#1D9E75" }}>▶ {ev.inicio}</div>
                          <div style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, textAlign: "center", background: "rgba(79,195,247,0.06)", border: "1px solid rgba(79,195,247,0.15)", color: "#4fc3f7" }}>■ {ev.fin}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {session.globalNote && (
            <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", fontSize: 12, color: "#888" }}>
              📋 Nota del Jefe: {session.globalNote}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function NurseView() {
  const { user, profile } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(null);
  const today = getToday();
  console.log("NurseView render - profile:", profile, "user:", !!user);

 const load = async () => {
    if (!user || !profile?.center) {
      setLoading(false);
      return;
    }
    try {
      const t = await user.getIdToken(true);
      setToken(t);
      console.log("Buscando sesiones:", profile.center, today);
      const data = await fetchSessions(t, profile.center, today);
      console.log("Sesiones encontradas:", data.length, data);
      setSessions(data);
    } catch (e) {
      console.error("Error:", e);
    } finally {
      setLoading(false);
    }
  };

 useEffect(() => {
  if (profile?.center) {
    load();
  }
}, [profile?.center]);

  const inCourse = sessions.filter(s => s.status === "en_curso").length;
  const waiting = sessions.filter(s => !s.events?.ingreso).length;
  const done = sessions.filter(s => s.status === "completado").length;
  
console.log("Token actual:", token ? "existe" : "null", "User:", user ? "existe" : "null");
  return (
    <div style={{ padding: "24px 28px", maxWidth: 800, margin: "0 auto" }}>
      <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#fff", marginBottom: 4 }}>Mis pacientes</h1>
          <p style={{ fontSize: 13, color: "#555" }}>{profile?.center} · {new Date().toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {[["en espera", waiting, "#888"], ["en curso", inCourse, "#1D9E75"], ["completos", done, "#4fc3f7"]].map(([l, v, c]) => (
            <div key={l} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 99, background: `${c}14`, border: `1px solid ${c}33`, color: c }}>{v} {l}</div>
          ))}
        </div>
      </div>
      {loading ? (
        <div style={{ color: "#555", fontSize: 14, padding: 24 }}>Cargando...</div>
      ) : sessions.length === 0 ? (
        <div style={{ color: "#444", fontSize: 14, padding: 40, textAlign: "center", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 14 }}>
          No hay sesiones asignadas hoy.
        </div>
      ) : (
        sessions.map(s => <SessionCard key={s.id} session={s} token={token} onRefresh={load} user={user} />)
      )}
    </div>
  );
}
