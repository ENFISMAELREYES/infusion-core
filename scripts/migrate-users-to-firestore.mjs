// Migración única: crea/actualiza el documento users/{uid} en Firestore para
// cada persona que hoy vive solo en el mapa PROFILES que tenía useAuth.jsx.
//
// Por qué: la app ya no lee el rol/centro de un mapa fijo en el código --
// ahora lo lee de Firestore (users/{uid}), la misma colección que ya usan
// firestore.rules para autorizar cada escritura. Este script solo sirve para
// sembrar esa colección una vez con los usuarios que ya existían.
//
// Uso:
//   1. Descarga la cuenta de servicio de tu proyecto de Firebase:
//      Firebase Console → Configuración del proyecto → Cuentas de servicio
//      → Generar nueva clave privada (o reutiliza la misma que ya está en
//      la variable de entorno FIREBASE_SERVICE_ACCOUNT de Vercel).
//   2. Expórtala como variable de entorno (el contenido del JSON, no la ruta):
//        export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
//   3. (Opcional) si vas a sembrar el proyecto de PRUEBAS en vez del real:
//        export VITE_FIREBASE_PROJECT_ID="infusion-core-dev"
//        export VITE_FIRESTORE_DATABASE_ID="default"
//   4. Corre:  node scripts/migrate-users-to-firestore.mjs
//
// Es seguro correrlo más de una vez -- sobreescribe cada documento con los
// mismos datos (PATCH), nunca borra ni toca otros documentos.

import { GoogleAuth } from "google-auth-library";

const PROJECT_ID  = process.env.VITE_FIREBASE_PROJECT_ID   || "infusion-core";
const DATABASE_ID = process.env.VITE_FIRESTORE_DATABASE_ID || "default";

// Copia exacta del mapa PROFILES que vivía en src/hooks/useAuth.jsx antes de
// este cambio -- fuente de la migración, no se vuelve a usar en la app.
const PROFILES = {
  "xGme3zlkjbOaYXkRUd6XSzScOB43": { name: "Ismael Reyes",       role: "jefe",         center: "CITIO" },
  "QQxWhAem1adZsXiy5BvWBgvM15Y2": { name: "Camila Aquino",      role: "enfermera",    center: "CIPI"  },
  "JRYVuMW3fidrrlQcvDc5KSm00XT2": { name: "Paola Vargas",       role: "enfermera",    center: "CIPI"  },
  "gHEOTAoTe8fZCR4EjetuzqA59Uu1": { name: "Danna Ramírez",      role: "enfermera",    center: "CITIO" },
  "iwAUACSAqWYhol991xMDxgq30vq1": { name: "Yessica Madera",     role: "enfermera",    center: "CITIO" },
  "IhiRm5Fc5IT8BzzmQLQaq1dFXGs1": { name: "Ismael Reyes",       role: "enfermera",    center: "CITIO" },
  "IC2Tegxjijc6icyaGXZUSjAFrxR2": { name: "Carlos Sorroza",     role: "visualizador", center: "CIPI"  },
  "0lah1NsefnR5GSpjfTX7D1qc4rh1": { name: "Jonathan Martínez",  role: "visualizador", center: "CITIO" },
  "dmMg7E4GfteR3Huc9hVYu9G4v5s1": { name: "Ana Flores",         role: "visualizador", center: "CIPI"  },
  "Ms8W1cGrrtY7bDDeSkt3RISvDZM2": { name: "Paola Itzel Sandre", role: "visualizador", center: "CIPI"  },
  "GstGhEoU7AbfbNwU8Lq2KZ2wiL52": { name: "Maricruz Zorrosa",   role: "visualizador", center: "CITIO" },
  "mUmYTTlSDwTcu2MY1kOoRhP1rMt2": { name: "Elizabet Sorroza",   role: "visualizador", center: "CITIO" },
  "yX2tnwdkAQexFWQ8suiNn6jpqp43": { name: "Jesus Tapia",        role: "visualizador", center: "CITIO" },
};

function toFV(val) {
  if (typeof val === "string") return { stringValue: val };
  return { stringValue: String(val) };
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).");
    process.exit(1);
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const auth = new GoogleAuth({ credentials: serviceAccount, scopes: ["https://www.googleapis.com/auth/datastore"] });
  const accessToken = await auth.getAccessToken();

  console.log(`Sembrando users/{uid} en ${PROJECT_ID} (db: ${DATABASE_ID})...`);
  let ok = 0, fail = 0;
  for (const [uid, profile] of Object.entries(PROFILES)) {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/users/${uid}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify({ fields: {
        name: toFV(profile.name),
        role: toFV(profile.role),
        center: toFV(profile.center),
      }}),
    });
    if (res.ok) {
      ok++;
      console.log(`  ✓ ${profile.name} (${uid})`);
    } else {
      fail++;
      const body = await res.text();
      console.error(`  ✗ ${profile.name} (${uid}): ${res.status} ${body}`);
    }
  }
  console.log(`Listo: ${ok} documentos creados/actualizados, ${fail} con error.`);
  if (fail > 0) process.exit(1);
}

main();
