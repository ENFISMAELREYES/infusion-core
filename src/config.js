// Configuración central de Firebase. Para trabajar contra el proyecto de
// PRUEBAS en vez del real, no toques nada aquí -- usa variables de entorno:
//
//   1. Copia .env.example a .env.local (este archivo NO se sube a git)
//   2. Pon ahí los datos de tu proyecto "infusion-core-dev"
//   3. Corre `npm run dev` normal -- automáticamente usará el de pruebas
//
// En Vercel, las variables de entorno se configuran por separado para
// "Production" y "Preview" (Settings → Environment Variables), así que los
// despliegues de ramas que no sean main pueden apuntar solas al proyecto de
// pruebas sin que nadie tenga que acordarse de cambiar nada a mano.

export const PROJECT_ID           = import.meta.env.VITE_FIREBASE_PROJECT_ID    || "infusion-core";
export const DATABASE_ID          = import.meta.env.VITE_FIRESTORE_DATABASE_ID  || "default";
export const API_KEY              = import.meta.env.VITE_FIREBASE_API_KEY      || "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";
export const AUTH_DOMAIN          = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN   || `${PROJECT_ID}.firebaseapp.com`;
export const STORAGE_BUCKET       = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || `${PROJECT_ID}.firebasestorage.app`;
export const MESSAGING_SENDER_ID  = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "372027565230";
export const APP_ID               = import.meta.env.VITE_FIREBASE_APP_ID       || "1:372027565230:web:9c2055e465b9ed7a02b93f";
export const VAPID_KEY             = import.meta.env.VITE_FIREBASE_VAPID_KEY    || "BMLOo1m7MOcerY21MKP-LfhHiQ5BEsVXNJog9Gv_EIklKdC6evUdC7kZQcufIcjPm44R5Bbhx2tJcucSdPNqyqA";

export const FIREBASE_CONFIG = {
  apiKey: API_KEY,
  authDomain: AUTH_DOMAIN,
  projectId: PROJECT_ID,
  storageBucket: STORAGE_BUCKET,
  messagingSenderId: MESSAGING_SENDER_ID,
  appId: APP_ID,
};

export const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

// Aviso visible: si estás usando una base de datos que no es la real (por
// nombre de base de datos, o por proyecto), se nota en la app para nunca
// confundirte de entorno mientras capturas datos de prueba.
export const IS_TEST_ENV = PROJECT_ID !== "infusion-core" || DATABASE_ID !== "default";
