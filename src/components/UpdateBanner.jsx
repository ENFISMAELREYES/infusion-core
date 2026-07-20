import { useEffect, useState } from "react";

const CHECK_INTERVAL_MS = 3 * 60 * 1000; // cada 3 minutos

export default function UpdateBanner() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const currentVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null;
    if (!currentVersion) return; // en desarrollo (npm run dev) no hay version.json que comparar

    const check = async () => {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (data.version && data.version !== currentVersion) {
          setAvailable(true);
        }
      } catch (e) {
        // sin conexión momentánea u otro problema de red: no molestar, se reintenta en el próximo ciclo
      }
    };

    check();
    const id = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (!available) return null;

  return (
    <div style={{
      position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 2000,
      display: "flex", alignItems: "center", gap: 14,
      background: "#161616", border: "1px solid rgba(0,212,170,0.35)", borderRadius: 12,
      padding: "12px 18px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)", maxWidth: "92vw",
    }}>
      <span style={{ fontSize: 13, color: "#f0f0f0" }}>
        🔄 Hay una nueva versión de InfusionCore disponible.
      </span>
      <button onClick={() => window.location.reload()} style={{
        padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
        background: "linear-gradient(135deg,#00d4aa,#0099ff)", border: "none", color: "#000", whiteSpace: "nowrap",
      }}>
        Actualizar ahora
      </button>
    </div>
  );
}
