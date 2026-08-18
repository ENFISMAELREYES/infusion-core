import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { FIREBASE_CONFIG, DATABASE_ID } from "../config";

// Reutiliza la misma app si ya fue inicializada por src/firebase.js (evita el
// error "Firebase App named '[DEFAULT]' already exists").
const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0];

// getFirestore(app) SIN segundo argumento siempre apunta a la base
// "(default)", sin importar DATABASE_ID -- a diferencia de FIRESTORE_BASE_URL
// (usado en el resto de la app vía REST), que sí arma la URL con la base
// correcta. Hay que pasarla explícitamente para que el SDK cliente (usado
// aquí solo para leer el perfil en useAuth.jsx) apunte a la misma base que
// todo lo demás.
export const db = getFirestore(app, DATABASE_ID);
export const auth = getAuth(app);
