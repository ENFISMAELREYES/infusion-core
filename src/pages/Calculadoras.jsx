import { useState } from "react";

function CalcCard({ title, children }) {
  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", marginBottom:16 }}>
      <div style={{ fontSize:13, color:"#00d4aa", fontWeight:600, letterSpacing:1, textTransform:"uppercase", marginBottom:16 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type="number" }) {
  return (
    <div style={{ marginBottom:12 }}>
      <label style={{ fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 }}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"10px 13px", color:"#f0f0f0", fontSize:14, outline:"none" }} />
    </div>
  );
}

function Result({ label, value, unit, color="#00d4aa" }) {
  return (
    <div style={{ padding:"14px 16px", borderRadius:10, background:`${color}10`, border:`1px solid ${color}33`, marginTop:4 }}>
      <div style={{ fontSize:11, color:"#666", letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:28, fontFamily:"'DM Serif Display', serif", color }}>
        {value} <span style={{ fontSize:14, color:"#888" }}>{unit}</span>
      </div>
    </div>
  );
}

function CalcDosis() {
  const [dosis, setDosis]           = useState("");
  const [dosisDisp, setDosisDisp]   = useState("");
  const [cantFarm, setCantFarm]     = useState("");
  const [result, setResult]         = useState(null);

  const calcular = () => {
    const d  = parseFloat(dosis);
    const dd = parseFloat(dosisDisp);
    const cf = parseFloat(cantFarm);
    if (!d || !dd || !cf || dd === 0) return;
    setResult(((d * cf) / dd).toFixed(2));
  };

  return (
    <CalcCard title="🧪 Cálculo de dosis">
      <Field label="Dosis requerida (mg)" value={dosis} onChange={setDosis} placeholder="ej: 250" />
      <Field label="Dosis disponible (mg)" value={dosisDisp} onChange={setDosisDisp} placeholder="ej: 500" />
      <Field label="Cantidad del fármaco (ml)" value={cantFarm} onChange={setCantFarm} placeholder="ej: 10" />
      <button onClick={calcular} style={{ width:"100%", padding:"11px", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer", background:"linear-gradient(135deg,#00d4aa,#0099ff)", border:"none", color:"#000", marginTop:4 }}>
        Calcular
      </button>
      {result !== null && <Result label="Resultado" value={result} unit="ml" />}
    </CalcCard>
  );
}

function CalcRangoConc() {
  const [dosisFarm, setDosisFarm]   = useState("");
  const [rangoMin, setRangoMin]     = useState("");
  const [rangoMax, setRangoMax]     = useState("");
  const [volRef, setVolRef]         = useState("");
  const [result, setResult]         = useState(null);

  const calcular = () => {
    const d   = parseFloat(dosisFarm);
    const min = parseFloat(rangoMin);
    const max = parseFloat(rangoMax);
    const vol = parseFloat(volRef);
    if (!d || !min || !max || !vol || min === 0 || max === 0) return;
    const concRef = min / vol; // mg/ml en concentración mínima
    const mlMin   = (d / max).toFixed(2); // ml para concentración máxima (más concentrado = menos ml)
    const mlMax   = (d / min).toFixed(2); // ml para concentración mínima (menos concentrado = más ml)
    setResult({ mlMin, mlMax });
  };

  return (
    <CalcCard title="📊 Rango de concentración">
      <Field label="Dosis del fármaco (mg)" value={dosisFarm} onChange={setDosisFarm} placeholder="ej: 500" />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
        <div>
          <label style={{ fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 }}>Rango mín (mg)</label>
          <input type="number" value={rangoMin} onChange={e => setRangoMin(e.target.value)} placeholder="ej: 1"
            style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"10px 13px", color:"#f0f0f0", fontSize:14, outline:"none" }} />
        </div>
        <div>
          <label style={{ fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 }}>Rango máx (mg)</label>
          <input type="number" value={rangoMax} onChange={e => setRangoMax(e.target.value)} placeholder="ej: 5"
            style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"10px 13px", color:"#f0f0f0", fontSize:14, outline:"none" }} />
        </div>
        <div>
          <label style={{ fontSize:11, color:"#666", letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 }}>Volumen ref (ml)</label>
          <input type="number" value={volRef} onChange={e => setVolRef(e.target.value)} placeholder="ej: 100"
            style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"10px 13px", color:"#f0f0f0", fontSize:14, outline:"none" }} />
        </div>
      </div>
      <button onClick={calcular} style={{ width:"100%", padding:"11px", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer", background:"linear-gradient(135deg,#00d4aa,#0099ff)", border:"none", color:"#000", marginTop:12 }}>
        Calcular
      </button>
      {result && (
        <div style={{ marginTop:12, padding:"14px 16px", borderRadius:10, background:"rgba(0,212,170,0.08)", border:"1px solid rgba(0,212,170,0.25)" }}>
          <div style={{ fontSize:11, color:"#666", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Rango en ml</div>
          <div style={{ display:"flex", gap:20 }}>
            <div>
              <div style={{ fontSize:10, color:"#555" }}>Mínimo</div>
              <div style={{ fontSize:28, fontFamily:"'DM Serif Display', serif", color:"#00d4aa" }}>{result.mlMin} <span style={{ fontSize:14, color:"#888" }}>ml</span></div>
            </div>
            <div style={{ fontSize:24, color:"#555", alignSelf:"center" }}>—</div>
            <div>
              <div style={{ fontSize:10, color:"#555" }}>Máximo</div>
              <div style={{ fontSize:28, fontFamily:"'DM Serif Display', serif", color:"#00d4aa" }}>{result.mlMax} <span style={{ fontSize:14, color:"#888" }}>ml</span></div>
            </div>
          </div>
        </div>
      )}
    </CalcCard>
  );
}

function CalcConcentracion() {
  const [dosis, setDosis]   = useState("");
  const [volumen, setVolumen] = useState("");
  const [result, setResult]   = useState(null);

  const calcular = () => {
    const d = parseFloat(dosis);
    const v = parseFloat(volumen);
    if (!d || !v || v === 0) return;
    setResult((d / v).toFixed(4));
  };

  return (
    <CalcCard title="💊 Concentración de dilución">
      <Field label="Dosis del fármaco (mg)" value={dosis} onChange={setDosis} placeholder="ej: 500" />
      <Field label="Volumen de dilución (ml)" value={volumen} onChange={setVolumen} placeholder="ej: 250" />
      <button onClick={calcular} style={{ width:"100%", padding:"11px", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer", background:"linear-gradient(135deg,#00d4aa,#0099ff)", border:"none", color:"#000", marginTop:4 }}>
        Calcular
      </button>
      {result !== null && <Result label="Concentración" value={result} unit="mg/ml" />}
    </CalcCard>
  );
}

function CalcDosisKg() {
  const [dosis, setDosis]   = useState("");
  const [peso, setPeso]     = useState("");
  const [result, setResult] = useState(null);

  const calcular = () => {
    const d = parseFloat(dosis);
    const p = parseFloat(peso);
    if (!d || !p || p === 0) return;
    setResult((d * p).toFixed(2));
  };

  return (
    <CalcCard title="⚖️ Dosis por peso">
      <Field label="Dosis (mg/kg)" value={dosis} onChange={setDosis} placeholder="ej: 2.5" />
      <Field label="Peso del paciente (kg)" value={peso} onChange={setPeso} placeholder="ej: 70" />
      <button onClick={calcular} style={{ width:"100%", padding:"11px", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer", background:"linear-gradient(135deg,#00d4aa,#0099ff)", border:"none", color:"#000", marginTop:4 }}>
        Calcular
      </button>
      {result !== null && <Result label="Dosis total" value={result} unit="mg" />}
    </CalcCard>
  );
}

function CalcBSA() {
  const [peso, setPeso]     = useState("");
  const [talla, setTalla]   = useState("");
  const [result, setResult] = useState(null);

  const calcular = () => {
    const p = parseFloat(peso);
    const t = parseFloat(talla);
    if (!p || !t || p === 0 || t === 0) return;
    // Fórmula de Mosteller: √(peso(kg) × talla(cm) / 3600)
    setResult(Math.sqrt((p * t) / 3600).toFixed(2));
  };

  return (
    <CalcCard title="📐 Superficie corporal (BSA)">
      <div style={{ fontSize:12, color:"#555", marginBottom:12 }}>Fórmula de Mosteller: √(peso × talla / 3600)</div>
      <Field label="Peso (kg)" value={peso} onChange={setPeso} placeholder="ej: 70" />
      <Field label="Talla (cm)" value={talla} onChange={setTalla} placeholder="ej: 165" />
      <button onClick={calcular} style={{ width:"100%", padding:"11px", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer", background:"linear-gradient(135deg,#00d4aa,#0099ff)", border:"none", color:"#000", marginTop:4 }}>
        Calcular
      </button>
      {result !== null && <Result label="Superficie corporal" value={result} unit="m²" color="#AFA9EC" />}
    </CalcCard>
  );
}

export default function Calculadoras() {
  return (
    <div style={{ padding:"24px 28px", maxWidth:720, margin:"0 auto" }}>
      <div style={{ marginBottom:28 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Calculadoras</h1>
        <p style={{ fontSize:13, color:"#555" }}>Herramientas de cálculo para infusiones</p>
      </div>
      <CalcDosis />
      <CalcRangoConc />
      <CalcConcentracion />
      <CalcDosisKg />
      <CalcBSA />
    </div>
  );
}
