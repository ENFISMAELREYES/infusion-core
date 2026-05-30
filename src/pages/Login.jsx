import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useNavigate } from "react-router-dom";

export default function Login() {
  const { login } = useAuth();
  const navigate  = useNavigate();
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const handle = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch {
      setError("Correo o contraseña incorrectos.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#080a0f", padding: 24,
      backgroundImage: "radial-gradient(ellipse 70% 50% at 50% 0%, rgba(0,212,170,0.07) 0%, transparent 70%)",
    }}>
      <div style={{
        width: "100%", maxWidth: 380,
        background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 20, padding: "36px 32px",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 11,
            background: "linear-gradient(135deg, #00d4aa, #0099ff)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
          }}>⊕</div>
          <div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "#fff" }}>InfusionCore</div>
            <div style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase" }}>Sistema de infusiones</div>
          </div>
        </div>

        <form onSubmit={handle} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 11, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", display: "block", marginBottom: 6 }}>
              Correo electrónico
            </label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)} required
              style={{
                width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10, padding: "11px 14px", color: "#f0f0f0", fontSize: 14, outline: "none",
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", display: "block", marginBottom: 6 }}>
              Contraseña
            </label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)} required
              style={{
                width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10, padding: "11px 14px", color: "#f0f0f0", fontSize: 14, outline: "none",
              }}
            />
          </div>

          {error && (
            <div style={{ fontSize: 13, color: "#ff6b6b", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: 8, padding: "10px 12px" }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={{
            marginTop: 8, padding: "13px", borderRadius: 11, fontSize: 14, fontWeight: 700,
            background: loading ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg, #00d4aa, #0099ff)",
            border: "none", color: loading ? "#555" : "#000", transition: "all 0.2s",
          }}>
            {loading ? "Ingresando..." : "Ingresar"}
          </button>
        </form>
      </div>
    </div>
  );
}
