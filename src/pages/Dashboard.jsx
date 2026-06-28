import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useNavigate } from "react-router-dom";

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

function getToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function parseDoc(doc) {
  const parse = (v) => {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return parseInt(v.integerValue);
    if (v.nullValue !== undefined) return null;
    if (v.arrayValue) return (v.arrayValue.values || []).map(parse);
    if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, parse(val)]));
    return null;
  };
  const id = doc.name.split("/").pop();
  return { id, ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, parse(v)])) };
}

async function fetchAllSessions(token, date) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "sessions" }],
        where: { fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: date } } }
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

const STATUS_META = {
  en_curso:   { label: "En curso",   color: "#00d4aa", bg: "rgba(0,212,170,0.10)" },
  completado: { label: "Completado", color: "#4fc3f7", bg: "rgba(79,195,247,0.10)" },
  pendiente:  { label: "Pendiente",  color: "#ffb347", bg: "rgba(255,179,71,0.10)" },
};

function StatCard({ label, value, accent }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "20px 24px", borderLeft: `3px solid ${accent}` }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: "#666", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 34, fontFamily: "'DM Serif Display', serif", color: "#fff", lineHeight: 1 }}>{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const { user, profile } = useAuth();
  const [notifStatus, setNotifStatus] = useState(Notification?.permission || "default");

const activateNotifications = async () => {
    try {
      const token = await user.getIdToken(true);
    const { requestNotificationPermission } = await import("./firebase.js");
      const fcmToken = await requestNotificationPermission(user.uid, token);
      if (fcmToken) {
        setNotifStatus("granted");
        alert("✅ Notificaciones activadas correctamente");
      } else {
        alert("⚠️ No se pudieron activar las notificaciones");
      }
    } catch(e) {
      alert("Error: " + e.message);
    }
  };
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const today = getToday();

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      try {
        const token = await user.getIdToken(true);
        const data = await fetchAllSessions(token, today);
        setSessions(data);
      } catch (e) {
        console.error("Dashboard error:", e);
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [user]);

  const enCurso    = sessions.filter(s => s.status === "en_curso").length;
  const pendiente  = sessions.filter(s => s.status === "pendiente").length;
  const completado = sessions.filter(s => s.status === "completado").length;
  const sinAuth    = sessions.filter(s => !s.authorized).length;
  const norte = sessions.filter(s => s.center === "CIPI");
  const sur   = sessions.filter(s => s.center === "CITIO");

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1200, margin: "0 auto", backgroundImage: "radial-gradient(ellipse 80% 40% at 60% -10%, rgba(0,212,170,0.05) 0%, transparent 70%)" }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 26, color: "#fff", marginBottom: 4 }}>Panel general</h1>
        <p style={{ fontSize: 13, color: "#555" }}>{new Date().toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
      </div>

      {profile?.role === "jefe" && (
          <div style={{ marginBottom:20, padding:"12px 16px", borderRadius:10, background: notifStatus === "granted" ? "rgba(29,158,117,0.08)" : "rgba(255,179,71,0.08)", border:`1px solid ${notifStatus === "granted" ? "rgba(29,158,117,0.25)" : "rgba(255,179,71,0.25)"}` }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div>
                <div style={{ fontSize:13, color: notifStatus === "granted" ? "#1D9E75" : "#ffb347", fontWeight:600 }}>
                  {notifStatus === "granted" ? "🔔 Notificaciones activas" : "🔕 Notificaciones desactivadas"}
                </div>
                <div style={{ fontSize:11, color:"#555", marginTop:2 }}>
                  {notifStatus === "granted" ? "Recibirás avisos cuando haya órdenes pendientes de autorizar" : "Activa para recibir avisos de nuevas órdenes"}
                </div>
              </div>
              {notifStatus !== "granted" && (
                <button onClick={activateNotifications} style={{ padding:"8px 16px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,179,71,0.15)", border:"1px solid rgba(255,179,71,0.4)", color:"#ffb347" }}>
                  Activar
                </button>
              )}
            </div>
          </div>
        )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 28 }}>
        <StatCard label="En curso"      value={enCurso}    accent="#00d4aa" />
        <StatCard label="Pendientes"    value={pendiente}  accent="#ffb347" />
        <StatCard label="Completados"   value={completado} accent="#4fc3f7" />
        <StatCard label="Sin autorizar" value={sinAuth}    accent="#ff6b6b" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
        {[["CIPI", norte], ["CITIO", sur]].map(([name, group]) => (
          <div key={name} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "18px 22px" }}>
            <div style={{ fontSize: 14, color: "#ccc", fontWeight: 600, marginBottom: 12 }}>{name}</div>
            <div style={{ display: "flex", gap: 16 }}>
              {[["en curso", group.filter(s => s.status === "en_curso").length, "#00d4aa"],
                ["espera",   group.filter(s => s.status === "pendiente").length, "#ffb347"],
                ["completos",group.filter(s => s.status === "completado").length,"#4fc3f7"]].map(([l, v, c]) => (
                <div key={l}>
                  <div style={{ fontSize: 24, fontFamily: "'DM Serif Display', serif", color: c }}>{v}</div>
                  <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 14 }}>Sesiones del día</div>

      {loading ? (
        <div style={{ color: "#555", fontSize: 14, padding: 24 }}>Cargando...</div>
      ) : sessions.length === 0 ? (
        <div style={{ color: "#444", fontSize: 14, padding: 40, textAlign: "center", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 14 }}>
          No hay sesiones registradas hoy.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sessions.map(s => {
            const sm = STATUS_META[s.status] || STATUS_META.pendiente;
            return (
              <div key={s.id} onClick={() => navigate(`/monitor`)}
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "16px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 16, transition: "background 0.15s" }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
                onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, color: "#f0f0f0", fontWeight: 600 }}>{s.patientName}</div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 3 }}>{s.diagnosis} · {s.cycle} · {s.center}</div>
                </div>
                <div style={{ fontSize: 12, color: "#666" }}>{s.physician}</div>
                <span style={{ fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 99, color: sm.color, background: sm.bg, border: `1px solid ${sm.color}33` }}>{sm.label}</span>
                {!s.authorized && (
                  <span style={{ fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 99, color: "#ffb347", background: "rgba(255,179,71,0.1)", border: "1px solid rgba(255,179,71,0.3)" }}>⚡ Sin autorizar</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
