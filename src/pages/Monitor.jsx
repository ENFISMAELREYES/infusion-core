import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { normalizeMedName, findFichaMatch } from "./FichasTecnicas";

import { PROJECT_ID, API_KEY, DATABASE_ID } from "../config";

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
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:runQuery`;
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

// Fichas técnicas, para la consulta rápida "ⓘ" junto a cada medicamento --
// visible para quien llega a Monitor (jefe o visualizador, únicos roles con
// acceso a esta pantalla), no depende de las sesiones y se carga una sola vez.
async function fetchFichasTecnicas(token) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "fichas_tecnicas" }], limit: 1000 } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

// Resumen de referencia de un medicamento -- mismo criterio que el ícono
// "?" de Sesión de hoy: información capturada + datos de la ficha técnica,
// SIN ningún veredicto ✓/⚠️ (eso es exclusivo de Autorizar/jefe).
function MedFichaModal({ med, ficha, onClose }) {
  const doseMatch = med.dose?.match(/(\d+\.?\d*)/);
  const dose      = doseMatch ? parseFloat(doseMatch[1]) : null;
  const volMatch  = med.diluent?.match(/(\d+\.?\d*)\s*ML/i);
  const vol       = volMatch ? parseFloat(volMatch[1]) : null;
  const ct        = (dose && vol) ? dose / vol : null;
  const mentionsPVC = /PVC/i.test(ficha.dilucion_solucion_tecnica || "");
  const hasCriticalAlert = ["SI","SÍ"].includes((ficha.alerta_critica_seguridad || "").trim().toUpperCase());

  return (
    <div onClick={e => { e.stopPropagation(); onClose(); }} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:440, maxHeight:"85vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>{med.name} {med.dose}</div>
          {med.diluent && <div style={{ fontSize:12, color:"#888", marginTop:2 }}>{med.diluent}</div>}
        </div>

        {hasCriticalAlert && (
          <div style={{ fontSize:12, color:"#ff6b6b", padding:"9px 12px", background:"rgba(255,107,107,0.08)", border:"1px solid rgba(255,107,107,0.25)", borderRadius:9 }}>
            🔴 <strong>Alerta crítica:</strong> {ficha.detalle_alerta_critica}
          </div>
        )}

        {ct !== null && (
          <div>
            <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.5, marginBottom:2 }}>Volumen / concentración</div>
            <div style={{ fontSize:13, color:"#ccc" }}>VOL. {vol} ML. CONCENTRACIÓN: {ct.toFixed(2)} MG/1ML</div>
          </div>
        )}

        <div>
          <div style={{ fontSize:11, color:"#666", textTransform:"uppercase", letterSpacing:0.5, marginBottom:2 }}>Infusión</div>
          <div style={{ fontSize:13, color:"#ccc" }}>
            {med.time ? `${med.time} MIN.` : "Sin tiempo capturado"}
            {mentionsPVC && <span style={{ color:"#ffb347" }}> · Utilizar equipos libres de PVC</span>}
          </div>
        </div>

        {[
          ["monitoreo_durante_infusion", "Monitoreo durante la infusión", "#666"],
          ["signos_alarma_hipersensibilidad", "Signos de alarma — hipersensibilidad", "#ff6b6b"],
          ["signos_alarma_extravasacion", "Signos de alarma — extravasación", "#ff6b6b"],
          ["conducta_inmediata_reaccion", "Conducta inmediata ante reacción", "#ff6b6b"],
          ["antidoto_kit_especifico", "Antídoto / kit específico", "#ff6b6b"],
        ].map(([field, label, color]) => ficha[field] && (
          <div key={field}>
            <div style={{ fontSize:11, color, textTransform:"uppercase", letterSpacing:0.5, marginBottom:2 }}>{label}</div>
            <div style={{ fontSize:13, color:"#ccc", lineHeight:1.5, whiteSpace:"pre-line" }}>{ficha[field]}</div>
          </div>
        ))}

        <button onClick={onClose} style={{ padding:"9px", borderRadius:9, fontSize:13, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>Cerrar</button>
      </div>
    </div>
  );
}

// Logo tenue por centro, junto al nombre del paciente. Si el archivo del centro
// aún no existe (ej. CIPI antes de subir su logo), el onError del <img> lo oculta solo.
const CENTER_LOGO = { CITIO: "/logo-citio-icon.png", CIPI: "/logo-cipi-icon.png" };

function parseTimeToMin(t) {
  if (!t) return null;
  if (t.includes("a.m.") || t.includes("p.m.")) {
    const [time, period] = t.split(" ");
    const [h, m] = time.split(":").map(Number);
    let hours = h;
    if (period === "p.m." && h !== 12) hours += 12;
    if (period === "a.m." && h === 12) hours = 0;
    return hours * 60 + m;
  }
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minToHHMM(min) {
  const h = Math.floor(((min % 1440) + 1440) % 1440 / 60);
  const m = ((min % 60) + 60) % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

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

// Minutos restantes para terminar la sesión: toma lo programado (medicamento
// + sus lavados) y le resta lo que ya se completó, según los eventos
// registrados. Es un estimado basado en lo programado, no en el reloj real.
function getRemainingMinutes(s) {
  const me = s.medEvents || {};
  const we = s.washEvents || {};
  let total = 0, done = 0;
  (s.meds || []).forEach(m => {
    const medTime = m.time || 0;
    total += medTime;
    if (me[`med_${m.id}`]?.fin) done += medTime;
    if (m.wash?.time && !m.washNA) {
      total += m.wash.time;
      if (we[`wash_${m.id}`]?.fin) done += m.wash.time;
    }
    if (m.wash2?.time) {
      total += m.wash2.time;
      if (we[`wash2_${m.id}`]?.fin) done += m.wash2.time;
    }
  });
  if (total === 0) return null;
  return Math.max(0, total - done);
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

function PatientRow({ s, onNoShow, isJefe, fichasByName }) {
  const st = getStatus(s);
  const pct = getProgress(s);
  const me = s.medEvents || {};
  const activeMed = (s.meds||[]).find(m => me[`med_${m.id}`]?.inicio && !me[`med_${m.id}`]?.fin);
  const canMarkNoShow = isJefe && !s.events?.ingreso; // solo jefe, y solo si aún no ha iniciado
  const [fichaModalMed, setFichaModalMed] = useState(null); // medicamento cuya ficha se está consultando, o null

  const findFicha = (medName) => findFichaMatch(medName, fichasByName);

  return (
    <div style={{
      background:"rgba(255,255,255,0.025)",
      border:"1px solid rgba(255,255,255,0.07)",
      borderLeft:`3px solid ${st.color}`, borderRadius:13, padding:"15px 20px",
    }}>
      <div style={{ display:"flex", gap:14, alignItems:"flex-start", flexWrap:"wrap" }}>
        <div style={{ minWidth:190, flex:"1 1 190px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
            {CENTER_LOGO[s.center] && (
              <img src={CENTER_LOGO[s.center]} alt="" onError={e => { e.currentTarget.style.display = "none"; }}
                style={{ width:20, height:20, objectFit:"contain", opacity:0.85, flexShrink:0, borderRadius:"50%" }} />
            )}
            <span style={{ fontSize:14, color:"#f0f0f0", fontWeight:600 }}>{s.patientName}</span>
            <span style={{ fontSize:10, padding:"2px 8px", borderRadius:99, background:`${st.color}18`, color:st.color, border:`1px solid ${st.color}44` }}>{st.label}</span>
            {canMarkNoShow && (
              <button onClick={() => onNoShow(s)} title="Marcar que el paciente no asistirá hoy -- se quita de esta lista"
                style={{ marginLeft:"auto", fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:99, cursor:"pointer", background:"rgba(255,107,107,0.08)", border:"1px solid rgba(255,107,107,0.2)", color:"#ff6b6b" }}>
                🚫 No asistirá hoy
              </button>
            )}
          </div>
          <div style={{ fontSize:11, color:"#666" }}>{s.diagnosis} · {s.cycle}</div>
          {s.sessionType === "procedimiento" && s.procedureType && (
  <div style={{ fontSize: 11, color: "#ffb347", marginTop: 2 }}>🔧 {s.procedureType}</div>
)}
          <div style={{ fontSize:11, color:"#555", marginTop:1 }}>{s.center} · {s.nurseName}</div>
        </div>
        <div style={{ flex:"2 1 260px" }}>
          <div style={{ fontSize:10, color:"#555", letterSpacing:1, textTransform:"uppercase", marginBottom:7 }}>Secuencia</div>
          <MedTimeline meds={s.meds} medEvents={s.medEvents} />
          {activeMed && <div style={{ fontSize:11, color:"#1D9E75", marginTop:5 }}>⏳ {activeMed.name} {activeMed.dose} en curso</div>}
          <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:3 }}>
  {(s.meds||[]).map(m => {
    const me = s.medEvents || {};
    const ev = me[`med_${m.id}`] || {};
    const done = !!ev.fin, active = !!ev.inicio && !ev.fin;
    const ficha = findFicha(m.name);
    return (
      <div key={m.id} style={{ display:"flex", alignItems:"center", gap:8, fontSize:11 }}>
        <span style={{ color: done ? "#1D9E75" : active ? "#00d4aa" : "#444" }}>
          {done ? "✓" : active ? "⏳" : "○"}
        </span>
        <span style={{ color: done ? "#777" : active ? "#f0f0f0" : "#555", fontWeight: active ? 600 : 400 }}>
          {m.name} {m.dose}
        </span>
        {ficha && (
          <button onClick={e => { e.stopPropagation(); setFichaModalMed(m); }} title="Consultar ficha técnica de este medicamento"
            style={{ width:16, height:16, borderRadius:"50%", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:700, cursor:"pointer", background:"rgba(79,195,247,0.12)", border:"1px solid rgba(79,195,247,0.3)", color:"#4fc3f7", padding:0 }}>
            ⓘ
          </button>
        )}
        {active && ev.inicio && (
          <span style={{ color:"#666", fontFamily:"'IBM Plex Mono', monospace" }}>
            ▶ {ev.inicio}
            {!!m.time && <span style={{ color:"#444" }}> (~{minToHHMM(parseTimeToMin(ev.inicio) + m.time)})</span>}
          </span>
        )}
        {!done && !active && !!m.time && (
          <span style={{ color:"#444", fontFamily:"'IBM Plex Mono', monospace" }}>{m.time} min</span>
        )}
        {done && ev.inicio && ev.fin && (
  <span style={{ color:"#555", fontFamily:"'IBM Plex Mono', monospace" }}>
    {ev.inicio} → {ev.fin}
    {(() => {
      try {
        const parseTime = (t) => {
  if (t.includes("a.m.") || t.includes("p.m.")) {
    const [time, period] = t.split(" ");
    const [h, m] = time.split(":").map(Number);
    let hours = h;
    if (period === "p.m." && h !== 12) hours += 12;
    if (period === "a.m." && h === 12) hours = 0;
    return hours * 60 + m;
  }
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
        const diff = parseTime(ev.fin) - parseTime(ev.inicio);
        if (diff > 0) return ` (${diff} min)`;
      } catch(e) {}
      return "";
    })()}
  </span>
)}
        {m.wash && done && (() => {
  const washEv = s.washEvents?.[`wash_${m.id}`];
  return (
    <span style={{ color: washEv?.fin ? "#4fc3f7" : "#666", fontSize:10 }}>
      💧 {washEv?.fin ? "lavado ✓" : "lavado pendiente"}
    </span>
  );
})()}
      </div>
    );
  })}
</div>
        </div>
      <div style={{ minWidth:130, textAlign:"right", flexShrink:0 }}>
  <div style={{ fontSize:24, fontFamily:"'DM Serif Display', serif", color:"#fff" }}>{pct}%</div>
  <div style={{ fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:1 }}>completado</div>

  {/* Tiempos programado vs real */}
  {s.meds && (() => {
    const programado = s.meds.reduce((acc, m) => acc + (m.time || 0) + (m.wash?.time || 0) + (m.wash2?.time || 0), 0);
    const me = s.medEvents || {};
    const pt = (t) => {
      if (!t) return null;
      if (t.includes("a.m.") || t.includes("p.m.")) {
        const [time, period] = t.split(" ");
        const [h, mm] = time.split(":").map(Number);
        let hours = h;
        if (period === "p.m." && h !== 12) hours += 12;
        if (period === "a.m." && h === 12) hours = 0;
        return hours * 60 + mm;
      }
      const [h, mm] = t.split(":").map(Number);
      return h * 60 + mm;
    };
    const we = s.washEvents || {};
    const real = s.meds.reduce((acc, m) => {
      let total = acc;
      const ev = me[`med_${m.id}`] || {};
      if (ev.inicio && ev.fin) {
        const d = pt(ev.fin) - pt(ev.inicio);
        total += (d > 0 ? d : 0);
      }
      const wev = we[`wash_${m.id}`] || {};
      if (wev.inicio && wev.fin) {
        const wd = pt(wev.fin) - pt(wev.inicio);
        total += (wd > 0 ? wd : 0);
      }
      return total;
    }, 0);
    return (
      <div style={{ marginTop:4, fontSize:10, fontFamily:"'IBM Plex Mono', monospace" }}>
        <div style={{ color:"#555" }}>Programado: {programado} min</div>
        {real > 0 && (
          <div style={{ color: real <= programado ? "#1D9E75" : "#EF9F27" }}>
            Real: {real} min {real < programado ? "▼" : real > programado ? "▲" : "="}
          </div>
        )}
      </div>
    );
  })()}

  {/* Ingreso y retiro */}
  {s.events?.ingreso && (
    <div style={{ fontSize:11, color:"#777", marginTop:6 }}>▶ Ingreso: {s.events.ingreso}</div>
  )}
  {s.events?.retiro && (
    <div style={{ fontSize:11, color:"#4fc3f7" }}>■ Retiro: {s.events.retiro}</div>
  )}

  {/* Estancia cuando ya se retiró */}
  {s.events?.ingreso && s.events?.retiro && (() => {
    try {
      const pt = (t) => {
        if (t.includes("a.m.") || t.includes("p.m.")) {
          const [time, period] = t.split(" ");
          const [h, mm] = time.split(":").map(Number);
          let hours = h;
          if (period === "p.m." && h !== 12) hours += 12;
          if (period === "a.m." && h === 12) hours = 0;
          return hours * 60 + mm;
        }
        const [h, mm] = t.split(":").map(Number);
        return h * 60 + mm;
      };
      const diff = pt(s.events.retiro) - pt(s.events.ingreso);
      if (diff > 0) return (
        <div style={{ fontSize:11, color:"#1D9E75", marginTop:4, fontFamily:"'IBM Plex Mono', monospace" }}>
          ⏱ Estancia: {Math.floor(diff/60)}h {diff%60}m
        </div>
      );
    } catch(e) {}
    return null;
  })()}

  {/* Estancia en curso */}
  {s.events?.ingreso && !s.events?.retiro && (() => {
    try {
      const pt = (t) => {
        if (t.includes("a.m.") || t.includes("p.m.")) {
          const [time, period] = t.split(" ");
          const [h, mm] = time.split(":").map(Number);
          let hours = h;
          if (period === "p.m." && h !== 12) hours += 12;
          if (period === "a.m." && h === 12) hours = 0;
          return hours * 60 + mm;
        }
        const [h, mm] = t.split(":").map(Number);
        return h * 60 + mm;
      };
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const diff = nowMin - pt(s.events.ingreso);
      if (diff > 0) return (
        <div style={{ fontSize:11, color:"#EF9F27", marginTop:4, fontFamily:"'IBM Plex Mono', monospace" }}>
          ⏱ En estancia: {Math.floor(diff/60)}h {diff%60}m
        </div>
      );
    } catch(e) {}
    return null;
  })()}
</div>
      </div>
      {s.events?.ingreso && (
        <div style={{ marginTop:10 }}>
          <div style={{ background:"rgba(255,255,255,0.05)", borderRadius:99, height:4, overflow:"hidden" }}>
            <div style={{ height:"100%", borderRadius:99, transition:"width 0.5s", width:`${pct}%`, background:s.status==="completado"?"#4fc3f7":"#1D9E75" }} />
          </div>
          {s.status !== "completado" && (() => {
            const remaining = getRemainingMinutes(s);
            if (remaining === null) return null;
            return (
              <div style={{ fontSize:11, color:"#1D9E75", marginTop:4, fontFamily:"'IBM Plex Mono', monospace" }}>
                ⏳ {remaining === 0 ? "Por terminar" : `Tiempo restante: ${Math.floor(remaining/60)}h ${remaining%60}m`}
              </div>
            );
          })()}
        </div>
      )}
      {fichaModalMed && (
        <MedFichaModal med={fichaModalMed} ficha={findFicha(fichaModalMed.name)} onClose={() => setFichaModalMed(null)} />
      )}
    </div>
  );
}

export default function Monitor() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const isVisualizador = profile?.role === "visualizador";
  // "visualizador" no es solo personal médico -- también lo usan contabilidad
  // y admisión, que no deben ver información clínica de tratamiento. Se
  // marca con un campo aparte en su documento de usuario (isMedico: true en
  // Firestore, users/{uid}) quién sí puede ver la ficha técnica de cada
  // medicamento; el jefe siempre puede.
  const canSeeFichas = isJefe || !!profile?.isMedico;
  const [sessions, setSessions] = useState([]);
  const [clock, setClock] = useState(new Date().toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false }));
  const [filter, setFilter] = useState("Todos");
  const [showNoShow, setShowNoShow] = useState(false);
  const [fichasByName, setFichasByName] = useState({});
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

  // Fichas técnicas -- se cargan aparte de las sesiones, no dependen del
  // día ni cambian con el refresco de cada 15s (ver ícono "ⓘ" en cada
  // medicamento, arriba en PatientRow). Ni se piden si el usuario no puede
  // verlas -- no solo se oculta el botón, tampoco se descarga la información
  // clínica al navegador de contabilidad/admisión.
  useEffect(() => {
    if (!user || !canSeeFichas) return;
    user.getIdToken().then(async (t) => {
      try {
        const fichas = await fetchFichasTecnicas(t);
        const byName = {};
        fichas.forEach(f => { if (f.nombre_generico) byName[normalizeMedName(f.nombre_generico)] = f; });
        setFichasByName(byName);
      } catch(e) { console.error("Error cargando fichas técnicas:", e); }
    });
  }, [user, canSeeFichas]);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date().toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false })), 1000);
    return () => clearInterval(id);
  }, []);

  const centers = ["Todos", "CIPI", "CITIO"];
  // Para visualizador: además de "confirmed", cuenta como asistencia
  // comprobada que la sesión ya tenga ingreso registrado o esté en curso/
  // completada -- si ya inició es prueba de que el paciente sí llegó, sin
  // importar si el campo "confirmed" se activó a tiempo o no.
  const attendedProof = (s) => s.confirmed || !!s.events?.ingreso || s.status === "en_curso" || s.status === "completado";
  const visibleSessions = sessions.filter(s => !s.noShowToday && (!isVisualizador || attendedProof(s)));
  const noShowSessions = sessions.filter(s => s.noShowToday);
  const filtered = filter === "Todos" ? visibleSessions : visibleSessions.filter(s => s.center === filter);
  const ns = visibleSessions.filter(s => s.center === "CIPI");
  const ss = visibleSessions.filter(s => s.center === "CITIO");
  const stats = (g) => ({
    enCurso:   g.filter(s => s.status === "en_curso").length,
    retirados: g.filter(s => s.status === "completado").length,
    enEspera:  g.filter(s => !s.events?.ingreso).length,
  });

  // Marca (o desmarca) una sesión como "no asistirá hoy" -- la quita de la
  // vista principal sin borrar nada; se va a la lista de "Programados" desde
  // la perspectiva de enfermería, y aquí queda visible aparte para revertir
  // por si se marcó por error.
  const toggleNoShow = async (session) => {
    const willMark = !session.noShowToday;
    try {
      const token = await user.getIdToken(true);
      await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/sessions/${session.id}?updateMask.fieldPaths=noShowToday&updateMask.fieldPaths=noShowMarkedAt&updateMask.fieldPaths=noShowMarkedBy`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: {
            noShowToday: { booleanValue: willMark },
            noShowMarkedAt: willMark ? { stringValue: new Date().toISOString() } : { nullValue: null },
            noShowMarkedBy: willMark ? { stringValue: user?.email || "" } : { nullValue: null },
          }}) });
      setSessions(prev => prev.map(x => x.id === session.id ? { ...x, noShowToday: willMark } : x));
    } catch(e) { alert("Error: " + e.message); }
  };

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
        ) : filtered.map(s => <PatientRow key={s.id} s={s} onNoShow={toggleNoShow} isJefe={isJefe} fichasByName={fichasByName} />)}
      </div>

      {isJefe && noShowSessions.length > 0 && (
        <div style={{ marginTop:16 }}>
          <button onClick={() => setShowNoShow(v => !v)} style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 12px", borderRadius:8, fontSize:12, cursor:"pointer", background:"rgba(255,107,107,0.06)", border:"1px solid rgba(255,107,107,0.2)", color:"#ff6b6b" }}>
            🚫 {noShowSessions.length} no asistirá{noShowSessions.length!==1?"n":""} hoy {showNoShow ? "▲" : "▼"}
          </button>
          {showNoShow && (
            <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:8 }}>
              {noShowSessions.map(s => (
                <div key={s.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 14px", borderRadius:10, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", opacity:0.7 }}>
                  <span style={{ flex:1, fontSize:12, color:"#999" }}>{s.patientName}</span>
                  <span style={{ fontSize:10, color:"#666" }}>{s.cycle}</span>
                  <span style={{ fontSize:10, color:"#666" }}>{s.center}</span>
                  <span style={{ fontSize:10, color:"#555" }} title={s.noShowMarkedAt ? new Date(s.noShowMarkedAt).toLocaleString("es-MX") : ""}>Marcado por: {s.noShowMarkedBy || "—"}</span>
                  <button onClick={() => toggleNoShow(s)} style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:7, cursor:"pointer", background:"rgba(0,212,170,0.1)", border:"1px solid rgba(0,212,170,0.25)", color:"#00d4aa" }}>
                    ↺ Deshacer
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
