import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

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
    if (v.doubleValue !== undefined) return v.doubleValue;
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

const CAT_COLOR = { premedicacion:"#FAC775", inmunoterapia:"#5DCAA5", quimioterapia:"#F09595", adicional:"#AFA9EC" };
const CAT_LABEL = { premedicacion:"Pre", inmunoterapia:"Inmuno", quimioterapia:"Quimio", adicional:"Adic." };

function getStatus(s) {
  if (!s.authorized)            return { label:"Sin autorizar", color:"#ffb347" };
  if (!s.events?.ingreso)       return { label:"En espera",     color:"#666" };
  if (s.status === "completado") return { label:"Retirado",     color:"#4fc3f7" };
  const me = s.medEvents || {};
  const active = (s.meds||[]).find(m => me[`med_${m.id}`]?.inicio && !me[`med_${m.id}`]?.fin);
  if (active) return { label:"En infusión", color:"#1D9E75" };
  return { label:"Pausado", color:"#EF9F27" };
}

function getProgress(s) {
  const timed = (s.meds||[]).filter(m => m.time);
  if (!timed.length) return 0;
  const total = timed.reduce((acc, m) => acc + m.time, 0);
  const me = s.medEvents || {};
  const done = timed.filter(m => me[`med_${m.id}`]?.fin).reduce((acc, m) => acc + m.time, 0);
  return Math.round((done / total) * 100);
}

function MedTimeline({ meds, medEvents }) {
  const me = medEvents || {};
  return (
    <div style={{ display:"flex", gap:4, alignItems:"center", flexWrap:"wrap" }}>
      {(meds||[]).map((m, i) => {
        const ev = me[`med_${m.id}`] || {};
        const done = !!ev.fin, active = !!ev.inicio && !ev.fin;
        const color = CAT_COLOR[m.category] || "#888";
        return (
          <div key={m.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
            <div title={`${m.name} ${m.dose}`} style={{
              position:"relative", overflow:"hidden", height:22, borderRadius:5,
              width: m.time ? Math.max(30, Math.round(m.time * 1.1)) : 26,
              background:"rgba(255,255,255,0.05)",
              border:`1px solid ${done||active ? color : "rgba(255,255,255,0.09)"}`,
            }}>
              {(done||active) && (
                <div style={{ position:"absolute", left:0, top:0, bottom:0, width:done?"100%":"50%", background:`${color}44` }} />
              )}
              <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:8, fontWeight:600, color:done||active ? color : "#555" }}>
                {done ? "✓" : active ? "⏳" : CAT_LABEL[m.category]}
              </div>
            </div>
            {i < (meds||[]).length-1 && <div style={{ width:6, height:1, background:"rgba(255,255,255,0.08)" }} />}
          </div>
        );
      })}
    </div>
  );
}

function PatientRow({ s }) {
  const st = getStatus(s);
  const pct = getProgress(s);
  const me = s.medEvents || {};
  const activeMed = (s.meds||[]).find(m => me[`med_${m.id}`]?.inicio && !me[`med_${m.id}`]?.fin);

  return (
    <div style={{
      background:"rgba(255,255,255,0.025)",
      border:"1px solid rgba(255,255,255,0.07)",
      borderLeft:`3px solid ${st.color}`, borderRadius:13, padding:"15px 20px",
    }}>
      <div style={{ display:"flex", gap:14, alignItems:"flex-start", flexWrap:"wrap" }}>
        <div style={{ minWidth:190, flex:"1 1 190px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
            <span style={{ fontSize:14, color:"#f0f0f0", fontWeight:600 }}>{s.patientName}</span>
            <span style={{ fontSize:10, padding:"2px 8px", borderRadius:99, background:`${st.color}18`, color:st.color, border:`1px solid ${st.color}44` }}>{st.label}</span>
          </div>
          <div style={{ fontSize:11, color:"#666" }}>{s.diagnosis} · {s.cycle}</div>
          <div style={{ fontSize:11, color:"#555", marginTop:1 }}>{s.center} · {s.nurseName}</div>
        </div>
        <div style={{ flex:"2 1 260px" }}>
          <div style={{ fontSize:10, color:"#555", letterSpacing:1, textTransform:"uppercase", marginBottom:7 }}>Secuencia</div>
          <MedTimeline meds={s.meds} medEvents={s.medEvents} />
          {activeMed && <div style={{ fontSize:11, color:"#1D9E75", marginTop:5 }}>⏳ {activeMed.name} {activeMed.dose} en curso</div>}
        </div>
        <div style={{ minWidth:100, textAlign:"right", flexShrink:0 }}>
          <div style={{ fontSize:24, fontFamily:"'DM Serif Display', serif", color:"#fff" }}>{pct}%</div>
          <div style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1 }}>completado</div>
          {s.events?.ingreso && <div style={{ fontSize:11, color:"#777", marginTop:6 }}>▶ {s.events.ingreso}</div>}
          {s.events?.retiro  && <div style={{ fontSize:11, color:"#4fc3f7" }}>■ {s.events.retiro}</div>}
        </div>
      </div>
      {s.events?.ingreso && (
        <div style={{ marginTop:10 }}>
          <div style={{ background:"rgba(255,255,255,0.05)", borderRadius:99, height:4, overflow:"hidden" }}>
            <div style={{ height:"100%", borderRadius:99, transition:"width 0.5s", width:`${pct}%`, background:s.status==="completado"?"#4fc3f7":"#1D9E75" }} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function Monitor() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [clock, setClock] = useState(new Date().toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit", second:"2-digit" }));
  const [filter, setFilter] = useState("Todos");
  const today = getToday();

  const load = async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken(true);
      const data = await fetchAllSessions(token, today);
      setSessions(data);
    } catch(e) { console.error(e); }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [user]);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date().toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit", second:"2-digit" })), 1000);
    return () => clearInterval(id);
  }, []);

  const centers = ["Todos", "CIPI", "CITIO"];
  const filtered = filter === "Todos" ? sessions : sessions.filter(s => s.center === filter);
  const ns = sessions.filter(s => s.center === "CIPI");
  const ss = sessions.filter(s => s.center === "CITIO");
  const stats = (g) => ({
    enCurso:   g.filter(s => s.status === "en_curso").length,
    retirados: g.filter(s => s.status === "completado").length,
    enEspera:  g.filter(s => !s.events?.ingreso).length,
  });

  return (
    <div style={{ padding:"24px 28px", maxWidth:1100, margin:"0 auto" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:24 }}>
        <div>
          <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Monitor en vivo</h1>
          <p style={{ fontSize:13, color:"#555" }}>Ambos centros · Actualiza cada 15 seg</p>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ width:7, height:7, borderRadius:"50%", background:"#1D9E75" }} />
          <span style={{ fontSize:13, color:"#aaa", fontFamily:"'IBM Plex Mono', monospace" }}>{clock}</span>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:22 }}>
        {[["CIPI", stats(ns)], ["CITIO", stats(ss)]].map(([name, s]) => (
          <div key={name} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:13, padding:"16px 20px" }}>
            <div style={{ fontSize:13, color:"#aaa", fontWeight:600, marginBottom:12 }}>{name}</div>
            <div style={{ display:"flex", gap:20 }}>
              {[["en curso",s.enCurso,"#1D9E75"],["en espera",s.enEspera,"#888"],["retirados",s.retirados,"#4fc3f7"]].map(([l,v,c]) => (
                <div key={l}>
                  <div style={{ fontSize:22, fontFamily:"'DM Serif Display', serif", color:c }}>{v}</div>
                  <div style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1 }}>{l}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display:"flex", gap:10, marginBottom:14, justifyContent:"flex-end" }}>
        {centers.map(c => (
          <button key={c} onClick={() => setFilter(c)} style={{
            padding:"5px 14px", borderRadius:99, fontSize:11, fontWeight:600, cursor:"pointer",
            background: filter===c ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
            border:`1px solid ${filter===c ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.07)"}`,
            color: filter===c ? "#00d4aa" : "#666",
          }}>{c}</button>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
        {filtered.length === 0 ? (
          <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:13 }}>
            No hay pacientes registrados hoy.
          </div>
        ) : filtered.map(s => <PatientRow key={s.id} s={s} />)}
      </div>
    </div>
  );
}
