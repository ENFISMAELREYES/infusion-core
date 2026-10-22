import { useState } from "react";
import { parseDoseMg } from "./data/materialCatalog";

// Etiqueta de solución/mezcla -- no es un PDF, es el mismo módulo de "texto
// para copiar y pegar" que ya usan en CEMI (PanelEtiquetas): se pega el
// cuerpo en el objeto de texto del software de impresión de etiquetas que
// ya usan. Un solo componente, usado tanto al generarla por primera vez
// (NurseView, justo antes de preparar) como al reimprimirla después
// (Historial, desde los mismos datos ya guardados en
// session.meds[].etiqueta) -- nunca se recalcula al reimprimir, se muestra
// exactamente lo que se guardó la primera vez.

// Vm = Dosis (mg) / Concentración del frasco (mg/ml) -- cuántos ml del
// medicamento hay que retirar del frasco para esa dosis.
export function computeVm(doseStr, mgFrasco, mlFrasco) {
  const doseMg = parseDoseMg(doseStr);
  const mg = parseFloat(mgFrasco), ml = parseFloat(mlFrasco);
  if (!doseMg || !mg || !ml) return null;
  return doseMg / (mg / ml);
}

function fmtFecha(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}/${m}/${y}` : d;
}

function textoEtiqueta(session, med) {
  const e = med.etiqueta || {};
  const vmTxt = e.vm != null ? Number(e.vm).toFixed(2) : "—";
  return [
    `Nombre del paciente: ${(session.patientName || "").toUpperCase()}`,
    `Fecha de Nacimiento: ${fmtFecha(session.dob)}`,
    `Fecha: ${fmtFecha(session.date)}`,
    `Sol. ${med.diluent || "—"}`,
    `Medicamento: ${med.name || ""} ${med.dose || ""}`,
    `Volumen de medicamento a retirar: ${vmTxt} ML`,
    `Tiempo de infusión: ${med.time ? `${med.time} minutos` : "—"}`,
    `Hora de Inicio: _______    Hora de término: _______`,
    `Enf. 1: ${e.enf1 || ""}`,
    `Enf. 2: ${e.enf2 || ""}`,
  ].join("\n");
}

function CajaCopiable({ titulo, texto }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {}
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#00d4aa" }}>{titulo}</div>
        <button onClick={copiar} style={{ padding: "4px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", background: copiado ? "rgba(0,212,170,0.15)" : "rgba(255,255,255,0.05)", border: `1px solid ${copiado ? "rgba(0,212,170,0.35)" : "rgba(255,255,255,0.09)"}`, color: copiado ? "#00d4aa" : "#ccc" }}>
          {copiado ? "✓ Copiado" : "Copiar"}
        </button>
      </div>
      <textarea readOnly value={texto} rows={9} onClick={e => e.target.select()}
        style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 8, padding: "8px 10px", color: "#ddd", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", resize: "vertical", outline: "none" }} />
    </div>
  );
}

// `session`/`med` -- igual que el resto de la app, med.etiqueta ya trae
// vm/enf1/enf2 calculados y guardados (ver NurseView.jsx), aquí solo se
// arma el texto, nunca se recalcula.
export default function EtiquetaPanel({ session, med, onCerrar }) {
  const texto = textoEtiqueta(session, med);
  return (
    <div onClick={onCerrar}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#161616", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 20, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button onClick={onCerrar} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#888" }}>‹ Cerrar</button>
        </div>
        <div style={{ padding: "10px 14px", borderRadius: 10, background: "#0a0a0a", border: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#f0f0f0" }}>{med.name} {med.dose} — {session.patientName}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Vista previa</div>
          <div style={{ background: "#fff", color: "#111", borderRadius: 8, padding: 12, fontFamily: "'Times New Roman', serif", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            <b>{(session.patientName || "").toUpperCase()}</b>
            {"\n" + texto.split("\n").slice(1).join("\n")}
          </div>
        </div>
        <CajaCopiable titulo="Texto del cuerpo (pegar en el objeto de texto)" texto={texto} />
      </div>
    </div>
  );
}
