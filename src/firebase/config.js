import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { FIREBASE_CONFIG } from "../config";

// Reutiliza la misma app si ya fue inicializada por src/firebase.js (evita el
// error "Firebase App named '[DEFAULT]' already exists").
const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0];

export const db = getFirestore(app);
export const auth = getAuth(app);
