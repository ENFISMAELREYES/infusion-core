import { useRef, useState, useEffect } from "react";

// Pad de firma sobre <canvas>. Funciona con mouse y con touch (dedo/lápiz en tableta).
// Expone la firma como dataURL PNG vía onChange cada vez que cambia, y un flag `empty`
// para que quien lo use pueda validar que sí se firmó antes de guardar.
export default function SignaturePad({ label, onChange, height = 140 }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    // Ajustar resolución real del canvas a su tamaño en pantalla (evita trazos borrosos)
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    // Fondo blanco explícito: así la firma se ve igual en la UI oscura que impresa en el PDF
    // (un trazo claro sobre canvas transparente sería invisible sobre una hoja blanca).
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111111";
  }, []);

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  };

  const start = (e) => {
    e.preventDefault();
    drawing.current = true;
    last.current = getPos(e);
  };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    last.current = pos;
    if (empty) setEmpty(false);
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (!empty) onChange?.(canvasRef.current.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width / ratio, canvas.height / ratio);
    setEmpty(true);
    onChange?.(null);
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <span style={{ fontSize:11, color:"#888", letterSpacing:1, textTransform:"uppercase" }}>{label}</span>
        <button type="button" onClick={clear} style={{ fontSize:10, padding:"3px 9px", borderRadius:7, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
          Limpiar
        </button>
      </div>
      <canvas
        ref={canvasRef}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        style={{
          width:"100%", height, borderRadius:10, touchAction:"none", cursor:"crosshair",
          background:"rgba(255,255,255,0.03)", border: empty ? "1px dashed rgba(255,255,255,0.15)" : "1px solid rgba(0,212,170,0.3)",
        }}
      />
      {empty && (
        <div style={{ fontSize:10, color:"#444", textAlign:"center", marginTop:-4 }}>Firma aquí con el dedo o el mouse</div>
      )}
    </div>
  );
}
