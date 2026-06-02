import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase/config";

const AuthContext = createContext(null);

// Perfiles hardcodeados como respaldo
const PROFILES = {
  "xGme3zlkjb0aYXkRUd6XSzScOB43": { name: "Ismael Reyes", role: "jefe", center: "CITIO" },
  "QQxWhAem1adZsXiy5BvWBgvM15Y2": { name: "Camila Aquino", role: "enfermera", center: "CIPI" },
  "JRYVuMW3fidrrlQcvDc5KSm00XT2": { name: "Paola Vargas",  role: "enfermera", center: "CIPI" },
  "gHEOTAoTe8fZCR4EjetuzqA59Uu1": { name: "Danna Ramírez", role: "enfermera", center: "CITIO" },
  "iwAUACSAqWYhol991xMDxgq30vq1": { name: "Yessica Maderas", role: "enfermera", center: "CITIO" },
};

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

 useEffect(() => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        const p = PROFILES[firebaseUser.uid] || null;
        console.log("Perfil:", p);
        setProfile(p);
      } else {
        setUser(null);
        setProfile(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const login  = (email, password) =>
    signInWithEmailAndPassword(auth, email, password);
  const logout = () => signOut(auth);

  return (
    <AuthContext.Provider value={{ user, profile, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
