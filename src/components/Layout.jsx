import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

const NAV = {
  jefe: [
    { to: "/",            icon: "⊞", label: "Panel general"   },
    { to: "/monitor",     icon: "◎", label: "Monitor en vivo" },
    { to: "/autorizar",   icon: "✦", label: "Autorizar"        },
    { to: "/historial",   icon: "◷", label: "Historial"        },
    { to: "/pacientes",   icon: "♡", label: "Pacientes"        },
  ],
  enfermera: [
    { to: "/",            icon: "◎", label: "Mis pacientes"   },
    { to: "/registrar",   icon: "⊕", label: "Registrar turno" },
  ],
};

function now() {
  return new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

export default function Layout() {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const links = NAV[profile?.role] || [];

  const handleLogout = async () => { await logout(); navigate("/login"); };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#080a0f" }}>

      {/* Sidebar */}
      <aside style={{
        width: 220, flexShrink: 0,
        background: "rgba(255,255,255,0.02)", borderRight: "1px solid rgba(255,255,255,0.06)",
        display: "flex", flexDirection: "column", padding: "24px 0",
        position: "sticky", top: 0, height: "100vh", overflowY: "auto",
      }}>
        {/* Logo */}
        <div style={{ padding: "0 20px 28px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 9,
              background: "linear-gradient(135deg, #00d4aa, #0099ff)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
            }}>⊕</div>
            <div>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 15, color: "#fff" }}>InfusionCore</div>
              <div style={{ fontSize: 9, color: "#555", letterSpacing: 1.5, textTransform: "uppercase" }}>{profile?.center || "Sistema"}</div>
            </div>
          </div>
        </div>

        {/* Nav links */}
        <nav style={{ flex: 1, padding: "20px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
          {links.map(({ to, icon, label }) => (
            <NavLink key={to} to={to} end={to === "/"} style={({ isActive }) => ({
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: 10, textDecoration: "none",
              fontSize: 13, fontWeight: 500, transition: "all 0.15s",
              background: isActive ? "rgba(0,212,170,0.12)" : "transparent",
              color: isActive ? "#00d4aa" : "#777",
              border: isActive ? "1px solid rgba(0,212,170,0.2)" : "1px solid transparent",
            })}>
              <span style={{ fontSize: 16, width: 20, textAlign: "center" }}>{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User info + logout */}
        <div style={{ padding: "16px 20px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ fontSize: 12, color: "#ddd", fontWeight: 500, marginBottom: 2 }}>{profile?.name || "Usuario"}</div>
          <div style={{ fontSize: 11, color: "#555", textTransform: "capitalize", marginBottom: 12 }}>{profile?.role}</div>
          <button onClick={handleLogout} style={{
            width: "100%", padding: "8px", borderRadius: 8, fontSize: 12,
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
            color: "#666", transition: "all 0.15s",
          }}
            onMouseEnter={e => { e.currentTarget.style.color = "#ff6b6b"; e.currentTarget.style.borderColor = "rgba(255,107,107,0.3)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "#666"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)"; }}
          >
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, overflowY: "auto", minHeight: "100vh" }}>
        <Outlet />
      </main>
    </div>
  );
}
