import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, browserLocalPersistence, setPersistence } from "firebase/auth";
import { auth } from "../firebase/config";

const AuthContext = createContext(null);

const PROFILES = {
  "xGme3zlkjbOaYXkRUd6XSzScOB43": { name: "Ismael Reyes",      role: "jefe",         center: "CITIO" },
  "QQxWhAem1adZsXiy5BvWBgvM15Y2": { name: "Camila Aquino",     role: "enfermera",    center: "CIPI"  },
  "JRYVuMW3fidrrlQcvDc5KSm00XT2": { name: "Paola Vargas",      role: "enfermera",    center: "CIPI"  },
  "gHEOTAoTe8fZCR4EjetuzqA59Uu1": { name: "Danna Ramírez",     role: "enfermera",    center: "CITIO" },
  "iwAUACSAqWYhol991xMDxgq30vq1": { name: "Yessica Madera",    role: "enfermera",    center: "CITIO" },
  "IC2Tegxjijc6icyaGXZUSjAFrxR2": { name: "Carlos Sorroza",    role: "visualizador", center: "CIPI"  },
  "0lah1NsefnR5GSpjfTX7D1qc4rh1": { name: "Jonathan Martínez", role: "visualizador", center: "CITIO" },
  "Ms8W1cGrrtY7bDDeSkt3RISvDZM2": { name: "Paola Itzel Sandre", role: "visualizador", center: "CIPI"  },
  "GstGhEoU7AbfbNwU8Lq2KZ2wiL52": { name: "Maricruz Zorrosa",  role: "visualizador", center: "CITIO" },
  "IhiRm5Fc5IT8BzzmQLQaq1dFXGs1": { name: "Ismael Reyes",      role: "enfermera",    center: "CITIO" },
  "dmMg7E4GfteR3Huc9hVYu9G4v5s1": { name: "Ana Flores",        role: "visualizador", center: "CIPI"  },
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

  const login = async (email, password) => {
    await setPersistence(auth, browserLocalPersistence);
    return signInWithEmailAndPassword(auth, email, password);
  };
  const logout = () => signOut(auth);

  return (
    <AuthContext.Provider value={{ user, profile, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
