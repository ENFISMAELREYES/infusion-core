import { parseDoseMg } from "./data/materialCatalog";

// Etiqueta de solución/mezcla para pegar en la bolsa antes de aplicarla --
// un solo diseño, usado tanto al generarla por primera vez (NurseView, justo
// antes de preparar) como al reimprimirla después (Historial, desde los
// mismos datos ya guardados en session.meds[].etiqueta). Nunca se
// recalcula al reimprimir -- se imprime exactamente lo que se guardó la
// primera vez, igual que ya hace "Reimprimir consentimiento".

// Vm = Dosis (mg) / Concentración del frasco (mg/ml) -- cuántos ml del
// medicamento hay que retirar del frasco para esa dosis.
export function computeVm(doseStr, mgFrasco, mlFrasco) {
  const doseMg = parseDoseMg(doseStr);
  const mg = parseFloat(mgFrasco), ml = parseFloat(mlFrasco);
  if (!doseMg || !mg || !ml) return null;
  return (doseMg / (mg / ml));
}

function fmtFecha(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}/${m}/${y}` : d;
}

export function printLabel(session, med) {
  const e = med.etiqueta || {};
  const logo = session.center === "CIPI" ? "/logo-cipi-icon.png" : "/logo-citio-icon.png";
  const vmTxt = e.vm != null ? `${Number(e.vm).toFixed(2)} ML` : "—";
  const win = window.open("", "_blank", "width=420,height:560");
  win.document.write(`<!DOCTYPE html><html><head><title>Etiqueta -- ${session.patientName || ""}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#111;}
    .label{width:360px;border:2px dashed #333;border-radius:10px;padding:16px;}
    .head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
    .head img{width:38px;height:38px;object-fit:contain;}
    .head .sub{font-size:10px;color:#666;line-height:1.3;}
    .row{font-size:13px;line-height:1.7;}
    .row b{font-weight:700;}
    .alerta{margin-top:10px;padding:7px 10px;background:#B91C1C;color:#fff;font-weight:700;text-align:center;border-radius:6px;font-size:12px;}
  </style></head><body>
    <div class="label">
      <div class="head"><img src="${logo}" /><div class="sub">${session.center === "CIPI" ? "Centro de Infusión Pediátrica Integral" : "Centro de Infusión, Tratamiento e Investigación Oncológica"}</div></div>
      <div class="row"><b>Nombre del paciente:</b> ${session.patientName || ""}</div>
      <div class="row"><b>Fecha de Nacimiento:</b> ${fmtFecha(session.dob)}</div>
      <div class="row"><b>Fecha:</b> ${fmtFecha(session.date)}</div>
      <div class="row"><b>Sol.</b> ${med.diluent || "—"}</div>
      <div class="row"><b>Medicamento:</b> ${med.name || ""} ${med.dose || ""}</div>
      <div class="row"><b>Volumen de medicamento a retirar:</b> ${vmTxt}</div>
      <div class="row"><b>Tiempo de infusión:</b> ${med.time ? `${med.time} minutos` : "—"}</div>
      <div class="row"><b>Hora de Inicio:</b> _______ &nbsp;&nbsp; <b>Hora de término:</b> _______</div>
      <div class="row"><b>Enf. 1:</b> ${e.enf1 || ""}</div>
      <div class="row"><b>Enf. 2:</b> ${e.enf2 || ""}</div>
      <div class="alerta">⚠ MEDICAMENTO DE ALTO RIESGO</div>
    </div>
    <script>window.onload = () => window.print();<\/script>
  </body></html>`);
  win.document.close();
}
