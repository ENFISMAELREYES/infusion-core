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

const MESES = ["ENE","FEB","MAR","ABR","MAY","JUN","JUL","AGO","SEP","OCT","NOV","DIC"];
function fmtFechaLarga(d) { // dd/MES/aaaa, como en el formato de expediente
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  const mes = MESES[parseInt(m, 10) - 1];
  return y && m && day && mes ? `${day}/${mes}/${y}` : d;
}
function fmtHora(h) { return h ? `${h} HRS` : ""; }

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

// Etiqueta de expediente -- NO es para la bolsa, es la copia que se imprime
// y se archiva en el expediente físico del paciente (ver PanelEtiquetas/
// lib/etiqueta.js de CEMI, mismo layout). Lote/caducidad de medicamento y
// diluyente, médico solicitante, alto riesgo y las fechas de
// elaboración/caducidad de refrigeración/entrega son datos propios de esta
// copia -- se capturan a mano junto con mg/ml del frasco (ver NurseView.jsx)
// y se guardan en med.etiqueta, nunca se recalculan al reimprimir.
function EtiquetaExpediente({ session, med }) {
  const e = med.etiqueta || {};
  const vm = e.vm != null ? Number(e.vm) : null;
  const volPrep = parseFloat(e.volumenPrep);
  const volDilFinal = (!isNaN(volPrep) && vm != null) ? (volPrep - vm).toFixed(1) : null;
  const diluyenteUp = (med.diluent || "").toUpperCase();

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#00d4aa" }}>Etiqueta de expediente</div>
        <button onClick={() => window.print()} style={{ padding: "4px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#ccc" }}>
          🖨️ Imprimir
        </button>
      </div>
      <div className="etiqueta-expediente-print" style={{ position: "relative", background: "#fff", color: "#111", borderRadius: 8, padding: "14px 16px", fontFamily: "'Times New Roman', serif", fontSize: 11.5, lineHeight: 1.55 }}>
        {e.altoRiesgo && (
          <div style={{ position: "absolute", top: 10, right: 12, width: 58, height: 58, borderRadius: "50%", background: "#D11A2A", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontWeight: 700, fontSize: 9.5, lineHeight: 1.15 }}>
            ALTO<br />RIESGO
          </div>
        )}
        <div style={{ fontWeight: 700 }}>{(session.patientName || "").toUpperCase()}</div>
        <div style={{ textAlign: "right", marginTop: -14 }}>F.N. {fmtFecha(session.dob)}</div>
        <div style={{ marginTop: 6 }}><b>Á</b>rea solicitante: {e.medico || ""}</div>
        <div><b>A</b>ctivo: {med.name} {med.dose}{e.piezas ? ` - ${e.piezas} Fco(s).` : ""}</div>
        <div style={{ paddingLeft: 13 }}>Lote: {e.loteMed || ""} Cad. {fmtFecha(e.cadMed)}</div>
        <div><b>D</b>iluyente: {med.diluent || "—"}</div>
        <div style={{ paddingLeft: 14 }}>Lote: {e.loteDil || ""}&nbsp;&nbsp;&nbsp;F.Cad. {fmtFecha(e.cadDil)}</div>

        <div style={{ marginTop: 8 }}><b>P</b>reparación:</div>
        <div style={{ fontWeight: 700 }}>{med.name} {med.dose} /</div>
        <div style={{ fontWeight: 700 }}>{diluyenteUp}{volDilFinal != null ? ` ${volDilFinal} ML` : ""}</div>
        <div><b>V</b>olumen Preparación: {e.volumenPrep ? <b>{e.volumenPrep}&nbsp;&nbsp;ml</b> : ""}</div>
        <div><b>F</b>echa de Elaboración: <b>{fmtFechaLarga(e.fechaElaboracion)}</b>{e.horaElaboracion ? `    ${fmtHora(e.horaElaboracion)}` : ""}</div>
        <div style={{ color: "#B91C1C" }}>Fecha de Cad. Refrigeración: <b>{fmtFechaLarga(e.fechaCadRefrigeracion)}</b>{e.horaCadRefrigeracion ? `  ${fmtHora(e.horaCadRefrigeracion)}` : ""}</div>
        <div><b>F</b>echa de Entrega: {fmtFechaLarga(e.fechaEntrega)}{e.horaEntrega ? `    ${fmtHora(e.horaEntrega)}` : ""}</div>
      </div>
    </div>
  );
}

// `session`/`med` -- igual que el resto de la app, med.etiqueta ya trae
// todos los datos capturados y calculados (ver NurseView.jsx), aquí solo se
// arman los dos formatos, nunca se recalcula nada.
export default function EtiquetaPanel({ session, med, onCerrar }) {
  const texto = textoEtiqueta(session, med);
  return (
    <div onClick={onCerrar}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <style>{`@media print {
        body * { visibility: hidden; }
        .etiqueta-expediente-print, .etiqueta-expediente-print * { visibility: visible; }
        .etiqueta-expediente-print { position: fixed; top: 0; left: 0; width: 100%; }
      }`}</style>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#161616", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 20, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button onClick={onCerrar} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", color: "#888" }}>‹ Cerrar</button>
        </div>
        <div style={{ padding: "10px 14px", borderRadius: 10, background: "#0a0a0a", border: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#f0f0f0" }}>{med.name} {med.dose} — {session.patientName}</div>
        </div>
        <EtiquetaExpediente session={session} med={med} />
        <CajaCopiable titulo="Etiqueta de bolsa — texto para copiar y pegar" texto={texto} />
      </div>
    </div>
  );
}
