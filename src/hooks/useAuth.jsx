import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, browserLocalPersistence, setPersistence } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase/config";

const AuthContext = createContext(null);

// El perfil (name/role/center) ya NO vive hardcodeado aquí -- se lee del
// documento users/{uid} en Firestore, el mismo que ya usan las reglas de
// seguridad (firestore.rules) para autorizar cada escritura. Antes había dos
// fuentes de verdad (este mapa + Firestore) que había que mantener
// sincronizadas a mano; ahora dar de alta a alguien es solo crear su usuario
// en Firebase Authentication + su documento en Firestore, sin tocar código.
//
// Para dar de alta o migrar usuarios existentes, ver scripts/migrate-users-to-firestore.mjs.

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = async (uid) => {
    try {
      const snap = await getDoc(doc(db, "users", uid));
      const p = snap.exists() ? snap.data() : null;
      console.log("Perfil:", p);
      setProfile(p);
    } catch (e) {
      console.error("Error al leer el perfil de Firestore:", e);
      setProfile(null);
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        await loadProfile(firebaseUser.uid);
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
  // Vuelve a leer el perfil sin recargar la página -- necesario después de
  // escribir algo en users/{uid} (ej. la firma en archivo), ya que este
  // hook solo lee una vez al iniciar sesión, no escucha cambios en vivo.
  const refreshProfile = () => user && loadProfile(user.uid);

  return (
    <AuthContext.Provider value={{ user, profile, loading, login, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
