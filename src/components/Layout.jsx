import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

const NAV = {
  jefe: [
    { to:"/",          icon:"⊞", label:"Panel"     },
    { to:"/monitor",   icon:"◎", label:"Monitor"   },
    { to:"/autorizar", icon:"✦", label:"Autorizar"  },
    { to:"/historial", icon:"◷", label:"Historial"  },
    { to:"/catalogo",  icon:"◈", label:"Catálogo"  },
    { to:"/agenda", icon:"📅", label:"Agenda" },
    { to:"/calculadoras", icon:"🧮", label:"Calculadoras" },
    { to:"/reportes", icon:"📊", label:"Reportes" },
  ],
  enfermera: [
    { to:"/pacientes", icon:"◎", label:"Pacientes"  },
    { to:"/registrar", icon:"＋", label:"Registrar"  },
    { to:"/historial", icon:"◷", label:"Historial"  },
    { to:"/agenda",    icon:"📅", label:"Agenda"     },
    { to:"/catalogo",  icon:"◈", label:"Catálogo"  },
    { to:"/calculadoras", icon:"🧮", label:"Calculadoras" },
  ],
  visualizador: [
    { to:"/monitor",   icon:"◎", label:"Monitor"   },
    { to:"/catalogo",  icon:"◈", label:"Catálogo"  },
    { to:"/agenda",    icon:"📅", label:"Agenda"    },
  ],
};

const ROLE_LABEL = {
  jefe: "Jefe de Enfermería",
  enfermera: "Enfermería",
  visualizador: "Visualizador",
};

export default function Layout() {
  const { profile, logout } = useAuth();
  const role = profile?.role || "enfermera";
  const nav  = NAV[role] || [];

  return (
    <div style={{ display:"flex", minHeight:"100vh", background:"#080a0f", color:"#f0f0f0", fontFamily:"'Inter', sans-serif" }}>
      {/* Sidebar — solo en desktop */}
      <aside style={{
        width:220, flexShrink:0, borderRight:"1px solid rgba(255,255,255,0.06)",
        display:"flex", flexDirection:"column", padding:"20px 12px",
        position:"sticky", top:0, height:"100vh", overflowY:"auto",
      }} className="desktop-only">
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:32, padding:"0 8px" }}>
          <img src="/icon-192-white.png" alt="InfusionCore" style={{ width:36, height:36, borderRadius:8, objectFit:"contain" }} />
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:"#fff", letterSpacing:-0.3 }}>InfusionCore</div>
            <div style={{ fontSize:10, color:"#555", letterSpacing:1, textTransform:"uppercase" }}>{profile?.center}</div>
          </div>
        </div>
        <nav style={{ display:"flex", flexDirection:"column", gap:4, flex:1 }}>
          {nav.map(item => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"}
              style={({ isActive }) => ({
                display:"flex", alignItems:"center", gap:12, padding:"10px 12px", borderRadius:10,
                textDecoration:"none", fontSize:13, fontWeight:500, transition:"all 0.15s",
                background: isActive ? "rgba(0,212,170,0.12)" : "transparent",
                color: isActive ? "#00d4aa" : "#666",
                border: isActive ? "1px solid rgba(0,212,170,0.2)" : "1px solid transparent",
              })}>
              <span style={{ fontSize:16 }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)", paddingTop:16, marginTop:16 }}>
          <div style={{ fontSize:13, color:"#f0f0f0", fontWeight:600, padding:"0 8px", marginBottom:2 }}>{profile?.name}</div>
          <div style={{ fontSize:11, color:"#555", padding:"0 8px", marginBottom:12, textTransform:"uppercase", letterSpacing:1 }}>{ROLE_LABEL[role] || role}</div>
          <button onClick={logout} style={{ width:"100%", padding:"9px", borderRadius:9, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", color:"#555" }}>
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Contenido principal */}
      <main style={{ flex:1, overflowY:"auto", paddingBottom:80 }} className="main-content">
        {/* Header móvil */}
        <div className="mobile-only" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px", borderBottom:"1px solid rgba(255,255,255,0.06)", position:"sticky", top:0, background:"#080a0f", zIndex:50 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <img src="/icon-192-white.png" alt="InfusionCore" style={{ width:28, height:28, borderRadius:6, objectFit:"contain" }} />
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:"#fff" }}>InfusionCore</div>
              <div style={{ fontSize:10, color:"#555" }}>{profile?.center} · {profile?.name}</div>
            </div>
          </div>
          <button onClick={logout} style={{ padding:"6px 12px", borderRadius:8, fontSize:11, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", color:"#555" }}>
            Salir
          </button>
        </div>
        <Outlet />
      </main>

      {/* Navegación inferior — solo en móvil */}
      <nav className="mobile-only" style={{
        position:"fixed", bottom:0, left:0, right:0, zIndex:100,
        background:"rgba(8,10,15,0.95)", borderTop:"1px solid rgba(255,255,255,0.08)",
        display:"flex", alignItems:"center", justifyContent:"space-around",
        padding:"8px 0 max(8px, env(safe-area-inset-bottom))",
        backdropFilter:"blur(12px)",
      }}>
        {nav.map(item => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}
            style={({ isActive }) => ({
              display:"flex", flexDirection:"column", alignItems:"center", gap:3,
              textDecoration:"none", padding:"6px 16px", borderRadius:10,
              color: isActive ? "#00d4aa" : "#555", transition:"all 0.15s",
              minWidth:60,
            })}>
            <span style={{ fontSize:20 }}>{item.icon}</span>
            <span style={{ fontSize:10, fontWeight:500, letterSpacing:0.5 }}>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
