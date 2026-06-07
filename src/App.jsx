import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Autorizar from "./pages/Autorizar";
import Monitor from "./pages/Monitor";
import NurseView from "./pages/NurseView";
import NuevaSession from "./pages/NuevaSession";
import Historial from "./pages/Historial";
import Catalogo from "./pages/Catalogo";

function PrivateRoute({ children, roles }) {
  const { user, profile, loading } = useAuth();
  if (loading) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#080a0f", color:"#555", fontSize:14 }}>
      Cargando...
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(profile?.role)) {
    if (profile?.role === "enfermera") return <Navigate to="/pacientes" replace />;
if (profile?.role === "visualizador") return <Navigate to="/monitor" replace />;
    return <Navigate to="/" replace />;
  }
  return children;
}

function AppRoutes() {
  const { profile, loading } = useAuth();

  if (loading) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#080a0f", color:"#555", fontSize:14 }}>
      Cargando...
    </div>
  );

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
        <Route index element={
         profile?.role === "enfermera"
            ? <Navigate to="/pacientes" replace />
            : profile?.role === "visualizador"
            ? <Navigate to="/monitor" replace />
            : <PrivateRoute roles={["jefe"]}><Dashboard /></PrivateRoute>
        } />
        <Route path="monitor" element={<PrivateRoute roles={["jefe","visualizador"]}><Monitor /></PrivateRoute>} />
        <Route path="autorizar" element={<PrivateRoute roles={["jefe"]}><Autorizar /></PrivateRoute>} />
        <Route path="historial" element={<PrivateRoute roles={["jefe","visualizador"]}><Historial /></PrivateRoute>} />
        <Route path="catalogo" element={<PrivateRoute roles={["jefe"]}><Catalogo /></PrivateRoute>} />
        <Route path="pacientes" element={<PrivateRoute roles={["enfermera"]}><NurseView /></PrivateRoute>} />
        <Route path="registrar" element={<PrivateRoute roles={["enfermera"]}><NuevaSession /></PrivateRoute>} />
        <Route path="*" element={<Navigate to={profile?.role === "enfermera" ? "/pacientes" : "/"} replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}


