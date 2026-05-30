import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Autorizar from "./pages/Autorizar";
import Monitor from "./pages/Monitor";
import NurseView from "./pages/NurseView";
import NuevaSession from "./pages/NuevaSession";

function PrivateRoute({ children, roles }) {
  const { user, profile, loading } = useAuth();
  if (loading) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#080a0f", color:"#555", fontSize:14 }}>
      Cargando...
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(profile?.role)) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { profile } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
        <Route index element={<PrivateRoute roles={["jefe"]}><Dashboard /></PrivateRoute>} />
        <Route path="monitor" element={<PrivateRoute roles={["jefe"]}><Monitor /></PrivateRoute>} />
        <Route path="autorizar" element={<PrivateRoute roles={["jefe"]}><Autorizar /></PrivateRoute>} />
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
