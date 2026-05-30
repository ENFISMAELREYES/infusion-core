import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where, orderBy } from "firebase/firestore";
import { db } from "../firebase/config";
import { useAuth } from "../hooks/useAuth";
import { useNavigate } from "react-router-dom";

const STATUS_META = {
  en_curso:   { label: "En curso",    color: "#00d4aa", bg: "rgba(0,212,170,0.10)" },
  completado: { label: "Completado",  color: "#4fc3f7", bg: "rgba(79,195,247,0.10)" },
  pendiente:  { label: "Pendiente",   color: "#ffb347", bg: "rgba(255,179,71,0.10)" },
};

function StatCard({ label, value, accent }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 14, padding: "20px 24px", borderLeft: `3px solid ${accent}`,
    }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: "#666", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 34, fontFamily: "'DM Serif Display', serif", color: "#fff", lineHeight: 1 }}>{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const { profile } = useAuth();
  const navigate    = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    // Listen to today's sessions in real time
    const today = new Date().toISOString().split("T")[0];
    const q = query(
      collection(db, "sessions"),
      where("date", "==", today),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, snap => {
      setSessions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  const enCurso    = sessions.filter(s => s.status === "en_curso").length;
  const pendiente  = sessions.filter(s => s.status === "pendiente").length;
  const completado = sessions.filter(s => s.status === "completado").length;
  const sinAuth    = sessions.filter(s => !s.authorized).length;

  const norte = sessions.filter(s => s.center === "CIPI");
  const sur   = sessions.filter(s => s.center === "CITIO");

  return (
    <div style={{
      padding: "28px 32px", maxWidth: 1200, margin: "0 auto",
      backgroundImage: "radial-gradient(ellipse 80% 40% at 60% -10%, rgba(0,212,170,0.05) 0%, transparent 70%)",
    }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 26, color: "#fff", marginBottom: 4 }}>
          Panel general
        </h1>
        <p style={{ fontSize: 13, color: "#555" }}>
          {new Date().toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 28 }}>
        <StatCard label="En curso"     value={enCurso}    accent="#00d4aa" />
        <StatCard label="Pendientes"   value={pendiente}  accent="#ffb347" />
        <StatCard label="Completados"  value={completado} accent="#4fc3f7" />
        <StatCard label="Sin autorizar" value={sinAuth}   accent="#ff6b6b" />
      </div>

      {/* Center summary */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
        {[["CIPI", norte], ["CITIO", sur]].map(([name, group]) => (
          <div key={name} style={{
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 14, padding: "18px 22px",
          }}>
            <div style={{ fontSize: 14, color: "#ccc", fontWeight: 600, marginBottom: 12 }}>{name}</div>
            <div style={{ display: "flex", gap: 16 }}>
              {[
                ["en curso",   group.filter(s => s.status === "en_curso").length,   "#00d4aa"],
                ["espera",     group.filter(s => s.status === "pendiente").length,   "#ffb347"],
                ["completos",  group.filter(s => s.status === "completado").length,  "#4fc3f7"],
              ].map(([l, v, c]) => (
                <div key={l}>
                  <div style={{ fontSize: 24, fontFamily: "'DM Serif Display', serif", color: c }}>{v}</div>
                  <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Session list */}
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 14 }}>
        Sesiones del día
      </div>

      {loading ? (
        <div style={{ color: "#555", fontSize: 14, padding: 24 }}>Cargando...</div>
      ) : sessions.length === 0 ? (
        <div style={{ color: "#444", fontSize: 14, padding: 40, textAlign: "center",
          background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 14 }}>
          No hay sesiones registradas hoy.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sessions.map(s => {
            const sm = STATUS_META[s.status] || STATUS_META.pendiente;
            return (
              <div key={s.id}
                onClick={() => navigate(`/pacientes/${s.id}`)}
                style={{
                  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 12, padding: "16px 20px", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 16, transition: "background 0.15s",
                }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
                onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, color: "#f0f0f0", fontWeight: 600 }}>{s.patientName}</div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 3 }}>
                    {s.diagnosis} · {s.cycle} · {s.center}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#666" }}>{s.physician}</div>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 99,
                  color: sm.color, background: sm.bg, border: `1px solid ${sm.color}33`,
                }}>{sm.label}</span>
                {!s.authorized && (
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 99,
                    color: "#ffb347", background: "rgba(255,179,71,0.1)", border: "1px solid rgba(255,179,71,0.3)",
                  }}>⚡ Sin autorizar</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
